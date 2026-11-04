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
    store.removeAll();
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
      store.moveTo(other, dir);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf'))).toBe(true);
      expect(fs.existsSync(path.join(other, 'embed-test.gguf.verified.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'embed-test.gguf'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('classifyDownloadError', () => {
  it('maps failures to the codes the UI explains', () => {
    expect(classifyDownloadError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code).toBe('disk_full');
    expect(classifyDownloadError(new DownloadError('bad', { code: 'CHECKSUM' })).code).toBe('checksum');
    expect(classifyDownloadError(Object.assign(new Error('x'), { statusCode: 451 })).code).toBe('blocked');
    expect(classifyDownloadError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code).toBe('offline');
    expect(classifyDownloadError(Object.assign(new Error('x'), { statusCode: 500 })).code).toBe('http');
    expect(classifyDownloadError(new Error('weird')).code).toBe('unknown');
  });
});
