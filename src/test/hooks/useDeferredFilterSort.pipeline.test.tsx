/**
 * useDeferredFilterSort pipeline (1.0.97 B21): library invalidation by list identity
 * (ui-browse-details#2), computedFor + empty results (ui-browse-details#1), content remap
 * (hooks#5), cancelled runs retried under StrictMode (ui-browse-details#17), release-date sort
 * in library (hooks#7) and single scoring per library search (hooks#20).
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Game, GameFilters } from '@/types/game';
import {
  useDeferredFilterSort,
  __filterSortInternals,
  type FilterSortInput,
} from '@/hooks/useDeferredFilterSort';

const scoreCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/services/prefetch-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/prefetch-store')>();
  return {
    ...actual,
    scoreGame: (...args: Parameters<typeof actual.scoreGame>) => {
      scoreCalls.n++;
      return actual.scoreGame(...args);
    },
  };
});

const FILTERS: GameFilters = {
  search: '',
  status: 'All',
  priority: 'All',
  genre: 'All',
  platform: 'All',
  category: 'top-sellers',
  releaseYear: 'All',
  store: [],
} as unknown as GameFilters;

function g(id: string, over: Partial<Game> = {}): Game {
  return {
    id,
    title: `Title ${id}`,
    developer: 'Dev',
    publisher: 'Pub',
    genre: ['Action'],
    platform: ['Windows'],
    metacriticScore: null,
    releaseDate: '2020-01-01',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as Game;
}

function base(over: Partial<FilterSortInput> = {}): FilterSortInput {
  return {
    currentGames: [],
    searchResults: [],
    isSearching: false,
    viewMode: 'library',
    searchQuery: '',
    filters: FILTERS,
    sortBy: 'rating',
    sortDirection: 'desc',
    allowAdultContent: true,
    ...over,
  };
}

/** Two rAFs (setTimeout(0) in the test setup) plus React's transition flush. */
async function flushFrames() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { vi.advanceTimersByTime(20); });
  }
}

describe('useDeferredFilterSort pipeline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('library: a rebuilt list with a new status is picked up, in one recompute', async () => {
    const lib1 = [g('steam-1', { isInLibrary: true, status: 'Want to Play' }), g('steam-2', { isInLibrary: true, status: 'Playing' })];
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ currentGames: lib1 }),
    });
    expect(result.current.sortedGames.map(x => x.status)).toEqual(['Playing', 'Want to Play']);

    const spy = vi.spyOn(__filterSortInternals, 'computeFilterAndDynamic');
    // useLibraryGames rebuilds the list (new reference, same length and endpoint ids).
    const lib2 = [g('steam-1', { isInLibrary: true, status: 'Completed' }), lib1[1]!];
    rerender(base({ currentGames: lib2 }));
    expect(result.current.sortedGames.find(x => x.id === 'steam-1')!.status).toBe('Completed');
    await flushFrames();
    expect(result.current.sortedGames.find(x => x.id === 'steam-1')!.status).toBe('Completed');
    expect(spy).toHaveBeenCalledTimes(1);

    // Same reference again (unrelated re-render): no recompute.
    rerender(base({ currentGames: lib2 }));
    await flushFrames();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('library: a search with no match returns [] for the library view', () => {
    const lib = [g('steam-1', { isInLibrary: true, title: 'Hades' }), g('steam-2', { isInLibrary: true, title: 'Celeste' })];
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ currentGames: lib }),
    });
    expect(result.current.computedFor?.viewMode).toBe('library');
    rerender(base({ currentGames: lib, searchQuery: 'zzzz', isSearching: true }));
    return flushFrames().then(() => {
      expect(result.current.sortedGames).toEqual([]);
      expect(result.current.computedFor?.viewMode).toBe('library');
    });
  });

  it('library: one search scores every game once (not twice), dynamic options unchanged', async () => {
    const lib = [
      g('steam-1', { isInLibrary: true, title: 'Hades', genre: ['Roguelike'], platform: ['Windows'], releaseDate: '2020-09-17' }),
      g('steam-2', { isInLibrary: true, title: 'Hades II', genre: ['Action'], platform: ['Mac'], releaseDate: '2025-09-25' }),
      g('steam-3', { isInLibrary: true, title: 'Celeste', genre: ['Platformer'], platform: ['Linux'], releaseDate: '2018-01-25' }),
    ];
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ currentGames: lib }),
    });
    scoreCalls.n = 0;
    rerender(base({ currentGames: lib, searchQuery: 'hades', isSearching: true }));
    await flushFrames();
    expect(scoreCalls.n).toBe(lib.length);
    expect(result.current.sortedGames.map(x => x.id).sort()).toEqual(['steam-1', 'steam-2']);
    expect(result.current.dynamicGenres).toEqual(['Action', 'Roguelike']);
    expect(result.current.dynamicPlatforms).toEqual(['Mac', 'Windows']);
    expect(result.current.dynamicYears).toEqual(['2025', '2020']);
  });

  it('browse: an empty filter result is [] stamped for browse', async () => {
    const games = Array.from({ length: 50 }, (_, i) => g(`steam-${i}`, { store: 'steam' }));
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ viewMode: 'browse', currentGames: games }),
    });
    expect(result.current.sortedGames).toHaveLength(50);
    rerender(base({ viewMode: 'browse', currentGames: games, filters: { ...FILTERS, store: ['epic'] } }));
    await flushFrames();
    expect(result.current.sortedGames).toEqual([]);
    expect(result.current.computedFor?.viewMode).toBe('browse');
  });

  it('browse: contentVersion remaps fresh objects in the same order, without a recompute', async () => {
    const games = [
      g('steam-1', { metacriticScore: 90, recommendations: 1000 }),
      g('steam-2', { metacriticScore: 80, recommendations: 1000 }),
      g('steam-3', { metacriticScore: 70, recommendations: 1000 }),
    ];
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ viewMode: 'browse', currentGames: games, contentVersion: 1 }),
    });
    const order = result.current.sortedGames.map(x => x.id);
    const spy = vi.spyOn(__filterSortInternals, 'computeFilterAndDynamic');

    // Same objects, bumped version: nothing changes, same output reference.
    const before = result.current;
    rerender(base({ viewMode: 'browse', currentGames: [...games], contentVersion: 2 }));
    await flushFrames();
    expect(result.current).toBe(before);

    const enriched = games.map(x => ({ ...x, playerCount: 1234 }));
    rerender(base({ viewMode: 'browse', currentGames: enriched, contentVersion: 3 }));
    await flushFrames();
    expect(result.current.sortedGames.map(x => x.id)).toEqual(order);
    expect(result.current.sortedGames.every(x => x.playerCount === 1234)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('browse: search mode is not remapped', async () => {
    const games = [g('steam-1'), g('steam-2')];
    const results = [g('steam-2')];
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ viewMode: 'browse', currentGames: games, searchResults: results, isSearching: true, searchQuery: 'x', contentVersion: 1 }),
    });
    const before = result.current;
    rerender(base({
      viewMode: 'browse', currentGames: games.map(x => ({ ...x, playerCount: 5 })), searchResults: results,
      isSearching: true, searchQuery: 'x', contentVersion: 2,
    }));
    await flushFrames();
    expect(result.current).toBe(before);
  });

  it('StrictMode: a large browse list is populated after the deferred frames', async () => {
    const games = Array.from({ length: 1000 }, (_, i) => g(`steam-${i}`));
    const wrapper = ({ children }: { children: React.ReactNode }) => <React.StrictMode>{children}</React.StrictMode>;
    const { result } = renderHook(() => useDeferredFilterSort(base({ viewMode: 'browse', currentGames: games })), { wrapper });
    expect(result.current.sortedGames).toHaveLength(0);
    await flushFrames();
    expect(result.current.sortedGames).toHaveLength(1000);
    expect(result.current.computedFor?.viewMode).toBe('browse');
  });

  it('version guard: a superseded deferred run does not overwrite the newer result', async () => {
    const games = Array.from({ length: 1000 }, (_, i) => g(`steam-${i}`, { genre: [i % 2 ? 'Odd' : 'Even'] }));
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ viewMode: 'browse', currentGames: games }),
    });
    rerender(base({ viewMode: 'browse', currentGames: games, filters: { ...FILTERS, genre: 'Odd' } }));
    await flushFrames();
    expect(result.current.sortedGames).toHaveLength(500);
    expect(result.current.sortedGames.every(x => x.genre[0] === 'Odd')).toBe(true);
  });

  it('view switch over 300 games keeps the previous view output for the first frame', async () => {
    const lib = Array.from({ length: 10 }, (_, i) => g(`lib-${i}`, { isInLibrary: true }));
    const browse = Array.from({ length: 400 }, (_, i) => g(`steam-${i}`));
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ viewMode: 'library', currentGames: lib }),
    });
    rerender(base({ viewMode: 'browse', currentGames: browse }));
    expect(result.current.computedFor?.viewMode).toBe('library');
    await flushFrames();
    expect(result.current.computedFor?.viewMode).toBe('browse');
    expect(result.current.sortedGames).toHaveLength(400);
  });

  it('library with a status filter sorts by release date (ISO, text and missing dates)', async () => {
    const lib = [
      g('a', { isInLibrary: true, status: 'Completed', releaseDate: '2021-05-01' }),
      g('b', { isInLibrary: true, status: 'Completed', releaseDate: 'Coming Soon' }),
      g('c', { isInLibrary: true, status: 'Completed', releaseDate: '2019-03-10' }),
      g('d', { isInLibrary: true, status: 'Completed', releaseDate: '' }),
      g('e', { isInLibrary: true, status: 'Completed', releaseDate: '2023-11-20' }),
      g('f', { isInLibrary: true, status: 'Playing', releaseDate: '2024-01-01' }),
    ];
    const filters = { ...FILTERS, status: 'Completed' } as GameFilters;
    const { result, rerender } = renderHook((p: FilterSortInput) => useDeferredFilterSort(p), {
      initialProps: base({ currentGames: lib, filters, sortBy: 'releaseDate', sortDirection: 'asc' }),
    });
    const asc = result.current.sortedGames.map(x => x.id);
    expect(asc.slice(2)).toEqual(['c', 'a', 'e']);
    expect(asc.slice(0, 2).sort()).toEqual(['b', 'd']);

    rerender(base({ currentGames: lib, filters, sortBy: 'releaseDate', sortDirection: 'desc' }));
    await flushFrames();
    const desc = result.current.sortedGames.map(x => x.id);
    expect(desc.slice(0, 3)).toEqual(['e', 'a', 'c']);
  });
});
