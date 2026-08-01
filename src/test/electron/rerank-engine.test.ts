import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { isOllamaRunning, isRerankModelInstalled } = vi.hoisted(() => ({
  isOllamaRunning: vi.fn(),
  isRerankModelInstalled: vi.fn((_base: string[], tags: string[], model: string) =>
    tags.some((t) => t.includes(model.split(':')[0])),
  ),
}));

vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: {
    getOllamaSettings: () => ({ url: 'http://127.0.0.1:11434' }),
  },
}));

vi.mock('../../../electron/ollama-setup.js', () => ({
  isOllamaRunning,
  isRerankModelInstalled,
  getRerankModelTag: () => 'dengcao/bge-reranker-v2-m3',
  getRerankQwenModelTag: () => 'qwen3-reranker:0.6b',
}));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  detectRerankTier,
  resetRerankTierCache,
  scoreFromBinaryToken,
  scoreFromTopLogprobs,
  scoreWithQwen3,
  versionAtLeast,
  LOGPROBS_MIN_VERSION,
} from '../../../electron/rerank-engine';

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return handler(init);
    }
    return new Response('not found', { status: 404 });
  });
}

describe('versionAtLeast', () => {
  it('compares semver segments', () => {
    expect(versionAtLeast('0.12.11', LOGPROBS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('0.12.10', LOGPROBS_MIN_VERSION)).toBe(false);
    expect(versionAtLeast('v0.13.0', LOGPROBS_MIN_VERSION)).toBe(true);
  });
});

describe('scoreFromTopLogprobs', () => {
  it('softmaxes yes vs no logprobs', () => {
    const score = scoreFromTopLogprobs([
      { token: ' yes', logprob: -0.1 },
      { token: ' no', logprob: -2.3 },
    ]);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0.9);
    expect(score!).toBeLessThanOrEqual(1);
  });

  it('returns null when neither yes nor no appears in top-k', () => {
    expect(scoreFromTopLogprobs([{ token: 'maybe', logprob: -0.1 }])).toBeNull();
  });
});

describe('scoreFromBinaryToken', () => {
  it('reads yes/no from a single generated token', () => {
    expect(scoreFromBinaryToken('Yes')).toBe(1);
    expect(scoreFromBinaryToken('▁no')).toBe(0);
    expect(scoreFromBinaryToken('maybe')).toBeNull();
  });
});

describe('detectRerankTier', () => {
  beforeEach(() => {
    resetRerankTierCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetRerankTierCache();
  });

  it('falls back to cosine when Ollama is down', async () => {
    isOllamaRunning.mockResolvedValue({ running: false, version: null });
    const det = await detectRerankTier({ force: true });
    expect(det.tier).toBe('embed_fallback');
    expect(det.ollamaUp).toBe(false);
  });

  it('selects native when /api/rerank succeeds', async () => {
    isOllamaRunning.mockResolvedValue({ running: true, version: '0.12.11' });
    mockFetch({
      '/api/rerank': () =>
        new Response(
          JSON.stringify({
            results: [
              { index: 0, relevance_score: 0.9 },
              { index: 1, relevance_score: 0.2 },
              { index: 2, relevance_score: 0.1 },
            ],
          }),
          { status: 200 },
        ),
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    });

    const det = await detectRerankTier({ force: true });
    expect(det.tier).toBe('native');
  });

  it('selects qwen_graded when rerank 404s and Qwen is installed on a new enough Ollama', async () => {
    isOllamaRunning.mockResolvedValue({ running: true, version: '0.12.11' });
    mockFetch({
      '/api/rerank': () => new Response('missing', { status: 404 }),
      '/api/tags': () =>
        new Response(JSON.stringify({ models: [{ name: 'qwen3-reranker:0.6b' }] }), {
          status: 200,
        }),
    });

    const det = await detectRerankTier({ force: true });
    expect(det.tier).toBe('qwen_graded');
  });

  it('selects qwen_binary on older Ollama builds', async () => {
    isOllamaRunning.mockResolvedValue({ running: true, version: '0.12.10' });
    mockFetch({
      '/api/rerank': () => new Response('missing', { status: 404 }),
      '/api/tags': () =>
        new Response(JSON.stringify({ models: [{ name: 'qwen3-reranker:0.6b' }] }), {
          status: 200,
        }),
    });

    const det = await detectRerankTier({ force: true });
    expect(det.tier).toBe('qwen_binary');
  });

  it('selects embed_fallback when neither native nor Qwen is available', async () => {
    isOllamaRunning.mockResolvedValue({ running: true, version: '0.12.11' });
    mockFetch({
      '/api/rerank': () => new Response('missing', { status: 404 }),
      '/api/tags': () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    });

    const det = await detectRerankTier({ force: true });
    expect(det.tier).toBe('embed_fallback');
  });
});

describe('scoreWithQwen3', () => {
  beforeEach(() => {
    resetRerankTierCache();
    vi.restoreAllMocks();
  });

  it('uses binary token fallback when logprobs are absent', async () => {
    let calls = 0;
    mockFetch({
      '/api/generate': () => {
        calls += 1;
        return new Response(JSON.stringify({ response: calls % 2 === 0 ? 'no' : 'yes' }), {
          status: 200,
        });
      },
    });

    const docs = Array.from({ length: 8 }, (_, i) => `document ${i}`);
    const result = await scoreWithQwen3('cozy roguelike', docs, {
      model: 'qwen3-reranker:0.6b',
      graded: true,
      budgetMs: 60_000,
    });

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('qwen_binary');
    expect(result!.scored).toBeGreaterThanOrEqual(8);
    expect(result!.rows.some((r) => r.relevance_score === 1)).toBe(true);
    expect(result!.rows.some((r) => r.relevance_score === 0)).toBe(true);
  });
});
