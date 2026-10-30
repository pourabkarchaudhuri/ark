/**
 * prefetch-store (1.0.97 B22):
 *  - renderer-stores#8: an empty or partial refresh never replaces / shrinks a healthy browse cache
 *  - renderer-stores#35: findGameById uses lazy id maps with the same first-match results as find()
 *  - ui-browse-details#29: a search index built for an older list is never used for a newer one
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Game } from '@/types/game';

const steamMock = vi.hoisted(() => ({
  getMostPlayedGames: vi.fn(),
  getNewReleases: vi.fn(),
  getTopSellers: vi.fn(),
  getComingSoon: vi.fn(),
}));
const epicMock = vi.hoisted(() => ({
  browseCatalog: vi.fn(),
  getFreeGames: vi.fn(),
}));

vi.mock('@/services/steam-service', () => ({ steamService: steamMock }));
vi.mock('@/services/epic-service', () => ({ epicService: epicMock }));
vi.mock('@/services/game-service', () => ({
  gameService: { getTopSellers: vi.fn().mockResolvedValue([]) },
}));
// Dedup by id, first wins (the real worker merges cross-store twins; that is not under test here).
vi.mock('@/workers/use-dedup-worker', () => ({
  dedupSortInWorker: vi.fn(async (games: Game[]) => {
    const seen = new Set<string>();
    return games.filter(g => (seen.has(g.id) ? false : (seen.add(g.id), true)));
  }),
}));

const posted: Array<{ type: string; games?: Game[] }> = [];
class FakeWorker {
  postMessage(msg: { type: string; games?: Game[] }) { posted.push(msg); }
  addEventListener() {}
  removeEventListener() {}
}
vi.stubGlobal('Worker', FakeWorker);

import {
  setPrefetchedGames,
  getPrefetchedGames,
  prefetchBrowseData,
  clearBrowseCache,
  findGameById,
  searchPrefetchedGames,
} from '@/services/prefetch-store';

function game(id: string, store: 'steam' | 'epic', extra: Partial<Game> = {}): Game {
  return {
    id,
    store,
    title: `Game ${id}`,
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

function range(prefix: string, n: number, store: 'steam' | 'epic'): Game[] {
  return Array.from({ length: n }, (_, i) => game(`${prefix}-${i}`, store));
}

const saves = () => posted.filter(m => m.type === 'save');

function mockSources(steam: Game[], epicCatalog: Game[], epicFree: Game[] = []) {
  steamMock.getMostPlayedGames.mockResolvedValue(steam);
  steamMock.getNewReleases.mockResolvedValue([]);
  steamMock.getTopSellers.mockResolvedValue([]);
  steamMock.getComingSoon.mockResolvedValue([]);
  epicMock.browseCatalog.mockResolvedValue(epicCatalog);
  epicMock.getFreeGames.mockResolvedValue(epicFree);
}

beforeEach(async () => {
  await clearBrowseCache();
  posted.length = 0;
  vi.clearAllMocks();
});

describe('browse cache commit guard (renderer-stores#8)', () => {
  it('keeps Epic entries when the Epic source comes back empty, and saves the merged set', async () => {
    const steam = range('steam', 2000, 'steam');
    const epic = range('epic', 3000, 'epic');
    await setPrefetchedGames([...steam, ...epic]);
    posted.length = 0;

    mockSources(steam, []);
    const result = await prefetchBrowseData();

    expect(result).toHaveLength(5000);
    expect(result.filter(g => g.store === 'epic')).toHaveLength(3000);
    expect(getPrefetchedGames()).toHaveLength(5000);
    expect(saves()).toHaveLength(1);
    expect(saves()[0].games).toHaveLength(5000);
  });

  it('keeps memory unchanged and posts no save when every source is empty', async () => {
    const prev = [...range('steam', 2000, 'steam'), ...range('epic', 3000, 'epic')];
    await setPrefetchedGames(prev);
    posted.length = 0;

    mockSources([], []);
    const result = await prefetchBrowseData();

    expect(result).toBe(prev);
    expect(getPrefetchedGames()).toBe(prev);
    expect(saves()).toHaveLength(0);
  });

  it('keeps the current set when the refresh still shrinks it after re-adding empty sources', async () => {
    const prev = [...range('steam', 4000, 'steam'), ...range('epic', 1000, 'epic')];
    await setPrefetchedGames(prev);
    posted.length = 0;

    // Steam came back with half its games; Epic is fine — nothing to re-add, still < 90%.
    const committed = await setPrefetchedGames([...range('steam', 2000, 'steam'), ...range('epic', 1000, 'epic')]);

    expect(committed.saved).toBe(false);
    expect(committed.games).toBe(prev);
    expect(getPrefetchedGames()).toBe(prev);
    expect(saves()).toHaveLength(0);
  });

  it('replaces a small (unhealthy) current set without the shrink guard', async () => {
    await setPrefetchedGames(range('steam', 10, 'steam'));
    posted.length = 0;
    const next = range('new', 500, 'steam');
    const committed = await setPrefetchedGames(next);
    expect(committed.saved).toBe(true);
    expect(getPrefetchedGames()).toBe(next);
    expect(saves()).toHaveLength(1);
  });

  it('never commits an empty set, even over nothing', async () => {
    const committed = await setPrefetchedGames([]);
    expect(committed).toEqual({ games: [], saved: false });
    expect(getPrefetchedGames()).toBeNull();
    expect(saves()).toHaveLength(0);
  });
});

describe('findGameById id index (renderer-stores#35)', () => {
  function oldFind(list: Game[], id: string): Game | null {
    return list.find(g => g.id === id) ?? list.find(g => g.secondaryId === id) ?? null;
  }

  it('matches the old find-based results for every id, duplicates included', async () => {
    const list = [
      game('steam-1', 'steam', { secondaryId: 'epic-a:1' }),
      game('steam-1', 'steam', { title: 'duplicate id' }),
      game('steam-2', 'steam', { secondaryId: 'epic-a:1' }),
      game('epic-b:2', 'epic', { secondaryId: 'steam-3' }),
      game('steam-3', 'steam'),
      ...range('steam-x', 600, 'steam'),
    ];
    await setPrefetchedGames(list);
    const ids = ['steam-1', 'steam-2', 'epic-a:1', 'epic-b:2', 'steam-3', 'steam-x-599', 'missing'];
    for (const id of ids) {
      expect(findGameById(id)).toBe(oldFind(list, id));
    }
  });

  it('rebuilds when the list is replaced', async () => {
    const a = [game('steam-1', 'steam', { title: 'A' })];
    await setPrefetchedGames(a);
    expect(findGameById('steam-1')?.title).toBe('A');
    const b = [game('steam-1', 'steam', { title: 'B' })];
    await setPrefetchedGames(b);
    expect(findGameById('steam-1')?.title).toBe('B');
    await clearBrowseCache();
    expect(findGameById('steam-1')).toBeNull();
  });
});

describe('search index source (ui-browse-details#29)', () => {
  it('does not match an old index against a same-length replacement list', async () => {
    let idleCb: (() => void) | null = null;
    // Hold every chunk so the build for list B never finishes during the test.
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idleCb = cb; return 1; });
    try {
      const n = 600; // > one 500-game chunk, so the build is chunked
      const a = Array.from({ length: n }, (_, i) => game(`a-${i}`, 'steam', { title: i === 0 ? 'Zelda Alpha' : `Alpha ${i}` }));
      await setPrefetchedGames(a);
      // Finish A's build.
      while (idleCb) { const cb: () => void = idleCb; idleCb = null; cb(); }
      expect(searchPrefetchedGames('zelda', 5)?.[0]?.id).toBe('a-0');

      const b = Array.from({ length: n }, (_, i) => game(`b-${i}`, 'steam', { title: i === 5 ? 'Zelda Beta' : `Beta ${i}` }));
      await setPrefetchedGames(b);
      // B's build is still pending: the search must use B (fallback path), not A's index.
      const hits = searchPrefetchedGames('zelda', 5) ?? [];
      expect(hits.map(g => g.id)).toEqual(['b-5']);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('Worker', FakeWorker);
    }
  });

  it('an older build finishing late does not commit over a newer one', async () => {
    const pending: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { pending.push(cb); return 1; });
    try {
      const n = 600;
      const a = Array.from({ length: n }, (_, i) => game(`a-${i}`, 'steam', { title: `Alpha ${i}` }));
      const b = Array.from({ length: n }, (_, i) => game(`b-${i}`, 'steam', { title: i === 7 ? 'Zelda Beta' : `Beta ${i}` }));
      await setPrefetchedGames(a); // A's second chunk queued
      await setPrefetchedGames(b); // B's second chunk queued
      // B's chunk finishes first, then A's stale chunk runs late.
      for (const cb of pending.splice(0).reverse()) cb();
      expect((searchPrefetchedGames('zelda', 5) ?? []).map(g => g.id)).toEqual(['b-7']);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('Worker', FakeWorker);
    }
  });
});
