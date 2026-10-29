/**
 * Pool-centric graph neighbours (v1.0.94): each library game's nearest candidates come from the pool
 * itself, so the graph signal reaches the candidates that are actually similar.
 */
import { describe, it, expect } from 'vitest';
import { computePoolNeighbors, GRAPH_NEIGHBOR_DISTANCE_CEILING } from '@/services/reco-scoring';
import { FIXTURE_NOW, candidatePool, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

const unit = (v: number[]) => {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / m);
};

describe('computePoolNeighbors', () => {
  const src = { gameId: 'lib-1', vector: unit([1, 0, 0, 0]) };
  const cands = [
    { gameId: 'near', embedding: unit([0.95, 0.1, 0, 0]) },
    { gameId: 'mid', embedding: unit([0.8, 0.6, 0, 0]) },
    { gameId: 'far', embedding: unit([0, 1, 0, 0]) },
    { gameId: 'novec' },
    { gameId: 'wrongdim', embedding: [1, 0] },
    { gameId: 'lib-1', embedding: unit([1, 0, 0, 0]) },
  ];

  it('keeps candidates within the distance ceiling, nearest first, never the source itself', () => {
    const { neighbors, hits } = computePoolNeighbors([src], cands, { k: 10, ceiling: 0.45 });
    expect(Object.keys(neighbors).sort()).toEqual(['mid', 'near']);
    expect(hits).toBe(2);
    expect(neighbors.near[0].d).toBeLessThan(neighbors.mid[0].d);
    expect(neighbors.near[0].u).toBe('lib-1');
  });

  it('caps each source at k neighbours', () => {
    const { neighbors } = computePoolNeighbors([src], cands, { k: 1, ceiling: 0.45 });
    expect(Object.keys(neighbors)).toEqual(['near']);
  });

  it('several sources stack hits on the same candidate', () => {
    const src2 = { gameId: 'lib-2', vector: unit([0.9, 0.2, 0, 0]) };
    const { neighbors } = computePoolNeighbors([src, src2], cands, { k: 10, ceiling: 0.45 });
    expect(neighbors.near.map(h => h.u).sort()).toEqual(['lib-1', 'lib-2']);
  });

  it('handles no sources / no vectors', () => {
    expect(computePoolNeighbors([], cands, { k: 5, ceiling: 0.45 }).hits).toBe(0);
    expect(computePoolNeighbors([src], [{ gameId: 'x' }], { k: 5, ceiling: 0.45 }).hits).toBe(0);
  });
});

describe('graph layer with pool neighbours', () => {
  it('fires for far more candidates when neighbours come from the pool', async () => {
    const library = multiTasteLibrary();
    const pool = candidatePool(80);
    // Give every candidate a vector close to one library game (same genre family).
    const vecFor = (i: number) => unit([1 + (i % 3) * 0.1, (i % 5) * 0.05, (i % 7) * 0.03, 0.2]);
    const sources = library.slice(0, 8).map((ug, i) => ({ gameId: ug.gameId, vector: vecFor(i) }));
    const withVec = pool.map((c, i) => ({ ...c, embedding: vecFor(i) }));
    const { neighbors } = computePoolNeighbors(sources, withVec, { k: 100, ceiling: GRAPH_NEIGHBOR_DISTANCE_CEILING });
    const result = await runWorkerPipeline(baseWorkerInput(library, pool, FIXTURE_NOW, {
      libraryNeighbors: neighbors, graphNeighborSource: 'pool',
    }));
    const graph = result.telemetry!.layers.find(l => l.layer === 'graphSignal')!;
    expect(graph.coverage).toBeGreaterThan(0.5);
    expect(result.telemetry!.graphNeighborSource).toBe('pool');
  });
});
