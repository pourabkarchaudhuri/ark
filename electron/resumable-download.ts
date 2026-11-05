/**
 * Resumable, checksum-verified file download (the updater's "alternate download").
 *
 * electron-updater fetches the whole installer in one request and cannot resume, so on a flaky
 * connection one drop fails the entire transfer. This downloads to a `.part` file and, after a
 * transient interruption, continues from the bytes already on disk with a standard HTTP Range
 * request. The file is only moved into place once its sha512 matches the release manifest.
 * A connection that stops sending data (no bytes for `idleTimeoutMs`) is treated the same way.
 *
 * It is an honest download, not a way around network policy: if the transfer is cut at the same
 * offset twice (a filter blocking the file, not a flaky link) or the request is blocked outright,
 * it stops and the UI points the user to their browser / IT team instead.
 * Network access is injectable so it can be tested against a local server.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/**
 * Default network call. Inside the Electron main process this is Chromium's network stack (`net.fetch`), which
 * trusts the Windows certificate store, follows the system proxy and does what the user's browser does. Node's
 * own `fetch` (undici, bundled CA list only) fails with SELF_SIGNED_CERT_IN_CHAIN behind a TLS-inspecting
 * corporate proxy, so the built-in AI model download and the installer fallback could not start there (found
 * by the 1.0.97 packaged-app smoke test). Plain Node (tests, scripts) keeps the global fetch.
 */
function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    if (process.versions.electron) {
      const { app, net } = nodeRequire('electron') as typeof import('electron');
      if (net?.fetch && app?.isReady?.()) return net.fetch(url, init as Parameters<typeof net.fetch>[1]) as unknown as Promise<Response>;
    }
  } catch { /* fall through to the global fetch */ }
  return fetch(url, init);
}

export interface ResumableDownloadOptions {
  url: string;
  destPath: string;
  /** Expected total size in bytes (from latest.yml). Enables completeness checks. */
  expectedSize?: number;
  /** Expected sha512, base64 (the format used by latest.yml). */
  sha512?: string;
  /** Expected sha256, lower-case hex (model files pinned in the local-AI manifest). */
  sha256?: string;
  maxAttempts?: number;
  /** An attempt that receives no bytes for this long is abandoned and resumed. Default 60s. */
  idleTimeoutMs?: number;
  onProgress?: (p: { transferred: number; total: number }) => void;
  signal?: AbortSignal;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export class DownloadError extends Error {
  code?: string;
  statusCode?: number;
  constructor(message: string, extra: { code?: string; statusCode?: number } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = extra.code;
    this.statusCode = extra.statusCode;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A backoff wait that ends the moment the caller cancels (Pause must not sit out a 15 s backoff). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return defaultSleep(ms);
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Write the whole chunk: `writeSync` may write less than asked. */
function writeAll(fh: number, chunk: Uint8Array): void {
  let off = 0;
  while (off < chunk.length) off += fs.writeSync(fh, chunk, off, chunk.length - off);
}

/** Disk full (or over quota): retrying cannot help and must be reported as such. */
function isDiskFull(err: unknown): boolean {
  return /ENOSPC|EDQUOT/.test(String((err as { code?: unknown } | null)?.code ?? ''));
}

/** The models folder / disk itself is the problem (read-only, permission denied, drive gone): retrying cannot help. */
const LOCAL_FS_CODES = /^(EACCES|EPERM|EROFS|ENOENT|EIO|ENODEV|ENAMETOOLONG|EBUSY|ENOTDIR|EISDIR|EMFILE|ENXIO|EEXIST)$/;
function isLocalFsError(err: unknown): boolean {
  if (err instanceof DownloadError) return false;
  const e = err as { code?: unknown; syscall?: unknown } | null;
  return typeof e?.code === 'string' && typeof e?.syscall === 'string' && LOCAL_FS_CODES.test(e.code);
}

function isTransientMoveError(err: unknown): boolean {
  return /^(EPERM|EBUSY|EACCES)$/.test(String((err as { code?: unknown } | null)?.code ?? ''));
}

/**
 * Replace `dest` with `src`, retrying a few times when Windows (antivirus, a sync client, a process that has
 * the old file open) holds either file for a moment. Throws the last error when it never lets go.
 */
export async function moveFileWithRetry(
  src: string,
  dest: string,
  delayMs = 150,
  tries = 6,
  ops: { rmSync: typeof fs.rmSync; renameSync: typeof fs.renameSync } = fs,
): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      ops.rmSync(dest, { force: true });
      ops.renameSync(src, dest);
      return;
    } catch (err) {
      if (i >= tries || !isTransientMoveError(err)) throw err;
      await defaultSleep(delayMs * i);
    }
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function hashOfFile(filePath: string, algo: 'sha512' | 'sha256', encoding: 'base64' | 'hex'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest(encoding)));
  });
}

export function sha512OfFile(filePath: string): Promise<string> {
  return hashOfFile(filePath, 'sha512', 'base64');
}

export function sha256OfFile(filePath: string): Promise<string> {
  return hashOfFile(filePath, 'sha256', 'hex');
}

/** Start byte of a "Content-Range: bytes 100-199/200" header, or null. */
function contentRangeStart(res: Response): number | null {
  const m = /bytes\s+(\d+)-/.exec(res.headers.get('content-range') ?? '');
  return m ? Number(m[1]) : null;
}

function errorText(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  return [e?.code, e?.message, e?.cause?.code, e?.cause?.message].filter((x) => typeof x === 'string').join(' ');
}

function dlErrCode(err: unknown): string | undefined {
  return err instanceof DownloadError ? err.code : undefined;
}

/** A request the network or a local filter refused outright — retrying will not help. */
function isBlocked(err: unknown): boolean {
  return /ERR_BLOCKED_BY|BLOCKED_BY_CLIENT|BLOCKED_BY_ADMINISTRATOR/i.test(errorText(err));
}

export async function downloadWithResume(opts: ResumableDownloadOptions): Promise<string> {
  const { url, destPath, expectedSize, sha512, sha256, onProgress, signal } = opts;
  const maxAttempts = opts.maxAttempts ?? 6;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const partPath = `${destPath}.part`;

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  } catch (err) {
    if (isLocalFsError(err)) throw new DownloadError(`The models folder is not available (${(err as { code: string }).code})`, { code: 'FOLDER_UNAVAILABLE' });
    throw err;
  }

  let lastError: unknown = null;
  let completed = false;
  // Offset at which the previous attempt was cut, to tell a flaky link from a filter.
  let lastCutOffset: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts && !completed; attempt++) {
    if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'ABORTED' });
    let written = 0;
    // Only an attempt that got a successful response counts toward the same-offset stop:
    // 5xx/429 and errors before any response say nothing about a filter cutting the file.
    let responded = false;
    // reader.read() can wait forever on a stalled connection, so each attempt has its own abort
    // (linked to the caller's signal) and an idle timer that is reset by every chunk.
    let stalled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const attemptAbort = new AbortController();
    const abortAttempt = () => {
      attemptAbort.abort();
      reader?.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', abortAttempt);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        abortAttempt();
      }, idleTimeoutMs);
    };
    let fh: number | null = null;
    let backoffMs = 0;
    try {
      let existing = fileSize(partPath);
      if (expectedSize && existing > expectedSize) {
        fs.rmSync(partPath, { force: true });
        existing = 0;
      }
      if (expectedSize && existing === expectedSize) {
        completed = true;
        break;
      }
      written = existing;

      const headers: Record<string, string> = {};
      if (existing > 0) headers.Range = `bytes=${existing}-`;
      armIdle();
      const res = await doFetch(url, { headers, redirect: 'follow', signal: attemptAbort.signal });
      // Stalled (or cancelled) before the response arrived, from a fetch that ignored the signal.
      if (attemptAbort.signal.aborted) throw new DownloadError('Download interrupted', { code: 'ABORTED' });

      if (res.status === 416) {
        // The partial is not a prefix the server recognises: start over.
        fs.rmSync(partPath, { force: true });
        written = 0;
        throw new DownloadError('Server rejected the resume range; restarting', { code: 'RANGE_RESET', statusCode: 416 });
      }
      if (!res.ok || !res.body) {
        throw new DownloadError(`HTTP ${res.status} while downloading update`, { statusCode: res.status });
      }

      // 200 = the server ignored Range (sends the whole file); 206 must continue exactly where we stopped.
      let resumeAt = existing;
      if (existing > 0 && (res.status !== 206 || contentRangeStart(res) !== existing)) {
        fs.rmSync(partPath, { force: true });
        resumeAt = 0;
      }
      written = resumeAt;
      responded = true;

      // A captive portal / proxy login page answers 200 with HTML: never write it into the .part, or a later
      // Range resume would glue the real file behind it and fail the checksum after the full transfer.
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (expectedSize && /^(text\/html|application\/json|application\/xhtml)/.test(contentType)) {
        fs.rmSync(partPath, { force: true });
        written = 0;
        throw new DownloadError('The network answered with a web page instead of the file (sign-in required?)', { code: 'PORTAL' });
      }

      // A response that already says it is larger than the pinned size is the wrong file: do not write it.
      const declared = Number(res.headers.get('content-length'));
      if (expectedSize && Number.isFinite(declared) && declared > 0 && resumeAt + declared > expectedSize) {
        fs.rmSync(partPath, { force: true });
        throw new DownloadError(`The server announced more data than expected (${resumeAt + declared}/${expectedSize} bytes)`, { code: 'OVERSIZE' });
      }

      fh = fs.openSync(partPath, resumeAt > 0 ? 'a' : 'w');
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          armIdle();
          // Never write past the pinned size: an endless or wrong-file stream must not fill the disk.
          if (expectedSize && written + value.length > expectedSize) {
            fs.closeSync(fh);
            fh = null;
            fs.rmSync(partPath, { force: true });
            throw new DownloadError(`The download is larger than expected (more than ${expectedSize} bytes)`, { code: 'OVERSIZE' });
          }
          writeAll(fh, value);
          written += value.length;
          onProgress?.({ transferred: written, total: expectedSize ?? 0 });
        }
      }
      // A cancelled reader ends with done=true; without a known size that would look complete.
      if (stalled) throw new DownloadError('Download stalled', { code: 'ETIMEDOUT' });

      if (expectedSize && written < expectedSize) {
        throw new DownloadError(`Download ended early (${written}/${expectedSize} bytes)`, { code: 'ECONNRESET' });
      }
      completed = true;
    } catch (caught) {
      // The caller's cancel wins over a stall that fired at the same time.
      if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'ABORTED' });
      const err = stalled
        ? new DownloadError(`Download stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`, { code: 'ETIMEDOUT' })
        : caught;
      lastError = err;
      if (isDiskFull(err)) {
        // Not a flaky link and not a filter: stop now with the code the UI maps to "not enough disk space".
        throw new DownloadError('ENOSPC: not enough disk space to continue the download', { code: 'ENOSPC' });
      }
      if (isLocalFsError(err)) {
        // Read-only / missing / denied folder: say so at once, not "blocked on this network" after two more requests.
        throw new DownloadError(`The models folder is not writable (${(err as { code: string }).code})`, { code: 'FOLDER_UNAVAILABLE' });
      }
      if (dlErrCode(err) === 'OVERSIZE' || dlErrCode(err) === 'PORTAL') break; // the wrong file / a login page: another attempt would be the same
      if (isBlocked(err)) {
        throw new DownloadError('The download was blocked on this computer or network', { code: 'ERR_BLOCKED_BY_CLIENT' });
      }
      const dlErr = err instanceof DownloadError ? err : null;
      const httpStatus = dlErr?.statusCode;
      if (httpStatus && httpStatus !== 416 && httpStatus < 500 && httpStatus !== 429) break; // 4xx: not transient
      const lookupOrTimeout = /ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED|TIMED_OUT|ETIMEDOUT|INTERNET_DISCONNECTED/i.test(errorText(err));
      if (responded && dlErr?.code !== 'RANGE_RESET' && !lookupOrTimeout) {
        // Cut at the same offset twice: a filter, not a flaky link. Stop instead of hammering it.
        if (lastCutOffset !== null && lastCutOffset === written) {
          throw new DownloadError(`The download was cut at the same point twice (${written} bytes)`, { code: 'BLOCKED_AT_OFFSET' });
        }
        lastCutOffset = written;
      }
      if (attempt >= maxAttempts) break;
      backoffMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', abortAttempt);
      // Releases the connection after a throw mid-transfer (e.g. a failed write); a no-op once done.
      reader?.cancel().catch(() => undefined);
      if (fh !== null) fs.closeSync(fh);
    }
    // Back off only after this attempt's file handle and connection are released.
    if (backoffMs) await sleep(backoffMs);
  }

  if (!completed) {
    throw lastError instanceof Error ? lastError : new DownloadError(String(lastError ?? 'Download failed'));
  }

  if (sha512) {
    const actual = await sha512OfFile(partPath);
    if (actual !== sha512) {
      fs.rmSync(partPath, { force: true });
      throw new DownloadError('sha512 checksum mismatch: the downloaded installer was discarded', { code: 'CHECKSUM' });
    }
  }
  if (sha256) {
    const actual = await sha256OfFile(partPath);
    if (actual !== sha256.toLowerCase()) {
      fs.rmSync(partPath, { force: true });
      throw new DownloadError('sha256 checksum mismatch: the downloaded file was discarded', { code: 'CHECKSUM' });
    }
  }

  await moveFileWithRetry(partPath, destPath);
  return destPath;
}
