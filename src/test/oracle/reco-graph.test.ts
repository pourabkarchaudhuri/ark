/**
 * R2 (v1.0.76): the graph, cluster and weight-assembly layers.
 *
 * Before R2 the graph signal saturated at 1.0 on a single match (so 1 match
 * tied with 8), its co-occurrence branch compared game ids to titles and could
 * never fire, titles only matched case-insensitively, the cluster-semantic
 * layer was unreachable in production, and k-means used Math.random().
 */
import { describe, it, expect } from 'vitest';
import {
  GRAPH_FULL_COVERAGE,
  GRAPH_MIN_HIT_STRENGTH,
  GRAPH_NEIGHBOR_DISTANCE_CEILING,
  assembleWeights,
  bestClusterSimilarity,
  bestPreparedClusterSimilarity,
  prepareClusterCentroids,
  buildGraphUserContext,
  computeGraphSignal,
  detectTasteClusters,
  normalizeTitleKey,
  WEIGHT_TOTAL,
} from '@/services/reco-scoring';
import type { TasteCluster } from '@/types/reco';
import { FIXTURE_NOW, makeCandidate, makeUser, multiTasteLibrary } from './fixtures';

describe('normalizeTitleKey', () => {
  it.each([
    ['The Witcher® 3: Wild Hunt', 'the witcher 3 wild hunt'],
    ['The Witcher 3: Wild Hunt – Game of the Year Edition', 'the witcher 3 wild hunt'],
    ['Skyrim Special Edition', 'skyrim'],
    ['Dark Souls: Remastered', 'dark souls'],
    ['Pokémon Café ReMix', 'pokemon cafe remix'],
    ['  DOOM (2016)  ', 'doom 2016'],
    ['Ultimate Chicken Horse', 'ultimate chicken horse'],
    ['Gold Rush!', 'gold rush'],
  ])('%s -> %s', (raw, key) => {
    expect(normalizeTitleKey(raw)).toBe(key);
  });

  it('keeps non-Latin titles distinct instead of collapsing them all to the empty string', () => {
    const keys = ['\u30c9\u30e9\u30b4\u30f3\u30af\u30a8\u30b9\u30c8', '\u9ed1\u795e\u8bdd\uff1a\u609f\u7a7a', '\u0421\u0442\u0430\u043b\u043a\u0435\u0440'].map(normalizeTitleKey);
    for (const k of keys) expect(k).not.toBe('');
    expect(new Set(keys).size).toBe(3);
  });

  it('makes differently-decorated titles of the same game equal', () => {
    expect(normalizeTitleKey('The Witcher 3: Wild Hunt')).toBe(normalizeTitleKey('The Witcher® 3: Wild Hunt'));
  });
});

describe('computeGraphSignal', () => {
  const loved = (n: number, similar: string[]) =>
    Array.from({ length: n }, (_, i) =>
      makeUser(`steam-${10 + i}`, {
        title: `Loved ${i}`, hoursPlayed: 40, rating: 5, status: 'Completed', similarGameTitles: similar,
      }));

  it('scales with how many loved games relate to the candidate (1 match no longer ties with 8)', () => {
    const target = makeCandidate('steam-99', { title: 'Target Game' });
    const eight = loved(8, ['Target Game']);
    const oneOfEight = eight.map((u, i) => (i === 0 ? u : { ...u, similarGameTitles: [] as string[] }));
    const one = computeGraphSignal(target, oneOfEight, undefined, buildGraphUserContext(oneOfEight, FIXTURE_NOW));
    const all = computeGraphSignal(target, eight, undefined, buildGraphUserContext(eight, FIXTURE_NOW));
    expect(one.score).toBeGreaterThan(0);
    expect(one.score).toBeLessThan(0.5);
    expect(all.score).toBeGreaterThan(0.9);
    expect(all.score).toBeGreaterThan(one.score + 0.4);
  });

  it('matches titles through decoration differences', () => {
    const users = [makeUser('steam-1', {
      title: 'Loved', hoursPlayed: 40, rating: 5, status: 'Completed',
      similarGameTitles: ['The Witcher 3: Wild Hunt'],
    })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const c = makeCandidate('steam-99', { title: 'The Witcher® 3: Wild Hunt - Game of the Year Edition' });
    expect(computeGraphSignal(c, users, undefined, ctx).score).toBeGreaterThan(0);
  });

  it('uses embedding-neighbour hits: closer neighbours score higher, beyond the ceiling scores zero', () => {
    const users = [makeUser('steam-1', { title: 'Loved', hoursPlayed: 40, rating: 5, status: 'Completed' })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const c = makeCandidate('steam-99', { title: 'No Title Link' });
    const near = computeGraphSignal(c, users, [{ u: 'steam-1', d: 0.05 }], ctx).score;
    const far = computeGraphSignal(c, users, [{ u: 'steam-1', d: 0.30 }], ctx).score;
    const beyond = computeGraphSignal(c, users, [{ u: 'steam-1', d: 0.60 }], ctx).score;
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(beyond).toBe(0);
  });

  it('ignores weak neighbour hits near the distance ceiling (no phantom coverage or explanations)', () => {
    const users = [makeUser('steam-1', { title: 'Loved', hoursPlayed: 40, rating: 5, status: 'Completed' })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const c = makeCandidate('steam-99', { title: 'Barely Related' });
    // Strength = 1 - d/0.45; anything under GRAPH_MIN_HIT_STRENGTH is noise.
    const dWeak = GRAPH_NEIGHBOR_DISTANCE_CEILING * (1 - GRAPH_MIN_HIT_STRENGTH) + 0.005;
    const weak = computeGraphSignal(c, users, [{ u: 'steam-1', d: dWeak }], ctx);
    expect(weak.score).toBe(0);
    expect(weak.similarTo).toEqual([]);
    const dOk = GRAPH_NEIGHBOR_DISTANCE_CEILING * (1 - GRAPH_MIN_HIT_STRENGTH) - 0.005;
    const ok = computeGraphSignal(c, users, [{ u: 'steam-1', d: dOk }], ctx);
    expect(ok.score).toBeGreaterThan(0);
    expect(ok.similarTo).toEqual(['Loved']);
  });

  it('does not let empty/non-Latin keys create false title matches', () => {
    const users = [makeUser('steam-1', {
      title: '!!!', hoursPlayed: 40, rating: 5, status: 'Completed',
      similarGameTitles: ['!!!', '???'],
    })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    // Titles made only of punctuation normalise to '' — they must never match each other.
    const c = makeCandidate('steam-99', { title: '...', similarGameTitles: ['***', '!!!'] });
    expect(computeGraphSignal(c, users, undefined, ctx).score).toBe(0);
  });

  it('matches a non-Latin similar-title only to the same title', () => {
    const jp = '\u30c9\u30e9\u30b4\u30f3\u30af\u30a8\u30b9\u30c8';
    const users = [makeUser('steam-1', { hoursPlayed: 40, rating: 5, status: 'Completed', similarGameTitles: [jp] })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    expect(computeGraphSignal(makeCandidate('steam-2', { title: jp }), users, undefined, ctx).score).toBeGreaterThan(0);
    expect(computeGraphSignal(makeCandidate('steam-3', { title: '\u9ed1\u795e\u8bdd' }), users, undefined, ctx).score).toBe(0);
  });

  it('removed library games neither set the reference mass nor contribute evidence', () => {
    const live = makeUser('steam-1', { title: 'Live', hoursPlayed: 40, rating: 5, status: 'Completed', similarGameTitles: ['Target'] });
    const removed = makeUser('steam-2', { title: 'Removed', hoursPlayed: 400, rating: 5, status: 'Completed', removedAt: '2026-01-01', similarGameTitles: ['Target'] });
    const ctxBoth = buildGraphUserContext([live, removed], FIXTURE_NOW);
    const ctxLive = buildGraphUserContext([live], FIXTURE_NOW);
    expect(ctxBoth.ugWeights.get('steam-2')).toBe(0);
    expect(ctxBoth.massRef).toBeCloseTo(ctxLive.massRef, 10);
    const out = computeGraphSignal(makeCandidate('steam-99', { title: 'Target' }), [live, removed], undefined, ctxBoth);
    expect(out.similarTo).toEqual(['Live']);
  });

  it('ignores neighbour hits that point at games not in the library', () => {
    const users = [makeUser('steam-1', { hoursPlayed: 40, rating: 5, status: 'Completed' })];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    expect(computeGraphSignal(makeCandidate('steam-99'), users, [{ u: 'steam-unknown', d: 0.01 }], ctx).score).toBe(0);
  });

  it('explains with the strongest related games first, up to three, deduplicated', () => {
    const users = [
      makeUser('steam-1', { title: 'Weak', hoursPlayed: 1, rating: 3, status: 'Playing', similarGameTitles: ['Target'] }),
      makeUser('steam-2', { title: 'Strong', hoursPlayed: 100, rating: 5, status: 'Completed', similarGameTitles: ['Target'] }),
      makeUser('steam-3', { title: 'Mid', hoursPlayed: 30, rating: 4, status: 'Completed', similarGameTitles: ['Target'] }),
      makeUser('steam-4', { title: 'Also', hoursPlayed: 20, rating: 4, status: 'Completed', similarGameTitles: ['Target'] }),
    ];
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const out = computeGraphSignal(makeCandidate('steam-99', { title: 'Target' }), users, undefined, ctx);
    // All four relate with strength 1.0, so contribution order == engagement-weight order.
    const byWeight = [...users]
      .sort((a, b) => (ctx.ugWeights.get(b.gameId) ?? 0) - (ctx.ugWeights.get(a.gameId) ?? 0))
      .map(u => u.title);
    expect(out.similarTo).toHaveLength(3);
    expect(out.similarTo).toEqual(byWeight.slice(0, 3));
    expect(out.similarTo[0]).toBe('Strong');
    expect(new Set(out.similarTo).size).toBe(3);
  });

  it('returns 0 with no library or no links, and never NaN', () => {
    const none = computeGraphSignal(makeCandidate('steam-99'), [], undefined, buildGraphUserContext([], FIXTURE_NOW));
    expect(none.score).toBe(0);
    const users = multiTasteLibrary();
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const r = computeGraphSignal(makeCandidate('steam-99', { title: 'Unrelated' }), users, undefined, ctx);
    expect(r.score).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('detectTasteClusters — deterministic', () => {
  const embed = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.sin(seed * (i + 1)));
  const library = () => multiTasteLibrary().map((g, i) => ({ ...g, embedding: embed(i + 1) }));

  it('returns identical clusters on repeated calls', () => {
    const a = detectTasteClusters(library(), FIXTURE_NOW);
    const b = detectTasteClusters(library(), FIXTURE_NOW);
    expect(a.map(c => [c.label, c.gameCount, c.topGames])).toEqual(b.map(c => [c.label, c.gameCount, c.topGames]));
  });

  it('does not depend on the order of the input games', () => {
    const forward = detectTasteClusters(library(), FIXTURE_NOW);
    const reversed = detectTasteClusters(library().reverse(), FIXTURE_NOW);
    expect(forward.map(c => [c.label, c.gameCount])).toEqual(reversed.map(c => [c.label, c.gameCount]));
  });
});

describe('bestClusterSimilarity', () => {
  const unit = (v: number[]) => {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / m);
  };
  const cluster = (label: string, centroid?: number[]): TasteCluster => ({
    id: 0, label, gameCount: 3, topGames: [], profile: {} as never, semanticCentroid: centroid,
  });

  it('returns the best cluster and its label', () => {
    const clusters = [cluster('Cozy', unit([1, 0, 0])), cluster('Souls', unit([0, 1, 0]))];
    const best = bestClusterSimilarity([0.1, 0.9, 0], clusters)!;
    expect(best.label).toBe('Souls');
    expect(best.sim).toBeGreaterThan(0.9);
  });

  it('never returns a negative similarity (it would subtract from the composite score)', () => {
    const clusters = [cluster('Cozy', unit([1, 0, 0]))];
    expect(bestClusterSimilarity([-1, 0, 0], clusters)).toBeNull();
    const prepared = prepareClusterCentroids(clusters);
    expect(bestPreparedClusterSimilarity([-1, 0.1, 0], prepared)).toBeNull();
    expect(bestPreparedClusterSimilarity([1, 0.1, 0], prepared)!.sim).toBeGreaterThan(0.9);
  });

  it('prepared centroids are typed arrays and clusters without a centroid are dropped', () => {
    const prepared = prepareClusterCentroids([cluster('A', unit([1, 0, 0])), cluster('B')]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].centroid).toBeInstanceOf(Float64Array);
  });

  it('is null when no cluster centroid matches the dimension or the vector is zero', () => {
    expect(bestClusterSimilarity([1, 0], [cluster('A', unit([1, 0, 0]))])).toBeNull();
    expect(bestClusterSimilarity([0, 0, 0], [cluster('A', unit([1, 0, 0]))])).toBeNull();
    expect(bestClusterSimilarity([1, 0, 0], [cluster('A')])).toBeNull();
  });
});

describe('assembleWeights', () => {
  type W = ReturnType<typeof assembleWeights>;
  const positive = (w: W) => Object.entries(w).reduce((s, [k, v]) => (k === 'W_NEGATIVE' ? s : s + v), 0);
  // Weights are normalised to a defined total (R5), so the 0.41 "similarity budget" is a share of it.
  const sum = (w: W) => (w.W_CONTENT + w.W_SEMANTIC + w.W_CLUSTER_SEM + w.W_GRAPH) / positive(w);
  const base = { embeddingCoverage: 0.6, hasClusterScores: true, hasGraphScores: false, mlCoverage: 0.5, graphSignalCoverage: 0.5 };

  it('positive weights always total exactly WEIGHT_TOTAL', () => {
    for (const embeddingCoverage of [0, 0.3, 1]) {
      for (const mlCoverage of [0, 0.5, 1]) {
        for (const hasGraphScores of [true, false]) {
          const w = assembleWeights({ ...base, embeddingCoverage, mlCoverage, hasGraphScores });
          expect(positive(w)).toBeCloseTo(WEIGHT_TOTAL, 10);
        }
      }
    }
  });

  it('keeps content + semantic + cluster + graph a constant share for any coverage', () => {
    const reference = sum(assembleWeights(base));
    for (const embeddingCoverage of [0, 0.3, 0.6, 1]) {
      for (const graphSignalCoverage of [0, 0.02, 0.1, 0.5, 1]) {
        for (const hasClusterScores of [true, false]) {
          const w = assembleWeights({ ...base, embeddingCoverage, graphSignalCoverage, hasClusterScores });
          expect(sum(w)).toBeCloseTo(reference, 10);
        }
      }
    }
  });

  it('moves the graph weight to content when the graph signal almost never fires', () => {
    const live = assembleWeights({ ...base, graphSignalCoverage: GRAPH_FULL_COVERAGE });
    const dead = assembleWeights({ ...base, graphSignalCoverage: 0 });
    expect(dead.W_GRAPH).toBe(0);
    expect(dead.W_CONTENT).toBeGreaterThan(live.W_CONTENT);
    expect(live.W_GRAPH).toBeGreaterThan(0.12);
  });

  it('scales the graph weight with coverage below the full-coverage threshold', () => {
    const half = assembleWeights({ ...base, graphSignalCoverage: GRAPH_FULL_COVERAGE / 2 });
    const full = assembleWeights({ ...base, graphSignalCoverage: GRAPH_FULL_COVERAGE });
    expect(half.W_GRAPH).toBeCloseTo(full.W_GRAPH / 2, 10);
  });

  it('gives the cluster layer 35% of the semantic budget only when cluster scores exist', () => {
    const withC = assembleWeights({ ...base, hasClusterScores: true });
    const without = assembleWeights({ ...base, hasClusterScores: false });
    expect(withC.W_CLUSTER_SEM).toBeGreaterThan(0);
    expect(withC.W_SEMANTIC + withC.W_CLUSTER_SEM).toBeCloseTo(without.W_SEMANTIC, 10);
    expect(without.W_CLUSTER_SEM).toBe(0);
  });

  it('splits unused ML budget 60/40 to content and quality, and total ML budget stays 0.10', () => {
    const w = assembleWeights({ ...base, mlCoverage: 0.25 });
    const full = assembleWeights({ ...base, mlCoverage: 1 });
    // Total ML budget (scored share + residual folded into content/quality) is independent of coverage.
    expect(w.W_ML + w.W_CONTENT_ML + w.W_QUALITY_ML).toBeCloseTo(full.W_ML, 10);
    expect(w.W_CONTENT_ML / w.W_QUALITY_ML).toBeCloseTo(1.5, 10);
  });

  it('only gives the graph-metrics layers weight when graph scores are available', () => {
    expect(assembleWeights({ ...base, hasGraphScores: false }).W_GRAPH_COMMUNITY).toBe(0);
    const on = assembleWeights({ ...base, hasGraphScores: true });
    expect(on.W_GRAPH_COMMUNITY + on.W_GRAPH_PAGERANK).toBeGreaterThan(0.04);
    expect(on.W_GRAPH_COMMUNITY / on.W_GRAPH_PAGERANK).toBeCloseTo(1.5, 10);
  });
});
