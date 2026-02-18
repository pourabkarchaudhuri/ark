import {
  LibraryGameEntry,
  GameStatus,
  GamePriority,
  CreateLibraryEntry,
  UpdateLibraryEntry,
  migrateGameId,
} from '@/types/game';
import { journeyStore } from './journey-store';
import { statusHistoryStore } from './status-history-store';
import { sessionStore } from './session-store';

const STORAGE_KEY = 'ark-library-data';
const STORAGE_VERSION = 5; // v5: gameId migrated from number to string

interface StoredData {
  version: number;
  entries: LibraryGameEntry[];
  lastUpdated: string;
}

/**
 * Library Store - Manages user's personal game library
 * Stores only user-specific data (status, priority, notes) for games added from Steam/Epic
 */
class LibraryStore {
  private entries: Map<string, LibraryGameEntry> = new Map(); // keyed by universal gameId string
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortedCache: LibraryGameEntry[] | null = null;

  constructor() {
    this.initialize();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  private scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveToStorage();
    }, 300);
  }

  private flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveToStorage();
    }
  }

  private invalidateSortedCache() {
    this._sortedCache = null;
  }

  private initialize() {
    if (this.isInitialized) return;

    try {
      const stored = this.loadFromStorage();
      let needsResave = false;
      if (stored && stored.entries.length > 0) {
        stored.entries.forEach((entry) => {
          // Migrate numeric gameId to string format
          const id = migrateGameId(entry as any);
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
        // Always resave if we loaded data (ensures migration persists)
        if (stored.version < STORAGE_VERSION) {
          needsResave = true;
        }
      }
      // Persist migrated entries so the migration only runs once.
      // GUARD: Never overwrite existing data with an empty store — if all
      // entries failed migration something went wrong and we must not wipe
      // the user's library.
      if (needsResave && this.entries.size > 0) {
        this.saveToStorage();
        console.log(`[LibraryStore] Migrated ${this.entries.size} entries to v5 (string gameId)`);
      } else if (needsResave && this.entries.size === 0) {
        console.warn('[LibraryStore] Migration produced 0 entries — skipping save to prevent data loss');
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
      // Allow migration from older versions — attempt to load entries
      // even from very old formats rather than silently discarding them.
      if (parsed.version < 2) {
        console.warn('[LibraryStore] Storage version very old (v' + parsed.version + ') — attempting migration');
      }

      // Migrate entries from v3 to v4 (add progress tracking fields)
      if (parsed.version < 4 && parsed.entries) {
        parsed.entries = parsed.entries.map(entry => ({
          ...entry,
          hoursPlayed: entry.hoursPlayed ?? 0,
          rating: entry.rating ?? 0,
        }));
      }

      // v5 migration (number → string gameId) happens in initialize()

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
    const gameId = input.gameId;
    
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
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();

    // Record initial status in status history
    const journeyEntry = journeyStore.getEntry(gameId);
    const title = journeyEntry?.title || `Game ${gameId}`;
    statusHistoryStore.record(gameId, title, null, entry.status);

    return entry;
  }

  // Remove a game from the library
  removeFromLibrary(gameId: string): boolean {
    const deleted = this.entries.delete(gameId);
    if (deleted) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
      // Mark in journey history (entry persists, just flagged as removed)
      journeyStore.markRemoved(gameId);
    }
    return deleted;
  }

  // Update a library entry
  updateEntry(gameId: string, input: UpdateLibraryEntry): LibraryGameEntry | undefined {
    const existing = this.entries.get(gameId);
    if (!existing) return undefined;

    // Detect status change before merging
    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const updatedStatus = input.status ?? existing.status;
    const isNowPlaying = updatedStatus === 'Playing' || updatedStatus === 'Playing Now';
    const isCompleted = updatedStatus === 'Completed';

    const updated: LibraryGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(),
    };

    this.entries.set(gameId, updated);
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();

    const hasJourney = journeyStore.has(gameId);
    const addedAtIso = existing.addedAt instanceof Date ? existing.addedAt.toISOString() : String(existing.addedAt);
    const nowIso = new Date().toISOString();

    // Create journey entry when game first reaches Playing (or Playing Now) so it appears in Your Ark / Logs
    if (statusChanged && isNowPlaying && !hasJourney) {
      const meta = existing.cachedMeta;
      journeyStore.record({
        gameId,
        title: meta?.title ?? 'Unknown',
        coverUrl: meta?.coverUrl,
        genre: meta?.genre ?? [],
        platform: meta?.platform ?? [],
        releaseDate: meta?.releaseDate,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        firstPlayedAt: nowIso, // so it appears in this month (when user set Playing)
        lastPlayedAt: updated.lastPlayedAt,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && isCompleted && !hasJourney) {
      // Completed games also appear in Your Ark / Logs (with firstPlayedAt so they show)
      const meta = existing.cachedMeta;
      journeyStore.record({
        gameId,
        title: meta?.title ?? 'Unknown',
        coverUrl: meta?.coverUrl,
        genre: meta?.genre ?? [],
        platform: meta?.platform ?? [],
        releaseDate: meta?.releaseDate,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        firstPlayedAt: updated.lastPlayedAt ?? addedAtIso ?? nowIso,
        lastPlayedAt: updated.lastPlayedAt ?? nowIso,
        addedAt: addedAtIso,
      });
    } else {
      // Sync progress to journey history
      journeyStore.syncProgress(gameId, {
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        lastPlayedAt: updated.lastPlayedAt,
      });
    }

    // Record status transition in status history
    if (statusChanged) {
      const journeyEntry = journeyStore.getEntry(gameId);
      const title = journeyEntry?.title || `Game ${gameId}`;
      statusHistoryStore.record(gameId, title, existing.status, updated.status);
    }

    return updated;
  }

  // Check if a game is in the library
  isInLibrary(gameId: string): boolean {
    return this.entries.has(gameId);
  }

  // Get a library entry by universal game ID
  getEntry(gameId: string): LibraryGameEntry | undefined {
    return this.entries.get(gameId);
  }

  // Get all library entries (cached sort — invalidated on mutation)
  getAllEntries(): LibraryGameEntry[] {
    if (this._sortedCache) return this._sortedCache;
    this._sortedCache = Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
    return this._sortedCache;
  }

  // Get all game IDs in library
  getAllGameIds(): string[] {
    return Array.from(this.entries.keys());
  }

  // Legacy method name for backwards compatibility
  getAllIgdbIds(): string[] { // kept for backward compat
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
  updateHoursFromSessions(gameId: string, totalHours: number, lastPlayedAt?: string) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    existing.hoursPlayed = totalHours;
    if (lastPlayedAt !== undefined) existing.lastPlayedAt = lastPlayedAt;
    existing.updatedAt = new Date();
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();

    // Sync to journey store
    journeyStore.syncProgress(gameId, { hoursPlayed: totalHours, lastPlayedAt });
  }

  // Get all entries that have an executablePath set
  getTrackableEntries(): Array<{ gameId: string; executablePath: string }> {
    return Array.from(this.entries.values())
      .filter((e) => e.executablePath)
      .map((e) => ({ gameId: e.gameId, executablePath: e.executablePath! }));
  }

  // Clear all library data
  clear() {
    this.entries.clear();
    this.invalidateSortedCache();
    this.flushSave();
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

  // Import library data — wipes all existing data and replaces with the import
  importData(jsonData: string): { success: boolean; count: number; error?: string } {
    try {
      const parsed = JSON.parse(jsonData);
      const entries = parsed.entries as LibraryGameEntry[];

      if (!Array.isArray(entries)) {
        return { success: false, count: 0, error: 'Invalid data format' };
      }

      // Clear all existing data across all stores
      this.entries.clear();
      journeyStore.clear();
      sessionStore.clear();
      statusHistoryStore.clear();

      let importCount = 0;
      entries.forEach((entry) => {
        const id = migrateGameId(entry as any);
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

  // Import library data — wipes all existing data and replaces with the import
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

      // Clear all existing data across all stores
      this.entries.clear();
      journeyStore.clear();
      sessionStore.clear();
      statusHistoryStore.clear();

      let added = 0;

      entries.forEach((entry) => {
        const id = migrateGameId(entry as any);
        if (!id) return;

        this.entries.set(id, {
          ...entry,
          gameId: id,
          hoursPlayed: entry.hoursPlayed ?? 0,
          rating: entry.rating ?? 0,
          addedAt: new Date(entry.addedAt || new Date()),
          updatedAt: new Date(entry.updatedAt || new Date()),
        });
        added++;
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

      return { success: true, added, updated: 0, skipped: 0 };
    } catch (error) {
      return { success: false, added: 0, updated: 0, skipped: 0, error: 'Failed to parse import data' };
    }
  }
}

// Singleton instance
export const libraryStore = new LibraryStore();
