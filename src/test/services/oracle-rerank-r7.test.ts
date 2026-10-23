/**
 * R7 late stages: rerank scope, real score blend, tier gating, honest truncation, doc/query quality,
 * and the MMR rewrite (embedding similarity, relevance key, incremental max-sim).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_ORACLE_RERANK_BLEND,
  QWEN_BINARY_MAX_BLEND,
  ORACLE_RERANK_MAX_BLEND,
  RERANKABLE_SHELF_TYPES,
  applyOracleRerankShelves,
  blendShelfOrder,
  effectiveRerankBlend,
  scoredGameToRerankDoc,
  __resetRerankRunStoreForTests,
} from '@/services/oracle-rerank';
import { mmrRerank } from '@/services/reco-scoring';
import { MMR_SKETCH_DIM, dotUnit, embeddingSimilarityToUnit, sketchEmbedding } from '@/services/mmr-embedding';
import type { RecoShelf, ScoredGame, TasteProfile } from '@/types/reco';
import { makeScored } from '../oracle/fixtures';

const profile = {
  genres: [], themes: [], gameModes: [], perspectives: [], developers: [], publishers: [], eras: [],
  totalGames: 0, totalHours: 0, avgRating: 0, topGenre: 'RPG', topTheme: '', clusters: [],
  loyalDevelopers: [], loyalPublishers: [],
} as unknown as TasteProfile;

const g = (id: string, score: number, over: Partial<ScoredGame> = {}): ScoredGame =>
  makeScored(id, score, { title: id, ...over });
const shelf = (type: string, games: ScoredGame[]): RecoShelf => ({ type, title: type, games } as unknown as RecoShelf);

describe('rerank policy helpers', () => {
  it('scope covers taste-ordered shelves only', () => {
    for (const t of ['because-you-loved', 'deep-in-genre', 'from-studios-you-love']) {
      expect(RERANKABLE_SHELF_TYPES.has(t)).toBe(true);
    }
    // hero is a single game: nothing to reorder, so it is out of scope.
    for (const t of ['hero', 'stretch-picks', 'trending-now', 'critics-choice', 'deals-for-you', 'free-for-you', 'hidden-gems',
      'new-releases-for-you', 'coming-soon-for-you', 'for-your-mood', 'complete-the-series', 'backlog-advisor', 'unfinished-business']) {
      expect(RERANKABLE_SHELF_TYPES.has(t)).toBe(false);
    }
  });

  it('default blend is below 1', () => {
    expect(DEFAULT_ORACLE_RERANK_BLEND).toBeLessThan(1);
    expect(DEFAULT_ORACLE_RERANK_BLEND).toBeGreaterThan(0);
  });

  it('tier gating: cosine fallback never applies, binary is capped, others pass through', () => {
    expect(effectiveRerankBlend('embed_fallback', 0.6)).toBeNull();
    expect(effectiveRerankBlend('qwen_binary', 0.6)).toBe(QWEN_BINARY_MAX_BLEND);
    expect(effectiveRerankBlend('qwen_binary', 0.1)).toBe(0.1);
    expect(effectiveRerankBlend('native', 0.6)).toBe(0.6);
    expect(effectiveRerankBlend('qwen_graded', 0.6)).toBe(0.6);
    expect(effectiveRerankBlend(null, 0.6)).toBe(0.6);
    // Even a saved "100%" never hands the whole order to the reranker.
    expect(effectiveRerankBlend('native', 1)).toBe(ORACLE_RERANK_MAX_BLEND);
  });

  it('documents carry year, modes and similar-to links', () => {
    const doc = scoredGameToRerankDoc(g('x', 0.5, {
      title: 'Hades', genres: ['Roguelike'], themes: ['Mythology'], gameModes: ['Single-player'],
      releaseDate: '2020-09-17', reasons: { ...makeScored('y', 0).reasons, similarTo: ['Dead Cells', 'Celeste'] },
    }));
    expect(doc).toContain('Released: 2020');
    expect(doc).toContain('Modes: Single-player');
    expect(doc).toContain('Similar to: Dead Cells, Celeste');
  });
});

describe('blendShelfOrder', () => {
  const games = [g('a', 0.9), g('b', 0.8), g('c', 0.7), g('d', 0.6)];

  it('blend 0 keeps worker order; blend 1 follows the reranker', () => {
    const scores = new Map([['a', 0.1], ['b', 0.2], ['c', 0.9], ['d', 0.5]]);
    expect(blendShelfOrder(games, scores, 0).map(x => x.gameId)).toEqual(['a', 'b', 'c', 'd']);
    expect(blendShelfOrder(games, scores, 1).map(x => x.gameId)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('the worker term is shelf POSITION: a flat reranker never undoes the MMR (diversity) order', () => {
    // MMR interleaved a diverse pick (C 0.60) ahead of the franchise sibling B (0.79): raw-score re-sorting would put B back.
    const mmrOrder = [g('A', 0.80), g('C', 0.60), g('B', 0.79)];
    const flat = new Map([['A', 0.5], ['B', 0.5], ['C', 0.5]]);
    expect(blendShelfOrder(mmrOrder, flat, 0.6).map(x => x.gameId)).toEqual(['A', 'C', 'B']);
    expect(blendShelfOrder(mmrOrder, new Map(), 0.6).map(x => x.gameId)).toEqual(['A', 'C', 'B']);
  });

  it('a moderate reranker preference moves a game only as far as the blend allows', () => {
    const shelfGames = [g('a', 0.9), g('b', 0.8), g('c', 0.7)];
    const scores = new Map([['a', 0.4], ['b', 0.3], ['c', 0.6]]);
    // blend 0.3: c's rerank lead is not enough to pass a and b on worker position.
    expect(blendShelfOrder(shelfGames, scores, 0.3).map(x => x.gameId)).toEqual(['a', 'b', 'c']);
    expect(blendShelfOrder(shelfGames, scores, 0.85)[0].gameId).toBe('c');
  });

  it('games the reranker did not see are neutral and keep their relative worker position', () => {
    const scores = new Map([['a', 0.2], ['b', 0.9]]); // c, d unseen
    const out = blendShelfOrder(games, scores, 1).map(x => x.gameId);
    expect(out).toEqual(['b', 'c', 'd', 'a']);
  });

  it('single-game and empty shelves are returned as-is', () => {
    expect(blendShelfOrder([g('a', 0.5)], new Map([['a', 1]]), 1).map(x => x.gameId)).toEqual(['a']);
    expect(blendShelfOrder([], new Map(), 1)).toEqual([]);
  });
});

describe('applyOracleRerankShelves (R7 policy)', () => {
  const win = window as unknown as { ollama?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = win.ollama;
    __resetRerankRunStoreForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { win.ollama = saved; vi.restoreAllMocks(); });

  const bridge = (tier: string, order: number[]) => ({
    rerank: vi.fn(async (payload: { documents: string[] }) => ({
      results: order.slice(0, payload.documents.length).map((index, i) => ({ index, relevance_score: 1 - i * 0.1 })),
      via: tier,
      report: { requestId: null, tier, scored: payload.documents.length, requested: payload.documents.length, elapsedMs: 5, scoreMin: 0.1, scoreMax: 1, scoreStdev: 0.2, truncated: false },
    })),
  });

  it('only rerankable shelves reach the reranker and only they change', async () => {
    const hero = shelf('deep-in-genre', [g('h1', 0.9), g('h2', 0.8), g('h3', 0.7)]);
    const stretch = shelf('stretch-picks', [g('s1', 0.5), g('s2', 0.4), g('s3', 0.3)]);
    const b = bridge('native', [2, 1, 0]);
    win.ollama = b;
    const out = await applyOracleRerankShelves(profile, [hero, stretch], { blend: 1 });
    const sent = (b.rerank.mock.calls[0][0] as { documents: string[] }).documents;
    expect(sent).toHaveLength(3);
    expect(sent.join(' ')).not.toContain('s1');
    expect(out.status.outcome).toBe('applied');
    expect(out.shelves[1]).toBe(stretch); // untouched, same object
    expect(out.shelves[0].games.map(x => x.gameId)).toEqual(['h3', 'h2', 'h1']);
  });

  it('no rerankable shelf → empty pool, nothing sent', async () => {
    const b = bridge('native', [0]);
    win.ollama = b;
    const out = await applyOracleRerankShelves(profile, [shelf('trending-now', [g('t1', 0.5), g('t2', 0.4)])]);
    expect(out.status.outcome).toBe('skipped_empty_pool');
    expect(b.rerank).not.toHaveBeenCalled();
  });

  it('embed_fallback is not applied and says so', async () => {
    win.ollama = bridge('embed_fallback', [2, 1, 0]);
    const hero = shelf('deep-in-genre', [g('h1', 0.9), g('h2', 0.8), g('h3', 0.7)]);
    const out = await applyOracleRerankShelves(profile, [hero], { blend: 1 });
    expect(out.status.outcome).toBe('skipped_degraded_tier');
    expect(out.status.tier).toBe('embed_fallback');
    expect(out.shelves[0].games.map(x => x.gameId)).toEqual(['h1', 'h2', 'h3']);
  });

  it('qwen_binary only nudges (blend capped)', async () => {
    win.ollama = bridge('qwen_binary', [2, 1, 0]);
    // Worker scores far apart: a 0.3 blend cannot overturn them.
    const hero = shelf('deep-in-genre', [g('h1', 0.9), g('h2', 0.5), g('h3', 0.1)]);
    const out = await applyOracleRerankShelves(profile, [hero], { blend: 1 });
    expect(out.status.outcome).toBe('applied');
    expect(out.shelves[0].games.map(x => x.gameId)).toEqual(['h1', 'h2', 'h3']);
  });

  it('reports truncation when the pool cap hides eligible games', async () => {
    win.ollama = bridge('native', Array.from({ length: 100 }, (_, i) => i));
    const many = shelf('deep-in-genre', Array.from({ length: 130 }, (_, i) => g(`m${i}`, 1 - i / 200)));
    const out = await applyOracleRerankShelves(profile, [many], { blend: 0.6 });
    expect(out.status.outcome).toBe('applied');
    expect(out.status.truncated).toBe(true);
  });
});

describe('MMR (R7)', () => {
  const unitVec = (v: number[]) => { const m = Math.hypot(...v) || 1; return v.map(x => x / m); };

  it('hero is the most relevant by the caller key, not by plain score', () => {
    const pool = [g('low-score-high-align', 0.4), g('high-score', 0.6)];
    const out = mmrRerank(pool, 0.7, 2, undefined, { relevance: x => (x.gameId === 'low-score-high-align' ? 10 : 1) });
    expect(out[0].gameId).toBe('low-score-high-align');
  });

  it('uses embedding similarity to separate near-duplicates that share a genre set', () => {
    const base = { genres: ['RPG'], developer: 'X' };
    const a = g('a', 0.9, { ...base, developer: 'A', title: 'Alpha' });
    const dup = g('dup', 0.88, { ...base, developer: 'B', title: 'Bravo' });
    const other = g('other', 0.85, { ...base, developer: 'C', title: 'Charlie' });
    const vectors = {
      a: unitVec([1, 0, 0]),
      dup: unitVec([0.99, 0.05, 0]), // near-duplicate of a
      other: unitVec([0, 1, 0]),
    };
    const out = mmrRerank([a, dup, other], 0.6, 3, undefined, { vectors });
    expect(out.map(x => x.gameId)).toEqual(['a', 'other', 'dup']);
    // Without vectors the identical genre sets tie, so score order wins.
    expect(mmrRerank([a, dup, other], 0.6, 3).map(x => x.gameId)).toEqual(['a', 'dup', 'other']);
  });

  it('same franchise / developer similarity still applies', () => {
    const a = g('a', 0.9, { title: 'Mass Effect 2', developer: 'BioWare', genres: ['RPG'] });
    const b = g('b', 0.89, { title: 'Mass Effect 3', developer: 'BioWare', genres: ['RPG'] });
    const c = g('c', 0.6, { title: 'Hades', developer: 'Supergiant', genres: ['Roguelike'] });
    expect(mmrRerank([a, b, c], 0.5, 3).map(x => x.gameId)).toEqual(['a', 'c', 'b']);
  });

  it('limit <= 0 returns nothing and the limit is respected', () => {
    const pool = [g('a', 0.9), g('b', 0.8), g('c', 0.7)];
    expect(mmrRerank(pool, 0.7, 0)).toEqual([]);
    expect(mmrRerank(pool, 0.7, -3)).toEqual([]);
    expect(mmrRerank(pool, 0.7, 2)).toHaveLength(2);
    expect(mmrRerank([], 0.7, 5)).toEqual([]);
  });

  it('handles a large pool quickly (incremental max-sim)', () => {
    const pool = Array.from({ length: 500 }, (_, i) => g(`g${i}`, 1 - i / 600, { genres: [['RPG', 'Action', 'Puzzle'][i % 3]], developer: `d${i}`, title: `T${i}` }));
    const vectors: Record<string, number[]> = {};
    pool.forEach((p, i) => { vectors[p.gameId] = Array.from(sketchEmbedding(Array.from({ length: 64 }, (_, k) => Math.sin(i * 0.37 + k))) ?? []); });
    const t0 = Date.now();
    const out = mmrRerank(pool, 0.7, 80, undefined, { vectors });
    expect(out).toHaveLength(80);
    expect(new Set(out.map(x => x.gameId)).size).toBe(80);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('embedding sketches', () => {
  const rnd = (seed: number, n: number) => {
    let s = seed;
    return Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; });
  };
  const cosine = (a: number[], b: number[]) => {
    let d = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
    return d / Math.sqrt(ma * mb);
  };

  it('returns unit vectors of the sketch dimension, deterministically', () => {
    const v = rnd(1, 1024);
    const s1 = sketchEmbedding(v)!;
    const s2 = sketchEmbedding(v)!;
    expect(s1.length).toBe(MMR_SKETCH_DIM);
    expect(Array.from(s1)).toEqual(Array.from(s2));
    expect(Math.hypot(...Array.from(s1))).toBeCloseTo(1, 5);
  });

  it('approximately preserves cosine similarity', () => {
    const a = rnd(2, 1024);
    const near = a.map((x, i) => x + 0.15 * rnd(3, 1024)[i]);
    const far = rnd(4, 1024);
    const sNear = dotUnit(sketchEmbedding(a)!, sketchEmbedding(near)!);
    const sFar = dotUnit(sketchEmbedding(a)!, sketchEmbedding(far)!);
    expect(Math.abs(sNear - cosine(a, near))).toBeLessThan(0.15);
    expect(sNear).toBeGreaterThan(sFar + 0.5);
  });

  it('degenerate inputs', () => {
    expect(sketchEmbedding([])).toBeNull();
    expect(sketchEmbedding([0, 0, 0])).toBeNull();
  });

  it('embeddingSimilarityToUnit maps unrelated to 0 and identical to 1', () => {
    expect(embeddingSimilarityToUnit(0.4)).toBe(0);
    expect(embeddingSimilarityToUnit(0.1)).toBe(0);
    expect(embeddingSimilarityToUnit(1)).toBe(1);
  });
});
