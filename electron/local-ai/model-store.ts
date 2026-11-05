/**
 * Model downloads for the built-in local AI (1.0.97 B36).
 *
 * Models live in `%LOCALAPPDATA%\Ark\models` (not roaming, survives updates) or a folder the
 * user picked. Each file is fetched from its manifest sources in order (only sources verified to load in the
 * bundled llama-server are listed: an Ollama registry blob and/or a pinned Hugging Face file) through `downloadWithResume`: `.part` + HTTP Range resume,
 * sha256 checked before the file is moved into place. A small `<file>.verified.json` marker
 * records the hash, size and mtime, so later launches trust the file without re-hashing 1+ GB;
 * a file whose size or mtime changed is hashed again before use.
 *
 * Downloads run one at a time. Pause aborts the transfer and keeps the `.part` (resume
 * continues from it); a disk-space check runs before each file; errors are classified
 * (offline, blocked, disk full, checksum, http) so the UI can offer Retry or "Continue without
 * local AI". Nothing here blocks the app: callers fire `ensure()` and listen to `onChange`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { downloadWithResume, sha256OfFile, moveFileWithRetry, DownloadError, type ResumableDownloadOptions } from '../resumable-download.js';
import type { LocalAiRole, ModelEntry, ModelSource } from './manifest.js';

export type ModelState = 'ready' | 'missing' | 'queued' | 'downloading' | 'paused' | 'verifying' | 'error';
export type ModelErrorCode = 'offline' | 'blocked' | 'disk_full' | 'checksum' | 'http' | 'folder_unavailable' | 'unknown';

export interface ModelStatus {
  id: string;
  role: LocalAiRole;
  label: string;
  file: string;
  auto: boolean;
  /** Size of the source that will be (or was) used. */
  sizeBytes: number;
  state: ModelState;
  transferred: number;
  /** 0..100 */
  pct: number;
  source: ModelSource['kind'] | null;
  error: { code: ModelErrorCode; message: string } | null;
}

export interface ModelStoreDeps {
  models: () => ModelEntry[];
  modelsDir: () => string;
  download?: (opts: ResumableDownloadOptions) => Promise<string>;
  hashFile?: (file: string) => Promise<string>;
  /** Free bytes on the volume holding `dir`; null when unknown (the check is skipped). */
  freeBytes?: (dir: string) => number | null;
  log?: (msg: string) => void;
  /** Minimum interval between progress notifications. */
  progressIntervalMs?: number;
  /** Pause between attempts to delete a file another process still holds (EBUSY/EPERM). */
  removeRetryDelayMs?: number;
}

export interface EnsureOptions {
  /** The user asked for this (Retry, Download): it also lifts a Pause. Background callers leave it off. */
  resumePaused?: boolean;
  /** Put these ahead of waiting models, and step a non-automatic download (the chat model) aside for them. */
  priority?: boolean;
}

/** A folder move in progress: the files are in the new folder, the old ones are still around until `commit`. */
export interface MovePlan {
  /** Delete the old copies. Call once the new folder is the one in use. */
  commit(): Promise<void>;
  /** Undo the move: put everything back and remove the copies. */
  rollback(): Promise<void>;
}

/** Spare room kept on the disk on top of the file itself. */
export const DISK_MARGIN_BYTES = 512 * 1024 * 1024;

interface Marker { sha256: string; size: number; mtimeMs: number; source: ModelSource['kind'] }

export function defaultFreeBytes(dir: string): number | null {
  try {
    let probe = dir;
    while (!fs.existsSync(probe)) {
      const up = path.dirname(probe);
      if (up === probe) return null;
      probe = up;
    }
    const st = fs.statfsSync(probe);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** Map a download failure to the code the UI explains. Exported for tests. */
export function classifyDownloadError(err: unknown): { code: ModelErrorCode; message: string } {
  const e = err as { code?: unknown; statusCode?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  const code = String(e?.code ?? e?.cause?.code ?? '');
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const text = `${code} ${message}`;
  if (/ENOSPC|disk full|not enough space/i.test(text)) return { code: 'disk_full', message: 'Not enough disk space' };
  if (code === 'OVERSIZE') return { code: 'checksum', message: 'The server sent a different file than expected, so it was discarded' };
  if (code === 'CHECKSUM') return { code: 'checksum', message: 'The downloaded file did not match its checksum and was discarded' };
  if (code === 'FOLDER_UNAVAILABLE') {
    return { code: 'folder_unavailable', message: 'Ark cannot write to the models folder. Check the drive and permissions, or choose another folder.' };
  }
  if (code === 'PORTAL') {
    return { code: 'blocked', message: 'The network asked for a sign-in (captive portal). Sign in to the network, then Retry.' };
  }
  if (/BLOCKED/i.test(code) || e?.statusCode === 403 || e?.statusCode === 451) {
    return { code: 'blocked', message: 'The download was blocked on this computer or network' };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ETIMEDOUT|fetch failed|ERR_(CONNECTION_(TIMED_OUT|REFUSED|RESET|CLOSED)|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NETWORK_ACCESS_DENIED|INTERNET_DISCONNECTED)/i.test(text)) {
    return { code: 'offline', message: 'No connection to the download server' };
  }
  if (typeof e?.statusCode === 'number') return { code: 'http', message: `The server answered HTTP ${e.statusCode}` };
  return { code: 'unknown', message };
}

export class ModelStore {
  private readonly deps: Required<Omit<ModelStoreDeps, 'log'>> & { log: (msg: string) => void };
  private readonly status = new Map<string, ModelStatus>();
  private readonly listeners = new Set<(s: ModelStatus[]) => void>();
  private queue: string[] = [];
  private running: Promise<void> | null = null;
  private current: { id: string; abort: AbortController; userAbort: boolean; preempted: boolean } | null = null;
  private refreshing: Promise<ModelStatus[]> | null = null;
  private paused = false;
  private lastProgressAt = 0;

  constructor(deps: ModelStoreDeps) {
    this.deps = {
      download: downloadWithResume,
      hashFile: sha256OfFile,
      freeBytes: defaultFreeBytes,
      progressIntervalMs: 250,
      removeRetryDelayMs: 300,
      log: () => undefined,
      ...deps,
    } as ModelStore['deps'];
    for (const m of this.deps.models()) this.status.set(m.id, this.blank(m));
  }

  private blank(m: ModelEntry): ModelStatus {
    return {
      id: m.id, role: m.role, label: m.label, file: m.file, auto: m.auto,
      sizeBytes: m.sources[0]?.size ?? 0, state: 'missing', transferred: 0, pct: 0, source: null, error: null,
    };
  }

  onChange(fn: (s: ModelStatus[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(force = true): void {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < this.deps.progressIntervalMs) return;
    this.lastProgressAt = now;
    const snap = this.statuses();
    for (const fn of this.listeners) {
      try { fn(snap); } catch { /* a listener must not break downloads */ }
    }
  }

  private set(id: string, patch: Partial<ModelStatus>, force = true): void {
    const cur = this.status.get(id);
    if (!cur) return;
    this.status.set(id, { ...cur, ...patch });
    this.emit(force);
  }

  statuses(): ModelStatus[] {
    return this.deps.models().map((m) => ({ ...(this.status.get(m.id) ?? this.blank(m)) }));
  }

  private entry(id: string): ModelEntry | undefined {
    return this.deps.models().find((m) => m.id === id);
  }

  filePath(m: ModelEntry): string {
    return path.join(this.deps.modelsDir(), m.file);
  }

  private markerPath(m: ModelEntry): string {
    return `${this.filePath(m)}.verified.json`;
  }

  isReady(role: LocalAiRole): boolean {
    const m = this.deps.models().find((x) => x.role === role);
    return !!m && this.status.get(m.id)?.state === 'ready';
  }

  /** Path of a verified model file for `role`, or null when it is not ready. */
  modelPath(role: LocalAiRole): string | null {
    const m = this.deps.models().find((x) => x.role === role);
    return m && this.isReady(role) ? this.filePath(m) : null;
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Check every model on disk. A file with a matching marker is ready; a file without one (or
   * whose size/mtime changed) is hashed against every source; a file that matches none is deleted.
   * Only one check runs at a time (callers share it). A file that could not be read is kept.
   */
  refresh(): Promise<ModelStatus[]> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private isActive(id: string): boolean {
    const st = this.status.get(id);
    return st?.state === 'downloading' || st?.state === 'queued' || this.queue.includes(id) || this.current?.id === id;
  }

  private async doRefresh(): Promise<ModelStatus[]> {
    for (const m of this.deps.models()) {
      const st = this.status.get(m.id);
      if (this.isActive(m.id)) continue;
      const file = this.filePath(m);
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(file); } catch { stat = null; }
      if (!stat) {
        this.set(m.id, { state: st?.state === 'paused' || st?.state === 'error' ? st.state : 'missing', transferred: st?.transferred ?? 0 }, false);
        continue;
      }
      const marker = this.readMarker(m);
      const src = marker ? m.sources.find((s) => s.sha256 === marker.sha256) : undefined;
      if (marker && src && marker.size === stat.size && marker.mtimeMs === stat.mtimeMs) {
        this.set(m.id, { state: 'ready', sizeBytes: stat.size, transferred: stat.size, pct: 100, source: src.kind, error: null }, false);
        continue;
      }
      this.set(m.id, { state: 'verifying' });
      let hash: string | null = null;
      let readError: unknown = null;
      try { hash = await this.deps.hashFile(file); } catch (err) { readError = err; }
      // A download may have started (and replaced the file) while the old bytes were being hashed.
      if (this.status.get(m.id)?.state !== 'verifying' || this.isActive(m.id)) continue;
      if (hash === null) {
        // Antivirus, a sync client or a busy disk can block the read for a moment: that says nothing about the file.
        this.deps.log(`[LocalAI] could not read ${m.file} to check it, keeping it: ${String(readError)}`);
        this.set(m.id, { state: 'error', error: { code: 'unknown', message: 'Could not check this model file right now. Use Re-check to try again.' } });
        continue;
      }
      const match = m.sources.find((s) => s.sha256 === hash && s.size === stat!.size);
      if (match) {
        this.writeMarker(m, match);
        this.set(m.id, { state: 'ready', sizeBytes: stat.size, transferred: stat.size, pct: 100, source: match.kind, error: null });
      } else {
        this.deps.log(`[LocalAI] ${m.file} does not match any pinned hash; removing it`);
        try {
          this.removeFile(m);
        } catch (err) {
          this.deps.log(`[LocalAI] could not remove ${m.file}: ${String(err)}`);
        }
        this.set(m.id, { state: 'missing', transferred: 0, pct: 0, source: null });
      }
    }
    this.emit();
    return this.statuses();
  }

  private readMarker(m: ModelEntry): Marker | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.markerPath(m), 'utf8')) as Marker;
      return typeof parsed?.sha256 === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeMarker(m: ModelEntry, src: ModelSource): void {
    try {
      const stat = fs.statSync(this.filePath(m));
      const marker: Marker = { sha256: src.sha256, size: stat.size, mtimeMs: stat.mtimeMs, source: src.kind };
      fs.writeFileSync(this.markerPath(m), JSON.stringify(marker), 'utf8');
    } catch (err) {
      this.deps.log(`[LocalAI] could not write the marker for ${m.file}: ${String(err)}`);
    }
  }

  private removeFile(m: ModelEntry): void {
    for (const p of [this.filePath(m), this.markerPath(m)]) fs.rmSync(p, { force: true });
  }

  /** Partial download of one source (per source, since two sources are different bytes). */
  private partBase(m: ModelEntry, src: ModelSource): string {
    return `${this.filePath(m)}.${src.sha256.slice(0, 12)}.dl`;
  }

  /**
   * Queue downloads for `ids` (models already ready are skipped). Resolves when the queue drains.
   * While paused, only a user action (`resumePaused`) starts anything; a background caller leaves
   * the models 'paused' so the user's Pause is not undone behind their back.
   */
  ensure(ids: string[], opts: EnsureOptions = {}): Promise<void> {
    if (opts.resumePaused) this.paused = false;
    const added: string[] = [];
    for (const id of ids) {
      const st = this.status.get(id);
      if (!st || st.state === 'ready') continue;
      if (this.current?.id === id) {
        // A paused attempt that is still winding down: queue it again so the resume is not lost.
        if (this.current.userAbort && !this.paused && !this.queue.includes(id)) { this.queue.push(id); this.set(id, { state: 'queued', error: null }); }
        continue;
      }
      if (this.queue.includes(id)) continue;
      if (this.paused) { this.set(id, { state: 'paused', error: null }); continue; }
      added.push(id);
      this.set(id, { state: 'queued', error: null });
    }
    if (opts.priority) {
      // Models that were already waiting (behind the chat model) move to the front too.
      const front = ids.filter((id) => added.includes(id) || this.queue.includes(id));
      this.queue = [...front, ...this.queue.filter((q) => !front.includes(q))];
      const cur = this.current;
      if (cur && front.length && !front.includes(cur.id) && !cur.userAbort && !this.status.get(cur.id)?.auto) {
        cur.preempted = true;
        cur.abort.abort();
      }
    } else {
      this.queue.push(...added);
    }
    if (!this.running && !this.paused) {
      this.running = this.drain().finally(() => { this.running = null; });
    }
    return this.running ?? Promise.resolve();
  }

  /** Lift a Pause (a user action: Retry, Re-check, Download); queued work starts with the next `ensure`. */
  unpause(): void {
    this.paused = false;
  }

  /** Resolves once every model in `ids` is neither waiting nor transferring nor being checked. */
  whenSettled(ids: string[]): Promise<void> {
    const busy = (): boolean => ids.some((id) => {
      const state = this.status.get(id)?.state;
      return state === 'queued' || state === 'downloading' || state === 'verifying';
    });
    if (!busy()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = this.onChange(() => { if (!busy()) { off(); resolve(); } });
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.paused) {
      const id = this.queue.shift()!;
      const m = this.entry(id);
      if (!m) continue;
      let result: Awaited<ReturnType<ModelStore['downloadOne']>>;
      try {
        result = await this.downloadOne(m);
      } catch (err) {
        // Whatever escapes must still end in a visible error with Retry, never a model stuck 'queued'.
        this.deps.log(`[LocalAI] ${m.file} failed unexpectedly: ${String(err)}`);
        this.set(m.id, { state: 'error', error: classifyDownloadError(err) });
        result = 'stop';
      }
      // Offline / disk full / blocked would fail every remaining file the same way: stop here.
      if (result === 'stop') {
        for (const rest of this.queue.splice(0)) this.set(rest, { state: 'missing' });
        break;
      }
    }
  }

  private async downloadOne(m: ModelEntry): Promise<'ok' | 'next' | 'stop' | 'paused'> {
    try {
      fs.mkdirSync(this.deps.modelsDir(), { recursive: true });
    } catch (err) {
      this.deps.log(`[LocalAI] models folder unavailable: ${String(err)}`);
      this.set(m.id, {
        state: 'error',
        error: { code: 'folder_unavailable', message: 'The models folder is not available. Check the drive or pick another folder.' },
      });
      return 'stop';
    }
    let lastErr: { code: ModelErrorCode; message: string } | null = null;
    for (const src of m.sources) {
      const base = this.partBase(m, src);
      const partSize = (() => { try { return fs.statSync(`${base}.part`).size; } catch { return 0; } })();
      const free = this.deps.freeBytes(this.deps.modelsDir());
      if (free !== null && free < src.size - partSize + DISK_MARGIN_BYTES) {
        const need = Math.ceil((src.size - partSize + DISK_MARGIN_BYTES) / 1e9 * 10) / 10;
        this.set(m.id, { state: 'error', error: { code: 'disk_full', message: `Not enough disk space: ${need} GB needed` } });
        return 'stop';
      }
      // A verified download whose final move failed earlier is still here: do not fetch it again.
      const leftover = (() => { try { return fs.statSync(base).size; } catch { return -1; } })();
      let haveVerified = false;
      if (leftover === src.size && partSize === 0) {
        haveVerified = await this.deps.hashFile(base).then((h) => h === src.sha256.toLowerCase()).catch(() => false);
        if (!haveVerified) fs.rmSync(base, { force: true });
      }
      const abort = new AbortController();
      const attempt = { id: m.id, abort, userAbort: false, preempted: false };
      this.current = attempt;
      let finalizing = false;
      this.set(m.id, { state: 'downloading', sizeBytes: src.size, transferred: partSize, pct: pct(partSize, src.size), source: src.kind, error: null });
      try {
        if (!haveVerified) await this.deps.download({
          url: src.url,
          destPath: base,
          expectedSize: src.size,
          sha256: src.sha256,
          signal: abort.signal,
          onProgress: ({ transferred }) => {
            this.set(m.id, { transferred, pct: pct(transferred, src.size) }, false);
          },
        });
        finalizing = true;
        await moveFileWithRetry(base, this.filePath(m));
        this.writeMarker(m, src);
        // Partial and finished-but-unmoved files of the other sources are useless now.
        for (const other of m.sources) {
          if (other === src) continue;
          fs.rmSync(`${this.partBase(m, other)}.part`, { force: true });
          fs.rmSync(this.partBase(m, other), { force: true });
        }
        this.set(m.id, { state: 'ready', transferred: src.size, pct: 100, error: null });
        this.deps.log(`[LocalAI] ${m.file} downloaded from ${src.kind} and verified`);
        return 'ok';
      } catch (err) {
        if (abort.signal.aborted && attempt.preempted && !attempt.userAbort) {
          // Stepped aside for a more urgent model; the .part stays and it runs again afterwards.
          this.set(m.id, { state: 'queued' });
          if (!this.queue.includes(m.id)) this.queue.push(m.id);
          return 'paused';
        }
        if (abort.signal.aborted && attempt.userAbort) {
          // A Resume that arrived before this attempt unwound has already queued it again.
          if (!this.queue.includes(m.id)) this.set(m.id, { state: 'paused' });
          return 'paused';
        }
        if (finalizing) {
          // The file is downloaded and verified; only the move into place failed (held by another program).
          // Another source would download a different multi-GB file for nothing: stop and keep the file.
          this.deps.log(`[LocalAI] ${m.file} could not be moved into place: ${String(err)}`);
          lastErr = { code: 'folder_unavailable', message: 'The finished download could not be moved into place (the file is in use). Close other programs using it, then Retry.' };
          break;
        }
        lastErr = err instanceof DownloadError && err.code === 'ABORTED'
          ? { code: 'unknown', message: 'Download cancelled' }
          : classifyDownloadError(err);
        this.deps.log(`[LocalAI] ${m.file} from ${src.kind} failed: ${lastErr.code} ${lastErr.message}`);
        if (lastErr.code === 'disk_full') break;
      } finally {
        if (this.current === attempt) this.current = null;
      }
    }
    // Show what is really on disk: a discarded (checksum) or never-started partial is 0, not the stale 100%.
    const lastSrc = m.sources[m.sources.length - 1];
    const kept = lastSrc ? (() => { try { return fs.statSync(`${this.partBase(m, lastSrc)}.part`).size; } catch { return 0; } })() : 0;
    this.set(m.id, {
      state: 'error', transferred: kept, pct: pct(kept, lastSrc?.size ?? 0),
      error: lastErr ?? { code: 'unknown', message: 'Download failed' },
    });
    return lastErr && (lastErr.code === 'offline' || lastErr.code === 'disk_full' || lastErr.code === 'blocked' || lastErr.code === 'folder_unavailable') ? 'stop' : 'next';
  }

  /** Stop the running download (its `.part` stays) and hold the queue. */
  pause(): void {
    if (!this.running) return;
    this.paused = true;
    const queued = this.queue.splice(0);
    for (const id of queued) this.set(id, { state: 'paused' });
    if (this.current) { this.current.userAbort = true; this.current.abort.abort(); }
  }

  /** Continue paused and failed downloads. */
  resume(): Promise<void> {
    const ids = this.statuses().filter((s) => s.state === 'paused' || s.state === 'error').map((s) => s.id);
    // A paused attempt that is still winding down has not reached 'paused' yet.
    if (this.current?.userAbort && !ids.includes(this.current.id)) ids.push(this.current.id);
    return this.ensure(ids, { resumePaused: true });
  }

  /** "Continue without local AI": stop everything for now (partial files are kept for later). */
  cancelAll(): void {
    this.paused = true;
    for (const id of this.queue.splice(0)) this.set(id, { state: 'missing' });
    const cur = this.current;
    if (cur) { cur.userAbort = true; cur.abort.abort(); }
    if (cur) this.set(cur.id, { state: 'paused' });
  }

  /**
   * Delete every model file, marker and partial download in the folder. A file the system still
   * holds (a server that is just exiting, antivirus) is retried a few times; anything that cannot
   * be deleted is reported once at the end, after everything else was removed.
   */
  async removeAll(): Promise<void> {
    this.cancelAll();
    // Let the aborted attempt unwind first: it must not set 'paused' over our 'missing', nor keep writing
    // into a .part we are deleting.
    await this.running?.catch(() => undefined);
    const dir = this.deps.modelsDir();
    const failed: string[] = [];
    for (const m of this.deps.models()) {
      const paths = [this.filePath(m), this.markerPath(m), ...m.sources.flatMap((src) => [`${this.partBase(m, src)}.part`, this.partBase(m, src)])];
      let allGone = true;
      for (const p of paths) {
        if (!(await this.removeWithRetry(p))) { allGone = false; failed.push(path.basename(p)); }
      }
      if (allGone) this.set(m.id, { state: 'missing', transferred: 0, pct: 0, source: null, error: null });
    }
    this.deps.log(`[LocalAI] removed the models in ${dir}`);
    if (failed.length) {
      // Show what is really on disk before reporting.
      await this.refresh().catch(() => undefined);
      throw new Error(`Some model files are still in use and could not be removed (${failed.join(', ')}). Close other programs using them and try again.`);
    }
  }

  private async removeWithRetry(p: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.rmSync(p, { force: true });
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break;
        await new Promise((r) => setTimeout(r, this.deps.removeRetryDelayMs));
      }
    }
    return false;
  }

  /** Bytes used by model files, markers and partial downloads. */
  diskUsedBytes(): number {
    const dir = this.deps.modelsDir();
    let total = 0;
    for (const m of this.deps.models()) {
      const names = [m.file, ...m.sources.flatMap((s) => [`${path.basename(this.partBase(m, s))}.part`, path.basename(this.partBase(m, s))])];
      for (const n of names) {
        try { total += fs.statSync(path.join(dir, n)).size; } catch { /* absent */ }
      }
    }
    return total;
  }

  /**
   * Move every model file (and partial download) to `newDir`. Downloads must be stopped first.
   * Same volume: rename. Another volume: copy to a temporary name, check the size, then rename it
   * into place; the old files are only deleted by `commit()`, once the new folder is the one in use.
   * On any failure everything already moved is put back, so the folder in use stays whole.
   */
  async beginMove(newDir: string, fromDir: string): Promise<MovePlan> {
    const noop: MovePlan = { commit: async () => undefined, rollback: async () => undefined };
    if (path.resolve(newDir) === path.resolve(fromDir)) return noop;
    await fs.promises.mkdir(newDir, { recursive: true });
    const names = fs.existsSync(fromDir) ? fs.readdirSync(fromDir).filter((n) => this.ownsFile(n)) : [];
    const renamed: Array<{ from: string; to: string }> = [];
    const copied: Array<{ from: string; to: string }> = [];
    let spaceChecked = false;
    const undo = async (): Promise<void> => {
      for (const c of copied) await fs.promises.rm(c.to, { force: true }).catch(() => undefined);
      for (const r of renamed.reverse()) await fs.promises.rename(r.to, r.from).catch(() => undefined);
    };
    try {
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const from = path.join(fromDir, name);
        const to = path.join(newDir, name);
        try {
          await fs.promises.rename(from, to);
          renamed.push({ from, to });
          continue;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
        }
        if (!spaceChecked) {
          spaceChecked = true;
          const remaining = names.slice(i).reduce((sum, n) => {
            try { return sum + fs.statSync(path.join(fromDir, n)).size; } catch { return sum; }
          }, 0);
          const free = this.deps.freeBytes(newDir);
          if (free !== null && free < remaining + DISK_MARGIN_BYTES) {
            throw new Error(`Not enough free space in the new folder: ${Math.ceil((remaining + DISK_MARGIN_BYTES) / 1e8) / 10} GB needed`);
          }
        }
        const tmp = `${to}.moving`;
        try {
          await fs.promises.copyFile(from, tmp);
          const [a, b] = await Promise.all([fs.promises.stat(from), fs.promises.stat(tmp)]);
          if (a.size !== b.size) throw new Error(`The copy of ${name} is incomplete`);
          await fs.promises.rename(tmp, to);
        } catch (err) {
          await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
          throw err;
        }
        copied.push({ from, to });
      }
    } catch (err) {
      await undo();
      throw err;
    }
    return {
      commit: async () => {
        for (const c of copied) {
          if (!(await this.removeWithRetry(c.from))) this.deps.log(`[LocalAI] could not delete the old copy ${c.from}`);
        }
      },
      rollback: undo,
    };
  }

  /** Move and finish in one step (no settings in between). */
  async moveTo(newDir: string, fromDir: string): Promise<void> {
    const plan = await this.beginMove(newDir, fromDir);
    await plan.commit();
  }

  private ownsFile(name: string): boolean {
    return this.deps.models().some((m) => name === m.file || name.startsWith(`${m.file}.`));
  }
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}
