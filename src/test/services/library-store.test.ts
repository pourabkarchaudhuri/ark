import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameStatus, GamePriority } from '@/types/game';

// Mock journey-store before importing library-store (which depends on it)
vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    getEntry: vi.fn(),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, updated: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

// Mock status-history-store before importing library-store (which depends on it)
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

// Mock localStorage
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

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Import after mocking
import { libraryStore } from '@/services/library-store';

describe('LibraryStore', () => {
  beforeEach(() => {
    localStorageMock.clear();
    libraryStore.clear();
  });

  describe('addToLibrary', () => {
    it('adds a game to the library', () => {
      const entry = libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: 'Looking forward to this!',
        recommendationSource: 'Friend',
      });

      expect(entry).toBeDefined();
      expect(entry.gameId).toBe(12345);
      expect(entry.status).toBe('Want to Play');
      expect(entry.priority).toBe('High');
      expect(entry.addedAt).toBeInstanceOf(Date);
      expect(entry.updatedAt).toBeInstanceOf(Date);
    });

    it('notifies listeners on add', () => {
      const listener = vi.fn();
      libraryStore.subscribe(listener);

      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('removeFromLibrary', () => {
    it('removes a game from the library', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(libraryStore.isInLibrary(12345)).toBe(true);

      const removed = libraryStore.removeFromLibrary(12345);

      expect(removed).toBe(true);
      expect(libraryStore.isInLibrary(12345)).toBe(false);
    });

    it('returns false for non-existent game', () => {
      const removed = libraryStore.removeFromLibrary(99999);
      expect(removed).toBe(false);
    });

    it('notifies listeners on remove', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });

      const listener = vi.fn();
      libraryStore.subscribe(listener);

      libraryStore.removeFromLibrary(12345);

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('updateEntry', () => {
    it('updates an existing entry', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'Low',
        publicReviews: '',
        recommendationSource: '',
      });

      const updated = libraryStore.updateEntry(12345, {
        status: 'Playing',
        priority: 'High',
        publicReviews: 'Started playing!',
      });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe('Playing');
      expect(updated?.priority).toBe('High');
      expect(updated?.publicReviews).toBe('Started playing!');
    });

    it('returns undefined for non-existent entry', () => {
      const updated = libraryStore.updateEntry(99999, { status: 'Completed' });
      expect(updated).toBeUndefined();
    });

    it('updates the updatedAt timestamp', () => {
      const entry = libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      const originalUpdatedAt = entry.updatedAt.getTime();

      // Small delay
      const updated = libraryStore.updateEntry(12345, { priority: 'High' });

      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe('isInLibrary', () => {
    it('returns true for existing entry', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Want to Play',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(libraryStore.isInLibrary(12345)).toBe(true);
    });

    it('returns false for non-existent entry', () => {
      expect(libraryStore.isInLibrary(99999)).toBe(false);
    });
  });

  describe('getEntry', () => {
    it('returns entry for existing gameId', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Playing',
        priority: 'High',
        publicReviews: 'Great game!',
        recommendationSource: 'Review',
      });

      const entry = libraryStore.getEntry(12345);

      expect(entry).toBeDefined();
      expect(entry?.gameId).toBe(12345);
      expect(entry?.status).toBe('Playing');
    });

    it('returns undefined for non-existent gameId', () => {
      const entry = libraryStore.getEntry(99999);
      expect(entry).toBeUndefined();
    });
  });

  describe('getAllEntries', () => {
    it('returns all entries', () => {
      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 3,
        status: 'Completed',
        priority: 'Low',
        publicReviews: '',
        recommendationSource: '',
      });

      const entries = libraryStore.getAllEntries();

      expect(entries).toHaveLength(3);
    });

    it('returns entries sorted by addedAt (newest first)', () => {
      vi.useFakeTimers();
      const now = new Date('2024-01-01T00:00:00.000Z');
      vi.setSystemTime(now);
      
      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      
      // Advance time by 1 second for the second entry
      vi.setSystemTime(new Date(now.getTime() + 1000));
      
      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      const entries = libraryStore.getAllEntries();

      expect(entries[0].gameId).toBe(2); // Most recently added
      expect(entries[1].gameId).toBe(1);
      
      vi.useRealTimers();
    });
  });

  describe('getAllIgdbIds', () => {
    it('returns all IGDB IDs in library', () => {
      libraryStore.addToLibrary({
        gameId: 100,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 200,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      const ids = libraryStore.getAllIgdbIds();

      expect(ids).toContain(100);
      expect(ids).toContain(200);
      expect(ids).toHaveLength(2);
    });
  });

  describe('getSize', () => {
    it('returns correct library size', () => {
      expect(libraryStore.getSize()).toBe(0);

      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(libraryStore.getSize()).toBe(1);

      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(libraryStore.getSize()).toBe(2);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 3,
        status: 'Completed',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      const stats = libraryStore.getStats();

      expect(stats.total).toBe(3);
      expect(stats.byStatus['Want to Play']).toBe(1);
      expect(stats.byStatus['Playing']).toBe(1);
      expect(stats.byStatus['Completed']).toBe(1);
      expect(stats.byPriority['High']).toBe(2);
      expect(stats.byPriority['Medium']).toBe(1);
    });
  });

  describe('filterByStatus', () => {
    beforeEach(() => {
      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });
      libraryStore.addToLibrary({
        gameId: 3,
        status: 'Want to Play',
        priority: 'Low',
        publicReviews: '',
        recommendationSource: '',
      });
    });

    it('filters by specific status', () => {
      const filtered = libraryStore.filterByStatus('Want to Play');
      expect(filtered).toHaveLength(2);
      filtered.forEach((entry) => {
        expect(entry.status).toBe('Want to Play');
      });
    });

    it('returns all entries when status is All', () => {
      const filtered = libraryStore.filterByStatus('All');
      expect(filtered).toHaveLength(3);
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = libraryStore.subscribe(listener);

      libraryStore.addToLibrary({
        gameId: 1,
        status: 'Want to Play',
        priority: 'High',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      libraryStore.addToLibrary({
        gameId: 2,
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });

      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('exportData', () => {
    it('exports data as JSON string', () => {
      libraryStore.addToLibrary({
        gameId: 12345,
        status: 'Playing',
        priority: 'High',
        publicReviews: 'Test notes',
        recommendationSource: 'Friend',
      });

      const exported = libraryStore.exportData();
      expect(typeof exported).toBe('string');

      const parsed = JSON.parse(exported);
      expect(parsed.entries).toBeDefined();
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.exportedAt).toBeDefined();
    });
  });

  describe('importData', () => {
    it('imports valid library data', () => {
      const importData = JSON.stringify({
        entries: [
          {
            gameId: 99999,
            status: 'Completed',
            priority: 'High',
            publicReviews: 'Imported!',
            recommendationSource: 'Import',
            addedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      });

      const result = libraryStore.importData(importData);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(libraryStore.isInLibrary(99999)).toBe(true);
    });

    it('returns error for invalid JSON', () => {
      const result = libraryStore.importData('not valid json');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error for invalid data format', () => {
      const result = libraryStore.importData('{"entries": "not an array"}');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid data format');
    });
  });
});

