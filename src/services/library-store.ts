import {
  LibraryGameEntry,
  GameStatus,
  GamePriority,
  CreateLibraryEntry,
  UpdateLibraryEntry,
} from '@/types/game';

const STORAGE_KEY = 'ark-library-data';
const STORAGE_VERSION = 3; // Bumped version for Steam migration

interface StoredData {
  version: number;
  entries: LibraryGameEntry[];
  lastUpdated: string;
}

/**
 * Library Store - Manages user's personal game library
 * Stores only user-specific data (status, priority, notes) for games added from Steam/IGDB
 */
class LibraryStore {
  private entries: Map<number, LibraryGameEntry> = new Map(); // keyed by gameId (Steam appId or IGDB ID)
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  private initialize() {
    if (this.isInitialized) return;

    try {
      const stored = this.loadFromStorage();
      if (stored && stored.entries.length > 0) {
        stored.entries.forEach((entry) => {
          // Support both new gameId and legacy igdbId
          const id = entry.gameId || entry.igdbId || entry.steamAppId;
          if (id) {
            this.entries.set(id, {
              ...entry,
              gameId: id,
              addedAt: new Date(entry.addedAt),
              updatedAt: new Date(entry.updatedAt),
            });
          }
        });
      }
    } catch (error) {
      console.error('Failed to load library data:', error);
    }

    this.isInitialized = true;
  }

  private loadFromStorage(): StoredData | null {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;

      const parsed = JSON.parse(data) as StoredData;
      // Allow migration from older versions
      if (parsed.version < 2) {
        console.log('Library storage version too old, resetting data');
        return null;
      }

      return parsed;
    } catch (error) {
      console.error('Failed to parse library data:', error);
      return null;
    }
  }

  private saveToStorage() {
    try {
      const data: StoredData = {
        version: STORAGE_VERSION,
        entries: Array.from(this.entries.values()),
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save library to storage:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.warn('Storage quota exceeded, data will not persist');
      }
    }
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }

  // Add a game to the library
  addToLibrary(input: CreateLibraryEntry): LibraryGameEntry {
    const now = new Date();
    const gameId = input.gameId || input.steamAppId || input.igdbId;
    
    if (!gameId) {
      throw new Error('No game ID provided');
    }
    
    const entry: LibraryGameEntry = {
      ...input,
      gameId,
      addedAt: now,
      updatedAt: now,
    };

    this.entries.set(gameId, entry);
    this.saveToStorage();
    this.notifyListeners();
    return entry;
  }

  // Remove a game from the library
  removeFromLibrary(gameId: number): boolean {
    const deleted = this.entries.delete(gameId);
    if (deleted) {
      this.saveToStorage();
      this.notifyListeners();
    }
    return deleted;
  }

  // Update a library entry
  updateEntry(gameId: number, input: UpdateLibraryEntry): LibraryGameEntry | undefined {
    const existing = this.entries.get(gameId);
    if (!existing) return undefined;

    const updated: LibraryGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(),
    };

    this.entries.set(gameId, updated);
    this.saveToStorage();
    this.notifyListeners();
    return updated;
  }

  // Check if a game is in the library
  isInLibrary(gameId: number): boolean {
    return this.entries.has(gameId);
  }

  // Get a library entry by game ID (Steam appId or IGDB ID)
  getEntry(gameId: number): LibraryGameEntry | undefined {
    return this.entries.get(gameId);
  }

  // Get all library entries
  getAllEntries(): LibraryGameEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
  }

  // Get all game IDs in library
  getAllGameIds(): number[] {
    return Array.from(this.entries.keys());
  }

  // Legacy method name for backwards compatibility
  getAllIgdbIds(): number[] {
    return this.getAllGameIds();
  }

  // Get library size
  getSize(): number {
    return this.entries.size;
  }

  // Get statistics
  getStats() {
    const entries = this.getAllEntries();

    const byStatus: Record<GameStatus, number> = {
      'Want to Play': 0,
      Playing: 0,
      Completed: 0,
      'On Hold': 0,
      Dropped: 0,
    };

    const byPriority: Record<GamePriority, number> = {
      High: 0,
      Medium: 0,
      Low: 0,
    };

    entries.forEach((entry) => {
      byStatus[entry.status]++;
      byPriority[entry.priority]++;
    });

    return {
      total: entries.length,
      byStatus,
      byPriority,
    };
  }

  // Filter library entries by status
  filterByStatus(status: GameStatus | 'All'): LibraryGameEntry[] {
    if (status === 'All') return this.getAllEntries();
    return this.getAllEntries().filter((entry) => entry.status === status);
  }

  // Filter library entries by priority
  filterByPriority(priority: GamePriority | 'All'): LibraryGameEntry[] {
    if (priority === 'All') return this.getAllEntries();
    return this.getAllEntries().filter((entry) => entry.priority === priority);
  }

  // Clear all library data
  clear() {
    this.entries.clear();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }

  // Export library data
  exportData(): string {
    return JSON.stringify(
      {
        entries: Array.from(this.entries.values()),
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
  }

  // Import library data
  importData(jsonData: string): { success: boolean; count: number; error?: string } {
    try {
      const parsed = JSON.parse(jsonData);
      const entries = parsed.entries as LibraryGameEntry[];

      if (!Array.isArray(entries)) {
        return { success: false, count: 0, error: 'Invalid data format' };
      }

      let importCount = 0;
      entries.forEach((entry) => {
        const id = entry.gameId || entry.igdbId || entry.steamAppId;
        if (id) {
          this.entries.set(id, {
            ...entry,
            gameId: id,
            addedAt: new Date(entry.addedAt || new Date()),
            updatedAt: new Date(entry.updatedAt || new Date()),
          });
          importCount++;
        }
      });

      this.saveToStorage();
      this.notifyListeners();
      return { success: true, count: importCount };
    } catch (error) {
      return { success: false, count: 0, error: 'Failed to parse import data' };
    }
  }
}

// Singleton instance
export const libraryStore = new LibraryStore();
