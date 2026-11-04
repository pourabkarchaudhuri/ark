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
import { downloadWithResume, sha256OfFile, DownloadError, type ResumableDownloadOptions } from '../resumable-download.js';
import type { LocalAiRole, ModelEntry, ModelSource } from './manifest.js';

export type ModelState = 'ready' | 'missing' | 'queued' | 'downloading' | 'paused' | 'verifying' | 'error';
export type ModelErrorCode = 'offline' | 'blocked' | 'disk_full' | 'checksum' | 'http' | 'unknown';

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
  if (code === 'CHECKSUM') return { code: 'checksum', message: 'The downloaded file did not match its checksum and was discarded' };
  if (/BLOCKED/i.test(code) || e?.statusCode === 403 || e?.statusCode === 451) {
    return { code: 'blocked', message: 'The download was blocked on this computer or network' };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ETIMEDOUT|fetch failed/i.test(text)) {
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
  private current: { id: string; abort: AbortController } | null = null;
  private paused = false;
  private lastProgressAt = 0;

  constructor(deps: ModelStoreDeps) {
    this.deps = {
      download: downloadWithResume,
      hashFile: sha256OfFile,
      freeBytes: defaultFreeBytes,
      progressIntervalMs: 250,
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
   */
  async refresh(): Promise<ModelStatus[]> {
    for (const m of this.deps.models()) {
      const st = this.status.get(m.id);
      if (st && (st.state === 'downloading' || st.state === 'queued')) continue;
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
      const hash = await this.deps.hashFile(file).catch(() => '');
      const match = m.sources.find((s) => s.sha256 === hash && s.size === stat!.size);
      if (match) {
        this.writeMarker(m, match);
        this.set(m.id, { state: 'ready', sizeBytes: stat.size, transferred: stat.size, pct: 100, source: match.kind, error: null });
      } else {
        this.deps.log(`[LocalAI] ${m.file} does not match any pinned hash; removing it`);
        this.removeFile(m);
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

  /** Queue downloads for `ids` (models already ready are skipped). Resolves when the queue drains. */
  ensure(ids: string[]): Promise<void> {
    this.paused = false;
    for (const id of ids) {
      const st = this.status.get(id);
      if (!st || st.state === 'ready' || this.queue.includes(id) || this.current?.id === id) continue;
      this.queue.push(id);
      this.set(id, { state: 'queued', error: null });
    }
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.paused) {
      const id = this.queue.shift()!;
      const m = this.entry(id);
      if (!m) continue;
      const result = await this.downloadOne(m);
      // Offline / disk full / blocked would fail every remaining file the same way: stop here.
      if (result === 'stop') {
        for (const rest of this.queue.splice(0)) this.set(rest, { state: 'missing' });
        break;
      }
    }
  }

  private async downloadOne(m: ModelEntry): Promise<'ok' | 'next' | 'stop' | 'paused'> {
    fs.mkdirSync(this.deps.modelsDir(), { recursive: true });
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
      const abort = new AbortController();
      this.current = { id: m.id, abort };
      this.set(m.id, { state: 'downloading', sizeBytes: src.size, transferred: partSize, pct: pct(partSize, src.size), source: src.kind, error: null });
      try {
        await this.deps.download({
          url: src.url,
          destPath: base,
          expectedSize: src.size,
          sha256: src.sha256,
          signal: abort.signal,
          onProgress: ({ transferred }) => {
            this.set(m.id, { transferred, pct: pct(transferred, src.size) }, false);
          },
        });
        fs.rmSync(this.filePath(m), { force: true });
        fs.renameSync(base, this.filePath(m));
        this.writeMarker(m, src);
        // Partial files of the other sources are useless now.
        for (const other of m.sources) if (other !== src) fs.rmSync(`${this.partBase(m, other)}.part`, { force: true });
        this.set(m.id, { state: 'ready', transferred: src.size, pct: 100, error: null });
        this.deps.log(`[LocalAI] ${m.file} downloaded from ${src.kind} and verified`);
        return 'ok';
      } catch (err) {
        if (abort.signal.aborted && this.paused) {
          this.set(m.id, { state: 'paused' });
          return 'paused';
        }
        lastErr = err instanceof DownloadError && err.code === 'ABORTED'
          ? { code: 'unknown', message: 'Download cancelled' }
          : classifyDownloadError(err);
        this.deps.log(`[LocalAI] ${m.file} from ${src.kind} failed: ${lastErr.code} ${lastErr.message}`);
        if (lastErr.code === 'disk_full') break;
      } finally {
        this.current = null;
      }
    }
    // Show what is really on disk: a discarded (checksum) or never-started partial is 0, not the stale 100%.
    const lastSrc = m.sources[m.sources.length - 1];
    const kept = lastSrc ? (() => { try { return fs.statSync(`${this.partBase(m, lastSrc)}.part`).size; } catch { return 0; } })() : 0;
    this.set(m.id, {
      state: 'error', transferred: kept, pct: pct(kept, lastSrc?.size ?? 0),
      error: lastErr ?? { code: 'unknown', message: 'Download failed' },
    });
    return lastErr && (lastErr.code === 'offline' || lastErr.code === 'disk_full' || lastErr.code === 'blocked') ? 'stop' : 'next';
  }

  /** Stop the running download (its `.part` stays) and hold the queue. */
  pause(): void {
    if (!this.running) return;
    this.paused = true;
    const queued = this.queue.splice(0);
    for (const id of queued) this.set(id, { state: 'paused' });
    this.current?.abort.abort();
  }

  /** Continue paused and failed downloads. */
  resume(): Promise<void> {
    const ids = this.statuses().filter((s) => s.state === 'paused' || s.state === 'error').map((s) => s.id);
    return this.ensure(ids);
  }

  /** "Continue without local AI": stop everything for now (partial files are kept for later). */
  cancelAll(): void {
    this.paused = true;
    for (const id of this.queue.splice(0)) this.set(id, { state: 'missing' });
    const cur = this.current;
    cur?.abort.abort();
    if (cur) this.set(cur.id, { state: 'paused' });
  }

  /** Delete every model file, marker and partial download in the folder. */
  removeAll(): void {
    this.cancelAll();
    const dir = this.deps.modelsDir();
    for (const m of this.deps.models()) {
      this.removeFile(m);
      for (const src of m.sources) fs.rmSync(`${this.partBase(m, src)}.part`, { force: true });
      this.set(m.id, { state: 'missing', transferred: 0, pct: 0, source: null, error: null });
    }
    this.deps.log(`[LocalAI] removed the models in ${dir}`);
  }

  /** Bytes used by model files, markers and partial downloads. */
  diskUsedBytes(): number {
    const dir = this.deps.modelsDir();
    let total = 0;
    for (const m of this.deps.models()) {
      const names = [m.file, ...m.sources.map((s) => `${path.basename(this.partBase(m, s))}.part`)];
      for (const n of names) {
        try { total += fs.statSync(path.join(dir, n)).size; } catch { /* absent */ }
      }
    }
    return total;
  }

  /**
   * Move every model file (and partial download) to `newDir`. Downloads must be stopped first.
   * Same volume: rename; otherwise copy then delete.
   */
  moveTo(newDir: string, fromDir: string): void {
    fs.mkdirSync(newDir, { recursive: true });
    if (path.resolve(newDir) === path.resolve(fromDir)) return;
    for (const name of fs.existsSync(fromDir) ? fs.readdirSync(fromDir) : []) {
      if (!this.ownsFile(name)) continue;
      const from = path.join(fromDir, name);
      const to = path.join(newDir, name);
      try {
        fs.renameSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
      }
    }
  }

  private ownsFile(name: string): boolean {
    return this.deps.models().some((m) => name === m.file || name.startsWith(`${m.file}.`));
  }
}

function pct(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}
