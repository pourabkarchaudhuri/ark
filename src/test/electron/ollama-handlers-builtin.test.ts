import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 1.0.99 built-in embedding path of ollama:generateEmbeddings:
 *  - an out-of-memory request relaunches the embed server on the CPU (the Ollama num_batch ladder is a no-op for
 *    llama-server) and retries once, instead of repeating the identical request;
 *  - the cold embed server is started before the GPU probe, so the pacing profile matches the server.
 */

const h = vi.hoisted(() => ({
  gpu: { value: false },
  serverUp: { value: false },
  ensure: vi.fn(async () => { h.serverUp.value = true; h.gpu.value = true; return {}; }),
  fallbackToCpu: vi.fn(async () => true),
  stepDown: vi.fn(() => true),
  embed: vi.fn(),
  oomOnce: { value: false },
}));

vi.mock('../../../electron/ollama-setup.js', () => ({
  isOllamaRunning: vi.fn(async () => ({ running: true, version: '0.13.0' })),
  runOllamaSetup: vi.fn(),
  generateEmbedding: vi.fn(async () => null),
  generateEmbeddingsBatch: vi.fn(async (texts: string[]) => texts.map(() => null)),
  generateEmbeddingsBatchDetailed: h.embed,
  getSessionEmbedOptions: vi.fn(() => ({ numBatch: 2048, numThread: 4 })),
  getSessionNumBatch: vi.fn(() => 2048),
  stepDownSessionNumBatch: h.stepDown,
  isOllamaOomError: vi.fn((m: string) => /out of memory/i.test(m)),
  EMBED_NUM_THREAD_CPU: 4,
  detectGpuMode: vi.fn(async () => h.serverUp.value && h.gpu.value),
  getEmbeddingModelInfo: vi.fn(async () => null),
  getEmbeddingModelSize: vi.fn(async () => 0),
  ensureRerankModelPull: vi.fn(async () => false),
  getRerankQwenModelTag: vi.fn(() => 'q'),
  EMBEDDING_MODEL_NAME: 'snowflake-arctic-embed2',
  OLLAMA_KEEP_ALIVE: '30m',
  unloadArkModels: vi.fn(async () => []),
  warmUpIfSkipped: vi.fn(() => true),
}));
vi.mock('../../../electron/local-ai/backend.js', () => ({
  useBuiltinBackend: () => true,
  getBuiltinBackend: () => ({}),
}));
vi.mock('../../../electron/local-ai/service.js', () => ({
  getLocalAiService: () => ({ runtime: { ensure: h.ensure, fallbackToCpu: h.fallbackToCpu } }),
}));
vi.mock('../../../electron/ai-router/service.js', () => ({
  getAiRouter: vi.fn(),
  routeFor: () => ({ via: 'builtin' }),
}));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: { getOllamaSettings: () => ({ url: 'http://127.0.0.1:11434', embeddingBatchSize: 0 }) },
  DEFAULT_OLLAMA_RERANK_MODEL: 'dengcao/bge-reranker-v2-m3',
}));
vi.mock('../../../electron/gpu-stats.js', () => ({ getGpuStats: vi.fn(async () => null) }));
vi.mock('../../../electron/rerank-engine.js', () => ({
  beginRerankRequest: vi.fn(() => new AbortController().signal),
  cancelRerankRequest: vi.fn(() => false),
  detectRerankTier: vi.fn(),
  endRerankRequest: vi.fn(),
  resetRerankTierCache: vi.fn(),
  rerankTierLabel: vi.fn((t: string) => t),
  scoreWithQwen3: vi.fn(async () => null),
}));
vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { register, resetOllamaRuntimeStateForTests, setEmbeddingBackgroundMode } from '../../../electron/ipc/ollama-handlers';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
register({ handle: (c, l) => { handlers.set(c, l as Handler); }, on: () => {} });
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { send: vi.fn() } }, ...args);

beforeEach(() => {
  resetOllamaRuntimeStateForTests();
  setEmbeddingBackgroundMode(false);
  vi.clearAllMocks();
  h.gpu.value = false;
  h.serverUp.value = false;
  h.ensure.mockImplementation(async () => { h.serverUp.value = true; h.gpu.value = true; return {}; });
  h.fallbackToCpu.mockImplementation(async () => true);
  h.embed.mockImplementation(async (texts: string[]) => ({ embeddings: texts.map(() => [0.1]), error: null }));
});

describe('built-in embed OOM', () => {
  it('relaunches on the CPU and retries once, never touching the Ollama num_batch ladder', async () => {
    let first = true;
    h.embed.mockImplementation(async (texts: string[]) => {
      if (first) { first = false; return { embeddings: texts.map(() => null), error: { kind: 'http', status: 500, message: 'failed: out of memory' } }; }
      return { embeddings: texts.map(() => [0.5]), error: null };
    });
    const res = await invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    expect(res).toEqual({ a: [0.5] });
    expect(h.fallbackToCpu).toHaveBeenCalledWith('embed');
    expect(h.stepDown).not.toHaveBeenCalled();
    expect(h.embed).toHaveBeenCalledTimes(2);
  });

  it('does not repeat the identical request when the server already runs on the CPU', async () => {
    h.fallbackToCpu.mockImplementation(async () => false);
    h.embed.mockImplementation(async (texts: string[]) => ({
      embeddings: texts.map(() => null), error: { kind: 'http', status: 500, message: 'out of memory' },
    }));
    const res = await invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    expect(res).toEqual({});
    expect(h.embed).toHaveBeenCalledTimes(1);
  });
});

describe('built-in embed GPU pacing on a cold server', () => {
  it('starts the embed server before probing the GPU, so the first pass uses the GPU profile', async () => {
    const res = await invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    expect(res).toEqual({ a: [0.1] });
    expect(h.ensure).toHaveBeenCalledWith('embed', { numBatch: 2048, numThread: 4 });
  });

  it('a failing server start is left to the embed call to report', async () => {
    h.ensure.mockImplementation(async () => { throw new Error('no model'); });
    const res = await invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    expect(res).toEqual({ a: [0.1] });
  });
});
