import {
  LibraryGameEntry,
  GameStatus,
  GamePriority,
  CreateLibraryEntry,
  UpdateLibraryEntry,
} from '@/types/game';
import { journeyStore } from './journey-store';
import { statusHistoryStore } from './status-history-store';
import { sessionStore } from './session-store';

const STORAGE_KEY = 'ark-library-data';
const STORAGE_VERSION = 4; // Bumped version for progress tracking fields

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
      let needsResave = false;
      if (stored && stored.entries.length > 0) {
        stored.entries.forEach((entry) => {
          // Support both new gameId and legacy igdbId
          const id = entry.gameId || entry.igdbId || entry.steamAppId;
          if (id) {
            // Migrate removed 'Dropped' status → 'On Hold'
            let status = entry.status;
            if ((status as string) === 'Dropped') {
              status = 'On Hold';
              needsResave = true;
            }
            this.entries.set(id, {
              ...entry,
              gameId: id,
              status,
              hoursPlayed: entry.hoursPlayed ?? 0,
              rating: entry.rating ?? 0,
              addedAt: new Date(entry.addedAt),
              updatedAt: new Date(entry.updatedAt),
            });
          }
        });
      }
      // Persist migrated entries so the migration only runs once
      if (needsResave) {
        this.saveToStorage();
        console.log('[LibraryStore] Migrated "Dropped" entries to "On Hold"');
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

      // Migrate entries from v3 to v4 (add progress tracking fields)
      if (parsed.version < 4 && parsed.entries) {
        parsed.entries = parsed.entries.map(entry => ({
          ...entry,
          hoursPlayed: entry.hoursPlayed ?? 0,
          rating: entry.rating ?? 0,
        }));
        parsed.version = 4;
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
      hoursPlayed: input.hoursPlayed ?? 0,
      rating: input.rating ?? 0,
      addedAt: now,
      updatedAt: now,
    };

    this.entries.set(gameId, entry);
    this.saveToStorage();
    this.notifyListeners();

    // Record initial status in status history
    const journeyEntry = journeyStore.getEntry(gameId);
    const title = journeyEntry?.title || `Game ${gameId}`;
    statusHistoryStore.record(gameId, title, null, entry.status);

    return entry;
  }

  // Remove a game from the library
  removeFromLibrary(gameId: number): boolean {
    const deleted = this.entries.delete(gameId);
    if (deleted) {
      this.saveToStorage();
      this.notifyListeners();
      // Mark in journey history (entry persists, just flagged as removed)
      journeyStore.markRemoved(gameId);
    }
    return deleted;
  }

  // Update a library entry
  updateEntry(gameId: number, input: UpdateLibraryEntry): LibraryGameEntry | undefined {
    const existing = this.entries.get(gameId);
    if (!existing) return undefined;

    // Detect status change before merging
    const statusChanged = input.status !== undefined && input.status !== existing.status;

    const updated: LibraryGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(),
    };

    this.entries.set(gameId, updated);
    this.saveToStorage();
    this.notifyListeners();

    // Sync progress to journey history
    journeyStore.syncProgress(gameId, {
      status: updated.status,
      hoursPlayed: updated.hoursPlayed,
      rating: updated.rating,
    });

    // Record status transition in status history
    if (statusChanged) {
      const journeyEntry = journeyStore.getEntry(gameId);
      const title = journeyEntry?.title || `Game ${gameId}`;
      statusHistoryStore.record(gameId, title, existing.status, updated.status);
    }

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
      'Playing Now': 0,
      Completed: 0,
      'On Hold': 0,
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

  // Update hoursPlayed from session tracking totals
  updateHoursFromSessions(gameId: number, totalHours: number) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    existing.hoursPlayed = totalHours;
    existing.updatedAt = new Date();
    this.saveToStorage();
    this.notifyListeners();

    // Sync to journey store
    journeyStore.syncProgress(gameId, { hoursPlayed: totalHours });
  }

  // Get all entries that have an executablePath set
  getTrackableEntries(): Array<{ gameId: number; executablePath: string }> {
    return Array.from(this.entries.values())
      .filter((e) => e.executablePath)
      .map((e) => ({ gameId: e.gameId, executablePath: e.executablePath! }));
  }

  // Clear all library data
  clear() {
    this.entries.clear();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }

  // Export library data (includes journey history, status history, and session history)
  exportData(): string {
    return JSON.stringify(
      {
        entries: Array.from(this.entries.values()),
        journeyHistory: journeyStore.exportData(),
        statusHistory: statusHistoryStore.exportData(),
        sessionHistory: sessionStore.exportData(),
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
  }

  // Import library data (replaces existing), also imports journey history if present
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
            hoursPlayed: entry.hoursPlayed ?? 0,
            rating: entry.rating ?? 0,
            addedAt: new Date(entry.addedAt || new Date()),
            updatedAt: new Date(entry.updatedAt || new Date()),
          });
          importCount++;
        }
      });

      this.saveToStorage();
      this.notifyListeners();

      // Import journey history if present
      if (Array.isArray(parsed.journeyHistory)) {
        journeyStore.importData(parsed.journeyHistory);
      }

      // Import status history if present
      if (Array.isArray(parsed.statusHistory)) {
        statusHistoryStore.importData(parsed.statusHistory);
      }

      // Import session history if present
      if (Array.isArray(parsed.sessionHistory)) {
        sessionStore.importData(parsed.sessionHistory);
      }

      return { success: true, count: importCount };
    } catch (error) {
      return { success: false, count: 0, error: 'Failed to parse import data' };
    }
  }

  // Compare two entries for equality (excluding timestamps)
  private areEntriesEqual(a: LibraryGameEntry, b: LibraryGameEntry): boolean {
    return (
      a.status === b.status &&
      a.priority === b.priority &&
      a.publicReviews === b.publicReviews &&
      a.recommendationSource === b.recommendationSource &&
      a.hoursPlayed === b.hoursPlayed &&
      a.rating === b.rating &&
      a.executablePath === b.executablePath
    );
  }

  // Import library data with delta logic (add new, update changed, skip identical)
  importDataWithDelta(jsonData: string): { 
    success: boolean; 
    added: number; 
    updated: number; 
    skipped: number; 
    error?: string 
  } {
    try {
      const parsed = JSON.parse(jsonData);
      const entries = parsed.entries as LibraryGameEntry[];

      if (!Array.isArray(entries)) {
        return { success: false, added: 0, updated: 0, skipped: 0, error: 'Invalid data format' };
      }

      let added = 0;
      let updated = 0;
      let skipped = 0;

      entries.forEach((entry) => {
        const id = entry.gameId || entry.igdbId || entry.steamAppId;
        if (!id) return;

        const existing = this.entries.get(id);
        const normalizedEntry: LibraryGameEntry = {
          ...entry,
          gameId: id,
          hoursPlayed: entry.hoursPlayed ?? 0,
          rating: entry.rating ?? 0,
          addedAt: new Date(entry.addedAt || new Date()),
          updatedAt: new Date(entry.updatedAt || new Date()),
        };

        if (!existing) {
          // New entry - add it
          this.entries.set(id, normalizedEntry);
          added++;
        } else if (!this.areEntriesEqual(existing, normalizedEntry)) {
          // Entry exists but is different - update it
          this.entries.set(id, {
            ...normalizedEntry,
            addedAt: existing.addedAt, // Preserve original addedAt
            updatedAt: new Date(), // Update the updatedAt timestamp
          });
          updated++;
        } else {
          // Entry exists and is identical - skip
          skipped++;
        }
      });

      if (added > 0 || updated > 0) {
        this.saveToStorage();
        this.notifyListeners();
      }

      // Import journey history if present
      if (Array.isArray(parsed.journeyHistory)) {
        journeyStore.importData(parsed.journeyHistory);
      }

      // Import status history if present
      if (Array.isArray(parsed.statusHistory)) {
        statusHistoryStore.importData(parsed.statusHistory);
      }

      // Import session history if present
      if (Array.isArray(parsed.sessionHistory)) {
        sessionStore.importData(parsed.sessionHistory);
      }

      return { success: true, added, updated, skipped };
    } catch (error) {
      return { success: false, added: 0, updated: 0, skipped: 0, error: 'Failed to parse import data' };
    }
  }
}

// Singleton instance
export const libraryStore = new LibraryStore();
