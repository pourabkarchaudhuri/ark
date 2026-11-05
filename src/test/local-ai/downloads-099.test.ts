/** 1.0.99 downloads group: folder errors, captive portal, move retry, offline codes, removeAll race, safe-write orphans. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadWithResume, DownloadError, moveFileWithRetry } from '../../../electron/resumable-download';
import { ModelStore, classifyDownloadError } from '../../../electron/local-ai/model-store';
import type { ModelEntry } from '../../../electron/local-ai/manifest';

const PAYLOAD = crypto.randomBytes(4096);
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-dl099-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

const okFetch = async () => new Response(PAYLOAD, { status: 200 });
const noSleep = async () => {};

function entry(): ModelEntry {
  return {
    id: 'm1', role: 'embed', label: 'M', file: 'm1.gguf', auto: true,
    sources: [{ kind: 'ollama', url: 'http://x/a', sha256: SHA, size: PAYLOAD.length }],
  };
}
function fsErr(code: string, syscall = 'open'): Error {
  return Object.assign(new Error(`${code}: boom`), { code, syscall });
}

describe('local fs errors (finding 0)', () => {
  it('a read-only / denied folder error mid-write is reported as folder_unavailable at once, one request', async () => {
    let calls = 0;
    const err = await downloadWithResume({
      url: 'http://x/a', destPath: path.join(dir, 'f.dl'), expectedSize: PAYLOAD.length, sha256: SHA,
      fetchImpl: async () => {
        calls++;
        const body = new ReadableStream<Uint8Array>({ pull() { throw fsErr('EROFS', 'write'); } });
        return new Response(body, { status: 200 });
      },
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('FOLDER_UNAVAILABLE');
    expect(calls).toBe(1);
    expect(classifyDownloadError(err).code).toBe('folder_unavailable');
  });

  it('an unusable folder path is reported the same way', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const err = await downloadWithResume({
      url: 'http://x/a', destPath: path.join(blocker, 'sub', 'f.dl'), expectedSize: PAYLOAD.length,
      fetchImpl: okFetch, sleep: noSleep,
    }).catch((e) => e);
    expect(err.code).toBe('FOLDER_UNAVAILABLE');
  });

  it('the store stops the queue on a folder error', async () => {
    const store = new ModelStore({
      models: () => [entry()], modelsDir: () => dir, freeBytes: () => null, progressIntervalMs: 0,
      download: async () => { throw new DownloadError('x', { code: 'FOLDER_UNAVAILABLE' }); },
    });
    await store.ensure(['m1']);
    expect(store.statuses()[0].error?.code).toBe('folder_unavailable');
  });
});

describe('captive portal (finding 9)', () => {
  it('rejects an HTML 200 without writing it and leaves no .part', async () => {
    let calls = 0;
    const dest = path.join(dir, 'f.dl');
    const err = await downloadWithResume({
      url: 'http://x/a', destPath: dest, expectedSize: PAYLOAD.length, sha256: SHA,
      fetchImpl: async () => { calls++; return new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }); },
      sleep: noSleep,
    }).catch((e) => e);
    expect(err.code).toBe('PORTAL');
    expect(calls).toBe(1);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    const c = classifyDownloadError(err);
    expect(c.code).toBe('blocked');
    expect(c.message).toMatch(/sign in/i);
  });
});

describe('moving into place (finding 5)', () => {
  it('retries a transient EPERM rename', async () => {
    const src = path.join(dir, 'a.part');
    const dest = path.join(dir, 'a');
    fs.writeFileSync(src, 'x');
    let n = 0;
    const ops = {
      rmSync: fs.rmSync,
      renameSync: (a: string, b: string) => { if (n++ < 2) throw fsErr('EPERM', 'rename'); fs.renameSync(a, b); },
    };
    await moveFileWithRetry(src, dest, 1, 6, ops);
    expect(fs.readFileSync(dest, 'utf8')).toBe('x');
    expect(n).toBe(3);
  });

  it('a failed final move keeps the verified .dl, stops, and the next run reuses it without downloading', async () => {
    const m = entry();
    let downloads = 0;
    const dl = async (o: { destPath: string }) => { downloads++; fs.writeFileSync(o.destPath, PAYLOAD); return o.destPath; };
    const store = new ModelStore({ models: () => [m], modelsDir: () => dir, freeBytes: () => null, progressIntervalMs: 0, download: dl as never });
    // A non-empty folder where the model file belongs makes the final move fail.
    const finalPath = path.join(dir, 'm1.gguf');
    fs.mkdirSync(finalPath);
    fs.writeFileSync(path.join(finalPath, 'x'), 'x');
    await store.ensure(['m1']);
    expect(store.statuses()[0].error?.code).toBe('folder_unavailable');
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.dl'))).toBe(true);
    expect(store.diskUsedBytes()).toBeGreaterThanOrEqual(PAYLOAD.length);
    fs.rmSync(finalPath, { recursive: true, force: true });
    await store.resume();
    expect(store.statuses()[0].state).toBe('ready');
    expect(downloads).toBe(1);
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.dl'))).toBe(false);
  }, 20000);
});

describe('offline classification (finding 11)', () => {
  it.each(['net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_CONNECTION_REFUSED'])('%s is offline', (msg) => {
    expect(classifyDownloadError(new Error(msg)).code).toBe('offline');
  });
});

describe('removeAll waits for the aborted attempt (finding 20)', () => {
  it('does not leave the model paused', async () => {
    const m = entry();
    const dl = (o: { signal?: AbortSignal }) => new Promise<string>((_, rej) => {
      o.signal?.addEventListener('abort', () => setTimeout(() => rej(new DownloadError('Download cancelled', { code: 'ABORTED' })), 30));
    });
    const store = new ModelStore({ models: () => [m], modelsDir: () => dir, freeBytes: () => null, progressIntervalMs: 0, download: dl as never });
    void store.ensure(['m1']);
    await new Promise((r) => setTimeout(r, 20));
    await store.removeAll();
    expect(store.statuses()[0].state).toBe('missing');
  });
});
