/**
 * downloadWithResume against a real local HTTP server: resume after a dropped connection, servers
 * that ignore Range, 416, checksum failure, and the "cut at the same offset twice" stop rule.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import { downloadWithResume, DownloadError } from '../../../electron/resumable-download';

const PAYLOAD = crypto.randomBytes(256 * 1024);
const SHA = crypto.createHash('sha512').update(PAYLOAD).digest('base64');
const SHA256 = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

type Mode = {
  /** Destroy the socket after sending this many body bytes, for the first `dropTimes` requests. */
  dropAfter?: number;
  dropTimes?: number;
  /** Always destroy at this absolute offset (a "filter" that cuts at the same point). */
  cutAtOffset?: number;
  ignoreRange?: boolean;
  status?: number;
};

let mode: Mode = {};
let requests: Array<{ range?: string }> = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range });
    if (mode.status) {
      res.writeHead(mode.status);
      res.end();
      return;
    }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    let start = 0;
    if (m && !mode.ignoreRange) {
      start = Number(m[1]);
      if (start >= PAYLOAD.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
        'content-length': String(PAYLOAD.length - start),
      });
    } else {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
    }
    const body = PAYLOAD.subarray(start);
    let limit = body.length;
    if (mode.cutAtOffset !== undefined && start <= mode.cutAtOffset) limit = mode.cutAtOffset - start;
    else if (mode.dropAfter !== undefined && (mode.dropTimes ?? 0) > 0) {
      mode.dropTimes = (mode.dropTimes ?? 0) - 1;
      limit = Math.min(limit, mode.dropAfter);
    }
    if (limit < body.length) {
      res.write(body.subarray(0, limit), () => setTimeout(() => res.socket?.destroy(), 20));
    } else {
      res.end(body);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir = '';
beforeEach(() => {
  mode = {};
  requests = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-dl-'));
});

const noSleep = async () => {};
// Under jsdom the per-attempt AbortController is jsdom's, which Node's fetch rejects; the real
// server tests do not abort mid-request, so the signal is dropped here (Electron's fetch takes it).
const nodeFetch = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined });
const run = (over: Partial<Parameters<typeof downloadWithResume>[0]> = {}) =>
  downloadWithResume({
    url: `${base}/Ark-Setup.exe`,
    destPath: path.join(dir, 'Ark-Setup.exe'),
    expectedSize: PAYLOAD.length,
    sha512: SHA,
    sleep: noSleep,
    fetchImpl: nodeFetch,
    ...over,
  });

describe('downloadWithResume', () => {
  it('downloads and verifies a file in one go', async () => {
    const out = await run();
    expect(fs.readFileSync(out).equals(PAYLOAD)).toBe(true);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('resumes with a Range request after the connection drops at different points', async () => {
    mode = { dropAfter: 64 * 1024, dropTimes: 2 };
    const out = await run();
    expect(fs.readFileSync(out).equals(PAYLOAD)).toBe(true);
    expect(requests[0].range).toBeUndefined();
    expect(requests[1].range).toBe('bytes=65536-');
    expect(requests[2].range).toBe('bytes=131072-');
  });

  it('restarts from zero when the server ignores Range (200 instead of 206)', async () => {
    mode = { dropAfter: 64 * 1024, dropTimes: 1, ignoreRange: true };
    const out = await run();
    expect(fs.readFileSync(out).equals(PAYLOAD)).toBe(true);
  });

  it('stops (instead of hammering) when the transfer is cut at the same offset twice', async () => {
    // A filter that resets the installer as soon as it starts: every attempt ends at byte 0.
    mode = { cutAtOffset: 0 };
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('BLOCKED_AT_OFFSET');
    expect(requests.length).toBeLessThanOrEqual(3);
  });

  it('discards the file on a checksum mismatch', async () => {
    const err = await run({ sha512: 'not-the-hash' }).catch((e) => e);
    expect(err.message).toMatch(/sha512/);
    expect(fs.existsSync(path.join(dir, 'Ark-Setup.exe'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'Ark-Setup.exe.part'))).toBe(false);
  });

  it('verifies a pinned sha256 (model files) and accepts a matching one, upper or lower case', async () => {
    const ok = await run({ sha512: undefined, sha256: SHA256 });
    expect(fs.readFileSync(ok).equals(PAYLOAD)).toBe(true);
    const upper = await run({ sha512: undefined, sha256: SHA256.toUpperCase() });
    expect(fs.readFileSync(upper).equals(PAYLOAD)).toBe(true);
  });

  it('discards the file on a sha256 mismatch with the CHECKSUM code', async () => {
    const err = await run({ sha512: undefined, sha256: '0'.repeat(64) }).catch((e) => e);
    expect(err.code).toBe('CHECKSUM');
    expect(err.message).toMatch(/sha256/);
    expect(fs.existsSync(path.join(dir, 'Ark-Setup.exe'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'Ark-Setup.exe.part'))).toBe(false);
  });

  it('does not retry a 404', async () => {
    mode = { status: 404 };
    const err = await run().catch((e) => e);
    expect(err.statusCode).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it('recovers from a stale over-long partial (416) by starting over', async () => {
    fs.writeFileSync(path.join(dir, 'Ark-Setup.exe.part'), Buffer.alloc(PAYLOAD.length - 10));
    // Corrupt partial: same length as a valid prefix but wrong bytes → hash check catches it.
    const err = await run().catch((e) => e);
    expect(err.message).toMatch(/sha512/);
    // A partial longer than the file is dropped and the whole file fetched.
    fs.writeFileSync(path.join(dir, 'Ark-Setup.exe.part'), Buffer.alloc(PAYLOAD.length + 5));
    const out = await run();
    expect(fs.readFileSync(out).equals(PAYLOAD)).toBe(true);
  });

  it('a blocked request stops immediately with a clear code', async () => {
    const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_BLOCKED_BY_CLIENT' } }); };
    const err = await run({ fetchImpl: fetchImpl as never }).catch((e) => e);
    expect(err.code).toBe('ERR_BLOCKED_BY_CLIENT');
  });

  it('honours an abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await run({ signal: ac.signal }).catch((e) => e);
    expect(err.code).toBe('ABORTED');
  });
});

/**
 * Fake-fetch scenarios: stalled bodies (idle timeout), errors before any response, and a failure
 * inside the write loop. A stalled stream never settles a read on its own, so only the idle timer
 * (or a cancel) can get the loop out of it.
 */
describe('downloadWithResume: stalls and failures that are not a filter', () => {
  const SMALL = crypto.randomBytes(8 * 1024);
  const SMALL_SHA = crypto.createHash('sha512').update(SMALL).digest('base64');

  type Call = { range?: string; signal?: AbortSignal };
  type Step = 'stall-after-half' | 'ok' | '503' | 'refused';

  /** A body that sends `bytes` and then either ends or hangs until cancelled. */
  function body(bytes: Uint8Array, hang: boolean, onCancel?: () => void) {
    return new WebReadableStream<Uint8Array>({
      start(c) {
        if (bytes.length) c.enqueue(bytes);
        if (!hang) c.close();
      },
      cancel() {
        onCancel?.();
      },
    });
  }

  /** Fake server for SMALL that honours Range; `plan[n]` decides how request n behaves. */
  function fakeFetch(plan: Step[], calls: Call[], onCancel?: () => void) {
    return async (_u: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      calls.push({ range, signal: init?.signal ?? undefined });
      const step = plan[calls.length - 1] ?? 'ok';
      if (step === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (step === '503') return new Response(null, { status: 503 });
      const start = Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
      const rest = SMALL.subarray(start);
      const headers: Record<string, string> = start
        ? { 'content-range': `bytes ${start}-${SMALL.length - 1}/${SMALL.length}` }
        : {};
      const chunk = step === 'stall-after-half' ? rest.subarray(0, Math.max(0, SMALL.length / 2 - start)) : rest;
      return new Response(body(chunk, step === 'stall-after-half', onCancel) as unknown as ReadableStream, {
        status: start ? 206 : 200,
        headers,
      });
    };
  }

  const runSmall = (over: Partial<Parameters<typeof downloadWithResume>[0]>) =>
    downloadWithResume({
      url: 'https://github.com/x/Ark-Setup.exe',
      destPath: path.join(dir, 'Ark-Setup.exe'),
      expectedSize: SMALL.length,
      sha512: SMALL_SHA,
      sleep: noSleep,
      idleTimeoutMs: 60,
      ...over,
    });

  it('a body that stops sending is abandoned after idleTimeoutMs and resumed from the .part offset', async () => {
    const calls: Call[] = [];
    let cancelled = 0;
    const out = await runSmall({ fetchImpl: fakeFetch(['stall-after-half', 'ok'], calls, () => cancelled++) });
    expect(fs.readFileSync(out).equals(SMALL)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].range).toBe(`bytes=${SMALL.length / 2}-`);
    expect(cancelled).toBe(1);
    // The stalled request's own signal was aborted; the caller's signal is untouched.
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('a stall without a known size is not mistaken for a finished download', async () => {
    const calls: Call[] = [];
    const out = await runSmall({ expectedSize: undefined, fetchImpl: fakeFetch(['stall-after-half', 'ok'], calls) });
    expect(fs.readFileSync(out).equals(SMALL)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a stall that repeats at the same offset keeps retrying instead of reporting a filter', async () => {
    const calls: Call[] = [];
    const out = await runSmall({ fetchImpl: fakeFetch(['stall-after-half', 'stall-after-half', 'stall-after-half', 'ok'], calls) });
    expect(fs.readFileSync(out).equals(SMALL)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('a user cancel during a stall is reported as cancelled, not retried', async () => {
    const calls: Call[] = [];
    const ac = new AbortController();
    const p = runSmall({ idleTimeoutMs: 10_000, signal: ac.signal, fetchImpl: fakeFetch(['stall-after-half', 'ok'], calls) });
    setTimeout(() => ac.abort(), 30);
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('ABORTED');
    expect(calls).toHaveLength(1);
  });

  it('an error thrown inside the write loop cancels the reader', async () => {
    const calls: Call[] = [];
    let cancelled = 0;
    // Same code path as a failing fs.writeSync (disk full): a throw between two reads.
    const onProgress = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const err = await runSmall({ maxAttempts: 1, onProgress, fetchImpl: fakeFetch(['stall-after-half'], calls, () => cancelled++) })
      .catch((e) => e);
    expect(err.message).toMatch(/ENOSPC/);
    expect(cancelled).toBe(1);
  });

  it('repeated 5xx responses at the same offset are retried, not reported as blocked', async () => {
    const calls: Call[] = [];
    const out = await runSmall({ fetchImpl: fakeFetch(['503', '503', '503', 'ok'], calls) });
    expect(fs.readFileSync(out).equals(SMALL)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('repeated connection-setup errors are retried, not reported as blocked', async () => {
    const calls: Call[] = [];
    const out = await runSmall({ fetchImpl: fakeFetch(['refused', 'refused', 'ok'], calls) });
    expect(fs.readFileSync(out).equals(SMALL)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('a 5xx on every attempt surfaces as the HTTP error, not BLOCKED_AT_OFFSET', async () => {
    const calls: Call[] = [];
    const err = await runSmall({ maxAttempts: 3, fetchImpl: fakeFetch(['503', '503', '503'], calls) }).catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.code).not.toBe('BLOCKED_AT_OFFSET');
    expect(calls).toHaveLength(3);
  });
});
