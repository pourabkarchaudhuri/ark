import { StatusChangeEntry, GameStatus, migrateGameId } from '@/types/game';

const STORAGE_KEY = 'ark-status-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

interface StoredStatusHistoryData {
  version: number;
  entries: StatusChangeEntry[];
  lastUpdated: string;
}

/**
 * Status History Store — persists a chronological log of every status change
 * made to any game in the library.
 *
 * Unlike the library store (which tracks current state) or the journey store
 * (which tracks per-game snapshots), this is an append-only log of transitions.
 * Each entry captures: gameId, title, previousStatus, newStatus, and timestamp.
 *
 * This data powers future tracking / analytics features.
 */
class StatusHistoryStore {
  private entries: StatusChangeEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  private initialize() {
    if (this.isInitialized) return;

    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredStatusHistoryData;
        if (Array.isArray(parsed.entries)) {
          this.entries = parsed.entries.map(entry => ({
            ...entry,
            gameId: migrateGameId(entry as any),
          }));
          if (parsed.version < STORAGE_VERSION) {
            needsResave = true;
          }
        }
      }
    } catch (error) {
      console.error('[StatusHistoryStore] Failed to load:', error);
    }

    if (needsResave && this.entries.length > 0) {
      this.save();
      console.log('[StatusHistoryStore] Migrated entries to v2 (string gameId)');
    }

    this.isInitialized = true;
  }

  private save() {
    try {
      const data: StoredStatusHistoryData = {
        version: STORAGE_VERSION,
        entries: this.entries,
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[StatusHistoryStore] Failed to save:', error);
    }
  }

  // ------ Subscriptions ------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((fn) => fn());
  }

  // ------ Core mutations ------

  /**
   * Record a status change event.
   * Appends a new entry to the chronological log.
   */
  record(
    gameId: string,
    title: string,
    previousStatus: GameStatus | null,
    newStatus: GameStatus,
  ): void {
    const entry: StatusChangeEntry = {
      gameId,
      title,
      previousStatus,
      newStatus,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);
    this.save();
    this.notifyListeners();
  }

  // ------ Queries ------

  /**
   * Get all status change entries for a specific game, ordered chronologically.
   */
  getForGame(gameId: string): StatusChangeEntry[] {
    return this.entries.filter((e) => e.gameId === gameId);
  }

  /**
   * Get all status change entries, ordered chronologically (oldest first).
   */
  getAll(): StatusChangeEntry[] {
    return [...this.entries];
  }

  /**
   * Get the most recent status change entries (newest first).
   */
  getRecent(limit: number = 50): StatusChangeEntry[] {
    return [...this.entries].reverse().slice(0, limit);
  }

  /**
   * Get the total number of recorded status changes.
   */
  getSize(): number {
    return this.entries.length;
  }

  // ------ Import / Export ------

  exportData(): StatusChangeEntry[] {
    return [...this.entries];
  }

  /**
   * Import status history entries (merges, skipping exact duplicates).
   * Duplicates are detected by matching gameId + timestamp + newStatus.
   */
  importData(entries: StatusChangeEntry[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;

    // Build a set of existing entries for fast duplicate detection
    const existingKeys = new Set(
      this.entries.map((e) => `${e.gameId}|${e.timestamp}|${e.newStatus}`),
    );

    for (const incoming of entries) {
      if (!incoming.gameId || !incoming.newStatus || !incoming.timestamp) {
        skipped++;
        continue;
      }

      const key = `${incoming.gameId}|${incoming.timestamp}|${incoming.newStatus}`;
      if (existingKeys.has(key)) {
        skipped++;
      } else {
        this.entries.push(incoming);
        existingKeys.add(key);
        added++;
      }
    }

    if (added > 0) {
      // Sort chronologically after merge
      this.entries.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      this.save();
      this.notifyListeners();
    }

    return { added, skipped };
  }

  /** Clear all status history data (mainly for testing / reset). */
  clear() {
    this.entries = [];
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const statusHistoryStore = new StatusHistoryStore();
