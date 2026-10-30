/**
 * v1.0.97 B34 — RecoStore ranking fixes on the main thread:
 *   - oracle#0  ML scores are written onto candidates once, ranked, or not at all
 *   - oracle#1  the pre-filter sees fresh engagement scores; snapshots use the shared curve classifier
 *   - oracle#3  turning adult content off refreshes Oracle (debounced, only after a compute, only on a real change)
 *   - oracle#20 the saved cache carries the library signature from compute start
 *   - earlier review: gg.deals "all-time low" needs an actual discount
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lib = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getAllGameIds: () => lib.ids,
    getEntry: () => undefined,
    getAllEntries: () => [],
    isInLibrary: () => false,
    subscribe: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getAllGames: () => [], getGame: () => undefined, subscribe: () => () => {} },
}));
vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    getAllEntries: () => [{
      gameId: 'steam-7', title: 'Short Story', genre: ['Adventure'], platform: [], status: 'Completed',
      hoursPlayed: 12, rating: 5, addedAt: '2026-01-01T00:00:00.000Z',
    }],
  },
}));
vi.mock('@/services/session-store', () => ({
  sessionStore: {
    // Three sessions within two days on a completed game.
    getAll: () => [0, 1, 2].map(i => ({
      gameId: 'steam-7',
      startTime: new Date(Date.UTC(2026, 0, 10, 10 + i * 12)).toISOString(),
      endTime: new Date(Date.UTC(2026, 0, 10, 14 + i * 12)).toISOString(),
      durationMinutes: 240,
      idleMinutes: 0,
    })),
  },
}));
vi.mock('@/services/status-history-store', () => ({ statusHistoryStore: { getAll: () => [] } }));
vi.mock('@/services/reco-history-store', () => ({
  recoHistoryStore: { getDismissals: () => [], getThumbsUpIds: () => [], getThumbsDownIds: () => [] },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: false, vectorCount: 0 } }));
vi.mock('@/services/bm25-index', () => ({ bm25Index: { isReady: false, scheduleIdleRebuild: () => {} } }));
vi.mock('@/services/embedding-service', () => ({ embeddingService: { computeTasteCentroid: () => null } }));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { isReady: false } }));
vi.mock('@/services/similar-games', () => ({ getSimilarTitlesForRecoBatch: async () => new Map() }));
vi.mock('@/services/resolve-graph-scores', () => ({
  GRAPH_BUILD_TIMEOUT_MS: 8_000,
  resolveGraphScores: async () => ({ graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined }),
}));
const prefilterSeen = vi.hoisted(() => [] as Array<{ now: number | undefined; loyal: string[] }>);
vi.mock('@/services/reco-prefilter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/reco-prefilter')>();
  const scoring = await import('@/services/reco-scoring');
  return {
    ...real,
    preFilterCandidates: (pool: Parameters<typeof real.preFilterCandidates>[0], userGames: Parameters<typeof real.preFilterCandidates>[1], opts: Parameters<typeof real.preFilterCandidates>[2]) => {
      // The loyal studios the pre-filter's own profile sees at this moment (same engagement cache).
      prefilterSeen.push({ now: opts?.now, loyal: scoring.buildTasteProfile(userGames, opts?.now ?? Date.now()).loyalDevelopers });
      return real.preFilterCandidates(pool, userGames, opts);
    },
  };
});
const gg = vi.hoisted(() => ({ on: false }));
vi.mock('@/services/ggdeals-service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/ggdeals-service')>();
  return {
    ...real,
    ggDealsService: {
      get available() { return gg.on; },
      hasKey: async () => gg.on,
      // Every game is at its all-time low price.
      getPrices: async (ids: number[]) => new Map(ids.map(id => [id, { currentRetail: 10, historicalRetail: 10, currentKeyshops: null, historicalKeyshops: null }])),
    },
  };
});

import { RecoStore, recoStore, LIBRARY_REFRESH_DEBOUNCE_MS } from '@/services/reco-store';
import { _engagementCache, classifyEngagementCurve } from '@/services/reco-scoring';
import { percentileRanks } from '@/services/ml-normalize';
import { setAllowAdultContent } from '@/hooks/useAllowAdultContent';
import type { CandidateGame, UserGameSnapshot } from '@/types/reco';

function user(gameId: string, over: Partial<UserGameSnapshot> = {}): UserGameSnapshot {
  return {
    gameId, title: gameId, status: 'Completed', rating: 5, hoursPlayed: 40,
    genres: ['Action'], themes: [], gameModes: [], perspectives: [], developer: '', publisher: '',
    releaseDate: '2020-01-01', addedAt: new Date().toISOString(), statusTrajectory: ['Completed'],
    sessionCount: 0, avgSessionMinutes: 0, lastSessionDate: null, activeToIdleRatio: 1,
    similarGameTitles: [], sessionTimestamps: [], sessionDurations: [], engagementPattern: 'unknown',
    ...over,
  };
}

function cand(gameId: string, over: Partial<CandidateGame> = {}): CandidateGame {
  return {
    gameId, title: gameId, developer: '', publisher: '', genres: ['Action'], themes: [], gameModes: [],
    perspectives: [], platforms: [], metacriticScore: null, playerCount: null, releaseDate: '2020-01-01',
    similarGameTitles: [], ...over,
  };
}

/** Stub the heavy stages on an instance so compute() runs only the orchestration. */
function stubStore(store: RecoStore, userGames: UserGameSnapshot[] = [user('steam-u1')]) {
  const s = store as any;
  s.loadResultsFromCache = vi.fn(async () => null);
  s.buildUserGameSnapshots = vi.fn(() => userGames.map(u => ({ ...u })));
  s.buildCandidatePool = vi.fn(async (_ug: unknown, sink: CandidateGame[]) => { sink.push(cand('steam-c1')); return sink; });
  s.hydrateSurvivorMetadata = vi.fn(async () => {});
  s.runWorker = vi.fn();
  return s;
}

describe('ML scores are written once (oracle#0)', () => {
  const win = window as any;
  let savedMl: unknown;
  beforeEach(() => { savedMl = win.ml; });
  afterEach(() => { win.ml = savedMl; });

  // 2,500 candidates = two batches of 2,000 + 500. Raw scores: real for even ids, synthesised for odd.
  const pool = () => Array.from({ length: 2500 }, (_, i) => cand(`steam-${i}`));
  const raw = (id: string) => (Number(id.slice(6)) % 97) / 100 + 0.01;
  function mockMl(onBatch: (batch: number) => void | Promise<void>) {
    let batch = 0;
    win.ml = {
      hasRealSteamProfile: async () => true,
      status: async () => ({ loaded: true }),
      buildUserProfile: async () => ({ profile: true }),
      scoreGames: vi.fn(async (_p: unknown, ids: string[]) => {
        await onBatch(batch++);
        return ids.map(id => ({ gameId: id, score: raw(id), synthetic: Number(id.slice(6)) % 2 === 1 }));
      }),
    };
  }
  const apply = (store: RecoStore, c: CandidateGame[], signal?: AbortSignal) =>
    (store as any).applyMLScores([user('steam-u1')], c, signal) as Promise<void>;

  it('a deadline after batch 1 leaves no mlScore / mlSynthetic on any candidate', async () => {
    const abort = new AbortController();
    // The deadline fires while batch 2 is being scored (batch 1 is already back).
    mockMl((b) => { if (b === 1) abort.abort(); });
    const c = pool();
    await apply(new RecoStore(), c, abort.signal);
    expect(c.some(x => x.mlScore != null || x.mlSynthetic)).toBe(false);
  });

  it('a failed second batch leaves no raw scores behind', async () => {
    mockMl((b) => { if (b === 1) throw new Error('ml crashed'); });
    const c = pool();
    await apply(new RecoStore(), c);
    expect(c.some(x => x.mlScore != null || x.mlSynthetic)).toBe(false);
  });

  it('normal completion writes the same percentile ranks as before', async () => {
    mockMl(() => {});
    const c = pool();
    await apply(new RecoStore(), c);
    const real = c.filter(x => Number(x.gameId.slice(6)) % 2 === 0);
    const synth = c.filter(x => Number(x.gameId.slice(6)) % 2 === 1);
    const realRanks = percentileRanks(real.map(x => raw(x.gameId)));
    const synthRanks = percentileRanks(synth.map(x => raw(x.gameId)));
    real.forEach((x, i) => { expect(x.mlScore).toBeCloseTo(realRanks[i], 12); expect(x.mlSynthetic).toBeUndefined(); });
    synth.forEach((x, i) => { expect(x.mlScore).toBeCloseTo(0.5 + (synthRanks[i] - 0.5) * 0.6, 12); expect(x.mlSynthetic).toBe(true); });
    expect(c.every(x => x.mlScore! >= 0 && x.mlScore! <= 1)).toBe(true);
  });
});

describe('fresh engagement for the pre-filter (oracle#1)', () => {
  beforeEach(() => { prefilterSeen.length = 0; });

  it('a game re-rated to 1 star since the last run no longer makes its studio loyal', async () => {
    const userGames = [
      user('steam-a', { developer: 'Studio X', rating: 1 }),
      user('steam-b', { developer: 'Studio X', rating: 5 }),
    ];
    // What the previous compute left in the per-run cache while steam-a was still loved.
    _engagementCache.set('steam-a', 5);
    const store = new RecoStore();
    store.subscribe(() => {});
    const s = stubStore(store, userGames);
    await store.compute();
    expect(prefilterSeen).toHaveLength(1);
    expect(prefilterSeen[0].loyal).not.toContain('studio x');
    // One clock for the run: the pre-filter's now is the worker's now.
    expect(s.runWorker).toHaveBeenCalledTimes(1);
    expect(prefilterSeen[0].now).toBe(s.runWorker.mock.calls[0][0].now);
  });

  it('snapshots carry the shared classifier label (a completed 2-day run is not a binge-drop)', () => {
    const snaps = (new RecoStore() as any).buildUserGameSnapshots() as UserGameSnapshot[];
    const s = snaps.find(x => x.gameId === 'steam-7')!;
    expect(s.sessionCount).toBe(3);
    expect(s.engagementPattern).toBe('unknown');
    expect(s.engagementPattern).toBe(classifyEngagementCurve(s));
  });
});

describe('adult content toggle refreshes Oracle (oracle#3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('refreshes once per real change, only after a first compute', async () => {
    setAllowAdultContent(true);
    const refresh = vi.spyOn(recoStore, 'refresh').mockImplementation(() => {});

    // Before any compute: the first compute reads the current setting anyway.
    setAllowAdultContent(false);
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(refresh).not.toHaveBeenCalled();

    setAllowAdultContent(true);
    recoStore.subscribe(() => {});
    stubStore(recoStore);
    const computed = recoStore.compute();
    await vi.advanceTimersByTimeAsync(1_000);
    await computed;
    expect((recoStore as any).runWorker).toHaveBeenCalledTimes(1);

    setAllowAdultContent(false);
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Flipped and flipped back inside the debounce: nothing changed.
    setAllowAdultContent(true);
    setAllowAdultContent(false);
    await vi.advanceTimersByTimeAsync(LIBRARY_REFRESH_DEBOUNCE_MS + 10);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('cache signature from compute start (oracle#20)', () => {
  afterEach(() => { lib.ids = []; localStorage.clear(); });

  it('a library change between compute start and save is not baked into the cache', async () => {
    lib.ids = ['steam-1'];
    const store = new RecoStore();
    store.subscribe(() => {});
    const s = stubStore(store);
    await store.compute();
    const gen = s.runWorker.mock.calls[0][1] as number;
    const startSignature = s.computeLibrarySignature as string;
    expect(startSignature).toContain('L:steam-1:');

    lib.ids = ['steam-1', 'steam-2']; // added while the worker ran
    s.finishWorkerResult({ type: 'result', shelves: [{ type: 'hero', title: 'h', games: [] }], tasteProfile: null, computeTimeMs: 1 }, gen);
    const saved = JSON.parse(localStorage.getItem('ark-oracle-results')!);
    expect(saved.librarySignature).toBe(startSignature);
    expect(saved.librarySignature).not.toContain('steam-2');
  });
});

describe('gg.deals all-time low needs a discount (earlier review)', () => {
  beforeEach(() => { gg.on = true; });
  afterEach(() => { gg.on = false; });

  it('a full-price game at its "low" is not flagged; a discounted one is', async () => {
    const c = [
      cand('steam-1', { price: { isFree: false, discountPercent: 0 } }),
      cand('steam-2', { price: { isFree: false, discountPercent: 10 } }),
    ];
    await (new RecoStore() as any).applyGgDeals(c);
    expect(c[0].price!.atHistoricalLow).toBeUndefined();
    expect(c[1].price!.atHistoricalLow).toBe(true);
  });
});
