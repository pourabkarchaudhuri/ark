import { StatusChangeEntry, GameStatus, migrateGameId } from '@/types/game';
import { SerialWriteQueue, readWithRetry, reportStorageReadOnly } from './storage-health';

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

/** Dedupe key for a status-change row. */
function entryKey(e: StatusChangeEntry): string {
  return `${e.gameId}|${e.timestamp}|${e.newStatus}`;
}

function byTimestamp(a: StatusChangeEntry, b: StatusChangeEntry): number {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

/**
 * Persistence mode:
 *  - `local`    no LevelDB bridge (tests / pre-preload) or pre-migration copy
 *               failed — legacy localStorage is the source of truth.
 *  - `pending`  bridge present, LevelDB hydrate still in flight. Writes are
 *               deferred; records made now are merged into the hydrated set.
 *  - `leveldb`  LevelDB is authoritative.
 *  - `readonly` LevelDB unreadable after retries — nothing is written (and the
 *               ignored legacy key is never written either).
 */
type PersistMode = 'local' | 'pending' | 'leveldb' | 'readonly';

class StatusHistoryStore {
  private entries: StatusChangeEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _mode: PersistMode = 'local';
  /** Rows recorded/imported while `pending` — merged into the hydrated set. */
  private _preHydration: StatusChangeEntry[] = [];
  /** clear() ran while `pending` — the hydrated LevelDB rows must be dropped. */
  private _clearedBeforeHydrate = false;
  /** A save was requested while `pending` — flush once hydrated. */
  private _saveAfterHydrate = false;
  private readonly _writeQueue = new SerialWriteQueue('StatusHistoryStore');
  /** Resolves once the async initialize() (hydrate + migrate) has run. */
  private _readyPromise: Promise<void>;

  constructor() {
    const store = getStore();
    const migrated = (() => {
      try {
        return localStorage.getItem(MIGRATION_FLAG_KEY) === 'yes';
      } catch {
        return false;
      }
    })();
    // Legacy localStorage is only read when it is still the source of truth:
    // no bridge, or the one-shot migration hasn't happened yet. After the
    // migration flag is stamped the key is frozen (v1.0.61) and ignored.
    if (!store || !migrated) this.hydrateFromLocalStorage();
    this._mode = store ? 'pending' : 'local';
    this._readyPromise = this.initializeAsync(migrated);
    if (typeof window !== 'undefined' && !_statusHistoryBeforeUnloadInstalled) {
      _statusHistoryBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  /**
   * Synchronous hydrate from localStorage — runs in the constructor so callers
   * that read (`getAll`, `getFirstPlayingTransition`, …) right after import
   * still see data on the legacy / pre-migration path.
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
   *  - No bridge (web tests, older builds) → stay on localStorage entirely.
   *  - Migration flag not stamped → copy the in-memory entries (legacy
   *    snapshot + anything recorded since) into LevelDB and stamp the flag.
   *    The original localStorage key is left alone for rollback.
   *  - Otherwise LevelDB is authoritative: hydrate with retries, MERGE any
   *    records made before hydration finished (startup auto-On-Hold sweep,
   *    cross-store sync) instead of replacing them, then notify. If the read
   *    still fails the store goes read-only (it never silently switches its
   *    writes to the ignored localStorage key).
   */
  private async initializeAsync(migrated: boolean): Promise<void> {
    const store = getStore();
    if (!store) return; // no bridge → localStorage remains SoT

    if (!migrated) {
      // First-time migration. `this.entries` already reflects localStorage
      // plus anything recorded while the copy was pending.
      const outcome = await readWithRetry('StatusHistoryStore', () =>
        store.put(LEVEL_NAMESPACE, LEVEL_DATA_KEY, this.buildPayload()),
      );
      this._preHydration = [];
      if (!outcome.ok) {
        // Pre-migration, localStorage is still the real source of truth (the
        // flag is not stamped, so the next launch re-reads it) — keep using it.
        console.error('[StatusHistoryStore] LevelDB migration put failed:', outcome.error);
        this._mode = 'local';
        if (this._saveAfterHydrate) this.writeLocalStorageSnapshot();
        this._saveAfterHydrate = false;
        return;
      }
      try { localStorage.setItem(MIGRATION_FLAG_KEY, 'yes'); } catch { /* ignore */ }
      this._mode = 'leveldb';
      console.log(
        `[StatusHistoryStore] Migrated ${this.entries.length} entries to LevelDB (${LEVEL_NAMESPACE})`,
      );
      if (this._saveAfterHydrate) {
        this._saveAfterHydrate = false;
        this.saveNow();
      }
      return;
    }

    // Already migrated on a previous run — LevelDB is authoritative.
    const outcome = await readWithRetry('StatusHistoryStore', () =>
      store.get<StoredStatusHistoryData>(LEVEL_NAMESPACE, LEVEL_DATA_KEY),
    );
    if (!outcome.ok) {
      this._mode = 'readonly';
      this._preHydration = [];
      this._saveAfterHydrate = false;
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      reportStorageReadOnly('status-history', outcome.error);
      this.notifyListeners();
      return;
    }

    const stored = this._clearedBeforeHydrate ? null : (outcome.value?.value ?? null);
    let hydrated: StatusChangeEntry[] = [];
    if (stored && Array.isArray(stored.entries)) {
      hydrated = stored.entries
        .map(entry => ({ ...entry, gameId: migrateGameId(entry as any) }))
        .filter(isValidStatusEntry);
    }
    // Merge records made before hydration (deduped).
    const seen = new Set(hydrated.map(entryKey));
    let merged = 0;
    for (const e of this._preHydration) {
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      hydrated.push(e);
      merged++;
    }
    hydrated.sort(byTimestamp);
    this.entries = hydrated;
    this._preHydration = [];
    this._mode = 'leveldb';
    if (merged > 0 || this._saveAfterHydrate) {
      this._saveAfterHydrate = false;
      this.saveNow();
    }
    this.notifyListeners();
  }

  /** Test / consumer hook — resolves after LevelDB hydrate + migrate. */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /** True when LevelDB could not be read this session — nothing is persisted. */
  isReadOnly(): boolean {
    return this._mode === 'readonly';
  }

  /**
   * Debounced save — coalesces bursts of status writes (rapid status flips,
   * imports, migrations) into a single persistent write ~300ms later.
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
      const store = getStore();
      if (this._mode === 'leveldb' && store) {
        // Unloading — don't wait behind an in-flight put; send it now.
        void store.put(LEVEL_NAMESPACE, LEVEL_DATA_KEY, this.buildPayload()).catch(() => {});
        return;
      }
      this.saveNow();
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

  private saveNow(): void {
    switch (this._mode) {
      case 'readonly':
        return;
      case 'pending':
        // Hydration still in flight — writing now would clobber the real
        // LevelDB row with a partial view. Flush right after hydrate instead.
        this._saveAfterHydrate = true;
        return;
      case 'local':
        this.writeLocalStorageSnapshot();
        return;
      case 'leveldb': {
        const store = getStore();
        if (!store) return;
        void this._writeQueue.run(async () => {
          // Payload is built when the task runs, so a queued save always
          // writes the latest state.
          const res = await store.put(LEVEL_NAMESPACE, LEVEL_DATA_KEY, this.buildPayload());
          if (res && res.error) {
            console.error('[StatusHistoryStore] LevelDB put failed:', res.error);
          }
        });
        return;
      }
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
    if (this._mode === 'pending') this._preHydration.push(entry);
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
  /**
   * Latest transition into any of `statuses` for a game (ms since epoch), or
   * null. Used by the auto On-Hold sweep so a game the user JUST moved to
   * "Playing" is measured from that moment, not from `addedAt`.
   */
  getLatestTransitionInto(gameId: string, statuses: readonly GameStatus[]): number | null {
    let latest: number | null = null;
    for (const e of this.entries) {
      if (e.gameId !== gameId) continue;
      if (!statuses.includes(e.newStatus)) continue;
      const ts = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      if (latest === null || ts > latest) latest = ts;
    }
    return latest;
  }

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
        if (this._mode === 'pending') this._preHydration.push(incoming);
        existingKeys.add(key);
        added++;
      }
    }

    if (added > 0) {
      // Sort chronologically after merge
      this.entries.sort(byTimestamp);
      this.saveNow(); // direct save for bulk import (queued behind clear())
      this.notifyListeners();
    }

    return { added, skipped };
  }

  /** Clear all status history data (mainly for testing / reset). */
  clear() {
    this.entries = [];
    this._preHydration = [];
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._mode === 'readonly') {
      this.notifyListeners();
      return;
    }
    // Always clear the legacy localStorage snapshot so a rollback doesn't
    // resurrect deleted data.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    if (this._mode === 'pending') this._clearedBeforeHydrate = true;
    const store = getStore();
    if ((this._mode === 'leveldb' || this._mode === 'pending') && store) {
      // Queued so a following importData() save lands strictly after the wipe.
      void this._writeQueue.run(async () => {
        const res = await store.clearNamespace(LEVEL_NAMESPACE);
        if (res && res.error) console.error('[StatusHistoryStore] LevelDB clearNamespace failed:', res.error);
      });
    }
    this.notifyListeners();
  }
}

// Singleton
export const statusHistoryStore = new StatusHistoryStore();
