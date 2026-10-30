/**
 * 1.0.97 RecoStore pipeline performance and cancellation (no score changes):
 *  - browse rows come from the prefetch store's in-memory list (IndexedDB only on a cold start)
 *  - no browse-row copy is kept on the singleton between computes
 *  - a yield between pool hygiene and the pre-filter, with a stale check after it
 *  - refresh()/reset() cancel the background Oracle rerank (not recorded as a timeout)
 *  - thumbs-up re-dispatches the worker only, with fallbacks to refresh()
 *  - saved layer telemetry is restored on a cache hit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lib = vi.hoisted(() => ({ ids: [] as string[] }));
const feedback = vi.hoisted(() => ({ up: [] as string[], down: [] as string[], dismissals: [] as Array<{ gameId: string; at: number }> }));
const prefetch = vi.hoisted(() => ({ games: null as Array<Record<string, unknown>> | null }));
const prefilterSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getAllGameIds: () => lib.ids,
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
    getDismissals: () => feedback.dismissals,
    getThumbsUpIds: () => [...feedback.up],
    getThumbsDownIds: () => [...feedback.down],
  },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: { getEntryCount: async () => 0, getEntries: async () => [] } }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: { getEntryCount: async () => 0 } }));
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
  resolveGraphScores: async () => ({ graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined }),
}));
vi.mock('@/services/prefetch-store', () => ({ getPrefetchedGames: () => prefetch.games }));
vi.mock('@/hooks/useAllowAdultContent', () => ({ isAllowAdultContent: () => false }));
vi.mock('@/services/adult-content-filter', () => ({
  isAdultContentByDescription: (g: { summary?: string; longDescription?: string }) =>
    /explicit/i.test(`${g.summary ?? ''} ${g.longDescription ?? ''}`),
}));
vi.mock('@/services/reco-prefilter', async (orig) => {
  const real = await orig<typeof import('@/services/reco-prefilter')>();
  return {
    ...real,
    preFilterCandidates: (...args: Parameters<typeof real.preFilterCandidates>) => {
      prefilterSpy.calls++;
      return real.preFilterCandidates(...args);
    },
  };
});

import { RecoStore, ORACLE_RERANK_BUDGET_MS, LIBRARY_REFRESH_DEBOUNCE_MS } from '@/services/reco-store';
import { getLastRerankRun } from '@/services/oracle-rerank';
import type { CandidateGame, RecoShelf, RecoWorkerInput, RecoWorkerResult, TasteProfile, UserGameSnapshot } from '@/types/reco';
import { makeCandidate, makeUser } from '@/test/oracle/fixtures';

const DAY = 86_400_000;

function browseRow(id: string, over: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, genre: ['Action'], themes: [], platform: ['Windows'], developer: 'D', ...over };
}

/** Minimal fake of the `ark-browse-cache` IndexedDB. */
function installFakeIdb(entry: unknown) {
  const close = vi.fn();
  const open = vi.fn(() => {
    const req: Record<string, any> = {};
    const db = {
      objectStoreNames: { contains: () => true },
      close,
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const g: Record<string, any> = {};
            setTimeout(() => { g.result = entry; g.onsuccess?.(); }, 0);
            return g;
          },
        }),
      }),
    };
    setTimeout(() => { req.result = db; req.onsuccess?.(); }, 0);
    return req;
  });
  vi.stubGlobal('indexedDB', { open });
  return { open, close };
}

const profile = { genres: [], themes: [], gameModes: [], perspectives: [], developers: [], publishers: [], eras: [], totalGames: 1, totalHours: 1, avgRating: 5, topGenre: '', topTheme: '', clusters: [] } as unknown as TasteProfile;

function workerResult(title: string, games: unknown[] = []): RecoWorkerResult {
  return {
    type: 'result',
    shelves: [{ type: 'deep-in-genre', title, subtitle: '', games }] as unknown as RecoShelf[],
    tasteProfile: profile,
    computeTimeMs: 1,
  } as unknown as RecoWorkerResult;
}

/** Store with the heavy stages stubbed (as in reco-store-compute.test.ts). */
function makeStore(pool: CandidateGame[] = [makeCandidate('steam-c1'), makeCandidate('steam-c2')]) {
  const store = new RecoStore();
  const anyStore = store as any;
  store.subscribe(() => {});
  anyStore.loadResultsFromCache = vi.fn(async () => null);
  anyStore.buildUserGameSnapshots = vi.fn(() => [makeUser('steam-u1', { hoursPlayed: 30, rating: 5 })]);
  anyStore.buildCandidatePool = vi.fn(async (_ug: unknown, sink: CandidateGame[]) => {
    sink.push(...pool.map(c => ({ ...c })));
    return sink;
  });
  anyStore.hydrateSurvivorMetadata = vi.fn(async () => {});
  anyStore.applyGgDeals = vi.fn(async () => {});
  anyStore.applyMLScores = vi.fn(async () => {});
  anyStore.saveResultsToCache = vi.fn();
  const runWorker = vi.fn();
  anyStore.runWorker = runWorker;
  return { store, anyStore, runWorker };
}

beforeEach(() => {
  lib.ids = [];
  feedback.up = [];
  feedback.down = [];
  feedback.dismissals = [];
  prefetch.games = null;
  prefilterSpy.calls = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('candidate pool: browse rows', () => {
  const userGames: UserGameSnapshot[] = [makeUser('steam-u1', { hoursPlayed: 30, rating: 5 })];
  const rows = [browseRow('steam-1'), browseRow('steam-2', { title: 'Second' }), browseRow('epic-3', { genre: ['RPG'] })];

  it('uses the prefetched list (no IndexedDB open) and builds the same pool as the IndexedDB path', async () => {
    const idb = installFakeIdb({ games: rows, timestamp: Date.now() });
    const fromIdb: CandidateGame[] = [];
    await (new RecoStore() as any).buildCandidatePool(userGames, fromIdb);
    expect(idb.open).toHaveBeenCalledTimes(1);

    idb.open.mockClear();
    prefetch.games = rows;
    const fromPrefetch: CandidateGame[] = [];
    await (new RecoStore() as any).buildCandidatePool(userGames, fromPrefetch);
    expect(idb.open).not.toHaveBeenCalled();
    expect(fromPrefetch).toEqual(fromIdb);
    expect(fromPrefetch.map(c => c.gameId)).toEqual(['steam-1', 'steam-2', 'epic-3']);
  });

  it('falls back to IndexedDB when prefetch has not hydrated, keeping the 7-day TTL', async () => {
    prefetch.games = [];
    installFakeIdb({ games: rows, timestamp: Date.now() - 2 * DAY });
    const fresh: CandidateGame[] = [];
    await (new RecoStore() as any).buildCandidatePool(userGames, fresh);
    expect(fresh).toHaveLength(3);

    prefetch.games = null;
    installFakeIdb({ games: rows, timestamp: Date.now() - 8 * DAY });
    const stale: CandidateGame[] = [];
    await (new RecoStore() as any).buildCandidatePool(userGames, stale);
    expect(stale).toHaveLength(0);
  });

  it('closes the IndexedDB connection if it only opens after the 8 s timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const reqs: Array<Record<string, any>> = [];
    vi.stubGlobal('indexedDB', { open: vi.fn(() => { const r: Record<string, any> = {}; reqs.push(r); return r; }) });
    const p = (new RecoStore() as any).loadBrowseCacheGames();
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await p).toEqual([]);
    reqs[0].result = { close, transaction: vi.fn() };
    reqs[0].onsuccess();
    expect(close).toHaveBeenCalledTimes(1);
    expect(reqs[0].result.transaction).not.toHaveBeenCalled();
  });
});

describe('pool hygiene: browse rows are per compute', () => {
  it('still filters an adult-flagged candidate by its browse description, and keeps no copy on the store', async () => {
    prefetch.games = [
      browseRow('steam-1', { themes: ['Mature'], summary: 'Explicit scenes throughout' }),
      browseRow('steam-2', { themes: ['Mature'], summary: 'A war story' }),
    ];
    const store = new RecoStore();
    const anyStore = store as any;
    const sink: CandidateGame[] = [];
    const holder = { rows: [] as Record<string, unknown>[] };
    const userGames = [makeUser('steam-u1')];
    await anyStore.buildCandidatePool(userGames, sink, undefined, holder);
    expect(holder.rows).toBe(prefetch.games); // by reference, not a copy
    const kept = anyStore.hygienePool(sink.slice(), userGames, holder.rows) as CandidateGame[];
    expect(kept.map(c => c.gameId)).toEqual(['steam-2']);
    expect('lastBrowseRows' in anyStore).toBe(false);
  });

  it('a pool build that overran its deadline does not hand the previous compute\'s rows to hygiene', async () => {
    const { store, anyStore } = makeStore();
    let call = 0;
    anyStore.buildCandidatePool = vi.fn(async (_ug: unknown, sink: CandidateGame[], _s: unknown, browse: { rows: unknown[] }) => {
      if (call++ === 0) browse.rows = [browseRow('steam-c1')];
      sink.push(makeCandidate('steam-c1'));
      return sink;
    });
    const hygiene = vi.spyOn(anyStore, 'hygienePool');
    await store.compute();
    store.refresh();
    await store.compute();
    expect(hygiene).toHaveBeenCalledTimes(2);
    expect((hygiene.mock.calls[0][2] as unknown[]).length).toBe(1);
    expect(hygiene.mock.calls[1][2]).toEqual([]);
  });
});

describe('yield between hygiene and the pre-filter', () => {
  it('a compute superseded during the yield returns before pre-filtering', async () => {
    const { store, anyStore, runWorker } = makeStore();
    const realHygiene = anyStore.hygienePool.bind(anyStore);
    anyStore.hygienePool = vi.fn((...args: unknown[]) => {
      const out = realHygiene(...args);
      setTimeout(() => store.refresh(), 0); // lands during the yield
      return out;
    });
    await store.compute();
    expect(anyStore.hygienePool).toHaveBeenCalledTimes(1);
    expect(prefilterSpy.calls).toBe(0);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('an undisturbed compute still pre-filters and dispatches', async () => {
    const { store, runWorker } = makeStore();
    await store.compute();
    expect(prefilterSpy.calls).toBe(1);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
});

describe('background Oracle rerank cancellation', () => {
  const win = window as any;
  let saved: { ollama: unknown; settings: unknown };
  beforeEach(() => {
    vi.useFakeTimers();
    saved = { ollama: win.ollama, settings: win.settings };
    win.settings = { getOllamaSettings: async () => ({ oracleRerankEnabled: true, oracleRerankBlend: 1 }) };
  });
  afterEach(() => {
    win.ollama = saved.ollama;
    win.settings = saved.settings;
  });

  function startRerank() {
    const rerank = vi.fn((_p: { requestId?: string }) => new Promise(() => {})); // slow: never answers
    const rerankCancel = vi.fn(async () => true);
    win.ollama = { rerank, rerankCancel };
    const { store, anyStore } = makeStore();
    const gen = ++anyStore.computeGeneration;
    anyStore.state = { ...anyStore.state, status: 'computing' };
    anyStore.finishWorkerResult(workerResult('w', [{ gameId: 'steam-1', title: 'A', genres: [], themes: [] }]), gen);
    return { store, anyStore, rerank, rerankCancel };
  }

  it('refresh() cancels the main-process rerank and records no "skipped_timeout"', async () => {
    const before = getLastRerankRun();
    const { store, rerank, rerankCancel } = startRerank();
    await vi.advanceTimersByTimeAsync(50);
    expect(rerank).toHaveBeenCalledTimes(1);
    store.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(rerankCancel).toHaveBeenCalledWith(rerank.mock.calls[0][0].requestId);
    await vi.advanceTimersByTimeAsync(ORACLE_RERANK_BUDGET_MS + 1_000);
    expect(getLastRerankRun()).toBe(before);
    expect(store.getState().oracleRerankStatus.outcome).not.toBe('skipped_timeout');
  });

  it('reset() cancels it too', async () => {
    const { store, rerank, rerankCancel } = startRerank();
    await vi.advanceTimersByTimeAsync(50);
    store.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(rerankCancel).toHaveBeenCalledWith(rerank.mock.calls[0][0].requestId);
  });

  it('invalidateCacheOnly() does not cancel (its shelves stay on screen)', async () => {
    const { store, rerankCancel } = startRerank();
    await vi.advanceTimersByTimeAsync(50);
    store.invalidateCacheOnly();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rerankCancel).not.toHaveBeenCalled();
  });
});

describe('thumbs-up re-dispatches the worker only', () => {
  const inputOf = (spy: ReturnType<typeof vi.fn>, i: number) => spy.mock.calls[i][0] as RecoWorkerInput;
  const withoutClock = ({ now: _n, currentHour: _h, ...rest }: RecoWorkerInput) => rest;

  it('unchanged library: no pool rebuild, new thumbs-up ids, same input as a full refresh', async () => {
    const { store, anyStore, runWorker } = makeStore();
    await store.compute();
    expect(anyStore.buildCandidatePool).toHaveBeenCalledTimes(1);
    anyStore.finishWorkerResult(workerResult('first'), runWorker.mock.calls[0][1]);

    feedback.up = ['steam-c1'];
    store.invalidateCacheOnly();
    store.recomputeThumbsUpOnly();
    expect(anyStore.buildCandidatePool).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe('computing');
    expect(store.getState().shelves[0].title).toBe('first'); // still visible
    const patched = inputOf(runWorker, 1);
    expect(patched.thumbsUpIds).toEqual(['steam-c1']);

    // The worker-only run's result publishes and is cached (cache epoch taken at re-dispatch).
    anyStore.finishWorkerResult(workerResult('patched'), runWorker.mock.calls[1][1]);
    expect(store.getState().status).toBe('done');
    expect(anyStore.saveResultsToCache).toHaveBeenCalled();

    store.refresh();
    await store.compute();
    expect(anyStore.buildCandidatePool).toHaveBeenCalledTimes(2);
    expect(withoutClock(patched)).toEqual(withoutClock(inputOf(runWorker, 2)));
  });

  it('falls back to refresh() when the library changed, nothing was dispatched, or the input expired', async () => {
    const { store, anyStore } = makeStore();
    const refresh = vi.spyOn(store, 'refresh');
    store.recomputeThumbsUpOnly(); // nothing dispatched yet
    expect(refresh).toHaveBeenCalledTimes(1);

    await store.compute();
    lib.ids = ['steam-new']; // library signature changed
    store.recomputeThumbsUpOnly();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(anyStore.lastDispatch).toBeNull(); // refresh() released it

    lib.ids = [];
    vi.useFakeTimers();
    const run = store.compute();
    await vi.advanceTimersByTimeAsync(10); // compute yields between hygiene and the pre-filter
    await run;
    expect(anyStore.lastDispatch).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(anyStore.lastDispatch).toBeNull(); // released at the result TTL
    anyStore.state = { ...anyStore.state, status: 'done' };
    store.recomputeThumbsUpOnly();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('falls back when a new feedback game is not in the remembered pool', async () => {
    const { store, anyStore, runWorker } = makeStore();
    await store.compute();
    anyStore.finishWorkerResult(workerResult('first'), runWorker.mock.calls[0][1]);
    const refresh = vi.spyOn(store, 'refresh');
    feedback.up = ['steam-not-in-pool'];
    store.recomputeThumbsUpOnly();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('scheduleThumbsUpRefresh debounces into one worker-only run, but a pending full refresh wins', async () => {
    vi.useFakeTimers();
    const { store, anyStore, runWorker } = makeStore();
    const run = store.compute();
    await vi.advanceTimersByTimeAsync(10);
    await run;
    anyStore.finishWorkerResult(workerResult('first'), runWorker.mock.calls[0][1]);
    const only = vi.spyOn(store, 'recomputeThumbsUpOnly');
    const refresh = vi.spyOn(store, 'refresh');
    feedback.up = ['steam-c1'];
    store.scheduleThumbsUpRefresh();
    store.scheduleThumbsUpRefresh();
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(only).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    store.scheduleRefresh();
    store.scheduleThumbsUpRefresh();
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(only).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('result cache restore', () => {
  it('restores the saved layer telemetry', async () => {
    const { store, anyStore } = makeStore();
    const telemetry = { layers: { contentSimilarity: { coverage: 1 } } };
    anyStore.loadResultsFromCache = vi.fn(async () => ({
      shelves: workerResult('cached').shelves,
      tasteProfile: profile,
      computeTimeMs: 5,
      lastComputed: Date.now(),
      telemetry,
    }));
    await store.compute();
    expect(store.getState().status).toBe('done');
    expect(store.getState().telemetry).toEqual(telemetry);
  });
});
