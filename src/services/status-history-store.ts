import { StatusChangeEntry, GameStatus, migrateGameId } from '@/types/game';

const STORAGE_KEY = 'ark-status-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

interface StoredStatusHistoryData {
  version: number;
  entries: StatusChangeEntry[];
  lastUpdated: string;
}

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _statusHistoryBeforeUnloadInstalled = false;

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
/** The only status values the rest of the app knows how to render. */
const VALID_STATUSES: ReadonlySet<string> = new Set<GameStatus>([
  'Playing Now',
  'Playing',
  'On Hold',
  'Want to Play',
  'Completed',
]);

/** A stored entry is usable only if it has the fields the timeline/Gantt rely on. */
function isValidStatusEntry(entry: unknown): entry is StatusChangeEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.gameId !== 'string' || !e.gameId) return false;
  if (typeof e.newStatus !== 'string' || !VALID_STATUSES.has(e.newStatus)) return false;
  if (typeof e.timestamp !== 'string' || !Number.isFinite(new Date(e.timestamp).getTime())) return false;
  return true;
}

class StatusHistoryStore {
  private entries: StatusChangeEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.initialize();
    if (typeof window !== 'undefined' && !_statusHistoryBeforeUnloadInstalled) {
      _statusHistoryBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  private initialize() {
    if (this.isInitialized) return;

    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredStatusHistoryData;
        if (Array.isArray(parsed.entries)) {
          const migrated = parsed.entries.map(entry => ({
            ...entry,
            gameId: migrateGameId(entry as any),
          }));
          // Drop corrupt/legacy entries so a bad status or timestamp can never
          // reach (and crash) the Voyage/OCD timeline.
          this.entries = migrated.filter(isValidStatusEntry);
          if (parsed.version < STORAGE_VERSION || this.entries.length !== migrated.length) {
            needsResave = true;
          }
        }
      }
    } catch (error) {
      console.error('[StatusHistoryStore] Failed to load:', error);
    }

    if (needsResave && this.entries.length > 0) {
      this.saveNow();
      console.log('[StatusHistoryStore] Migrated entries to v2 (string gameId)');
    }

    this.isInitialized = true;
  }

  /**
   * Debounced save — coalesces bursts of status writes (rapid status flips,
   * imports, migrations) into a single localStorage write ~300ms later.
   */
  private save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 300);
  }

  /** Flush any pending debounced save (used on beforeunload). */
  private flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveNow();
    }
  }

  private saveNow() {
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

  /**
   * Find the earliest transition into `Playing` (or `Playing Now`) for a game.
   * Returns the ISO timestamp as a ms-since-epoch number, or null if no such
   * transition exists.
   *
   * Used as a fallback for `firstPlayedAt` when no session was recorded but
   * the user did flip the status manually.
   */
  getFirstPlayingTransition(gameId: string): number | null {
    let earliest: number | null = null;
    for (const e of this.entries) {
      if (e.gameId !== gameId) continue;
      if (e.newStatus !== 'Playing' && e.newStatus !== 'Playing Now') continue;
      const ts = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      if (earliest === null || ts < earliest) earliest = ts;
    }
    return earliest;
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
      this.saveNow(); // direct save for bulk import
      this.notifyListeners();
    }

    return { added, skipped };
  }

  /** Clear all status history data (mainly for testing / reset). */
  clear() {
    this.entries = [];
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const statusHistoryStore = new StatusHistoryStore();
