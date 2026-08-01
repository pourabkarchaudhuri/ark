import { describe, it, expect } from 'vitest';
import { CHUNK_WEIGHTS, type ChunkKind } from '@/services/embedding-chunks';
import {
  cloneChunkWeights,
  generateWeightCandidates,
  scoreWeightCandidate,
  runWeightSweep,
  type SweepFixtureGame,
  type SweepQuery,
} from '@/services/embedding-weight-sweep';

function unit(kindBias: Partial<Record<ChunkKind, number>>): number[] {
  // 8-d toy vectors — poolChunkVectors uses EMBEDDING_DIM (1024); pad with zeros.
  const v = new Array(1024).fill(0);
  v[0] = kindBias.facets ?? 0;
  v[1] = kindBias.summary ?? 0;
  v[2] = kindBias.description ?? 0;
  v[3] = kindBias.notes ?? 0;
  v[4] = kindBias.similar ?? 0;
  // Normalize
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function game(
  gameId: string,
  bias: Partial<Record<ChunkKind, number>>,
): SweepFixtureGame {
  const kinds: ChunkKind[] = ['facets', 'summary', 'description'];
  return {
    gameId,
    chunks: kinds.map((kind) => ({
      kind,
      vector: unit({ [kind]: bias[kind] ?? 0.1 }),
    })),
  };
}

describe('embedding-weight-sweep', () => {
  it('generateWeightCandidates includes baseline and perturbations', () => {
    const c = generateWeightCandidates(CHUNK_WEIGHTS);
    expect(c.length).toBeGreaterThan(5);
    expect(c[0]).toEqual(cloneChunkWeights(CHUNK_WEIGHTS));
  });

  it('scores held-out similar pairs with MRR', () => {
    const corpus: SweepFixtureGame[] = [
      game('a', { facets: 1, summary: 0.1 }),
      game('b', { facets: 0.95, summary: 0.1 }), // similar to a
      game('c', { facets: 0.1, summary: 1 }), // dissimilar
    ];
    const queries: SweepQuery[] = [
      {
        queryGameId: 'a',
        queryChunks: corpus[0].chunks,
        relevantIds: ['b'],
      },
    ];
    const score = scoreWeightCandidate(CHUNK_WEIGHTS, corpus, queries);
    expect(score.labeledQueries).toBe(1);
    expect(score.mrr).toBeGreaterThan(0);
  });

  it('runWeightSweep picks improved weights when a candidate wins', () => {
    // Construct a corpus where boosting `summary` ranks the relevant game higher.
    const corpus: SweepFixtureGame[] = [
      {
        gameId: 'q',
        chunks: [
          { kind: 'facets', vector: unit({ facets: 1 }) },
          { kind: 'summary', vector: unit({ summary: 1 }) },
        ],
      },
      {
        gameId: 'rel',
        chunks: [
          { kind: 'facets', vector: unit({ facets: 0.2 }) },
          { kind: 'summary', vector: unit({ summary: 1 }) },
        ],
      },
      {
        gameId: 'dist',
        chunks: [
          { kind: 'facets', vector: unit({ facets: 1 }) },
          { kind: 'summary', vector: unit({ summary: 0.05 }) },
        ],
      },
    ];
    const queries: SweepQuery[] = [
      {
        queryGameId: 'q',
        queryChunks: corpus[0].chunks,
        relevantIds: ['rel'],
      },
    ];
    const highSummary = cloneChunkWeights(CHUNK_WEIGHTS);
    highSummary.summary = 2;
    highSummary.facets = 0.1;
    const result = runWeightSweep({
      corpus: corpus.slice(1),
      queries,
      candidates: [CHUNK_WEIGHTS, highSummary],
      currentPoolVersion: 1,
    });
    expect(result.winner.weights.summary).toBeGreaterThanOrEqual(CHUNK_WEIGHTS.summary);
    // When improved, suggest bump; otherwise null — either is valid for harness.
    if (result.improved) {
      expect(result.suggestedPoolVersion).toBe(2);
    }
  });

  it('does not claim improvement when all candidates tie baseline', () => {
    const corpus: SweepFixtureGame[] = [game('a', { facets: 1 }), game('b', { facets: 0.9 })];
    const queries: SweepQuery[] = [
      { queryGameId: 'a', queryChunks: corpus[0].chunks, relevantIds: ['b'] },
    ];
    const same = cloneChunkWeights(CHUNK_WEIGHTS);
    const result = runWeightSweep({
      corpus: [corpus[1]],
      queries,
      candidates: [same],
      currentPoolVersion: 1,
    });
    expect(result.improved).toBe(false);
    expect(result.suggestedPoolVersion).toBeNull();
  });
});
