/**
 * useGameStore browse state (1.0.97 B22):
 *  - hooks#2   category switch race (Most Played, Catalog slow path, 'all' background refresh)
 *  - hooks#3   leaving the default category keeps catalogTotalCount / the catalog fast path
 *  - hooks#11  the 6-hour catalog refresh never swaps an unsorted list into active Catalog (A-Z)
 *  - hooks#12  background refresh result is stored even after unmount; throttle only on store
 *  - hooks#13  loadCatalogAppList dedups concurrent loads
 *  - hooks#10  library player counts fetched on mount and kept across library edits
 *  - player-count sweep: results of a superseded run land, a blocked run re-queues (1.0.96 regression)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Game } from '@/types/game';
import type { SteamAppListItem } from '@/types/steam';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    syncTitleIfPlaceholder: vi.fn(),
    getEntry: vi.fn().mockReturnValue(undefined),
    has: vi.fn().mockReturnValue(false),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, updated: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));
vi.mock('@/services/session-store', () => ({
  sessionStore: {
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
    clear: vi.fn(),
  },
}));
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    getFirstPlayingTransition: vi.fn().mockReturnValue(null),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

const steam = vi.hoisted(() => ({
  getMostPlayedGames: vi.fn(),
  getNewReleases: vi.fn(),
  getTopSellers: vi.fn(),
  getComingSoon: vi.fn(),
  getAppList: vi.fn(),
  getMultiplePlayerCounts: vi.fn(),
}));
const epic = vi.hoisted(() => ({ browseCatalog: vi.fn(), getFreeGames: vi.fn() }));
const gameSvc = vi.hoisted(() => ({
  getTopSellers: vi.fn(),
  getNewReleases: vi.fn(),
  getComingSoon: vi.fn(),
  clearCache: vi.fn(),
  getGameDetails: vi.fn().mockResolvedValue(null),
  searchGames: vi.fn().mockResolvedValue([]),
}));
const prefetch = vi.hoisted(() => ({
  getPrefetchedGames: vi.fn(),
  setPrefetchedGames: vi.fn(),
  getPrefetchedTopSellers: vi.fn(),
  waitForTopSellersPreload: vi.fn(),
  clearBrowseCache: vi.fn(),
  searchPrefetchedGames: vi.fn(),
}));
const catalog = vi.hoisted(() => ({
  getCachedCatalog: vi.fn(),
  setCachedCatalog: vi.fn(),
  isCatalogStale: vi.fn(),
  clearCatalogCache: vi.fn(),
  sortCatalogAZ: vi.fn((list: Array<{ name: string }>) => {
    list.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  }),
}));

vi.mock('@/services/steam-service', () => ({ steamService: steam }));
vi.mock('@/services/epic-service', () => ({ epicService: epic }));
vi.mock('@/services/game-service', () => ({ gameService: gameSvc }));
vi.mock('@/services/prefetch-store', () => prefetch);
vi.mock('@/services/catalog-cache', () => catalog);
vi.mock('@/services/detail-enricher', () => ({ detailEnricher: { reset: vi.fn() } }));
vi.mock('@/workers/use-dedup-worker', () => ({ dedupSortInWorker: vi.fn(async (g: Game[]) => [...g]) }));

import { useSteamGames, useLibraryGames, loadCatalogAppList, resetCatalogLoader } from '@/hooks/useGameStore';
import { libraryStore } from '@/services/library-store';
import type { GameCategory } from '@/types/game';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function game(id: string, extra: Partial<Game> = {}): Game {
  return {
    id,
    store: 'steam',
    title: id,
    developer: '',
    publisher: '',
    genre: [],
    platform: [],
    metacriticScore: null,
    releaseDate: '',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  } as Game;
}

function games(prefix: string, n: number, steamBase?: number): Game[] {
  return Array.from({ length: n }, (_, i) =>
    game(`${prefix}-${i}`, steamBase !== undefined ? { steamAppId: steamBase + i } : {}),
  );
}

/** A-Z app list of `perLetter` apps per letter, returned in reverse (unsorted) order. */
function appList(perLetter: number): SteamAppListItem[] {
  const out: SteamAppListItem[] = [];
  let id = 1;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (let i = 0; i < perLetter; i++) out.push({ appid: id++, name: `${letter}${String(i).padStart(3, '0')}` });
  }
  return out.reverse();
}

const ids = (list: Game[]) => list.map(g => g.id);

const flush = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalogLoader();
  localStorage.clear();
  libraryStore.clear();
  prefetch.getPrefetchedGames.mockReturnValue(null);
  prefetch.setPrefetchedGames.mockImplementation(async (g: Game[]) => ({ games: g, saved: true }));
  prefetch.getPrefetchedTopSellers.mockReturnValue(null);
  prefetch.waitForTopSellersPreload.mockResolvedValue(null);
  prefetch.searchPrefetchedGames.mockReturnValue(null);
  prefetch.clearBrowseCache.mockResolvedValue(undefined);
  catalog.isCatalogStale.mockResolvedValue(true);
  catalog.getCachedCatalog.mockResolvedValue([]);
  catalog.setCachedCatalog.mockResolvedValue(undefined);
  catalog.clearCatalogCache.mockResolvedValue(undefined);
  steam.getAppList.mockResolvedValue([{ appid: 1, name: 'Alpha' }, { appid: 2, name: 'Bravo' }]);
  steam.getMultiplePlayerCounts.mockResolvedValue({});
  steam.getMostPlayedGames.mockResolvedValue([]);
  steam.getNewReleases.mockResolvedValue([]);
  steam.getTopSellers.mockResolvedValue([]);
  steam.getComingSoon.mockResolvedValue([]);
  epic.browseCatalog.mockResolvedValue([]);
  epic.getFreeGames.mockResolvedValue([]);
  gameSvc.getTopSellers.mockResolvedValue(games('ts', 60));
  gameSvc.getNewReleases.mockResolvedValue([]);
  gameSvc.getComingSoon.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── hooks#13 ──────────────────────────────────────────────────────────────

describe('loadCatalogAppList in-flight dedup (hooks#13)', () => {
  it('two concurrent loads read IndexedDB once', async () => {
    catalog.isCatalogStale.mockResolvedValue(false);
    const idb = deferred<SteamAppListItem[]>();
    catalog.getCachedCatalog.mockReturnValue(idb.promise);
    const a = loadCatalogAppList();
    const b = loadCatalogAppList();
    idb.resolve([{ appid: 2, name: 'B' }, { appid: 1, name: 'A' }]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(catalog.getCachedCatalog).toHaveBeenCalledTimes(1);
    expect(steam.getAppList).not.toHaveBeenCalled();
    expect(ra).toBe(rb);
  });

  it('a sorted caller joining an unsorted load gets sorted data', async () => {
    const api = deferred<SteamAppListItem[]>();
    steam.getAppList.mockReturnValue(api.promise);
    const unsorted = loadCatalogAppList();
    const sorted = loadCatalogAppList({ sorted: true });
    api.resolve([{ appid: 3, name: 'C' }, { appid: 1, name: 'A' }, { appid: 2, name: 'B' }]);
    await unsorted;
    const list = await sorted;
    expect(list.map(a => a.name)).toEqual(['A', 'B', 'C']);
    expect(steam.getAppList).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh during a normal load does its own fetch', async () => {
    const first = deferred<SteamAppListItem[]>();
    const second = deferred<SteamAppListItem[]>();
    steam.getAppList.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const normal = loadCatalogAppList();
    await vi.waitFor(() => expect(steam.getAppList).toHaveBeenCalledTimes(1));
    const forced = loadCatalogAppList({ forceRefresh: true });
    second.resolve([{ appid: 9, name: 'Fresh' }]);
    first.resolve([{ appid: 1, name: 'Old' }]);
    expect((await forced).map(a => a.name)).toEqual(['Fresh']);
    expect((await normal).map(a => a.name)).toEqual(['Old']);
    expect(steam.getAppList).toHaveBeenCalledTimes(2);
  });

  it('a reset during a load keeps the stale result out of the memory cache', async () => {
    const api = deferred<SteamAppListItem[]>();
    steam.getAppList.mockReturnValueOnce(api.promise);
    const pending = loadCatalogAppList();
    resetCatalogLoader();
    api.resolve([{ appid: 1, name: 'Stale' }]);
    await pending;
    steam.getAppList.mockResolvedValueOnce([{ appid: 2, name: 'New' }]);
    const next = await loadCatalogAppList();
    expect(next.map(a => a.name)).toEqual(['New']);
    expect(catalog.setCachedCatalog).toHaveBeenCalledTimes(1);
    expect(catalog.setCachedCatalog).toHaveBeenCalledWith([{ appid: 2, name: 'New' }]);
  });
});

// ─── hooks#2 ───────────────────────────────────────────────────────────────

describe('category switch race (hooks#2)', () => {
  it('a slow Most Played fetch does not overwrite New Releases', async () => {
    const mp = deferred<Game[]>();
    const nr = deferred<Game[]>();
    steam.getMostPlayedGames.mockReturnValue(mp.promise);
    gameSvc.getNewReleases.mockReturnValue(nr.promise);
    const { result, rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'most-played' as GameCategory },
    });
    rerender({ cat: 'recent' });
    await act(async () => { nr.resolve(games('nr', 3)); });
    await act(async () => { mp.resolve(games('mp', 5)); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ids(result.current.games)).toEqual(ids(games('nr', 3)));
    unmount();
  });

  it('a slow Catalog list load does not append catalog stubs to Top Sellers', async () => {
    const api = deferred<SteamAppListItem[]>();
    steam.getAppList.mockReturnValue(api.promise);
    const { result, rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'catalog' as GameCategory },
    });
    rerender({ cat: 'trending' });
    await waitFor(() => expect(result.current.games).toHaveLength(60));
    await act(async () => { api.resolve(appList(5)); });
    await waitFor(() => expect(result.current.catalogTotalCount).toBe(130));
    expect(ids(result.current.games)).toEqual(ids(games('ts', 60)));
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it("the 'all' background refresh finishing after a switch to Trending does not replace the grid", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const prefetched = games('pf', 600);
    prefetch.getPrefetchedGames.mockReturnValue(prefetched);
    const mp = deferred<Game[]>();
    steam.getMostPlayedGames.mockReturnValue(mp.promise);
    // Mounting straight on 'all' reuses the seeded set without a fetch; switching to it fetches.
    const { result, rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'trending' as GameCategory },
    });
    await flush();
    rerender({ cat: 'all' });
    await flush(10_000); // background refresh timer fires; sources pending
    expect(steam.getMostPlayedGames).toHaveBeenCalled();
    rerender({ cat: 'trending' });
    await flush();
    expect(result.current.games).toHaveLength(60);
    const fresh = games('fresh', 600);
    await act(async () => { mp.resolve(fresh); });
    await flush();
    expect(prefetch.setPrefetchedGames).toHaveBeenCalledWith(fresh);
    expect(ids(result.current.games)).toEqual(ids(games('ts', 60)));
    unmount();
  });

  it('a superseded Top Sellers fetch still upgrades 38 → 137 within the same category', async () => {
    const first = deferred<Game[]>();
    const second = deferred<Game[]>();
    gameSvc.getTopSellers.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, unmount } = renderHook(() => useSteamGames('trending'));
    act(() => { result.current.refresh(); });
    await act(async () => { second.resolve(games('ts38', 38)); });
    await waitFor(() => expect(result.current.games).toHaveLength(38));
    await act(async () => { first.resolve(games('ts137', 137)); });
    await waitFor(() => expect(result.current.games).toHaveLength(137));
    unmount();
  });
});

// ─── hooks#3 ───────────────────────────────────────────────────────────────

describe('catalog count across category switches (hooks#3)', () => {
  it('keeps catalogTotalCount after leaving Top Sellers and reuses the list for Catalog', async () => {
    const { result, rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'trending' as GameCategory },
    });
    await waitFor(() => expect(result.current.catalogTotalCount).toBe(2));
    rerender({ cat: 'recent' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalogTotalCount).toBe(2);
    rerender({ cat: 'catalog' });
    await waitFor(() => expect(result.current.games.map(g => g.title)).toEqual(['Alpha', 'Bravo']));
    expect(steam.getAppList).toHaveBeenCalledTimes(1);
    expect(catalog.getCachedCatalog).not.toHaveBeenCalled();

    // Manual refresh drops the list; the count is reloaded.
    steam.getAppList.mockResolvedValue([{ appid: 1, name: 'Alpha' }, { appid: 2, name: 'Bravo' }, { appid: 3, name: 'Charlie' }]);
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.catalogTotalCount).toBe(3));
    unmount();
  });
});

// ─── hooks#11 ──────────────────────────────────────────────────────────────

describe('6-hour catalog refresh during Catalog (A-Z) (hooks#11)', () => {
  it('keeps the sorted list and offset; loadMore and letter jumps stay A-Z', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    steam.getAppList.mockResolvedValue(appList(10)); // 260 apps, unsorted
    const { result, unmount } = renderHook(() => useSteamGames('catalog'));
    await flush();
    expect(result.current.games).toHaveLength(100);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.games).toHaveLength(200);

    // Stale cache: the forced refresh returns Steam's unsorted order.
    steam.getAppList.mockResolvedValue(appList(10));
    await flush(6 * 60 * 60 * 1000);
    expect(steam.getAppList).toHaveBeenCalledTimes(2);

    await act(async () => { await result.current.loadMore(); });
    const titles = result.current.games.map(g => g.title);
    expect(titles).toHaveLength(260);
    expect(titles).toEqual([...titles].sort());

    act(() => { result.current.jumpToLetter('M'); });
    expect(result.current.games[0].title).toBe('M000');
    unmount();
  });
});

// ─── hooks#12 ──────────────────────────────────────────────────────────────

describe('background refresh across unmount (hooks#12)', () => {
  it('stores the fresh set and records the refresh when the Dashboard unmounted mid-refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    prefetch.getPrefetchedGames.mockReturnValue(games('pf', 600));
    const mp = deferred<Game[]>();
    steam.getMostPlayedGames.mockReturnValue(mp.promise);
    const { rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'trending' as GameCategory },
    });
    await flush();
    rerender({ cat: 'all' });
    await flush(10_000);
    unmount();
    const fresh = games('fresh', 600);
    await act(async () => { mp.resolve(fresh); });
    await flush();
    expect(prefetch.setPrefetchedGames).toHaveBeenCalledWith(fresh);
    expect(localStorage.getItem('ark-bg-refresh-ts')).not.toBeNull();
  });

  it('does not record the refresh when the size check rejects it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    prefetch.getPrefetchedGames.mockReturnValue(games('pf', 600));
    const mp = deferred<Game[]>();
    steam.getMostPlayedGames.mockReturnValue(mp.promise);
    const { rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'trending' as GameCategory },
    });
    await flush();
    rerender({ cat: 'all' });
    await flush(10_000);
    unmount();
    await act(async () => { mp.resolve(games('fresh', 100)); });
    await flush();
    expect(prefetch.setPrefetchedGames).not.toHaveBeenCalled();
    expect(localStorage.getItem('ark-bg-refresh-ts')).toBeNull();
  });
});

// ─── Player-count sweep (1.0.96 regression) ─────────────────────────────────

describe('Browse player-count sweep', () => {
  it('shows results of a sweep superseded mid-flight and re-queues the blocked run', async () => {
    prefetch.getPrefetchedGames.mockReturnValue(games('all', 150, 50_000));
    const gate = deferred<void>();
    steam.getMultiplePlayerCounts.mockImplementation(async (batch: number[]) => {
      await gate.promise;
      return Object.fromEntries(batch.map(id => [id, id]));
    });
    gameSvc.getNewReleases.mockResolvedValue(games('nr', 3, 50_000));
    const { result, rerender, unmount } = renderHook(({ cat }: { cat: GameCategory }) => useSteamGames(cat), {
      initialProps: { cat: 'all' as GameCategory },
    });
    await waitFor(() => expect(steam.getMultiplePlayerCounts).toHaveBeenCalledTimes(1), { timeout: 3000 });
    rerender({ cat: 'recent' });
    await waitFor(() => expect(result.current.games).toHaveLength(3));
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(result.current.games.map(g => g.playerCount)).toEqual([50_000, 50_001, 50_002]), { timeout: 3000 });
    unmount();
  });

  it('a run blocked by another mount’s sweep retries instead of waiting 10 minutes', async () => {
    prefetch.getPrefetchedGames.mockReturnValue(null);
    const gate = deferred<void>();
    steam.getMultiplePlayerCounts.mockImplementationOnce(async (batch: number[]) => {
      await gate.promise;
      return Object.fromEntries(batch.map(id => [id, 1]));
    });
    steam.getMultiplePlayerCounts.mockImplementation(async (batch: number[]) => Object.fromEntries(batch.map(id => [id, 2])));
    steam.getMostPlayedGames.mockResolvedValue(games('mpA', 2, 60_000));
    gameSvc.getNewReleases.mockResolvedValue(games('nrB', 2, 61_000));
    const a = renderHook(() => useSteamGames('most-played'));
    await waitFor(() => expect(steam.getMultiplePlayerCounts).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const b = renderHook(() => useSteamGames('recent'));
    await waitFor(() => expect(b.result.current.games).toHaveLength(2));
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(b.result.current.games.map(g => g.playerCount)).toEqual([2, 2]), { timeout: 4000 });
    expect(steam.getMultiplePlayerCounts).toHaveBeenLastCalledWith([61_000, 61_001]);
    a.unmount();
    b.unmount();
  });
});

// ─── hooks#10 ──────────────────────────────────────────────────────────────

describe('library player counts (hooks#10)', () => {
  function addSteam(appId: number) {
    libraryStore.addToLibrary({
      gameId: `steam-${appId}`,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      cachedMeta: { title: `Game ${appId}`, store: 'steam', steamAppId: appId },
    });
  }

  it('fetches counts once on mount and keeps them across a status edit made mid-fetch', async () => {
    addSteam(70_001);
    addSteam(70_002);
    addSteam(70_003);
    const gate = deferred<void>();
    steam.getMultiplePlayerCounts.mockImplementation(async (batch: number[]) => {
      await gate.promise;
      return Object.fromEntries(batch.map(id => [id, id - 70_000]));
    });
    const { result, unmount } = renderHook(() => useLibraryGames());
    await waitFor(() => expect(steam.getMultiplePlayerCounts).toHaveBeenCalledTimes(1));
    expect([...steam.getMultiplePlayerCounts.mock.calls[0][0]].sort()).toEqual([70_001, 70_002, 70_003]);

    // A library edit inside the fetch window rebuilds the list before the counts land.
    act(() => { libraryStore.updateEntry('steam-70002', { status: 'Playing' }); });
    await waitFor(() => expect(result.current.games.find(g => g.id === 'steam-70002')?.status).toBe('Playing'));
    await act(async () => { gate.resolve(); });
    const countOf = (id: string) => result.current.games.find(g => g.id === id)?.playerCount;
    await waitFor(() => expect(countOf('steam-70001')).toBe(1));
    expect(countOf('steam-70002')).toBe(2);
    expect(countOf('steam-70003')).toBe(3);

    // A later edit keeps them (rebuild merges the shared counts) and does not refetch.
    act(() => { libraryStore.updateEntry('steam-70003', { status: 'Completed' }); });
    await waitFor(() => expect(result.current.games.find(g => g.id === 'steam-70003')?.status).toBe('Completed'));
    expect(countOf('steam-70001')).toBe(1);
    expect(countOf('steam-70003')).toBe(3);
    expect(steam.getMultiplePlayerCounts).toHaveBeenCalledTimes(1);
    unmount();
  });
});
