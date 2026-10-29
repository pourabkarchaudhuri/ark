/**
 * Resumable, checksum-verified file download (the updater's "alternate download").
 *
 * electron-updater fetches the whole installer in one request and cannot resume, so on a flaky
 * connection one drop fails the entire transfer. This downloads to a `.part` file and, after a
 * transient interruption, continues from the bytes already on disk with a standard HTTP Range
 * request. The file is only moved into place once its sha512 matches the release manifest.
 *
 * It is an honest download, not a way around network policy: if the transfer is cut at the same
 * offset twice (a filter blocking the file, not a flaky link) or the request is blocked outright,
 * it stops and the UI points the user to their browser / IT team instead.
 * Network access is injectable so it can be tested against a local server.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';

export interface ResumableDownloadOptions {
  url: string;
  destPath: string;
  /** Expected total size in bytes (from latest.yml). Enables completeness checks. */
  expectedSize?: number;
  /** Expected sha512, base64 (the format used by latest.yml). */
  sha512?: string;
  maxAttempts?: number;
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

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function sha512OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('base64')));
  });
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

/** A request the network or a local filter refused outright — retrying will not help. */
function isBlocked(err: unknown): boolean {
  return /ERR_BLOCKED_BY|BLOCKED_BY_CLIENT|BLOCKED_BY_ADMINISTRATOR/i.test(errorText(err));
}

export async function downloadWithResume(opts: ResumableDownloadOptions): Promise<string> {
  const { url, destPath, expectedSize, sha512, onProgress, signal } = opts;
  const maxAttempts = opts.maxAttempts ?? 6;
  const doFetch = opts.fetchImpl ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const sleep = opts.sleep ?? defaultSleep;
  const partPath = `${destPath}.part`;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let lastError: unknown = null;
  let completed = false;
  // Offset at which the previous attempt was cut, to tell a flaky link from a filter.
  let lastCutOffset: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts && !completed; attempt++) {
    if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'ABORTED' });
    let written = 0;
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
      const res = await doFetch(url, { headers, redirect: 'follow', signal });

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

      const fh = fs.openSync(partPath, resumeAt > 0 ? 'a' : 'w');
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            fs.writeSync(fh, value);
            written += value.length;
            onProgress?.({ transferred: written, total: expectedSize ?? 0 });
          }
        }
      } finally {
        fs.closeSync(fh);
      }

      if (expectedSize && written < expectedSize) {
        throw new DownloadError(`Download ended early (${written}/${expectedSize} bytes)`, { code: 'ECONNRESET' });
      }
      completed = true;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'ABORTED' });
      if (isBlocked(err)) {
        throw new DownloadError('The download was blocked on this computer or network', { code: 'ERR_BLOCKED_BY_CLIENT' });
      }
      const dlErr = err instanceof DownloadError ? err : null;
      const httpStatus = dlErr?.statusCode;
      if (httpStatus && httpStatus !== 416 && httpStatus < 500 && httpStatus !== 429) break; // 4xx: not transient
      const lookupOrTimeout = /ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED|TIMED_OUT|ETIMEDOUT|INTERNET_DISCONNECTED/i.test(errorText(err));
      if (dlErr?.code !== 'RANGE_RESET' && !lookupOrTimeout) {
        // Cut at the same offset twice: a filter, not a flaky link. Stop instead of hammering it.
        if (lastCutOffset !== null && lastCutOffset === written) {
          throw new DownloadError(`The download was cut at the same point twice (${written} bytes)`, { code: 'BLOCKED_AT_OFFSET' });
        }
        lastCutOffset = written;
      }
      if (attempt >= maxAttempts) break;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
    }
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

  fs.rmSync(destPath, { force: true });
  fs.renameSync(partPath, destPath);
  return destPath;
}
