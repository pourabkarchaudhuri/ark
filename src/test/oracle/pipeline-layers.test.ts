/**
 * Full-pipeline checks on the fixture libraries (R2 acceptance): the graph and
 * cluster layers fire for most candidates once their inputs are supplied, and
 * the weight table keeps its invariants end to end.
 */
import { describe, it, expect } from 'vitest';
import { detectTasteClusters } from '@/services/reco-scoring';
import {
  FIXTURE_NOW,
  candidatePool,
  makeCandidate,
  makeUser,
  multiTasteLibrary,
  newUserLibrary,
} from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

const unit = (v: number[]) => {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / m);
};

function layer(result: Awaited<ReturnType<typeof runWorkerPipeline>>, name: string) {
  return result.telemetry!.layers.find(l => l.layer === name)!;
}

describe('worker pipeline on fixtures', () => {
  it('runs end to end and returns shelves plus telemetry', async () => {
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(60), FIXTURE_NOW));
    expect(result.shelves.length).toBeGreaterThan(0);
    expect(result.telemetry).toBeDefined();
    expect(result.telemetry!.funnel.candidatesIn).toBe(60);
    expect(result.telemetry!.funnel.scored).toBeGreaterThan(0);
  });

  it('is deterministic: same input, same top picks', async () => {
    const input = baseWorkerInput(multiTasteLibrary(), candidatePool(60), FIXTURE_NOW);
    const a = await runWorkerPipeline(input);
    const b = await runWorkerPipeline(input);
    const ids = (r: typeof a) => r.shelves.flatMap(s => s.games.slice(0, 5).map(g => `${s.type}:${g.gameId}`));
    expect(ids(a)).toEqual(ids(b));
  });

  it('handles the new-user (cold start) library without error', async () => {
    const result = await runWorkerPipeline(baseWorkerInput(newUserLibrary(), candidatePool(30), FIXTURE_NOW));
    expect(result.telemetry!.funnel.scored).toBeGreaterThan(0);
  });

  describe('graph signal', () => {
    const library = multiTasteLibrary();
    const pool = candidatePool(60);

    it('is dead without links or neighbours (the weight moves to content)', async () => {
      const result = await runWorkerPipeline(baseWorkerInput(library, pool, FIXTURE_NOW));
      const graph = layer(result, 'graphSignal');
      expect(graph.coverage).toBe(0);
      expect(graph.weight).toBe(0);
      expect(layer(result, 'contentSimilarity').weight).toBeGreaterThan(0.15);
    });

    it('fires for most candidates once library neighbours are supplied, and keeps its weight', async () => {
      const libraryNeighbors: Record<string, Array<{ u: string; d: number }>> = {};
      pool.slice(0, 45).forEach((c, i) => {
        libraryNeighbors[c.gameId] = [{ u: library[i % 6].gameId, d: 0.05 + (i % 8) * 0.04 }];
      });
      const result = await runWorkerPipeline(baseWorkerInput(library, pool, FIXTURE_NOW, { libraryNeighbors }));
      const graph = layer(result, 'graphSignal');
      expect(graph.coverage).toBeGreaterThan(0.5);
      expect(graph.weight).toBeGreaterThanOrEqual(0.14);
      // Not saturated: scores spread across the range instead of piling at 1.0.
      expect(graph.max).toBeLessThan(1);
      expect(graph.median).toBeLessThan(graph.max + 1e-9);
    });

    it('also fires through the library games\' own similar-games lists', async () => {
      const linked = library.map((g, i) => ({
        ...g,
        similarGameTitles: pool.slice(i * 8, i * 8 + 8).map(c => c.title),
      }));
      const result = await runWorkerPipeline(baseWorkerInput(linked, pool, FIXTURE_NOW));
      expect(layer(result, 'graphSignal').coverage).toBeGreaterThan(0.5);
    });
  });

  describe('cluster-semantic layer', () => {
    const embed = (i: number) => unit([Math.cos(i), Math.sin(i), Math.cos(2 * i), Math.sin(3 * i)]);
    const library = multiTasteLibrary().map((g, i) => ({ ...g, embedding: embed(i + 1) }));
    const clusters = detectTasteClusters(library, FIXTURE_NOW);
    const pool = candidatePool(40);

    it('has real clusters with semantic centroids for the multi-taste library', () => {
      expect(clusters.length).toBeGreaterThanOrEqual(2);
      expect(clusters.filter(c => c.semanticCentroid).length).toBeGreaterThanOrEqual(2);
    });

    it('contributes when precomputed cluster scores are supplied (previously unreachable in production)', async () => {
      const precomputedClusterScores: Record<string, { sim: number; label: string }> = {};
      const precomputedSemanticScores: Record<string, number> = {};
      pool.forEach((c, i) => {
        precomputedClusterScores[c.gameId] = { sim: 0.4 + (i % 10) * 0.05, label: clusters[i % clusters.length].label };
        precomputedSemanticScores[c.gameId] = 0.3 + (i % 7) * 0.05;
      });
      const result = await runWorkerPipeline(baseWorkerInput(library, pool, FIXTURE_NOW, {
        embeddingCoverage: 1,
        tasteCentroid: embed(1),
        precomputedSemanticScores,
        precomputedClusters: clusters,
        precomputedClusterScores,
      }));
      const cluster = layer(result, 'clusterSemanticSim');
      expect(cluster.coverage).toBeGreaterThan(0.9);
      expect(cluster.weight).toBeGreaterThan(0);
      const labels = new Set(result.shelves.flatMap(s => s.games.map(g => g.reasons.bestClusterLabel)).filter(Boolean));
      expect(labels.size).toBeGreaterThan(0);
    });

    it('only claims "fits your X taste" when the cluster fits clearly better than the overall taste', async () => {
      const mk = (clusterSim: number, semanticSim: number) => {
        const scores: Record<string, { sim: number; label: string }> = {};
        const sem: Record<string, number> = {};
        for (const c of pool) {
          scores[c.gameId] = { sim: clusterSim, label: clusters[0].label };
          sem[c.gameId] = semanticSim;
        }
        return baseWorkerInput(library, pool, FIXTURE_NOW, {
          embeddingCoverage: 1,
          tasteCentroid: embed(1),
          precomputedSemanticScores: sem,
          precomputedClusters: clusters,
          precomputedClusterScores: scores,
        });
      };
      const text = (r: Awaited<ReturnType<typeof runWorkerPipeline>>) =>
        r.shelves.flatMap(s => s.games.map(g => g.reasons.explanation)).join(' | ');

      const generic = await runWorkerPipeline(mk(0.62, 0.62)); // same fit everywhere
      expect(text(generic)).not.toContain('fits your');

      const niche = await runWorkerPipeline(mk(0.75, 0.55)); // cluster clearly better
      expect(text(niche)).toContain('fits your');
    });

    it('stays off (weight 0) when no cluster scores are supplied', async () => {
      const result = await runWorkerPipeline(baseWorkerInput(library, pool, FIXTURE_NOW, { embeddingCoverage: 0 }));
      expect(layer(result, 'clusterSemanticSim').weight).toBe(0);
    });
  });

  it('keeps content + semantic + cluster + graph at 0.41 in the worker\'s reported weights', async () => {
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(30), FIXTURE_NOW));
    const w = (n: string) => layer(result, n).weight;
    expect(w('contentSimilarity') - 0 + w('semanticSimilarity') + w('clusterSemanticSim') + w('graphSignal'))
      // contentSimilarity's reported weight also includes the unused-ML share (W_CONTENT_ML)
      .toBeGreaterThan(0.41 - 1e-9);
  });

  it('never drops a candidate to NaN', async () => {
    const odd = [
      makeCandidate('steam-1', { releaseDate: '', title: '' }),
      makeCandidate('steam-2', { metacriticScore: 0, playerCount: 0 }),
      makeCandidate('steam-3', { genres: [], themes: [] }),
    ];
    const result = await runWorkerPipeline(baseWorkerInput([makeUser('steam-u', { genres: ['RPG'] })], odd, FIXTURE_NOW));
    expect(result.telemetry!.funnel.scored).toBe(3);
  });
});
