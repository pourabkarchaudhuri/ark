/**
 * Oracle rerank — run logic: positions moved, constant-score detection,
 * tier-aware plans, renderer-driven cancel, and the one-line run log.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyOracleRerankShelves,
  computeRerankMovement,
  formatRerankLogLine,
  getLastRerankRun,
  rerankHasNoSignal,
  rerankPlan,
  ORACLE_RERANK_QWEN_POOL,
  ORACLE_RERANK_QWEN_BUDGET_MS,
  ORACLE_RERANK_DEFAULT_BUDGET_MS,
  NEIGHBOR_RERANK_BUDGET_MS,
  NEIGHBOR_RERANK_QWEN_POOL,
  __resetRerankRunStoreForTests,
} from '@/services/oracle-rerank';
import type { RecoShelf, ScoredGame, TasteProfile } from '@/types/reco';

function emptyProfile(): TasteProfile {
  return {
    genres: [],
    themes: [],
    gameModes: [],
    perspectives: [],
    developers: [],
    publishers: [],
    eras: [],
    totalGames: 0,
    totalHours: 0,
    avgRating: 0,
    topGenre: 'RPG',
    topTheme: '',
    clusters: [],
    loyalDevelopers: [],
    loyalPublishers: [],
  };
}

function game(id: string): ScoredGame {
  return { gameId: id, title: id, genres: [], themes: [], developer: '', publisher: '' } as unknown as ScoredGame;
}
function shelf(title: string, ids: string[]): RecoShelf {
  return { type: 'deep-in-genre', title, games: ids.map(game) } as unknown as RecoShelf;
}

describe('computeRerankMovement', () => {
  it('counts moved positions and the mean |Δ| of the movers', () => {
    const m = computeRerankMovement([['a', 'b', 'c', 'd']], [['c', 'b', 'a', 'd']]);
    expect(m.moved).toBe(2); // a: 0→2, c: 2→0
    expect(m.meanAbsDelta).toBe(2);
    expect(m.compared).toBe(4);
  });

  it('is zero when nothing moved', () => {
    expect(computeRerankMovement([['a', 'b']], [['a', 'b']])).toEqual({ moved: 0, meanAbsDelta: 0, compared: 2 });
  });

  it('compares per list and ignores ids present on one side only', () => {
    const m = computeRerankMovement([['a', 'b'], ['x', 'y', 'z']], [['b', 'a'], ['x', 'q', 'y']]);
    // list 1: a,b swapped (2 moved, Δ1 each); list 2: y 1→2 (1 moved); z / q ignored
    expect(m.moved).toBe(3);
    expect(m.meanAbsDelta).toBe(1);
    expect(m.compared).toBe(4);
  });
});

describe('rerankHasNoSignal', () => {
  it('flags constant scores from the report', () => {
    expect(rerankHasNoSignal({ scoreMin: 0, scoreMax: 0, scored: 40 }, [])).toBe(true);
    expect(rerankHasNoSignal({ scoreMin: 0.1, scoreMax: 0.9, scored: 40 }, [])).toBe(false);
  });

  it('falls back to the returned rows without a report', () => {
    expect(rerankHasNoSignal(undefined, [{ relevance_score: 1 }, { relevance_score: 1 }])).toBe(true);
    expect(rerankHasNoSignal(undefined, [{ relevance_score: 1 }, { relevance_score: 0 }])).toBe(false);
    // A single row carries no comparison either way — not flagged.
    expect(rerankHasNoSignal(undefined, [{ relevance_score: 1 }])).toBe(false);
  });
});

describe('rerankPlan', () => {
  it('gives Qwen3 a longer Oracle budget and a smaller pool', () => {
    const q = rerankPlan('oracle', 'qwen_graded');
    expect(q.budgetMs).toBe(ORACLE_RERANK_QWEN_BUDGET_MS);
    expect(q.maxDocs).toBe(ORACLE_RERANK_QWEN_POOL);
    expect(q.mainBudgetMs).toBeLessThan(q.budgetMs);
    const n = rerankPlan('oracle', 'native');
    expect(n.budgetMs).toBe(ORACLE_RERANK_DEFAULT_BUDGET_MS);
    expect(n.maxDocs).toBe(100);
  });

  it('bounds the neighbour rerank and shrinks its Qwen pool', () => {
    expect(rerankPlan('neighbors', 'qwen_binary')).toMatchObject({
      budgetMs: NEIGHBOR_RERANK_BUDGET_MS,
      maxDocs: NEIGHBOR_RERANK_QWEN_POOL,
    });
    expect(rerankPlan('neighbors', 'native').budgetMs).toBe(NEIGHBOR_RERANK_BUDGET_MS);
  });
});

describe('applyOracleRerankShelves', () => {
  const win = window as unknown as { ollama?: unknown };
  let saved: unknown;
  const profile = emptyProfile();

  beforeEach(() => {
    saved = win.ollama;
    __resetRerankRunStoreForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    win.ollama = saved;
    vi.restoreAllMocks();
  });

  it('constant scores → no_signal, shelves untouched (not "applied")', async () => {
    const rerankLog = vi.fn();
    win.ollama = {
      rerank: vi.fn(async () => ({
        results: [
          { index: 0, relevance_score: 0 },
          { index: 1, relevance_score: 0 },
          { index: 2, relevance_score: 0 },
        ],
        via: 'qwen_binary',
        report: {
          requestId: null, tier: 'qwen_binary', scored: 3, requested: 3, elapsedMs: 10,
          scoreMin: 0, scoreMax: 0, scoreStdev: 0, truncated: false,
        },
      })),
      rerankLog,
    };
    const shelves = [shelf('A', ['g1', 'g2', 'g3'])];
    const out = await applyOracleRerankShelves(profile, shelves);
    expect(out.status.outcome).toBe('no_signal');
    expect(out.status.tier).toBe('qwen_binary');
    expect(out.shelves).toBe(shelves);
    expect(getLastRerankRun()?.outcome).toBe('no_signal');
    expect(rerankLog).toHaveBeenCalledWith(expect.stringContaining('outcome=no_signal'));
  });

  it('applied → reports positions moved and logs one summary line', async () => {
    const rerankLog = vi.fn();
    win.ollama = {
      rerank: vi.fn(async () => ({
        // pool order g1,g2,g3 → reranked g3,g2,g1
        results: [
          { index: 2, relevance_score: 0.97 },
          { index: 1, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.02 },
        ],
        via: 'qwen_graded',
        report: {
          requestId: null, tier: 'qwen_graded', scored: 3, requested: 3, elapsedMs: 7200,
          scoreMin: 0.02, scoreMax: 0.97, scoreStdev: 0.4, truncated: false,
        },
      })),
      rerankLog,
    };
    const out = await applyOracleRerankShelves(profile, [shelf('A', ['g1', 'g2', 'g3'])]);
    expect(out.status).toMatchObject({ outcome: 'applied', tier: 'qwen_graded', moved: 2, meanAbsDelta: 2 });
    expect(out.shelves[0].games.map((g) => g.gameId)).toEqual(['g3', 'g2', 'g1']);
    expect(rerankLog).toHaveBeenCalledTimes(1);
    const line = rerankLog.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[Rerank\] oracle tier=qwen_graded 3\/3 \d+\.\ds spread=0\.02–0\.97 moved=2 \(avgΔ2\.0\)$/);
    expect(getLastRerankRun()).toMatchObject({ source: 'oracle', outcome: 'applied', moved: 2 });
  });

  it('sends only the plan pool (top of the round-robin order) with request id + main budget', async () => {
    const rerank = vi.fn(async (_p: { documents: string[]; requestId?: string; budgetMs?: number }) => ({
      error: { code: 'http_error', message: 'x' },
    }));
    win.ollama = { rerank };
    const plan = { budgetMs: 10_000, mainBudgetMs: 8_500, maxDocs: 3 };
    const out = await applyOracleRerankShelves(
      profile,
      [shelf('A', ['a1', 'a2', 'a3']), shelf('B', ['b1', 'b2', 'b3'])],
      { plan },
    );
    expect(out.status.outcome).toBe('error');
    const payload = rerank.mock.calls[0][0];
    expect(payload.documents.map((d) => d.split(' | ')[0])).toEqual(['a1', 'b1', 'a2']);
    expect(payload.requestId).toMatch(/^oracle-/);
    expect(payload.budgetMs).toBe(plan.mainBudgetMs);
  });

  it('a main-process timeout is reported as a timeout, not a failure', async () => {
    win.ollama = { rerank: vi.fn(async () => ({ error: { code: 'timeout', message: 'slow' } })) };
    const out = await applyOracleRerankShelves(profile, [shelf('A', ['g1', 'g2'])]);
    expect(out.status.outcome).toBe('skipped_timeout');
  });

  it('cancels the main-process request when the caller aborts', async () => {
    const rerankCancel = vi.fn(async () => true);
    let resolveRerank: (v: unknown) => void = () => {};
    const rerank = vi.fn((_p: { requestId?: string }) => new Promise((r) => { resolveRerank = r; }));
    win.ollama = { rerank, rerankCancel };
    const ac = new AbortController();
    const p = applyOracleRerankShelves(profile, [shelf('A', ['g1', 'g2'])], { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const requestId = rerank.mock.calls[0][0].requestId;
    expect(rerankCancel).toHaveBeenCalledWith(requestId);
    expect(getLastRerankRun()?.outcome).toBe('skipped_timeout');
    resolveRerank({ error: { code: 'cancelled', message: 'Cancelled by the renderer' } });
    await p;
    // The late reply does not overwrite the recorded timeout.
    expect(getLastRerankRun()?.outcome).toBe('skipped_timeout');
  });
});

describe('formatRerankLogLine', () => {
  it('names the outcome when the run did not apply', () => {
    const line = formatRerankLogLine({
      source: 'neighbors', outcome: 'skipped_timeout', tier: null, at: 0, elapsedMs: 8000,
      scored: 0, requested: 24, moved: null, meanAbsDelta: null, scoreMin: null, scoreMax: null, truncated: false,
    });
    expect(line).toBe('[Rerank] neighbors tier=none outcome=skipped_timeout 0/24 8.0s');
  });
});
