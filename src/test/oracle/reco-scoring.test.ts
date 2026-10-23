/**
 * Characterization tests for the scoring primitives extracted from
 * reco.worker.ts in v1.0.75, plus the new telemetry helper.
 *
 * The "CURRENT BEHAVIOR" tests pin real defects found in the Oracle audit so
 * the extraction is provably behavior-preserving; each is flipped by the
 * release named in its title (R2..R7 in the staged plan). When a later
 * release fixes one, update the assertion in the same commit.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGraphUserContext,
  buildTasteProfile,
  classifyEngagementCurve,
  computeGraphSignal,
  computePopularityAdjustment,
  computeQualitySignal,
  computeRecoTelemetry,
  mmrRerank,
  TELEMETRY_LAYERS,
} from '@/services/reco-scoring';
import {
  FIXTURE_NOW,
  backlogHeavyLibrary,
  candidatePool,
  makeCandidate,
  makeScored,
  makeUser,
  multiTasteLibrary,
} from './fixtures';

describe('computeGraphSignal — CURRENT BEHAVIOR (fixed in R2)', () => {
  it('saturates at 1.0 on a single match, so 1 match ties with 8 matches', () => {
    const loved = makeUser('steam-1', {
      title: 'Loved Game', hoursPlayed: 40, rating: 5, status: 'Completed',
      similarGameTitles: ['Target Game'],
    });
    const many = Array.from({ length: 8 }, (_, i) =>
      makeUser(`steam-${10 + i}`, {
        title: `Loved ${i}`, hoursPlayed: 40, rating: 5, status: 'Completed',
        similarGameTitles: ['Target Game'],
      }));
    const target = makeCandidate('steam-99', { title: 'Target Game' });

    const oneCtx = buildGraphUserContext([loved], FIXTURE_NOW);
    const one = computeGraphSignal(target, [loved], new Map(), oneCtx);
    const manyCtx = buildGraphUserContext(many, FIXTURE_NOW);
    const eight = computeGraphSignal(target, many, new Map(), manyCtx);

    expect(one.score).toBe(1);
    expect(eight.score).toBe(1);
  });

  it('returns 0 for a candidate with no similar-title link to the library', () => {
    const users = multiTasteLibrary();
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const c = makeCandidate('steam-99', { title: 'Unrelated', similarGameTitles: [] });
    expect(computeGraphSignal(c, users, new Map(), ctx).score).toBe(0);
  });
});

describe('computeQualitySignal — CURRENT BEHAVIOR (fixed in R5)', () => {
  it('rewards review volume over review ratio: 70%-positive/500k beats 97%-positive/2k', () => {
    const popular = makeCandidate('a', { reviewPositivity: 0.7, reviewVolume: 500_000, recommendations: 400_000 });
    const niche = makeCandidate('b', { reviewPositivity: 0.97, reviewVolume: 2_000, recommendations: 1_500 });
    const q = (c: ReturnType<typeof makeCandidate>) => computeQualitySignal(c, 500_000, 500_000);
    expect(q(popular)).toBeGreaterThan(q(niche));
  });

  it('stays within [0, 1]', () => {
    for (const c of candidatePool(40)) {
      const q = computeQualitySignal(c, 100_000, 200_000);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe('computePopularityAdjustment — CURRENT BEHAVIOR (fixed in R5)', () => {
  it('"debias" still increases with popularity: raw * adj is monotonic', () => {
    const max = 1_000_000;
    let prev = -1;
    for (const players of [10, 1_000, 50_000, 500_000, 1_000_000]) {
      const raw = Math.log(players + 1) / Math.log(max + 1);
      const signal = raw * computePopularityAdjustment(players, max);
      expect(signal).toBeGreaterThan(prev);
      prev = signal;
    }
  });
});

describe('buildTasteProfile — CURRENT BEHAVIOR (fixed in R4)', () => {
  it('lets a hated 1-star 80h game and a removed game raise their genres', () => {
    const profile = buildTasteProfile(multiTasteLibrary(), FIXTURE_NOW);
    const shooter = profile.genres.find(g => g.name.toLowerCase().includes('shooter'));
    expect(shooter).toBeDefined();
    expect(shooter!.weight).toBeGreaterThan(0);
  });

  it('is deterministic for the same input', () => {
    const a = buildTasteProfile(backlogHeavyLibrary(), FIXTURE_NOW);
    const b = buildTasteProfile(backlogHeavyLibrary(), FIXTURE_NOW);
    expect(a.genres.map(g => [g.name, g.weight])).toEqual(b.genres.map(g => [g.name, g.weight]));
  });
});

describe('classifyEngagementCurve — CURRENT BEHAVIOR (fixed in R5)', () => {
  it('labels a one-weekend completed 5-star game as binge-drop', () => {
    const t0 = FIXTURE_NOW - 10 * 86_400_000;
    const g = makeUser('x', {
      status: 'Completed', rating: 5, hoursPlayed: 20, sessionCount: 5,
      sessionTimestamps: [t0, t0 + 3_600_000, t0 + 7_200_000, t0 + 86_400_000, t0 + 90_000_000],
      sessionDurations: [180, 200, 220, 240, 260],
    });
    expect(classifyEngagementCurve(g)).toBe('binge-drop');
  });
});

describe('mmrRerank', () => {
  it('picks the highest score first and respects the limit', () => {
    const scored = [0.3, 0.9, 0.5, 0.7].map((s, i) => makeScored(`g${i}`, s, { genres: [`G${i}`] }));
    const out = mmrRerank(scored, 0.7, 3);
    expect(out).toHaveLength(3);
    expect(out[0].gameId).toBe('g1');
  });

  it('CURRENT BEHAVIOR (fixed in R7): with identical genres the penalty is constant and order equals score order', () => {
    const scored = [0.9, 0.8, 0.7, 0.6, 0.5].map((s, i) => makeScored(`g${i}`, s, { genres: ['RPG'] }));
    const out = mmrRerank(scored, 0.7, 5);
    expect(out.map(g => g.gameId)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
  });
});

describe('computeRecoTelemetry', () => {
  const funnel = { candidatesIn: 10, afterExclusions: 9, scored: 4, mmrPool: 4, mmrSelected: 3, shelfGames: 3 };

  it('reports per-layer coverage, spread and weights', () => {
    const scored = [
      makeScored('a', 0.9, { layerScores: { ...makeScored('x', 0).layerScores, graphSignal: 1, contentSimilarity: 0.5 } }),
      makeScored('b', 0.8, { layerScores: { ...makeScored('x', 0).layerScores, graphSignal: 0, contentSimilarity: 0.3 } }),
      makeScored('c', 0.7, { layerScores: { ...makeScored('x', 0).layerScores, graphSignal: 0, contentSimilarity: 0.1 } }),
      makeScored('d', 0.6, { layerScores: { ...makeScored('x', 0).layerScores, graphSignal: 0, contentSimilarity: 0 } }),
    ];
    const t = computeRecoTelemetry({
      scored, weights: { graphSignal: 0.14, contentSimilarity: 0.15 },
      funnel, embeddingCoverage: 0.5, mlCoverage: 0.25, graphScoresAvailable: false,
    });
    const graph = t.layers.find(l => l.layer === 'graphSignal')!;
    expect(graph.coverage).toBe(0.25);
    expect(graph.max).toBe(1);
    expect(graph.weight).toBe(0.14);
    const content = t.layers.find(l => l.layer === 'contentSimilarity')!;
    expect(content.coverage).toBe(0.75);
    expect(t.layers.map(l => l.layer)).toEqual([...TELEMETRY_LAYERS]);
    expect(t.weightSum).toBeCloseTo(0.29, 10);
    expect(t.mlCoverage).toBe(0.25);
  });

  it('counts ties among the top 20 scores', () => {
    const scored = [
      makeScored('a', 0.5), makeScored('b', 0.5), makeScored('c', 0.5),
      makeScored('d', 0.4), makeScored('e', 0.3),
    ];
    const t = computeRecoTelemetry({
      scored, weights: {}, funnel, embeddingCoverage: 0, mlCoverage: 0, graphScoresAvailable: false,
    });
    expect(t.top20Ties).toBe(3);
    expect(t.top20Distinct).toBe(3);
  });

  it('handles an empty pool without NaN', () => {
    const t = computeRecoTelemetry({
      scored: [], weights: {}, funnel, embeddingCoverage: 0, mlCoverage: 0, graphScoresAvailable: false,
    });
    expect(t.layers.every(l => l.coverage === 0 && Number.isFinite(l.median))).toBe(true);
    expect(t.top20Ties).toBe(0);
  });
});
