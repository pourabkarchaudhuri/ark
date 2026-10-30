/**
 * 1.0.97 B18 — the cachedMeta backfill is ONE shared chain: concurrent callers
 * (Settings import + every Dashboard mount) fetch each id once, ids filled
 * elsewhere mid-run are skipped, and writes land in batches (a few notifies,
 * not one per game). A clear / import resets the per-session state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Game } from '@/types/game';
import { gameService, __resetCachedMetaBackfillForTests } from '@/services/game-service';
import { libraryStore } from '@/services/library-store';
import { useLibraryGames } from '@/hooks/useGameStore';

function fakeGame(id: string): Game {
  return {
    id,
    title: `Title ${id}`,
    store: id.startsWith('epic-') ? 'epic' : 'steam',
    developer: 'Dev',
    publisher: 'Pub',
    genre: ['Action'],
    metacriticScore: null,
    platform: ['PC'],
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    releaseDate: '2020-01-01',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Game;
}

function addBare(ids: string[]) {
  for (const gameId of ids) {
    libraryStore.addToLibrary({
      gameId,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
    });
  }
}

const ids = (n: number, prefix = 'steam-') => Array.from({ length: n }, (_, i) => `${prefix}${1000 + i}`);

describe('gameService.backfillLibraryMissingCachedMeta', () => {
  let details: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    libraryStore.clear();
    __resetCachedMetaBackfillForTests({ delayMs: 0 });
    details = vi.spyOn(gameService, 'getGameDetails').mockImplementation(async (id: string) => fakeGame(id));
  });

  afterEach(() => {
    details.mockRestore();
    __resetCachedMetaBackfillForTests();
  });

  it('backfills 100 games with a handful of notifies, not 100', async () => {
    addBare(ids(100));
    let notifies = 0;
    const unsub = libraryStore.subscribe(() => { notifies++; });

    await gameService.backfillLibraryMissingCachedMeta();
    unsub();

    expect(details).toHaveBeenCalledTimes(100);
    expect(notifies).toBeGreaterThanOrEqual(1);
    expect(notifies).toBeLessThanOrEqual(5);
    expect(libraryStore.getEntry('steam-1042')!.cachedMeta!.title).toBe('Title steam-1042');
  });

  it('two concurrent callers share one run (one fetch per id)', async () => {
    addBare(ids(20));
    const a = gameService.backfillLibraryMissingCachedMeta();
    const b = gameService.backfillLibraryMissingCachedMeta();
    await Promise.all([a, b]);

    expect(details).toHaveBeenCalledTimes(20);
    expect(new Set(details.mock.calls.map((c) => c[0])).size).toBe(20);
  });

  it('skips an id filled elsewhere while the run is in progress', async () => {
    addBare(ids(5));
    details.mockImplementation(async (id: string) => {
      // While fetching the first id, something else fills the third one.
      if (id === 'steam-1000') libraryStore.updateEntry('steam-1002', { cachedMeta: { title: 'Filled elsewhere' } });
      return fakeGame(id);
    });

    await gameService.backfillLibraryMissingCachedMeta();

    expect(details.mock.calls.map((c) => c[0])).not.toContain('steam-1002');
    expect(libraryStore.getEntry('steam-1002')!.cachedMeta!.title).toBe('Filled elsewhere');
  });

  it('does not retry failed ids in the same session, but does after the library is replaced', async () => {
    addBare(ids(3));
    details.mockResolvedValue(null);
    await gameService.backfillLibraryMissingCachedMeta();
    await gameService.backfillLibraryMissingCachedMeta();
    expect(details).toHaveBeenCalledTimes(3);

    const exported = libraryStore.exportData();
    libraryStore.importData(exported);
    await gameService.backfillLibraryMissingCachedMeta();
    expect(details).toHaveBeenCalledTimes(6);
  });

  it('ignores custom ids', async () => {
    libraryStore.addToLibrary({
      gameId: 'custom-1',
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
    });
    await gameService.backfillLibraryMissingCachedMeta();
    expect(details).not.toHaveBeenCalled();
  });
});

describe('useLibraryGames cachedMeta backfill', () => {
  let details: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    libraryStore.clear();
    __resetCachedMetaBackfillForTests({ delayMs: 0 });
    details = vi.spyOn(gameService, 'getGameDetails').mockImplementation(async (id: string) => fakeGame(id));
  });

  afterEach(() => {
    details.mockRestore();
    __resetCachedMetaBackfillForTests();
  });

  it('mount / unmount / remount three times fetches each id once', async () => {
    addBare(ids(10));
    for (let i = 0; i < 3; i++) {
      const { unmount } = renderHook(() => useLibraryGames());
      unmount();
    }
    await gameService.backfillLibraryMissingCachedMeta();

    expect(details).toHaveBeenCalledTimes(10);
    expect(new Set(details.mock.calls.map((c) => c[0])).size).toBe(10);
    for (const id of ids(10)) expect(libraryStore.getEntry(id)!.cachedMeta).toBeDefined();
  });
});
