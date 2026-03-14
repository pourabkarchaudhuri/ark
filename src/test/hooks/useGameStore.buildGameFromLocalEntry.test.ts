/**
 * Tests for buildGameFromLocalEntry (useGameStore).
 * Ensures entries without cachedMeta show a safe placeholder title, not raw IDs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
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
    clear: vi.fn(),
  },
}));

vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

import { libraryStore } from '@/services/library-store';
import { buildGameFromLocalEntry } from '@/hooks/useGameStore';

describe('buildGameFromLocalEntry', () => {
  beforeEach(() => {
    localStorageMock.clear();
    libraryStore.clear();
  });

  it('returns title "Unknown Game" when entry has no cachedMeta and no journey entry (Epic)', () => {
    libraryStore.addToLibrary({
      gameId: 'epic-099a5ae11e914547af1c0cca4c9ffde2:238bbfdb72dd48f196c3835fba2e1842',
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
    });
    const id = 'epic-099a5ae11e914547af1c0cca4c9ffde2:238bbfdb72dd48f196c3835fba2e1842';
    const entry = libraryStore.getEntry(id);
    const game = buildGameFromLocalEntry(id, entry);
    expect(game).not.toBeNull();
    expect(game!.title).toBe('Unknown Game');
    expect(game!.developer).toBe('Unknown');
    expect(game!.store).toBe('epic');
  });

  it('returns title "Unknown Game" when entry has no cachedMeta and no journey entry (Steam)', () => {
    libraryStore.addToLibrary({
      gameId: 'steam-730',
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
    });
    const game = buildGameFromLocalEntry('steam-730', libraryStore.getEntry('steam-730'));
    expect(game).not.toBeNull();
    expect(game!.title).toBe('Unknown Game');
    expect(game!.developer).toBe('Unknown');
    expect(game!.store).toBe('steam');
  });

  it('returns meta title when entry has cachedMeta', () => {
    libraryStore.addToLibrary({
      gameId: 'epic-fn:reanimal',
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      cachedMeta: {
        title: 'Reanimal',
        store: 'epic',
        developer: 'Studio',
      },
    });
    const game = buildGameFromLocalEntry('epic-fn:reanimal', libraryStore.getEntry('epic-fn:reanimal'));
    expect(game).not.toBeNull();
    expect(game!.title).toBe('Reanimal');
    expect(game!.developer).toBe('Studio');
  });
});
