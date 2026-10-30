import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Ollama resource policy while gaming (ollama-handlers.ts):
 *  - background pacing = window state OR game running (combined, never overwritten),
 *  - a hidden start begins in background mode and skips the boot warm-up,
 *  - a game start unloads Ark's models and holds background embed / rerank work,
 *  - background work draining while Ark is not in front unloads the models.
 *
 * The handlers are driven through register()'s injectable ipc seam —
 * createRequire('electron') is invisible to vi.mock.
 */

const setup = vi.hoisted(() => ({
  unloadArkModels: vi.fn(async () => [] as string[]),
  warmUpIfSkipped: vi.fn(() => true),
  runOllamaSetup: vi.fn(async () => ({ ollamaDetected: true })),
  generateEmbeddingsBatchDetailed: vi.fn(async (texts: string[]) => ({
    embeddings: texts.map(() => [0.1, 0.2]),
    error: null,
  })),
  detectRerankTier: vi.fn(async () => ({
    tier: 'embed_fallback', ollamaUp: false, reason: 'down', model: '', ollamaVersion: null, probes: [],
  })),
}));

vi.mock('../../../electron/ollama-setup.js', () => ({
  isOllamaRunning: vi.fn(async () => ({ running: true, version: '0.13.0' })),
  runOllamaSetup: setup.runOllamaSetup,
  generateEmbedding: vi.fn(async () => null),
  generateEmbeddingsBatch: vi.fn(async (texts: string[]) => texts.map(() => null)),
  generateEmbeddingsBatchDetailed: setup.generateEmbeddingsBatchDetailed,
  getSessionEmbedOptions: vi.fn(() => ({})),
  getSessionNumBatch: vi.fn(() => 2048),
  stepDownSessionNumBatch: vi.fn(() => false),
  isOllamaOomError: vi.fn(() => false),
  EMBED_NUM_THREAD_CPU: 4,
  detectGpuMode: vi.fn(async () => false),
  getEmbeddingModelInfo: vi.fn(async () => null),
  getEmbeddingModelSize: vi.fn(async () => 0),
  ensureRerankModelPull: vi.fn(async () => false),
  getRerankQwenModelTag: vi.fn(() => 'dengcao/Qwen3-Reranker-0.6B:Q8_0'),
  EMBEDDING_MODEL_NAME: 'snowflake-arctic-embed2',
  OLLAMA_KEEP_ALIVE: '30m',
  unloadArkModels: setup.unloadArkModels,
  warmUpIfSkipped: setup.warmUpIfSkipped,
}));

vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: { getOllamaSettings: () => ({ url: 'http://127.0.0.1:11434', embeddingBatchSize: 0 }) },
  DEFAULT_OLLAMA_RERANK_MODEL: 'dengcao/bge-reranker-v2-m3',
}));

vi.mock('../../../electron/gpu-stats.js', () => ({ getGpuStats: vi.fn(async () => null) }));

vi.mock('../../../electron/rerank-engine.js', () => ({
  beginRerankRequest: vi.fn(() => new AbortController().signal),
  cancelRerankRequest: vi.fn(() => false),
  detectRerankTier: setup.detectRerankTier,
  endRerankRequest: vi.fn(),
  resetRerankTierCache: vi.fn(),
  rerankTierLabel: vi.fn((t: string) => t),
  scoreWithQwen3: vi.fn(async () => null),
}));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  register,
  applyInitialWindowBackground,
  beginOllamaWork,
  endOllamaWork,
  DRAIN_UNLOAD_DELAY_MS,
  isEmbeddingBackground,
  isOllamaWorkHeld,
  resetOllamaRuntimeStateForTests,
  setEmbeddingBackgroundMode,
  setEmbeddingGameRunning,
  setEmbeddingHiddenStart,
} from '../../../electron/ipc/ollama-handlers';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
register({
  handle: (channel, listener) => { handlers.set(channel, listener as Handler); },
  on: () => {},
});
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { send: vi.fn() } }, ...args);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetOllamaRuntimeStateForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('embedding background mode', () => {
  it('a hidden start is background; showing and focusing the window turns it off', () => {
    applyInitialWindowBackground({ isVisible: () => false, isFocused: () => false });
    expect(isEmbeddingBackground()).toBe(true);
    setEmbeddingBackgroundMode(false);
    expect(isEmbeddingBackground()).toBe(false);
  });

  it('a visible, focused window starts in the foreground', () => {
    applyInitialWindowBackground({ isVisible: () => true, isFocused: () => true });
    expect(isEmbeddingBackground()).toBe(false);
  });

  it('session start forces background; session end restores the window-derived state', () => {
    setEmbeddingBackgroundMode(false);
    setEmbeddingGameRunning(true);
    expect(isEmbeddingBackground()).toBe(true);
    setEmbeddingGameRunning(false);
    expect(isEmbeddingBackground()).toBe(false);

    setEmbeddingBackgroundMode(true);
    setEmbeddingGameRunning(true);
    setEmbeddingGameRunning(false);
    expect(isEmbeddingBackground()).toBe(true);
  });
});

describe('game start unloads Ark models', () => {
  it('unloads once per game start, never on blur / minimize', () => {
    setEmbeddingBackgroundMode(true);
    setEmbeddingBackgroundMode(false);
    expect(setup.unloadArkModels).not.toHaveBeenCalled();

    setEmbeddingGameRunning(true);
    setEmbeddingGameRunning(true); // repeated report, same state
    expect(setup.unloadArkModels).toHaveBeenCalledTimes(1);
    setEmbeddingGameRunning(false);
    expect(setup.unloadArkModels).toHaveBeenCalledTimes(1);
  });
});

describe('work hold while a game runs', () => {
  it('holds a batch embed until Ark is brought to the front', async () => {
    setEmbeddingBackgroundMode(true);
    setEmbeddingGameRunning(true);
    expect(isOllamaWorkHeld()).toBe(true);

    let settled = false;
    const call = Promise.resolve(invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]))
      .then((r) => { settled = true; return r; });
    await flush();
    await flush();
    expect(settled).toBe(false);
    expect(setup.generateEmbeddingsBatchDetailed).not.toHaveBeenCalled();

    setEmbeddingBackgroundMode(false);
    const result = await call;
    expect(setup.generateEmbeddingsBatchDetailed).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ a: [0.1, 0.2] });
  });

  it('the game ending releases held work', async () => {
    setEmbeddingBackgroundMode(true);
    setEmbeddingGameRunning(true);
    const call = invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    await flush();
    setEmbeddingGameRunning(false);
    await call;
    expect(setup.generateEmbeddingsBatchDetailed).toHaveBeenCalledTimes(1);
  });

  it('a game with Ark in front does not hold work', async () => {
    setEmbeddingBackgroundMode(false);
    setEmbeddingGameRunning(true);
    expect(isOllamaWorkHeld()).toBe(false);
    await invoke('ollama:generateEmbeddings', [{ id: 'a', text: 'hello' }]);
    expect(setup.generateEmbeddingsBatchDetailed).toHaveBeenCalledTimes(1);
  });

  it('a rerank while held is skipped without touching Ollama', async () => {
    setEmbeddingBackgroundMode(true);
    setEmbeddingGameRunning(true);
    const res = await invoke('ollama:rerank', { query: 'q', documents: ['a', 'b'] }) as { error?: { code: string } };
    expect(res.error?.code).toBe('cancelled');
    expect(setup.detectRerankTier).not.toHaveBeenCalled();
  });
});

describe('hidden start warm-up', () => {
  it('skips the boot warm-up on a hidden start, then warms up once the window is shown', async () => {
    setEmbeddingHiddenStart(true);
    await invoke('ollama:setup');
    expect(setup.runOllamaSetup).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { skipWarmUp: true });

    setEmbeddingBackgroundMode(false);
    expect(setup.warmUpIfSkipped).toHaveBeenCalledTimes(1);
  });

  it('a normal start keeps the warm-up', async () => {
    await invoke('ollama:setup');
    expect(setup.runOllamaSetup).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { skipWarmUp: false });
  });

  it('does not warm up on focus while a game is running', () => {
    setEmbeddingHiddenStart(true);
    setEmbeddingGameRunning(true);
    setEmbeddingBackgroundMode(false);
    expect(setup.warmUpIfSkipped).not.toHaveBeenCalled();
  });
});

describe('drain unload', () => {
  it('unloads after background work drains and stays idle', () => {
    vi.useFakeTimers();
    setEmbeddingBackgroundMode(true);
    beginOllamaWork();
    endOllamaWork();
    vi.advanceTimersByTime(DRAIN_UNLOAD_DELAY_MS - 1);
    expect(setup.unloadArkModels).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setup.unloadArkModels).toHaveBeenCalledTimes(1);
  });

  it('new work cancels the pending drain unload', () => {
    vi.useFakeTimers();
    setEmbeddingBackgroundMode(true);
    beginOllamaWork();
    endOllamaWork();
    vi.advanceTimersByTime(DRAIN_UNLOAD_DELAY_MS / 2);
    beginOllamaWork();
    vi.advanceTimersByTime(DRAIN_UNLOAD_DELAY_MS);
    expect(setup.unloadArkModels).not.toHaveBeenCalled();
    endOllamaWork();
  });

  it('keeps the models loaded when Ark is in front', () => {
    vi.useFakeTimers();
    setEmbeddingBackgroundMode(false);
    beginOllamaWork();
    endOllamaWork();
    vi.advanceTimersByTime(DRAIN_UNLOAD_DELAY_MS * 2);
    expect(setup.unloadArkModels).not.toHaveBeenCalled();
  });
});
