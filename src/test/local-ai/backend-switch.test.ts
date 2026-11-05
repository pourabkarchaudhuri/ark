/**
 * Backend selection and dispatch (1.0.97 B36): the built-in runtime is the default, the user's own
 * Ollama is an advanced switch, and each former Ollama entry point (health, embeddings, GPU probe,
 * unload, model info, reranker tiers, setup) goes to the right one without touching the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  local: { useExternalOllama: false, modelsDir: null as string | null },
  legacyStore: false,
  httpCalls: [] as string[],
}));

vi.mock('http', () => {
  const { EventEmitter } = require('node:events');
  const request = (opts: { path: string }) => {
    h.httpCalls.push(opts.path);
    const req = Object.assign(new EventEmitter(), { write: () => {}, end: () => setTimeout(() => req.emit('error', new Error('http blocked in test')), 0), destroy: () => {} });
    return req;
  };
  const get = (opts: { path: string }) => {
    h.httpCalls.push(opts.path);
    const req = Object.assign(new EventEmitter(), { destroy: () => {} });
    setTimeout(() => req.emit('error', new Error('http blocked in test')), 0);
    return req;
  };
  return { request, get, default: { request, get } };
});

vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'getLocalAiSettings') return h.legacyStore ? undefined : () => h.local;
      if (prop === 'getOllamaSettings') return () => ({ url: 'http://127.0.0.1:11434', embeddingBatchSize: 0, rerankModel: '', rerankQwenModel: '' });
      return undefined;
    },
  }),
  DEFAULT_OLLAMA_RERANK_MODEL: 'dengcao/bge-reranker-v2-m3',
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL: 'dengcao/Qwen3-Reranker-0.6B:Q8_0',
}));
vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getBackendKind, useBuiltinBackend, __setBuiltinBackendForTests } from '../../../electron/local-ai/backend';
import { __setLocalAiServiceForTests } from '../../../electron/local-ai/service';
import type { BuiltinBackend } from '../../../electron/local-ai/builtin-backend';
import {
  isOllamaRunning, generateEmbeddingsBatchDetailed, unloadArkModels, getEmbeddingModelInfo, getEmbeddingModelSize,
  runOllamaSetup, detectGpuMode, resetGpuModeCache, declineBuiltinAutoDownload, allowBuiltinAutoDownload, ensureRerankModelPull, startBuiltinModelDownloadsAndNotify, onBuiltinModelsSettled,
} from '../../../electron/ollama-setup';
import { detectRerankTier, resetRerankTierCache } from '../../../electron/rerank-engine';

function fakeBackend(over: Partial<Record<string, unknown>> = {}) {
  const ready = new Set<string>(['embed', 'rerank', 'rerank-qwen']);
  const failed = new Set<string>();
  const backend = {
    kind: 'builtin',
    health: vi.fn(() => ({ running: true, version: 'b11780' })),
    embed: vi.fn(async (texts: string[]) => ({ embeddings: texts.map(() => [0.1, 0.2]), error: null })),
    gpuReading: vi.fn(() => ({ loaded: true, sizeBytes: 100, vramBytes: 100 })),
    unloadAll: vi.fn(async () => ['embed', 'rerank']),
    embeddingModelInfo: vi.fn(() => ({ name: 'arctic-embed2', installed: true, sizeBytes: 1160285024, parameterSize: '568M', quantization: 'F16' })),
    isModelReady: vi.fn((role: string) => ready.has(role)),
    runtime: { roleStatus: vi.fn((role: string) => ({ state: failed.has(role) ? 'failed' : 'ready' })) },
    ...over,
  };
  return { backend, ready, failed, asBackend: backend as unknown as BuiltinBackend };
}

function fakeService(opts: { readyIds?: string[]; embedReady?: boolean } = {}) {
  const states = new Map<string, string>([
    ['arctic-embed2', opts.embedReady === false ? 'missing' : 'ready'],
    ['bge-reranker-v2-m3', 'missing'],
    ['qwen3-reranker-0.6b', 'missing'],
  ]);
  for (const id of opts.readyIds ?? []) states.set(id, 'ready');
  const models = [
    { id: 'arctic-embed2', role: 'embed', auto: true, label: 'embed' },
    { id: 'bge-reranker-v2-m3', role: 'rerank', auto: true, label: 'rerank' },
    { id: 'qwen3-reranker-0.6b', role: 'rerank-qwen', auto: true, label: 'qwen' },
  ];
  const store = {
    refresh: vi.fn(async () => undefined),
    statuses: vi.fn(() => models.map((m) => ({ ...m, state: states.get(m.id) }))),
    ensure: vi.fn(async (ids: string[]) => { for (const id of ids) states.set(id, 'ready'); }),
    isReady: vi.fn((role: string) => models.some((m) => m.role === role && states.get(m.id) === 'ready')),
    whenSettled: vi.fn(async () => undefined),
    onChange: vi.fn(() => () => undefined),
    cancelAll: vi.fn(),
  };
  return { store, svc: { store, runtime: {}, backend: {} } as never };
}

beforeEach(() => {
  h.local = { useExternalOllama: false, modelsDir: null };
  h.legacyStore = false;
  h.httpCalls = [];
  __setBuiltinBackendForTests(null);
  __setLocalAiServiceForTests(null);
  resetGpuModeCache();
  resetRerankTierCache();
  allowBuiltinAutoDownload();
});

describe('backend selection', () => {
  it('every install starts on the built-in runtime', () => {
    expect(getBackendKind()).toBe('builtin');
    expect(useBuiltinBackend()).toBe(true);
  });
  it('"Use my own Ollama" switches to the external backend', () => {
    h.local.useExternalOllama = true;
    expect(getBackendKind()).toBe('ollama');
  });
  it('a settings store without the local-AI settings behaves as the legacy Ollama setup', () => {
    h.legacyStore = true;
    expect(getBackendKind()).toBe('ollama');
  });
});

describe('dispatch to the built-in backend', () => {
  it('isOllamaRunning reports the runtime, not an HTTP probe of 11434', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    expect(await isOllamaRunning()).toEqual({ running: true, version: 'b11780' });
    expect(h.httpCalls).toEqual([]);
  });

  it('embeddings go to the built-in server with the session options and never over http', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const out = await generateEmbeddingsBatchDetailed(['a', 'b'], { numThread: 3, numBatch: 1024 });
    expect(out.embeddings).toEqual([[0.1, 0.2], [0.1, 0.2]]);
    expect(f.backend.embed).toHaveBeenCalledWith(['a', 'b'], { numThread: 3, numBatch: 1024 });
    expect(h.httpCalls).toEqual([]);
  });

  it('unloadArkModels stops the built-in servers', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    expect(await unloadArkModels()).toEqual(['embed', 'rerank']);
    expect(h.httpCalls).toEqual([]);
  });

  it('model info and size come from the downloaded model', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    expect((await getEmbeddingModelInfo())?.sizeBytes).toBe(1160285024);
    expect(await getEmbeddingModelSize()).toBe(1160285024);
    f.backend.embeddingModelInfo.mockReturnValue({ name: 'x', installed: false, sizeBytes: 0, parameterSize: '', quantization: '' });
    expect(await getEmbeddingModelInfo()).toBeNull();
  });

  it('GPU mode is read from the server log; "not loaded yet" is inconclusive and not cached', async () => {
    const f = fakeBackend({ gpuReading: vi.fn(() => ({ loaded: false, sizeBytes: 0, vramBytes: 0 })) });
    __setBuiltinBackendForTests(f.asBackend);
    expect(await detectGpuMode()).toBe(false);
    resetGpuModeCache();
    f.backend.gpuReading.mockReturnValue({ loaded: true, sizeBytes: 10, vramBytes: 10 });
    expect(await detectGpuMode()).toBe(true);
    expect(h.httpCalls).toEqual([]);
  });
});

describe('dispatch to the user\'s own Ollama', () => {
  it('uses the Ollama HTTP path and leaves the built-in backend untouched', async () => {
    h.local.useExternalOllama = true;
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    expect((await isOllamaRunning()).running).toBe(false); // the blocked fake http errors
    const out = await generateEmbeddingsBatchDetailed(['a'], { numThread: 2 });
    expect(out.error?.kind).toBe('network');
    expect(h.httpCalls).toContain('/api/version');
    expect(h.httpCalls).toContain('/api/embed');
    expect(f.backend.health).not.toHaveBeenCalled();
    expect(f.backend.embed).not.toHaveBeenCalled();
  });
});

describe('reranker tier detection (built-in)', () => {
  it('uses the cross-encoder when its model is downloaded', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const d = await detectRerankTier({ force: true });
    expect(d.tier).toBe('native');
    expect(d.ollamaUp).toBe(true);
    expect(d.ollamaVersion).toBe('b11780');
  });

  it('falls to the graded Qwen3 tier when only that model is there', async () => {
    const f = fakeBackend();
    f.ready.delete('rerank');
    __setBuiltinBackendForTests(f.asBackend);
    expect((await detectRerankTier({ force: true })).tier).toBe('qwen_graded');
  });

  it('skips a reranker whose server failed too often', async () => {
    const f = fakeBackend();
    f.failed.add('rerank');
    __setBuiltinBackendForTests(f.asBackend);
    expect((await detectRerankTier({ force: true })).tier).toBe('qwen_graded');
  });

  it('is cosine (but "up") while no reranker model is downloaded, and starts nothing to find out', async () => {
    const f = fakeBackend();
    f.ready.delete('rerank');
    f.ready.delete('rerank-qwen');
    __setBuiltinBackendForTests(f.asBackend);
    const d = await detectRerankTier({ force: true });
    expect(d.tier).toBe('embed_fallback');
    expect(d.ollamaUp).toBe(true);
    expect(d.reason).toMatch(/downloaded yet/);
  });

  it('is cosine and "down" when the runtime is not in the install', async () => {
    const f = fakeBackend({ health: vi.fn(() => ({ running: false, version: null })) });
    __setBuiltinBackendForTests(f.asBackend);
    const d = await detectRerankTier({ force: true });
    expect(d.tier).toBe('embed_fallback');
    expect(d.ollamaUp).toBe(false);
  });
});

describe('setup flow (built-in)', () => {
  it('with every Oracle model downloaded it is ready at once and downloads nothing', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const s = fakeService({ readyIds: ['bge-reranker-v2-m3', 'qwen3-reranker-0.6b'] });
    __setLocalAiServiceForTests(s.svc);
    const out = await runOllamaSetup(undefined, undefined, { skipWarmUp: true });
    expect(out.ollamaDetected).toBe(true);
    expect(out.embeddingModelReady).toBe(true);
    expect(out.rerankModelReady).toBe(true);
    expect(s.store.ensure).not.toHaveBeenCalled();
  });

  it('with models missing it does not block: starts the background download and reports "not ready yet"', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const s = fakeService({ embedReady: false });
    f.ready.delete('embed');
    f.ready.delete('rerank');
    f.ready.delete('rerank-qwen');
    __setLocalAiServiceForTests(s.svc);
    const progress: string[] = [];
    const out = await runOllamaSetup((status) => progress.push(status), undefined, { skipWarmUp: true });
    expect(out.embeddingModelReady).toBe(false);
    expect(out.error).toMatch(/downloading/i);
    expect(s.store.ensure).toHaveBeenCalled();
    expect(progress.join(' ')).toMatch(/background/);
  });

  it('after "Continue without local AI" no automatic download starts', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const s = fakeService({ embedReady: false });
    __setLocalAiServiceForTests(s.svc);
    declineBuiltinAutoDownload();
    expect(s.store.cancelAll).toHaveBeenCalled();
    const out = await runOllamaSetup(undefined, undefined, { skipWarmUp: true });
    expect(out.embeddingModelReady).toBe(false);
    expect(out.error).toMatch(/declined/);
    expect(s.store.ensure).not.toHaveBeenCalled();
  });

  it('reports a missing runtime instead of throwing', async () => {
    const f = fakeBackend({ health: vi.fn(() => ({ running: false, version: null })) });
    __setBuiltinBackendForTests(f.asBackend);
    __setLocalAiServiceForTests(fakeService().svc);
    const out = await runOllamaSetup(undefined, undefined, { skipWarmUp: true });
    expect(out.ollamaDetected).toBe(false);
    expect(out.error).toMatch(/runtime not found/i);
  });

  it('Retry / Re-check downloads tell the renderer when the queue settled', async () => {
    const s = fakeService();
    __setLocalAiServiceForTests(s.svc);
    const seen: boolean[] = [];
    const off = onBuiltinModelsSettled((ready) => seen.push(ready));
    await startBuiltinModelDownloadsAndNotify();
    off();
    expect(seen).toEqual([true]);
  });

  it('ensureRerankModelPull downloads the rerank models through the store', async () => {
    const f = fakeBackend();
    __setBuiltinBackendForTests(f.asBackend);
    const s = fakeService();
    __setLocalAiServiceForTests(s.svc);
    expect(await ensureRerankModelPull()).toBe(true);
    expect(s.store.ensure).toHaveBeenCalledWith(['bge-reranker-v2-m3', 'qwen3-reranker-0.6b'], { priority: true });
    expect(s.store.whenSettled).toHaveBeenCalledWith(['bge-reranker-v2-m3', 'qwen3-reranker-0.6b']);
    expect(h.httpCalls).toEqual([]);
  });
});
