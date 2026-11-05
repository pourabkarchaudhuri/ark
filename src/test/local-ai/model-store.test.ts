/**
 * ModelStore against a real local HTTP server: download + sha256 check, resume after a cut
 * connection, checksum failure (file discarded), source fallback, disk-space check, error
 * classification, pause/resume, "ready" markers on later launches, remove and move.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ModelStore, classifyDownloadError, DISK_MARGIN_BYTES } from '../../../electron/local-ai/model-store';
import { DownloadError, downloadWithResume } from '../../../electron/resumable-download';
import type { ModelEntry } from '../../../electron/local-ai/manifest';

const PAYLOAD = crypto.randomBytes(200 * 1024);
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

type Mode = { dropAfter?: number; dropTimes?: number; corrupt?: boolean; status?: number; delayMs?: number };
let mode: Mode = {};
let hits: Array<{ url: string; range?: string }> = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', range: req.headers.range });
    if (mode.status) { res.writeHead(mode.status); res.end(); return; }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    let body = PAYLOAD.subarray(start);
    if (mode.corrupt) body = Buffer.concat([Buffer.from('XX'), body.subarray(2)]);
    const headers: Record<string, string | number> = { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' };
    if (m) { headers['Content-Range'] = `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`; res.writeHead(206, headers); }
    else res.writeHead(200, headers);
    const drop = mode.dropAfter !== undefined && (mode.dropTimes ?? 0) > 0 ? mode.dropAfter : undefined;
    if (drop !== undefined) {
      mode.dropTimes = (mode.dropTimes ?? 1) - 1;
      res.write(body.subarray(0, drop), () => setTimeout(() => res.destroy(), 20));
      return;
    }
    const send = () => res.end(body);
    mode.delayMs ? setTimeout(send, mode.delayMs) : send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-models-'));
  mode = {};
  hits = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function entry(over: Partial<ModelEntry> = {}, sources?: ModelEntry['sources']): ModelEntry {
  return {
    id: 'embed-test', role: 'embed', label: 'Embedder', file: 'embed-test.gguf', auto: true,
    sources: sources ?? [{ kind: 'ollama', url: `${base}/blob`, sha256: SHA, size: PAYLOAD.length }],
    ...over,
  };
}

// Under jsdom the per-attempt AbortController is jsdom's, which Node's fetch rejects (same note as in
// resumable-download.test.ts), so the signal is dropped from the fetch; the store's own abort handling
// still works through the download loop's checks.
const nodeFetch = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: undefined });
const download = (opts: Parameters<typeof downloadWithResume>[0]) => downloadWithResume({ ...opts, fetchImpl: nodeFetch, sleep: async () => {} });

function makeStore(models: ModelEntry[], extra: Partial<ConstructorParameters<typeof ModelStore>[0]> = {}) {
  return new ModelStore({
    models: () => models,
    modelsDir: () => dir,
    freeBytes: () => null,
    progressIntervalMs: 0,
    download,
    ...extra,
  });
}

describe('ModelStore download', () => {
  it('downloads, verifies the sha256 and marks the model ready', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    const st = store.statuses()[0];
    expect(st.state).toBe('ready');
    expect(st.pct).toBe(100);
    expect(st.source).toBe('ollama');
    expect(fs.readFileSync(path.join(dir, 'embed-test.gguf')).equals(PAYLOAD)).toBe(true);
    expect(store.modelPath('embed')).toBe(path.join(dir, 'embed-test.gguf'));
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf.verified.json'))).toBe(true);
  });

  it('reports progress while downloading', async () => {
    const store = makeStore([entry()]);
    const seen: number[] = [];
    store.onChange((all) => { if (all[0].state === 'downloading') seen.push(all[0].pct); });
    await store.ensure(['embed-test']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(100);
  });

  it('resumes after the connection is cut, continuing from the .part file', async () => {
    mode = { dropAfter: 50_000, dropTimes: 1 };
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    expect(store.statuses()[0].state).toBe('ready');
    expect(hits.some((h) => /bytes=\d+-/.test(h.range ?? ''))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'embed-test.gguf')).equals(PAYLOAD)).toBe(true);
  });

  it('discards a file whose checksum does not match and reports a checksum error', async () => {
    mode = { corrupt: true };
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    const st = store.statuses()[0];
    expect(st.state).toBe('error');
    expect(st.error?.code).toBe('checksum');
    // The discarded partial must not leave a stale 100% bar on the error row.
    expect(st.pct).toBe(0);
    expect(st.transferred).toBe(0);
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.part'))).toEqual([]);
    expect(store.modelPath('embed')).toBeNull();
  });

  it('falls back to the second source when the first fails', async () => {
    const store = makeStore([entry({}, [
      { kind: 'ollama', url: `${base}/missing`, sha256: crypto.createHash('sha256').update('x').digest('hex'), size: 10 },
      { kind: 'huggingface', url: `${base}/blob`, sha256: SHA, size: PAYLOAD.length },
    ])], {
      // The first URL is the failing one: serve a 404 for it.
    });
    // 404 for /missing, 200 for /blob.
    const orig = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
      orig(req, res);
    });
    try {
      await store.ensure(['embed-test']);
    } finally {
      server.removeAllListeners('request');
      server.on('request', orig);
    }
    const st = store.statuses()[0];
    expect(st.state).toBe('ready');
    expect(st.source).toBe('huggingface');
  });

  it('does not download a model that is already ready', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    const before = hits.length;
    await store.ensure(['embed-test']);
    expect(hits.length).toBe(before);
  });

  it('refuses to start when the disk has no room, before any byte is requested', async () => {
    const store = makeStore([entry()], { freeBytes: () => PAYLOAD.length + DISK_MARGIN_BYTES - 1 });
    await store.ensure(['embed-test']);
    const st = store.statuses()[0];
    expect(st.state).toBe('error');
    expect(st.error?.code).toBe('disk_full');
    expect(hits).toHaveLength(0);
  });

  it('a 403 is reported as blocked and the queue stops', async () => {
    mode = { status: 403 };
    const second = entry({ id: 'rerank-test', role: 'rerank', file: 'rerank-test.gguf' });
    const store = makeStore([entry(), second]);
    await store.ensure(['embed-test', 'rerank-test']);
    const [a, b] = store.statuses();
    expect(a.error?.code).toBe('blocked');
    expect(b.state).toBe('missing');
  });

  it('pause keeps the partial file and resume finishes the download', async () => {
    mode = { delayMs: 400 };
    const store = makeStore([entry()]);
    const run = store.ensure(['embed-test']);
    await new Promise((r) => setTimeout(r, 80));
    store.pause();
    await run;
    expect(store.statuses()[0].state).toBe('paused');
    mode = {};
    await store.resume();
    expect(store.statuses()[0].state).toBe('ready');
  });

  it('cancelAll ("Continue without local AI") stops and leaves nothing queued', async () => {
    mode = { delayMs: 400 };
    const store = makeStore([entry(), entry({ id: 'b', role: 'rerank', file: 'b.gguf' })]);
    const run = store.ensure(['embed-test', 'b']);
    await new Promise((r) => setTimeout(r, 80));
    store.cancelAll();
    await run;
    expect(store.statuses().some((s) => s.state === 'ready')).toBe(false);
    expect(store.isBusy()).toBe(false);
  });
});

describe('ModelStore on-disk state', () => {
  it('a later launch trusts a verified file without hashing it again', async () => {
    const first = makeStore([entry()]);
    await first.ensure(['embed-test']);
    let hashed = 0;
    const second = makeStore([entry()], { hashFile: async () => { hashed++; return SHA; } });
    await second.refresh();
    expect(second.statuses()[0].state).toBe('ready');
    expect(hashed).toBe(0);
  });

  it('a file without a marker is hashed and accepted when it matches', async () => {
    fs.writeFileSync(path.join(dir, 'embed-test.gguf'), PAYLOAD);
    const store = makeStore([entry()]);
    await store.refresh();
    expect(store.statuses()[0].state).toBe('ready');
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf.verified.json'))).toBe(true);
  });

  it('a file that matches no pinned hash is deleted', async () => {
    fs.writeFileSync(path.join(dir, 'embed-test.gguf'), Buffer.from('garbage'));
    const store = makeStore([entry()]);
    await store.refresh();
    expect(store.statuses()[0].state).toBe('missing');
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(false);
  });

  it('a changed file (size or mtime differs from its marker) is hashed again and rejected', async () => {
    const first = makeStore([entry()]);
    await first.ensure(['embed-test']);
    fs.appendFileSync(path.join(dir, 'embed-test.gguf'), 'tamper');
    const second = makeStore([entry()]);
    await second.refresh();
    expect(second.statuses()[0].state).toBe('missing');
  });

  it('removeAll deletes files, markers and partial downloads', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    fs.writeFileSync(path.join(dir, `embed-test.gguf.${SHA.slice(0, 12)}.dl.part`), 'x');
    await store.removeAll();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(store.statuses()[0].state).toBe('missing');
    expect(store.diskUsedBytes()).toBe(0);
  });

  it('diskUsedBytes counts model files and partial downloads', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    expect(store.diskUsedBytes()).toBe(PAYLOAD.length);
  });

  it('moveTo relocates model files and markers', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-models-new-'));
    try {
      await store.moveTo(other, dir);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf'))).toBe(true);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf.verified.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('ModelStore robustness (1.0.98 F2)', () => {
  const rerank = () => entry({ id: 'rerank-test', role: 'rerank', file: 'rerank-test.gguf' });

  it('a read error while hashing keeps the file instead of deleting a valid model', async () => {
    fs.writeFileSync(path.join(dir, 'embed-test.gguf'), PAYLOAD);
    const store = makeStore([entry()], { hashFile: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
    await store.refresh();
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(true);
    expect(store.statuses()[0].state).toBe('error');
    // The next check succeeds and the same file is accepted.
    const again = makeStore([entry()]);
    await again.refresh();
    expect(again.statuses()[0].state).toBe('ready');
  });

  it('refresh is single-flight: overlapping calls hash a file once', async () => {
    fs.writeFileSync(path.join(dir, 'embed-test.gguf'), PAYLOAD);
    let hashed = 0;
    const store = makeStore([entry()], { hashFile: async () => { hashed++; await new Promise((r) => setTimeout(r, 30)); return SHA; } });
    const [a, b] = [store.refresh(), store.refresh()];
    await Promise.all([a, b]);
    expect(hashed).toBe(1);
    expect(store.statuses()[0].state).toBe('ready');
  });

  it('a refresh that finishes hashing after a download started does not delete the new file or reset its state', async () => {
    fs.writeFileSync(path.join(dir, 'embed-test.gguf'), Buffer.from('old bytes'));
    let release!: (h: string) => void;
    const store = makeStore([entry()], { hashFile: () => new Promise<string>((r) => { release = r; }) });
    const checking = store.refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.statuses()[0].state).toBe('verifying');
    const run = store.ensure(['embed-test']);
    await run;
    expect(store.statuses()[0].state).toBe('ready');
    release('not-a-pinned-hash');
    await checking;
    expect(store.statuses()[0].state).toBe('ready');
    expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(true);
  });

  it('a background ensure does not undo the user\'s Pause; Retry (resume) does', async () => {
    mode = { delayMs: 300 };
    const store = makeStore([entry(), rerank()]);
    const run = store.ensure(['embed-test']);
    await new Promise((r) => setTimeout(r, 60));
    store.pause();
    await run;
    await store.ensure(['embed-test', 'rerank-test']);
    expect(store.isPaused()).toBe(true);
    expect(store.isBusy()).toBe(false);
    expect(store.statuses().map((s) => s.state)).toEqual(['paused', 'paused']);
    mode = {};
    await store.resume();
    expect(store.statuses().map((s) => s.state)).toEqual(['ready', 'ready']);
  });

  it('Resume right after Pause (before the abort unwinds) is not turned into an error', async () => {
    mode = { delayMs: 300 };
    const store = makeStore([entry()]);
    const run = store.ensure(['embed-test']);
    await new Promise((r) => setTimeout(r, 60));
    store.pause();
    mode = {};
    const again = store.resume();
    await Promise.all([run, again]);
    const st = store.statuses()[0];
    expect(st.state).toBe('ready');
    expect(st.error).toBeNull();
  });

  it('an unavailable models folder ends in an error with a code, not a model stuck queued', async () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const store = makeStore([entry(), rerank()], { modelsDir: () => path.join(blocker, 'models') });
    await store.ensure(['embed-test', 'rerank-test']);
    const [a, b] = store.statuses();
    expect(a.state).toBe('error');
    expect(a.error?.code).toBe('folder_unavailable');
    expect(b.state).toBe('missing');
  });

  it('a disk-full failure during the transfer is reported as disk_full and stops the queue', async () => {
    const store = makeStore([entry(), rerank()], {
      download: async () => { throw new DownloadError('ENOSPC: not enough disk space to continue the download', { code: 'ENOSPC' }); },
    });
    await store.ensure(['embed-test', 'rerank-test']);
    const [a, b] = store.statuses();
    expect(a.error?.code).toBe('disk_full');
    expect(b.state).toBe('missing');
  });

  it('whenSettled and priority: a rerank model does not wait for a running chat download', async () => {
    mode = { delayMs: 300 };
    const chat = entry({ id: 'chat-test', role: 'chat', file: 'chat-test.gguf', auto: false });
    const store = makeStore([entry(), rerank(), chat]);
    void store.ensure(['chat-test']);
    await new Promise((r) => setTimeout(r, 60));
    expect(store.statuses()[2].state).toBe('downloading');
    mode = {};
    void store.ensure(['embed-test', 'rerank-test'], { priority: true });
    await store.whenSettled(['embed-test', 'rerank-test']);
    const [a, b, c] = store.statuses();
    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
    expect(c.state).not.toBe('ready');
    await store.whenSettled(['chat-test']);
    expect(store.statuses()[2].state).toBe('ready');
  });

  it('priority also moves models that were already waiting behind a running chat download', async () => {
    mode = { delayMs: 300 };
    const chat = entry({ id: 'chat-test', role: 'chat', file: 'chat-test.gguf', auto: false });
    const store = makeStore([entry(), rerank(), chat]);
    void store.ensure(['chat-test', 'embed-test']);
    await new Promise((r) => setTimeout(r, 60));
    expect(store.statuses()[2].state).toBe('downloading');
    mode = {};
    void store.ensure(['embed-test'], { priority: true });
    await store.whenSettled(['embed-test']);
    expect(store.statuses()[0].state).toBe('ready');
    expect(store.statuses()[2].state).not.toBe('ready');
    await store.whenSettled(['chat-test']);
  });

  it('a move that fails midway puts every file back and leaves the old folder whole', async () => {
    const second = rerank();
    const store = makeStore([entry(), second]);
    await store.ensure(['embed-test', 'rerank-test']);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-models-new-'));
    try {
      // A directory where the second file must go makes that rename fail after the first one succeeded.
      fs.mkdirSync(path.join(other, 'rerank-test.gguf'));
      await expect(store.beginMove(other, dir)).rejects.toThrow();
      expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'embed-test.gguf.verified.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'rerank-test.gguf'))).toBe(true);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a rolled-back move restores the files', async () => {
    const store = makeStore([entry()]);
    await store.ensure(['embed-test']);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-models-new-'));
    try {
      const plan = await store.beginMove(other, dir);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf'))).toBe(true);
      await plan.rollback();
      expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(true);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('removeAll reports a file that stays locked after the rest were removed', async () => {
    const store = makeStore([entry(), rerank()], { removeRetryDelayMs: 1 });
    await store.ensure(['embed-test', 'rerank-test']);
    // A directory with the file's name cannot be removed by a file delete (EISDIR/EPERM).
    fs.rmSync(path.join(dir, 'embed-test.gguf'));
    fs.mkdirSync(path.join(dir, 'embed-test.gguf'));
    fs.writeFileSync(path.join(dir, 'embed-test.gguf', 'x'), 'x');
    await expect(store.removeAll()).rejects.toThrow(/could not be removed/);
    expect(fs.existsSync(path.join(dir, 'rerank-test.gguf'))).toBe(false);
  });
});

describe('classifyDownloadError', () => {
  it('maps failures to the codes the UI explains', () => {
    expect(classifyDownloadError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code).toBe('disk_full');
    expect(classifyDownloadError(new DownloadError('bad', { code: 'CHECKSUM' })).code).toBe('checksum');
    expect(classifyDownloadError(Object.assign(new Error('x'), { statusCode: 451 })).code).toBe('blocked');
    expect(classifyDownloadError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code).toBe('offline');
    expect(classifyDownloadError(Object.assign(new Error('x'), { statusCode: 500 })).code).toBe('http');
    expect(classifyDownloadError(new DownloadError('x', { code: 'ENOSPC' })).code).toBe('disk_full');
    expect(classifyDownloadError(new DownloadError('x', { code: 'OVERSIZE' })).code).toBe('checksum');
    expect(classifyDownloadError(new Error('weird')).code).toBe('unknown');
  });
});
