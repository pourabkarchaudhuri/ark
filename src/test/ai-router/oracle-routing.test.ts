/**
 * The Oracle's path through the AI router (1.0.97 B35): embeddings (ollama-setup), reranking
 * (ollama-handlers) and rerank tier detection (rerank-engine) ask the router where a role goes.
 * Built-in routes stay on the local backend without touching the router; a routed connector goes
 * through it, with the local backend handed over as the fallback the router may use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  route: { chat: 'local', embeddings: 'local', reranker: 'local' } as Record<string, 'local' | 'router'>,
  router: {
    embed: vi.fn(),
    rerank: vi.fn(),
  },
  builtin: {
    embed: vi.fn(),
    rerank: vi.fn(),
    health: vi.fn(() => ({ running: true, version: 'b1' })),
    isModelReady: vi.fn(() => true),
    runtime: { roleStatus: vi.fn(() => ({ state: 'stopped' })) },
  },
}));

vi.mock('../../../electron/safe-logger.js', () => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: {
    getLocalAiSettings: () => ({ useExternalOllama: false, modelsDir: null }),
    getOllamaSettings: () => ({ url: 'http://127.0.0.1:11434', rerankModel: 'bge', rerankQwenModel: 'qwen' }),
  },
  DEFAULT_OLLAMA_RERANK_MODEL: 'dengcao/bge-reranker-v2-m3',
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL: 'dengcao/Qwen3-Reranker-0.6B:Q8_0',
}));
vi.mock('../../../electron/ai-router/service.js', () => ({
  routeFor: (role: string) => (h.route[role] === 'router'
    ? { via: 'router', connector: { id: 'compat-1', kind: 'openai-compatible', name: 'Server' }, model: 'm', alias: `ark-${role}` }
    : { via: 'local' }),
  getAiRouter: () => h.router,
}));

import { __setBuiltinBackendForTests } from '../../../electron/local-ai/backend';
import { generateEmbeddingsBatchDetailed } from '../../../electron/ollama-setup';
import { rerankViaNativeEndpoint } from '../../../electron/ipc/ollama-handlers';
import { detectRerankTier, resetRerankTierCache } from '../../../electron/rerank-engine';

beforeEach(() => {
  h.route = { chat: 'local', embeddings: 'local', reranker: 'local' };
  h.router.embed.mockReset();
  h.router.rerank.mockReset();
  h.builtin.embed.mockReset().mockResolvedValue({ embeddings: [[1, 2]], error: null });
  h.builtin.rerank.mockReset().mockResolvedValue({ rows: [{ index: 0, relevance_score: 0.4 }], code: 'ok', message: 'ok' });
  __setBuiltinBackendForTests(h.builtin as never);
  resetRerankTierCache();
});

describe('embeddings', () => {
  it('a built-in route embeds locally and never touches the router', async () => {
    const out = await generateEmbeddingsBatchDetailed(['a'], { numBatch: 512 });
    expect(out).toEqual({ embeddings: [[1, 2]], error: null });
    expect(h.builtin.embed).toHaveBeenCalledWith(['a'], expect.objectContaining({ numBatch: 512 }));
    expect(h.router.embed).not.toHaveBeenCalled();
  });

  it('a routed connector goes through the router, with the local embed as its fallback', async () => {
    h.route.embeddings = 'router';
    h.router.embed.mockImplementation(async (_texts: string[], local: () => Promise<unknown>) => ({ viaRouter: true, fallback: await local() }));
    const out = await generateEmbeddingsBatchDetailed(['a', 'b']) as unknown as { viaRouter: boolean; fallback: unknown };
    expect(h.router.embed).toHaveBeenCalledWith(['a', 'b'], expect.any(Function));
    expect(out.viaRouter).toBe(true);
    expect(out.fallback).toEqual({ embeddings: [[1, 2]], error: null });
    expect(h.builtin.embed).toHaveBeenCalledTimes(1); // only because the fallback was invoked
  });

  it('an empty batch needs no router or backend', async () => {
    h.route.embeddings = 'router';
    expect(await generateEmbeddingsBatchDetailed([])).toEqual({ embeddings: [], error: null });
    expect(h.router.embed).not.toHaveBeenCalled();
  });
});

describe('reranking', () => {
  it('a built-in route reranks locally', async () => {
    const out = await rerankViaNativeEndpoint('q', ['a'], 1, 'bge');
    expect(out).toMatchObject({ code: 'ok', results: [{ index: 0, relevance_score: 0.4 }] });
    expect(h.router.rerank).not.toHaveBeenCalled();
  });

  it('a routed connector answers through the router; its rows are normalised like local ones', async () => {
    h.route.reranker = 'router';
    h.router.rerank.mockResolvedValue({ rows: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], code: 'ok', message: 'ok' });
    const out = await rerankViaNativeEndpoint('q', ['a', 'b'], 2, 'bge');
    expect(out).toMatchObject({ code: 'ok', results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
    expect(h.router.rerank).toHaveBeenCalledWith('q', ['a', 'b'], undefined, expect.any(Function));
    expect(h.builtin.rerank).not.toHaveBeenCalled();
  });

  it('a router failure comes back in the same shape the caller already handles', async () => {
    h.route.reranker = 'router';
    h.router.rerank.mockResolvedValue({ rows: null, code: 'router_down', message: 'The AI router is not running: x' });
    expect(await rerankViaNativeEndpoint('q', ['a'], 1, 'bge')).toMatchObject({ results: null, code: 'router_down' });
  });

  it('the fallback handed to the router is the local reranker', async () => {
    h.route.reranker = 'router';
    h.router.rerank.mockImplementation(async (_q: string, _d: string[], _o: unknown, local: () => Promise<unknown>) => local());
    const out = await rerankViaNativeEndpoint('q', ['a'], 1, 'bge');
    expect(out).toMatchObject({ code: 'ok', results: [{ index: 0, relevance_score: 0.4 }] });
    expect(h.builtin.rerank).toHaveBeenCalledTimes(1);
  });
});

describe('rerank tier detection', () => {
  it('a routed reranker is the native tier without probing anything', async () => {
    h.route.reranker = 'router';
    const d = await detectRerankTier({ force: true });
    expect(d.tier).toBe('native');
    expect(d.model).toBe('m');
    expect(d.reason).toMatch(/AI router sends reranking to Server \(m\)/);
    expect(h.builtin.isModelReady).not.toHaveBeenCalled();
  });

  it('a built-in reranker keeps the local detection', async () => {
    const d = await detectRerankTier({ force: true });
    expect(d.tier).toBe('native');
    expect(d.reason).toMatch(/Built-in llama\.cpp/);
  });
});
