/**
 * RecoStore compute lifecycle: generation guard (stale computes can't
 * overwrite), pre-worker deadline, and the background rerank not blocking
 * status 'done'.
 *
 * Heavy pipeline stages (candidate gather, hydrate, worker) are stubbed on
 * the instance so these tests exercise only the orchestration in compute().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: false, vectorCount: 0 } }));
vi.mock('@/services/bm25-index', () => ({
  bm25Index: { isReady: false, scheduleIdleRebuild: () => {} },
}));
vi.mock('@/services/embedding-service', () => ({
  embeddingService: { computeTasteCentroid: () => null },
}));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { isReady: false } }));
vi.mock('@/services/similar-games', () => ({
  getSimilarTitlesForRecoBatch: async () => new Map(),
}));
vi.mock('@/services/resolve-graph-scores', () => ({
  GRAPH_BUILD_TIMEOUT_MS: 8_000,
  resolveGraphScores: async () => ({
    graphScoresMap: undefined,
    userCommunityCounts: undefined,
    userCommunityTotal: undefined,
  }),
}));

import {
  RecoStore,
  PRE_WORKER_BUDGET_MS,
  ORACLE_RERANK_BUDGET_MS,
  LIBRARY_REFRESH_DEBOUNCE_MS,
} from '@/services/reco-store';
import { ORACLE_RERANK_QWEN_BUDGET_MS } from '@/services/oracle-rerank';
import type { CandidateGame, RecoShelf, RecoWorkerResult, TasteProfile, UserGameSnapshot } from '@/types/reco';

function stubUser(gameId: string): UserGameSnapshot {
  return {
    gameId,
    title: gameId,
    status: 'Completed',
    rating: 5,
    hoursPlayed: 10,
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    developer: '',
    publisher: '',
    releaseDate: '2020-01-01',
    addedAt: new Date().toISOString(),
    statusTrajectory: ['Completed'],
    sessionCount: 0,
    avgSessionMinutes: 0,
    lastSessionDate: null,
    activeToIdleRatio: 0,
    similarGameTitles: [],
    sessionTimestamps: [],
    sessionDurations: [],
    engagementPattern: 'unknown',
  };
}

function stubCandidate(gameId: string): CandidateGame {
  return {
    gameId,
    title: gameId,
    developer: '',
    publisher: '',
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    platforms: [],
    metacriticScore: null,
    playerCount: null,
    releaseDate: '2020-01-01',
    similarGameTitles: [],
  };
}

const profile: TasteProfile = {
  genres: [{ name: 'Action', weight: 1, gameCount: 1, totalHours: 10, avgRating: 5 }],
  themes: [],
  gameModes: [],
  perspectives: [],
  developers: [],
  publishers: [],
  eras: [],
  totalGames: 1,
  totalHours: 10,
  avgRating: 5,
  topGenre: 'Action',
  topTheme: '',
  clusters: [],
};

function shelvesNamed(title: string): RecoShelf[] {
  return [{ type: 'deep-in-genre', title, subtitle: '', games: [] } as unknown as RecoShelf];
}

function workerResult(title: string): RecoWorkerResult {
  return {
    type: 'result',
    shelves: shelvesNamed(title),
    tasteProfile: profile,
    computeTimeMs: 1,
  } as unknown as RecoWorkerResult;
}

/** Instance with the heavy stages stubbed. Returns spies for assertions. */
function makeStore(opts?: {
  pool?: (call: number) => Promise<CandidateGame[]>;
  userGames?: UserGameSnapshot[];
}) {
  const store = new RecoStore();
  const anyStore = store as any;
  // Keep a listener attached so refresh() doesn't auto-compute (UI-driven path).
  store.subscribe(() => {});
  anyStore.loadResultsFromCache = vi.fn(async () => null);
  anyStore.buildUserGameSnapshots = vi.fn(() => (opts?.userGames ?? [stubUser('steam-u1')]).map(u => ({ ...u })));
  let poolCalls = 0;
  anyStore.buildCandidatePool = vi.fn(async (_ug: unknown, sink: CandidateGame[]) => {
    const got = await (opts?.pool?.(poolCalls++) ?? Promise.resolve([stubCandidate('steam-c1')]));
    sink.push(...got);
    return sink;
  });
  anyStore.hydrateSurvivorMetadata = vi.fn(async () => {});
  anyStore.saveResultsToCache = vi.fn();
  const runWorker = vi.fn();
  anyStore.runWorker = runWorker;
  return { store, anyStore, runWorker };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('RecoStore compute generation', () => {
  it('claims "computing" synchronously so a second compute() is a no-op', async () => {
    const { store, anyStore, runWorker } = makeStore();
    const a = store.compute();
    expect(store.getState().status).toBe('computing');
    const b = store.compute();
    await Promise.all([a, b]);
    expect(anyStore.buildCandidatePool).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it('a compute superseded by refresh() never dispatches or overwrites newer results', async () => {
    const firstPool = deferred<CandidateGame[]>();
    const { store, anyStore, runWorker } = makeStore({
      pool: (call) => (call === 0 ? firstPool.promise : Promise.resolve([stubCandidate('steam-c2')])),
    });

    const stale = store.compute();
    expect(store.getState().status).toBe('computing');
    // Let the stale run get past the cache read and into the (hung) gather.
    await vi.waitFor(() => expect(anyStore.buildCandidatePool).toHaveBeenCalledTimes(1));

    store.refresh(); // aborts the in-flight gather
    expect(store.getState().status).toBe('idle');

    await store.compute(); // the fresh run (what OracleView would trigger)
    expect(runWorker).toHaveBeenCalledTimes(1);
    const freshGen = runWorker.mock.calls[0][1] as number;

    // The stale gather finally returns — it must bail, not dispatch a worker.
    firstPool.resolve([stubCandidate('steam-old')]);
    await stale;
    expect(runWorker).toHaveBeenCalledTimes(1);

    // A late worker result from an older generation is dropped…
    anyStore.finishWorkerResult(workerResult('stale'), freshGen - 1);
    expect(store.getState().status).toBe('computing');
    // …while the current one publishes.
    anyStore.finishWorkerResult(workerResult('fresh'), freshGen);
    expect(store.getState().status).toBe('done');
    expect(store.getState().shelves[0].title).toBe('fresh');
  });

  it('refresh() keeps previous shelves visible (stale-while-revalidate)', () => {
    const { store, anyStore } = makeStore();
    anyStore.state = { ...anyStore.state, status: 'done', shelves: shelvesNamed('old'), tasteProfile: profile };
    store.refresh();
    expect(store.getState().status).toBe('idle');
    expect(store.getState().shelves[0].title).toBe('old');
    expect(store.getState().invalidationGeneration).toBe(1);
  });
});

describe('RecoStore pre-worker deadline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a hung embedding generator cannot block the worker; it only sees user games', async () => {
    const { store, runWorker } = makeStore();
    const generator = vi.fn(() => new Promise<number>(() => {})); // never resolves

    const done = store.compute(generator);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generator).toHaveBeenCalledTimes(1);
    const ids = (generator.mock.calls[0] as unknown[])[0] as Array<{ id: string }>;
    expect(ids.map(g => g.id)).toEqual(['steam-u1']); // no candidates embedded inline
    expect(runWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PRE_WORKER_BUDGET_MS);
    await done;
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('computing'); // worker owns it from here
  });

  it('all pre-worker steps share one overall budget', async () => {
    // Pool takes 50s of the 120s budget; a hung generator gets only the 70s left
    // (not its own 90s cap), so the worker starts at ~120s.
    const { store, runWorker } = makeStore({
      pool: () => new Promise((r) => setTimeout(() => r([stubCandidate('steam-c1')]), 50_000)),
    });
    const generator = vi.fn(() => new Promise<number>(() => {}));
    const done = store.compute(generator);

    await vi.advanceTimersByTimeAsync(50_000 + 60_000);
    expect(runWorker).not.toHaveBeenCalled(); // generator still inside its share
    await vi.advanceTimersByTimeAsync(PRE_WORKER_BUDGET_MS - 110_000 + 1_000);
    await done;
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
});

describe('RecoStore background rerank', () => {
  const win = window as any;
  let savedOllama: unknown;
  let savedSettings: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    savedOllama = win.ollama;
    savedSettings = win.settings;
    win.settings = { getOllamaSettings: async () => ({ oracleRerankEnabled: true, oracleRerankBlend: 1 }) };
  });
  afterEach(() => {
    vi.useRealTimers();
    win.ollama = savedOllama;
    win.settings = savedSettings;
  });

  it('publishes "done" with worker order before rerank; a hung rerank times out', async () => {
    const rerank = vi.fn(() => new Promise(() => {})); // main-process cascade never answers
    win.ollama = { rerank };
    const { store, anyStore } = makeStore();
    const gen = ++anyStore.computeGeneration;
    anyStore.state = { ...anyStore.state, status: 'computing' };

    const msg = workerResult('worker-order');
    msg.shelves[0].games = [{ gameId: 'steam-1', title: 'A', genres: [], themes: [] } as any];
    anyStore.finishWorkerResult(msg, gen);

    // Synchronously done — no 92% "Refining recommendations" stall.
    expect(store.getState().status).toBe('done');
    expect(store.getState().shelves).toBe(msg.shelves);

    await vi.advanceTimersByTimeAsync(ORACLE_RERANK_BUDGET_MS + 100);
    expect(rerank).toHaveBeenCalled();
    expect(store.getState().status).toBe('done');
    expect(store.getState().oracleRerankStatus.outcome).toBe('skipped_timeout');
    expect(store.getState().shelves).toBe(msg.shelves);
  });

  it('Qwen3 tier gets the longer budget; on overrun the main-process pass is cancelled', async () => {
    const rerank = vi.fn((_p: { requestId?: string }) => new Promise(() => {}));
    const rerankCancel = vi.fn(async () => true);
    win.ollama = { rerank, rerankCancel, rerankTier: async () => ({ tier: 'qwen_graded', ollamaUp: true }) };
    const { store, anyStore } = makeStore();
    const gen = ++anyStore.computeGeneration;
    anyStore.state = { ...anyStore.state, status: 'computing' };
    const msg = workerResult('worker-order');
    msg.shelves[0].games = [{ gameId: 'steam-1', title: 'A', genres: [], themes: [] } as any];
    anyStore.finishWorkerResult(msg, gen);

    // The fast-tier budget passes without a timeout — a CPU Qwen pass is still allowed to finish.
    await vi.advanceTimersByTimeAsync(ORACLE_RERANK_BUDGET_MS + 100);
    expect(store.getState().oracleRerankStatus.outcome).toBe('none');
    expect(rerankCancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ORACLE_RERANK_QWEN_BUDGET_MS);
    expect(store.getState().oracleRerankStatus.outcome).toBe('skipped_timeout');
    expect(rerankCancel).toHaveBeenCalledWith(rerank.mock.calls[0][0].requestId);
    expect(store.getState().shelves).toBe(msg.shelves);
  });

  it('scheduleRefresh() debounces bursts into a single refresh', async () => {
    const { store } = makeStore();
    const spy = vi.spyOn(store, 'refresh');
    store.scheduleRefresh();
    store.scheduleRefresh();
    store.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
