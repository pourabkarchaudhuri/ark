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
  buildTasteProfile,
  _engagementCache,
  classifyEngagementCurve,
  computePopularitySignal,
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

describe('computeQualitySignal', () => {
  it('positivity outweighs volume: 97%-positive/2k beats 70%-positive/500k (R5)', () => {
    const popular = makeCandidate('a', { reviewPositivity: 0.7, reviewVolume: 500_000, recommendations: 400_000 });
    const niche = makeCandidate('b', { reviewPositivity: 0.97, reviewVolume: 2_000, recommendations: 1_500 });
    expect(computeQualitySignal(niche)).toBeGreaterThan(computeQualitySignal(popular));
  });

  it('stays within [0, 1]', () => {
    for (const c of candidatePool(40)) {
      const q = computeQualitySignal(c);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe('computePopularitySignal', () => {
  it('debiases: the signal decreases monotonically with popularity (R5)', () => {
    const max = 1_000_000;
    let prev = Infinity;
    for (const players of [10, 1_000, 50_000, 500_000, 1_000_000]) {
      const signal = computePopularitySignal(players, max);
      expect(signal).toBeLessThan(prev);
      prev = signal;
    }
  });
});

describe('buildTasteProfile', () => {
  it('does not let a hated 1-star 80h game or a removed game raise their genres (R4)', () => {
    _engagementCache.clear();
    const profile = buildTasteProfile(multiTasteLibrary(), FIXTURE_NOW);
    const shooter = profile.genres.find(g => g.name.toLowerCase().includes('shooter'));
    expect(shooter?.weight ?? 0).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const a = buildTasteProfile(backlogHeavyLibrary(), FIXTURE_NOW);
    const b = buildTasteProfile(backlogHeavyLibrary(), FIXTURE_NOW);
    expect(a.genres.map(g => [g.name, g.weight])).toEqual(b.genres.map(g => [g.name, g.weight]));
  });
});

describe('classifyEngagementCurve', () => {
  it('does not label a one-weekend completed 5-star game as binge-drop (R5)', () => {
    const t0 = FIXTURE_NOW - 10 * 86_400_000;
    const g = makeUser('x', {
      status: 'Completed', rating: 5, hoursPlayed: 20, sessionCount: 5,
      sessionTimestamps: [t0, t0 + 3_600_000, t0 + 7_200_000, t0 + 86_400_000, t0 + 90_000_000],
      sessionDurations: [180, 200, 220, 240, 260],
    });
    expect(classifyEngagementCurve(g)).not.toBe('binge-drop');
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
