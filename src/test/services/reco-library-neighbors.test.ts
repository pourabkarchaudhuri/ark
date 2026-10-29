/**
 * R2 (v1.0.76): the main thread feeds the worker library-neighbour hits,
 * deterministic taste clusters and per-candidate cluster scores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ann = vi.hoisted(() => ({ isReady: true, vectorCount: 100 }));
const neighborsMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getAllGameIds: () => [],
    getEntry: () => undefined,
    getAllEntries: () => [],
    subscribe: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getAllGames: () => [], subscribe: () => () => {} },
}));
vi.mock('@/services/journey-store', () => ({ journeyStore: { getAllEntries: () => [] } }));
vi.mock('@/services/session-store', () => ({ sessionStore: { getAll: () => [] } }));
vi.mock('@/services/status-history-store', () => ({ statusHistoryStore: { getAll: () => [] } }));
vi.mock('@/services/reco-history-store', () => ({
  recoHistoryStore: {
    getDismissals: () => [],
    getThumbsUpIds: () => [],
    getThumbsDownIds: () => [],
  },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/ann-index', () => ({ annIndex: ann }));
vi.mock('@/services/bm25-index', () => ({
  bm25Index: { isReady: false, scheduleIdleRebuild: () => {} },
}));
vi.mock('@/services/embedding-service', () => ({
  embeddingService: {
    // A fixed unit centroid in the same 4-d space as the test vectors.
    computeTasteCentroid: () => new Float64Array([1, 0, 0, 0]),
  },
}));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { isReady: false } }));
vi.mock('@/services/similar-games', () => ({
  getSimilarTitlesForRecoBatch: async () => new Map(),
  getAnnNeighborsForRecoBatch: neighborsMock,
}));
vi.mock('@/services/resolve-graph-scores', () => ({
  GRAPH_BUILD_TIMEOUT_MS: 8_000,
  resolveGraphScores: async () => ({
    graphScoresMap: undefined,
    userCommunityCounts: undefined,
    userCommunityTotal: undefined,
  }),
}));

import { RecoStore } from '@/services/reco-store';
import { GRAPH_NEIGHBOR_DISTANCE_CEILING } from '@/services/reco-scoring';
import type { CandidateGame, RecoWorkerInput, UserGameSnapshot } from '@/types/reco';
import { makeCandidate, makeUser } from '@/test/oracle/fixtures';

const vec = (...v: number[]) => v;

beforeEach(() => {
  ann.isReady = true;
  neighborsMock.mockReset();
});

describe('RecoStore.computeLibraryNeighbors', () => {
  type Result = { neighbors: Record<string, Array<{ u: string; d: number }>> | undefined; source: 'pool' | 'ann' | 'none' };
  const run = (store: RecoStore, users: UserGameSnapshot[], candidates: CandidateGame[]) =>
    (store as any).computeLibraryNeighbors(users, candidates) as Promise<Result>;
  const bare = (...ids: string[]) => ids.map(id => makeCandidate(id));

  it('reports "none" when no library game has an embedding, without querying', async () => {
    expect(await run(new RecoStore(), [makeUser('steam-1')], bare('steam-9'))).toEqual({ neighbors: undefined, source: 'none' });
    expect(neighborsMock).not.toHaveBeenCalled();
  });

  it('v1.0.94: finds neighbours inside the candidate pool when candidates have vectors (no ANN query)', async () => {
    const users = [makeUser('steam-1', { embedding: vec(1, 0, 0, 0), hoursPlayed: 50, rating: 5 })];
    const candidates = [
      makeCandidate('steam-100', { embedding: vec(0.95, 0.1, 0, 0) }),
      makeCandidate('steam-200', { embedding: vec(0, 1, 0, 0) }), // too far
      makeCandidate('steam-300'),                                 // no vector
    ];
    const out = await run(new RecoStore(), users, candidates);
    expect(out.source).toBe('pool');
    expect(Object.keys(out.neighbors!)).toEqual(['steam-100']);
    expect(out.neighbors!['steam-100'][0].u).toBe('steam-1');
    expect(out.neighbors!['steam-100'][0].d).toBeLessThan(GRAPH_NEIGHBOR_DISTANCE_CEILING);
    expect(neighborsMock).not.toHaveBeenCalled();
  });

  it('falls back to "none" when no candidate has a vector and the ANN index is not ready', async () => {
    ann.isReady = false;
    const users = [makeUser('steam-1', { embedding: vec(1, 0, 0, 0) })];
    expect(await run(new RecoStore(), users, bare('steam-9'))).toEqual({ neighbors: undefined, source: 'none' });
    expect(neighborsMock).not.toHaveBeenCalled();
  });

  it('ANN fallback inverts library->neighbours into candidate->hits, dropping non-candidates and hits past the ceiling', async () => {
    neighborsMock.mockResolvedValue(new Map([
      ['steam-1', [
        { id: 'steam-100', distance: 0.1 },
        { id: 'steam-200', distance: GRAPH_NEIGHBOR_DISTANCE_CEILING + 0.01 }, // too far
        { id: 'steam-300', distance: 0.2 },                                    // not a candidate
      ]],
      ['steam-2', [{ id: 'steam-100', distance: 0.3 }]],
    ]));
    const users = [
      makeUser('steam-1', { embedding: vec(1, 0, 0, 0), hoursPlayed: 50, rating: 5 }),
      makeUser('steam-2', { embedding: vec(0, 1, 0, 0), hoursPlayed: 10, rating: 4 }),
    ];
    const out = await run(new RecoStore(), users, bare('steam-100', 'steam-200'));
    expect(out).toEqual({
      neighbors: { 'steam-100': [{ u: 'steam-1', d: 0.1 }, { u: 'steam-2', d: 0.3 }] },
      source: 'ann',
    });
  });

  it('uses only the strongest library games (by the graph-signal weights), never removed ones, capped at 32; ANN asks 100 each', async () => {
    neighborsMock.mockResolvedValue(new Map());
    const users = [
      ...Array.from({ length: 60 }, (_, i) =>
        makeUser(`steam-${i}`, { embedding: vec(1, 0, 0, 0), hoursPlayed: i, rating: 4 })),
      makeUser('steam-removed', { embedding: vec(1, 0, 0, 0), hoursPlayed: 500, rating: 5, removedAt: '2026-01-01' }),
    ];
    await run(new RecoStore(), users, bare('steam-9000'));
    const sources = neighborsMock.mock.calls[0][0] as Array<{ gameId: string }>;
    expect(sources).toHaveLength(32);
    expect(sources.some(s => s.gameId === 'steam-removed')).toBe(false);
    expect(sources[0].gameId).toBe('steam-59');
    expect(neighborsMock.mock.calls[0][1]).toBe(100);
  });
});

describe('compute() dispatches neighbours + clusters to the worker', () => {
  function makeStore(users: UserGameSnapshot[], pool: CandidateGame[]) {
    const store = new RecoStore();
    const anyStore = store as any;
    store.subscribe(() => {});
    anyStore.loadResultsFromCache = vi.fn(async () => null);
    anyStore.buildUserGameSnapshots = vi.fn(() => users.map(u => ({ ...u })));
    anyStore.buildCandidatePool = vi.fn(async (_u: unknown, sink: CandidateGame[]) => { sink.push(...pool.map(c => ({ ...c }))); return sink; });
    anyStore.hydrateSurvivorMetadata = vi.fn(async () => {});
    anyStore.applyMLScores = vi.fn(async () => {});
    anyStore.saveResultsToCache = vi.fn();
    const runWorker = vi.fn();
    anyStore.runWorker = runWorker;
    return { store, runWorker };
  }

  // Two clearly separated taste groups, each with embeddings.
  const groupA = ['steam-1', 'steam-2', 'steam-3', 'steam-4'].map((id, i) =>
    makeUser(id, { title: `A${i}`, genres: ['RPG'], themes: ['Fantasy'], embedding: vec(1, 0.1 * i, 0, 0), hoursPlayed: 30, rating: 5 }));
  const groupB = ['steam-5', 'steam-6', 'steam-7', 'steam-8'].map((id, i) =>
    makeUser(id, { title: `B${i}`, genres: ['Strategy'], themes: ['4X'], embedding: vec(0, 0.1 * i, 1, 0), hoursPlayed: 30, rating: 5 }));
  const library = [...groupA, ...groupB];

  it('passes libraryNeighbors, deterministic precomputedClusters and per-candidate cluster scores', async () => {
    neighborsMock.mockResolvedValue(new Map([['steam-1', [{ id: 'steam-100', distance: 0.1 }]]]));
    const pool = [
      makeCandidate('steam-100', { embedding: vec(1, 0, 0, 0) }),
      makeCandidate('steam-101', { embedding: vec(0, 0, 1, 0) }),
    ];
    const { store, runWorker } = makeStore(library, pool);
    await store.compute();

    expect(runWorker).toHaveBeenCalledTimes(1);
    const input = runWorker.mock.calls[0][0] as RecoWorkerInput;

    // v1.0.94: neighbours come from the pool itself (both candidates carry vectors).
    expect(input.graphNeighborSource).toBe('pool');
    expect(input.libraryNeighbors!['steam-100'].map(h => h.u)).toContain('steam-1');
    expect(neighborsMock).not.toHaveBeenCalled();

    expect(input.precomputedClusters!.length).toBeGreaterThanOrEqual(2);
    expect(input.precomputedClusters!.every(c => c.semanticCentroid)).toBe(true);

    const scores = input.precomputedClusterScores!;
    expect(Object.keys(scores).sort()).toEqual(['steam-100', 'steam-101']);
    // Each candidate lands closest to the cluster matching its own taste group.
    expect(scores['steam-100'].label).not.toBe(scores['steam-101'].label);
    // Scores are per-source percentiles (R4), so they live in 0..1 rather than raw cosine.
    for (const id of ['steam-100', 'steam-101']) {
      expect(scores[id].sim).toBeGreaterThanOrEqual(0);
      expect(scores[id].sim).toBeLessThanOrEqual(1);
    }

    // Candidate embeddings are stripped before dispatch.
    expect(input.candidates.every(c => c.embedding === undefined)).toBe(true);
  });

  it('produces identical clusters on repeated runs (no Math.random)', async () => {
    neighborsMock.mockResolvedValue(new Map());
    const pool = [makeCandidate('steam-100', { embedding: vec(1, 0, 0, 0) })];
    const first = makeStore(library, pool);
    await first.store.compute();
    const second = makeStore(library, pool);
    await second.store.compute();
    const labels = (r: ReturnType<typeof makeStore>) =>
      (r.runWorker.mock.calls[0][0] as RecoWorkerInput).precomputedClusters!.map(c => [c.label, c.gameCount]);
    expect(labels(first)).toEqual(labels(second));
  });

  it('omits cluster inputs when the library is too small to cluster, and still dispatches', async () => {
    neighborsMock.mockResolvedValue(new Map());
    const { store, runWorker } = makeStore([makeUser('steam-1', { embedding: vec(1, 0, 0, 0) })], [makeCandidate('steam-100', { embedding: vec(1, 0, 0, 0) })]);
    await store.compute();
    const input = runWorker.mock.calls[0][0] as RecoWorkerInput;
    expect(input.precomputedClusters).toBeUndefined();
    expect(input.precomputedClusterScores).toBeUndefined();
  });
});
