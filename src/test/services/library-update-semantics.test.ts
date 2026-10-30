import { describe, it, expect, beforeEach, vi } from 'vitest';

// 1.0.97 B25: an explicit `addedAt: undefined` in an update (the Add-to-Library follow-up
// update) used to wipe the stored date, then crash building an ISO string from it.

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    syncJourneyTitle: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, updated: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getTotalHours: vi.fn().mockReturnValue(0),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
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

import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import type { LibraryEntryWithStatusStamp } from '@/services/library-store';

describe('libraryStore.updateEntry app-managed fields', () => {
  beforeEach(() => {
    localStorage.clear();
    libraryStore.clear();
  });

  it('keeps addedAt when the update carries addedAt: undefined, and does not throw', () => {
    const added = libraryStore.addToLibrary({ gameId: 'steam-1', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    const original = added.addedAt.getTime();

    expect(() => libraryStore.updateEntry('steam-1', { status: 'Playing', addedAt: undefined })).not.toThrow();
    expect(libraryStore.getEntry('steam-1')!.addedAt.getTime()).toBe(original);

    // A second update (e.g. a later status change) also works.
    expect(() => libraryStore.updateEntry('steam-1', { status: 'Completed' })).not.toThrow();
    expect(libraryStore.getEntry('steam-1')!.addedAt.getTime()).toBe(original);
  });

  it('still applies a defined addedAt', () => {
    libraryStore.addToLibrary({ gameId: 'steam-2', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    const when = new Date('2024-01-02T00:00:00Z');
    libraryStore.updateEntry('steam-2', { addedAt: when });
    expect(libraryStore.getEntry('steam-2')!.addedAt.getTime()).toBe(when.getTime());
  });

  it('clears executablePath when the update spreads executablePath: undefined', () => {
    libraryStore.addToLibrary({ gameId: 'steam-3', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '', executablePath: 'C:/g.exe' });
    libraryStore.updateEntry('steam-3', { executablePath: undefined });
    expect(libraryStore.getEntry('steam-3')!.executablePath).toBeUndefined();
  });

  it('keeps statusChangedAt when an update spreads it as undefined without a status change', () => {
    libraryStore.addToLibrary({ gameId: 'steam-4', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    libraryStore.updateEntry('steam-4', { status: 'Playing' });
    const stamp = (libraryStore.getEntry('steam-4') as LibraryEntryWithStatusStamp).statusChangedAt;
    expect(stamp).toBeTruthy();
    libraryStore.updateEntry('steam-4', { publicReviews: 'n', statusChangedAt: undefined } as never);
    expect((libraryStore.getEntry('steam-4') as LibraryEntryWithStatusStamp).statusChangedAt).toBe(stamp);
  });
});

describe('customGameStore.updateGame app-managed fields', () => {
  beforeEach(() => {
    localStorage.clear();
    customGameStore.clear();
  });

  it('keeps addedAt when the update carries addedAt: undefined', () => {
    const g = customGameStore.addGame({ title: 'Mine', platform: ['PC'], status: 'Want to Play' });
    const original = new Date(g.addedAt).getTime();
    expect(() => customGameStore.updateGame(g.id, { status: 'Playing', addedAt: undefined })).not.toThrow();
    expect(new Date(customGameStore.getGame(g.id)!.addedAt).getTime()).toBe(original);
    expect(() => customGameStore.updateGame(g.id, { status: 'Completed' })).not.toThrow();
  });

  it('still clears executablePath via an undefined spread', () => {
    const g = customGameStore.addGame({ title: 'Mine2', platform: ['PC'], status: 'Want to Play', executablePath: 'C:/x.exe' });
    customGameStore.updateGame(g.id, { executablePath: undefined });
    expect(customGameStore.getGame(g.id)!.executablePath).toBeUndefined();
  });
});
