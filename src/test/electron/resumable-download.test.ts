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
import { downloadWithResume, DownloadError } from '../../../electron/resumable-download';

const PAYLOAD = crypto.randomBytes(256 * 1024);
const SHA = crypto.createHash('sha512').update(PAYLOAD).digest('base64');

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
const run = (over: Partial<Parameters<typeof downloadWithResume>[0]> = {}) =>
  downloadWithResume({
    url: `${base}/Ark-Setup.exe`,
    destPath: path.join(dir, 'Ark-Setup.exe'),
    expectedSize: PAYLOAD.length,
    sha512: SHA,
    sleep: noSleep,
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
