/**
 * Embedding Space neighbour rerank — budget, Qwen pool, constant scores and
 * the short failure cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyOllamaNeighborRerank,
  NEIGHBOR_RERANK_FAILURE_TTL_MS,
  __clearNeighborRerankCacheForTests,
} from '@/services/ollama-rerank';
import { NEIGHBOR_RERANK_BUDGET_MS, NEIGHBOR_RERANK_QWEN_POOL, __resetRerankRunStoreForTests, getLastRerankRun } from '@/services/oracle-rerank';
import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';

function node(id: string): GraphNode {
  return {
    id, title: id, genres: [], themes: [], developer: '', publisher: '', isLibrary: false, hoursPlayed: 0,
    reviewCount: 0, luminance: 0.5, releaseYear: 2020, x: 0, y: 0, z: 0, colorIdx: 0,
  } as GraphNode;
}
function nbs(n: number): NeighborInfo[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, distance: 0.1 + i * 0.01, node: node(`n${i}`) }));
}

describe('applyOllamaNeighborRerank', () => {
  const win = window as unknown as { ollama?: unknown };
  let saved: unknown;
  const anchor = node('anchor');

  beforeEach(() => {
    saved = win.ollama;
    __clearNeighborRerankCacheForTests();
    __resetRerankRunStoreForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    win.ollama = saved;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives up after the budget, keeps the heuristic order and cancels the main-process pass', async () => {
    vi.useFakeTimers();
    const rerankCancel = vi.fn(async () => true);
    const rerank = vi.fn((_p: { requestId?: string; documents: string[] }) => new Promise(() => {}));
    win.ollama = { rerank, rerankCancel, rerankTier: async () => ({ tier: 'qwen_graded', ollamaUp: true }) };
    const list = nbs(72);

    const p = applyOllamaNeighborRerank(anchor, list, 12);
    await vi.advanceTimersByTimeAsync(NEIGHBOR_RERANK_BUDGET_MS + 50);
    const out = await p;

    expect(out.status.outcome).toBe('skipped_timeout');
    expect(out.neighbors.map((n) => n.id)).toEqual(list.slice(0, 12).map((n) => n.id));
    // Qwen3 tier: only the top of the heuristic order is scored.
    expect(rerank.mock.calls[0][0].documents).toHaveLength(NEIGHBOR_RERANK_QWEN_POOL);
    expect(rerankCancel).toHaveBeenCalledWith(rerank.mock.calls[0][0].requestId);
    expect(getLastRerankRun()).toMatchObject({ source: 'neighbors', outcome: 'skipped_timeout' });
  });

  it('constant scores → no_signal with heuristic order', async () => {
    win.ollama = {
      rerank: vi.fn(async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({ index: i, relevance_score: 1 })),
        via: 'qwen_binary',
        report: {
          requestId: null, tier: 'qwen_binary', scored: 24, requested: 24, elapsedMs: 5,
          scoreMin: 1, scoreMax: 1, scoreStdev: 0, truncated: false,
        },
      })),
    };
    const list = nbs(30);
    const out = await applyOllamaNeighborRerank(anchor, list, 12);
    expect(out.status.outcome).toBe('no_signal');
    expect(out.neighbors.map((n) => n.id)).toEqual(list.slice(0, 12).map((n) => n.id));
  });

  it('applied → status carries positions moved', async () => {
    win.ollama = {
      rerank: vi.fn(async () => ({
        results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }],
        via: 'native',
      })),
      rerankTier: async () => ({ tier: 'native', ollamaUp: true }),
    };
    const out = await applyOllamaNeighborRerank(anchor, nbs(2), 2);
    expect(out.status).toMatchObject({ outcome: 'applied', tier: 'native', moved: 2, meanAbsDelta: 1 });
    expect(out.neighbors.map((n) => n.id)).toEqual(['n1', 'n0']);
  });

  it('caches a failure only briefly, so a reranker that comes up is used soon', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rerank = vi.fn(async () => ({ error: { code: 'network_error', message: 'down' } }));
    win.ollama = { rerank, rerankTier: async () => ({ tier: 'native', ollamaUp: true }) };
    const list = nbs(20);

    expect((await applyOllamaNeighborRerank(anchor, list, 12)).status.outcome).toBe('error');
    await applyOllamaNeighborRerank(anchor, list, 12);
    expect(rerank).toHaveBeenCalledTimes(1); // cache hit within the failure TTL

    vi.setSystemTime(Date.now() + NEIGHBOR_RERANK_FAILURE_TTL_MS + 1);
    await applyOllamaNeighborRerank(anchor, list, 12);
    expect(rerank).toHaveBeenCalledTimes(2); // was 10 minutes before
  });
});
