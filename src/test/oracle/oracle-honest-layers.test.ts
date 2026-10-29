/**
 * v1.0.92: weights only go to layers that can fire, conditional layers are "sparse" rather than
 * "dead", franchise penalties count as activity, feedback outside the pool is used, and the dev
 * panel shows a feedback counter.
 */
import { describe, it, expect } from 'vitest';
import { assembleWeights, computeRecoTelemetry, CONDITIONAL_LAYERS, WEIGHT_TOTAL } from '@/services/reco-scoring';
import { feedbackLine, oracleLayersStatus } from '@/services/system-status';
import { FIXTURE_NOW, candidatePool, makeCandidate, makeScored, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';
import type { RecoTelemetry } from '@/types/reco';

const base = { embeddingCoverage: 0.74, hasClusterScores: true, hasGraphScores: true, mlCoverage: 0.43, graphSignalCoverage: 0.014 };
const positiveSum = (w: Record<string, number>) => Object.entries(w).filter(([k]) => k !== 'W_NEGATIVE').reduce((s, [, v]) => s + v, 0);

describe('assembleWeights — inactive feedback layers get no weight', () => {
  it('defaults keep the previous table', () => {
    const w = assembleWeights(base);
    expect(w.W_NEGATIVE).toBeGreaterThan(0);
    expect(w.W_POSITIVE).toBeGreaterThan(0);
  });

  it('no thumbs-up: W_POSITIVE is 0 and its budget is shared by the others (total stays 1)', () => {
    const before = assembleWeights(base);
    const after = assembleWeights({ ...base, positiveActive: false });
    expect(after.W_POSITIVE).toBe(0);
    expect(positiveSum(after as unknown as Record<string, number>)).toBeCloseTo(WEIGHT_TOTAL, 10);
    expect(after.W_CONTENT).toBeGreaterThan(before.W_CONTENT);
    expect(after.W_QUALITY).toBeGreaterThan(before.W_QUALITY);
  });

  it('no negative profile: W_NEGATIVE is 0 and nothing else moves (it is outside the positive sum)', () => {
    const before = assembleWeights(base);
    const after = assembleWeights({ ...base, negativeActive: false });
    expect(after.W_NEGATIVE).toBe(0);
    expect(after.W_CONTENT).toBeCloseTo(before.W_CONTENT, 12);
  });
});

describe('computeRecoTelemetry', () => {
  it('counts a franchise dislike penalty as activity and tags layer kinds', () => {
    const scored = [
      makeScored('a', 0.5, { layerScores: { franchiseBoost: -0.4 } as never }),
      makeScored('b', 0.4, { layerScores: { franchiseBoost: 0 } as never }),
    ];
    const t = computeRecoTelemetry({
      scored, weights: { franchiseBoost: 0.07, contentSimilarity: 0.3 },
      funnel: { candidatesIn: 2, afterExclusions: 2, scored: 2, mmrPool: 2, mmrSelected: 2, shelfGames: 2 },
      embeddingCoverage: 1, mlCoverage: 1, graphScoresAvailable: true,
      conditional: { franchiseBoost: { active: true, note: 'fires only for games in franchises you have played' } },
    });
    const fr = t.layers.find(l => l.layer === 'franchiseBoost')!;
    expect(fr.coverage).toBe(0.5);
    expect(fr.kind).toBe('conditional');
    expect(fr.note).toMatch(/franchises/);
    expect(t.layers.find(l => l.layer === 'contentSimilarity')!.kind).toBe('core');
    expect(CONDITIONAL_LAYERS.has('graphSignal')).toBe(false);
  });
});

function telemetry(layers: Array<Partial<RecoTelemetry['layers'][number]> & { layer: string }>): RecoTelemetry {
  return {
    layers: layers.map(l => ({ coverage: 0, min: 0, median: 0, max: 0, weight: 0.05, ...l })) as RecoTelemetry['layers'],
    top20Ties: 0, top20Distinct: 20,
    funnel: { candidatesIn: 1, afterExclusions: 1, scored: 1, mmrPool: 1, mmrSelected: 1, shelfGames: 1 },
    embeddingCoverage: 0.74, mlCoverage: 0.43, graphScoresAvailable: true, weightSum: 1,
    feedback: { up: 12, down: 3, dismissed: 5, usedUp: 9, usedDown: 3, usedDismissed: 5 },
  };
}

describe('oracleLayersStatus (dev panel)', () => {
  it('a sparse conditional layer is not "dead"; a sparse core layer is', () => {
    const s = oracleLayersStatus(telemetry([
      { layer: 'franchiseBoost', coverage: 0.02, kind: 'conditional' },
      { layer: 'positiveAffinity', coverage: 0, weight: 0, kind: 'conditional', active: false, note: 'no thumbs-up yet' },
      { layer: 'graphSignal', coverage: 0.04, kind: 'core' },
      { layer: 'contentSimilarity', coverage: 0.99, weight: 0.3, kind: 'core' },
    ]))!;
    expect(s.deadLayers).toEqual(['graphSignal']);
    expect(s.sparseLayers.sort()).toEqual(['franchiseBoost', 'positiveAffinity']);
    expect(s.detail).toMatch(/1 dead layer · 2 sparse/);
    expect(s.detail).toContain('👍 12 (9 used) · 👎 3 · dismissed 5');
  });

  it('shows the feedback counter before the first compute', () => {
    const s = oracleLayersStatus(null, { up: 2, down: 0, dismissed: 1 })!;
    expect(s.stage).toBe('idle');
    expect(s.detail).toContain(feedbackLine({ up: 2, down: 0, dismissed: 1 }));
    expect(oracleLayersStatus(null)).toBeNull();
  });
});

describe('worker: feedback outside the candidate pool still counts', () => {
  it('a thumbs-up game the pre-filter dropped feeds the positive profile', async () => {
    const liked = makeCandidate('steam-99001', { title: 'Liked Elsewhere', genres: ['Strategy'], developer: 'Somebody' });
    const without = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(60), FIXTURE_NOW, { thumbsUpIds: ['steam-99001'] }));
    const withFb = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(60), FIXTURE_NOW, {
      thumbsUpIds: ['steam-99001'], feedbackCandidates: [liked],
    }));
    expect(without.telemetry!.feedback!.usedUp).toBe(0);
    expect(withFb.telemetry!.feedback!.usedUp).toBe(1);
    const posWithout = without.telemetry!.layers.find(l => l.layer === 'positiveAffinity')!;
    const posWith = withFb.telemetry!.layers.find(l => l.layer === 'positiveAffinity')!;
    expect(posWithout.weight).toBe(0);
    expect(posWithout.active).toBe(false);
    expect(posWith.weight).toBeGreaterThan(0);
  });
});
