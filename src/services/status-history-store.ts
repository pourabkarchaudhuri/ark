import { StatusChangeEntry, GameStatus, migrateGameId } from '@/types/game';

// ─── Persistence constants ──────────────────────────────────────────────────
//
// Post v1.0.61 this store is backed by LevelDB (main process, exposed via
// `window.store`). The original localStorage key is preserved unchanged for
// one release so a user can roll back to a pre-migration build without losing
// their status log. Once the migration flag is stamped we stop reading /
// writing localStorage — LevelDB is the source of truth.

/** Legacy localStorage key — retained for boot-time hydrate + rollback. */
const STORAGE_KEY = 'ark-status-history';
/** One-shot migration sentinel — stamped after the first successful copy. */
const MIGRATION_FLAG_KEY = 'ark-status-history-migrated-v1';
/** LevelDB namespace + key. */
const LEVEL_NAMESPACE = 'status-history';
const LEVEL_DATA_KEY = 'data';

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

/** Best-effort feature detect for the preload-exposed LevelDB bridge. */
type StoreBridge = NonNullable<Window['store']>;
function getStore(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  return window.store ?? null;
}

class StatusHistoryStore {
  private entries: StatusChangeEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Flips true once initialize() decides LevelDB is the source of truth. */
  private _useLevelDb = false;
  /** Resolves once the async initialize() (hydrate + migrate) has run. */
  private _readyPromise: Promise<void>;

  constructor() {
    this.hydrateFromLocalStorage();
    this._readyPromise = this.initializeAsync();
    if (typeof window !== 'undefined' && !_statusHistoryBeforeUnloadInstalled) {
      _statusHistoryBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  /**
   * Synchronous hydrate from localStorage — runs in the constructor so callers
   * that read (`getAll`, `getFirstPlayingTransition`, …) right after import
   * still see data. LevelDB hydrate happens async and replaces this cache.
   */
  private hydrateFromLocalStorage(): void {
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
      console.error('[StatusHistoryStore] Failed to load from localStorage:', error);
    }

    if (needsResave && this.entries.length > 0) {
      // Rewrite the localStorage snapshot in v2 shape. The async LevelDB
      // migration below will then pick these up.
      this.writeLocalStorageSnapshot();
      console.log('[StatusHistoryStore] Migrated entries to v2 (string gameId)');
    }

    this.isInitialized = true;
  }

  /**
   * One-shot LevelDB adoption:
   *  - If the bridge isn't present (web tests, older builds) stay on
   *    localStorage entirely.
   *  - If the migration flag isn't stamped yet, copy the current in-memory
   *    entries (already hydrated from localStorage) into LevelDB and stamp
   *    the flag. The original localStorage key is left alone so a rollback
   *    to a pre-v1.0.61 build keeps the pre-migration snapshot.
   *  - Otherwise LevelDB is authoritative — hydrate from it and overwrite
   *    the in-memory cache, then notify listeners so any component that
   *    rendered off the stale localStorage snapshot re-reads.
   */
  private async initializeAsync(): Promise<void> {
    const store = getStore();
    if (!store) return; // no bridge → localStorage remains SoT

    const migrated = (() => {
      try {
        return localStorage.getItem(MIGRATION_FLAG_KEY) === 'yes';
      } catch {
        return false;
      }
    })();

    if (!migrated) {
      // First-time migration. `this.entries` already reflects localStorage.
      try {
        const payload: StoredStatusHistoryData = {
          version: STORAGE_VERSION,
          entries: this.entries,
          lastUpdated: new Date().toISOString(),
        };
        const res = await store.put(LEVEL_NAMESPACE, LEVEL_DATA_KEY, payload);
        if (res && res.error) {
          console.error('[StatusHistoryStore] LevelDB migration put failed:', res.error);
          return;
        }
        try { localStorage.setItem(MIGRATION_FLAG_KEY, 'yes'); } catch { /* ignore */ }
        this._useLevelDb = true;
        console.log(
          `[StatusHistoryStore] Migrated ${this.entries.length} entries to LevelDB (${LEVEL_NAMESPACE})`,
        );
      } catch (err) {
        console.error('[StatusHistoryStore] LevelDB migration failed:', err);
      }
      return;
    }

    // Already migrated on a previous run — LevelDB is authoritative.
    try {
      const res = await store.get<StoredStatusHistoryData>(LEVEL_NAMESPACE, LEVEL_DATA_KEY);
      if (res && res.error) {
        console.error('[StatusHistoryStore] LevelDB hydrate failed:', res.error);
        return;
      }
      const stored = res?.value ?? null;
      if (stored && Array.isArray(stored.entries)) {
        const migratedEntries = stored.entries.map(entry => ({
          ...entry,
          gameId: migrateGameId(entry as any),
        }));
        this.entries = migratedEntries.filter(isValidStatusEntry);
      } else {
        // No LevelDB data yet (flag stamped but row missing) — treat as empty.
        this.entries = [];
      }
      this._useLevelDb = true;
      this.notifyListeners();
    } catch (err) {
      console.error('[StatusHistoryStore] LevelDB hydrate failed:', err);
    }
  }

  /** Test / consumer hook — resolves after LevelDB hydrate + migrate. */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Debounced save — coalesces bursts of status writes (rapid status flips,
   * imports, migrations) into a single persistent write ~300ms later.
   */
  private save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.saveNow();
    }, 300);
  }

  /** Flush any pending debounced save (used on beforeunload). */
  private flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      void this.saveNow();
    }
  }

  private buildPayload(): StoredStatusHistoryData {
    return {
      version: STORAGE_VERSION,
      entries: this.entries,
      lastUpdated: new Date().toISOString(),
    };
  }

  private writeLocalStorageSnapshot(payload?: StoredStatusHistoryData): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload ?? this.buildPayload()));
    } catch (error) {
      console.error('[StatusHistoryStore] Failed to write localStorage snapshot:', error);
    }
  }

  private async saveNow(): Promise<void> {
    const payload = this.buildPayload();
    const store = getStore();

    if (this._useLevelDb && store) {
      try {
        const res = await store.put(LEVEL_NAMESPACE, LEVEL_DATA_KEY, payload);
        if (res && res.error) {
          console.error('[StatusHistoryStore] LevelDB put failed:', res.error);
        }
      } catch (error) {
        console.error('[StatusHistoryStore] LevelDB put threw:', error);
      }
      return;
    }

    // Fallback / pre-migration path.
    this.writeLocalStorageSnapshot(payload);
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
      void this.saveNow(); // direct save for bulk import
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
    // Always clear the legacy localStorage snapshot so a rollback doesn't
    // resurrect deleted data.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    const store = getStore();
    if (this._useLevelDb && store) {
      void store.clearNamespace(LEVEL_NAMESPACE).catch((err) => {
        console.error('[StatusHistoryStore] LevelDB clearNamespace failed:', err);
      });
    }
    this.notifyListeners();
  }
}

// Singleton
export const statusHistoryStore = new StatusHistoryStore();
