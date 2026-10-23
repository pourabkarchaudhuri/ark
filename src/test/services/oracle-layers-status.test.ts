/** Dev-panel "Oracle Layers" row: flags layers that carry weight but never fire. */
import { describe, it, expect } from 'vitest';
import { oracleLayersStatus } from '@/services/system-status';
import type { RecoTelemetry } from '@/types/reco';

const base: RecoTelemetry = {
  layers: [],
  top20Ties: 4,
  top20Distinct: 12,
  funnel: { candidatesIn: 1, afterExclusions: 1, scored: 1, mmrPool: 1, mmrSelected: 1, shelfGames: 1 },
  embeddingCoverage: 0.5,
  mlCoverage: 0.25,
  graphScoresAvailable: false,
  weightSum: 1,
};

describe('oracleLayersStatus', () => {
  it('returns null before the first run', () => {
    expect(oracleLayersStatus(null)).toBeNull();
  });

  it('flags weighted layers that are non-zero for under 5% of candidates', () => {
    const s = oracleLayersStatus({
      ...base,
      layers: [
        { layer: 'graphSignal', coverage: 0.02, min: 0, median: 0, max: 1, weight: 0.14 },
        { layer: 'contentSimilarity', coverage: 0.9, min: 0, median: 0.2, max: 0.9, weight: 0.15 },
        { layer: 'clusterSemanticSim', coverage: 0, min: 0, median: 0, max: 0, weight: 0 },
      ],
    })!;
    expect(s.deadLayers).toEqual(['graphSignal']);
    expect(s.stage).toBe('error');
    expect(s.detail).toContain('1 dead layer');
    expect(s.detail).toContain('top-20 ties 4');
    expect(s.detail).toContain('ML 25%');
    // Zero-weight layers are not listed.
    expect(s.layers.map(l => l.layer)).toEqual(['contentSimilarity', 'graphSignal']);
  });

  it('is healthy when every weighted layer fires', () => {
    const s = oracleLayersStatus({
      ...base,
      layers: [{ layer: 'contentSimilarity', coverage: 0.8, min: 0, median: 0.1, max: 0.9, weight: 0.15 }],
    })!;
    expect(s.stage).toBe('done');
    expect(s.deadLayers).toEqual([]);
  });
});
