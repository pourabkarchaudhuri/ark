import {
  LibraryGameEntry,
  GameStatus,
  GamePriority,
  CreateLibraryEntry,
  UpdateLibraryEntry,
  migrateGameId,
  CachedGameMeta,
} from '@/types/game';
import type { CustomGameEntry, GameSession, JourneyEntry, StatusChangeEntry } from '@/types/game';
import { journeyStore } from './journey-store';
import { customGameStore } from './custom-game-store';
import { oracleEventLog } from './oracle-event-log';
import { recoHistoryStore } from './reco-history-store';
import { normalizeTitle } from '@/services/dedup';

// Statuses that cross-store propagation is allowed to write to a sibling.
// (Playing / Playing Now / Completed — "in progress" or "done" on some store.)
const PROPAGATABLE_STATUSES = new Set<GameStatus>(['Playing', 'Playing Now', 'Completed']);

// Statuses considered "stronger" — never overwritten by a weaker sibling.
// Completed is the terminal state; Playing Now is the in-session marker.
const NEVER_OVERWRITE_STATUSES = new Set<GameStatus>(['Completed', 'Playing Now']);

// Statuses safe for a Playing / Playing Now sibling to overwrite.
// Completed is stronger; Playing Now is in-flight — leave both alone.
const PLAYING_OVERWRITE_TARGETS = new Set<GameStatus>(['Want to Play', 'On Hold']);

// Statuses safe for a Completed sibling to overwrite (anything not already
// Completed — Completed → Completed would be a no-op).
const COMPLETED_OVERWRITE_TARGETS = new Set<GameStatus>([
  'Want to Play',
  'Playing',
  'Playing Now',
  'On Hold',
]);

// Case-insensitive substrings that mean "release date not yet confirmed".
// Backlog filtering treats any of these as unannounced.
const UNANNOUNCED_MARKERS = ['tba', 'tbd', 'coming soon', 'to be announced', 'unknown'] as const;

// Duplicated from dedup.ts on purpose: dedup.ts does not export SENTINEL_YEAR
// and per this file's ownership rules we don't want to force a helper export.
// Keep in sync with dedup.ts SENTINEL_YEAR.
const SENTINEL_YEAR_LOCAL = 2090;

/**
 * Which storefront a library entry belongs to, for cross-store propagation.
 * The gameId prefix wins ('epic-' also covers 'epic-fn:'); otherwise the cached
 * store. Custom games and unknown ids are null, so they are never synced.
 */
function storeOf(entry: LibraryGameEntry): 'steam' | 'epic' | null {
  const id = entry.gameId;
  if (id.startsWith('steam-')) return 'steam';
  if (id.startsWith('epic-')) return 'epic';
  if (id.startsWith('custom-')) return null;
  const s = entry.cachedMeta?.store;
  return s === 'steam' || s === 'epic' ? s : null;
}

/** Four-digit year in a release-date string ("2020-12-10", "10 Dec, 2020", "Q1 2027"), else null. */
function releaseYearOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /\b(19\d{2}|20\d{2})\b/.exec(String(raw));
  return m ? Number(m[1]) : null;
}

function resolveJourneyTitleForRecord(
  updated: LibraryGameEntry,
  existing: LibraryGameEntry
): string {
  const fromUpdated = updated.cachedMeta?.title?.trim();
  if (fromUpdated) return fromUpdated;
  const fromExisting = existing.cachedMeta?.title?.trim();
  if (fromExisting) return fromExisting;
  return 'Unknown';
}
import { statusHistoryStore } from './status-history-store';
import { sessionStore } from './session-store';
import {
  SaveRetry,
  SerialWriteQueue,
  readWithRetry,
  reportStorageReadOnly,
} from './storage-health';
import { firstPlayEvidenceIso, resolveFirstPlayedAt } from './first-played';
import type { StatusChangeSource } from '@/types/game';

/**
 * Library entry plus the app-managed `statusChangedAt` stamp (ISO). Set by
 * `updateEntry` / cross-store propagation whenever `status` actually changes,
 * so time-based sweeps (auto On-Hold) can tell "just set to Playing" apart
 * from "stale since addedAt". Optional — older rows don't carry it.
 */
export type LibraryEntryWithStatusStamp = LibraryGameEntry & { statusChangedAt?: string };

const STORAGE_KEY = 'ark-library-data';
const STORAGE_VERSION = 5; // v5: gameId migrated from number to string

/**
 * One-shot marker stamped in localStorage after the LevelDB migration
 * copies the ark-library-data payload across. Presence => never migrate
 * again. Original STORAGE_KEY stays intact one release for rollback.
 */
const MIGRATION_MARKER_KEY = 'ark-library-data-migrated-v1';

/** LevelDB namespace this store owns. Keys within it are gameId. */
const LEVEL_NAMESPACE = 'library';

interface StoredData {
  version: number;
  entries: LibraryGameEntry[];
  lastUpdated: string;
}

/** LevelDB namespace + key holding the automatic pre-import snapshot (userData). */
const IMPORT_SNAPSHOT_NAMESPACE = 'library-import-backup';
const IMPORT_SNAPSHOT_KEY = 'latest';

/**
 * A parsed, validated backup file (parseImport) — nothing applied yet. The
 * optional arrays are present only when the file carries them.
 */
export interface LibraryImportPlan {
  entries: LibraryGameEntry[];
  journeyHistory?: JourneyEntry[];
  statusHistory?: StatusChangeEntry[];
  sessionHistory?: GameSession[];
  customGames?: { entries: CustomGameEntry[]; nextCounter?: number };
  /** For the confirmation dialog. fileCustomGames is null for files without custom games. */
  counts: {
    currentGames: number;
    fileGames: number;
    currentCustomGames: number;
    fileCustomGames: number | null;
  };
}

export interface LibraryImportResult {
  success: boolean;
  /** Library (Steam/Epic) games now in the library. */
  count: number;
  /** Custom games now in the library. */
  customCount: number;
  error?: string;
}

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _libraryBeforeUnloadInstalled = false;

/**
 * Library Store - Manages user's personal game library
 * Stores only user-specific data (status, priority, notes) for games added from Steam/Epic
 */
export class LibraryStore {
  private entries: Map<string, LibraryGameEntry> = new Map(); // keyed by universal gameId string
  private listeners: Set<() => void> = new Set();
  /**
   * Hours-only subscription channel. Fired by every mutation that touches
   * `hoursPlayed` (including session-tracker updates via updateHoursFromSessions).
   * Regular status/collection mutations ALSO fire this channel — hours listeners
   * are a superset of regular listeners. This split lets 15s session ticks
   * update per-card hours without invalidating expensive top-level memos
   * (games grid, Oracle reco signature) that only need to react to
   * status/collection changes.
   */
  private hoursListeners: Set<() => void> = new Set();
  /**
   * Monotonic version counter bumped by every non-hours mutation. Enables cheap
   * `useSyncExternalStore` snapshots for consumers that need to know "did the
   * library change?" without pulling the full entry list. Used by
   * `useDeferredFilterSort` to fold per-game content edits (status pill flips)
   * into its memo fingerprint — the v1.0.60 card-status-broken bug.
   */
  private _version = 0;
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortedCache: LibraryGameEntry[] | null = null;
  /** v1.0.45 — guard so `syncCrossStoreStatusesOnce` only ever sweeps once. */
  private _crossStoreSweepDone = false;
  /**
   * Set once this store AND the journey / status-history stores have hydrated.
   * The sweep writes to all three, so it must not run on the empty boot-window maps.
   */
  private _sweepDepsReady = false;
  /**
   * Bumped whenever the whole library is cleared or replaced (clear / import), so
   * module-level helpers such as the cachedMeta backfill can drop their per-session state.
   */
  private _replaceEpoch = 0;

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  /**
   * gameId -> the exact entry object last written to LevelDB. Each save diffs
   * `entries` against it by identity (status/meta mutations replace the entry
   * object; in-place hours ticks are tracked in `_dirtyIds`), so only changed
   * rows are written and removed rows are deleted.
   * A 15s session tick now writes ONE row instead of the whole library.
   */
  private _persisted: Map<string, LibraryGameEntry> = new Map();

  /**
   * gameIds mutated IN PLACE since the last save (the 15s hours tick keeps
   * mutating the existing object so components holding a reference still
   * read live hours). Written on the next save alongside identity changes.
   */
  private _dirtyIds: Set<string> = new Set();

  /** Serializes every LevelDB write (saves + clearNamespace) — audit items 5/10. */
  private readonly _writeQueue = new SerialWriteQueue('LibraryStore');

  /**
   * True when the LevelDB read failed even after retries. No writes are issued
   * (in-memory edits still work for this session) so a partial/empty view can
   * never overwrite the real data. Surfaced via storage-health for the banner.
   */
  private _readOnly = false;

  /** Backoff retry for a failed LevelDB save (also forces the unload flush). */
  private readonly _saveRetry = new SaveRetry('LibraryStore', () => this.saveNow());

  /** Export JSON of the state right before the last import this session (undo). */
  private _lastImportSnapshot: string | null = null;

  /**
   * Resolves when the async LevelDB hydration finishes. Public reads are safe
   * before it resolves — they just see an empty cache during the boot window.
   */
  readonly ready: Promise<void>;

  constructor() {
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
    this.ready = this.initializeAsync();
    const markSweepReady = () => { this._sweepDepsReady = true; };
    void this.ready
      .then(() => {
        // Read the sibling stores lazily (inside the callback) so a mocked or
        // not-yet-evaluated module never breaks construction.
        const journeyReady = (journeyStore as { ready?: Promise<void> } | undefined)?.ready;
        const history = statusHistoryStore as { ready?: () => Promise<void> } | undefined;
        const historyReady = typeof history?.ready === 'function' ? history.ready() : undefined;
        return Promise.all([journeyReady, historyReady]);
      })
      .then(markSweepReady, markSweepReady);
    if (typeof window !== 'undefined' && !_libraryBeforeUnloadInstalled) {
      _libraryBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  private scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 300);
  }

  private flushSave() {
    // A failed save (or a pending retry) also counts as unsaved work, not
    // only a pending debounce — otherwise a lone failed save is lost on quit.
    const retryPending = this._useLevelDB && this._saveRetry.needsFlush;
    if (!this._saveTimer && !retryPending) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveRetry.cancel();
    if (this._useLevelDB && !this._readOnly) {
      // Page is unloading — we can't wait behind an in-flight batch, so issue
      // the diff now (puts are idempotent; IPC preserves send order).
      void this.saveNowLevelDB();
      return;
    }
    this.saveNow();
  }

  private saveNow(): void {
    if (this._readOnly) return;
    if (this._useLevelDB) {
      void this._writeQueue.run(() => this.saveNowLevelDB());
      return;
    }
    this.saveToStorage();
  }

  /** True when LevelDB could not be read this session — nothing is persisted. */
  isReadOnly(): boolean {
    return this._readOnly;
  }

  /** Resolves once every queued LevelDB write has settled (tests / shutdown). */
  whenPersisted(): Promise<void> {
    return this._writeQueue.idle();
  }

  private async saveNowLevelDB(): Promise<void> {
    if (this._readOnly) return;
    // Snapshot + reset: in-place mutations landing while this batch is in
    // flight re-mark their id for the next save.
    const dirty = this._dirtyIds;
    this._dirtyIds = new Set();
    try {
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];
      const written: Array<[string, LibraryGameEntry]> = [];
      const deleted: string[] = [];

      for (const [id, entry] of this.entries) {
        if (!id) continue;
        if (this._persisted.get(id) === entry && !dirty.has(id)) continue; // unchanged
        // Shallow copy: the payload must reflect THIS moment even if the
        // entry is mutated in place while the IPC is in flight.
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: id, value: { ...entry } });
        written.push([id, entry]);
      }

      for (const oldKey of this._persisted.keys()) {
        if (!this.entries.has(oldKey)) {
          ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: oldKey });
          deleted.push(oldKey);
        }
      }

      if (ops.length === 0) {
        this._saveRetry.success();
        return;
      }

      const res = await window.store!.batch(ops);
      if (res.error) {
        for (const id of dirty) this._dirtyIds.add(id); // retried below
        this._saveRetry.failure(res.error);
        return;
      }
      // Record exactly what this batch wrote (not the live map — it may have
      // changed while the batch was in flight; the next save picks that up).
      for (const [id, entry] of written) this._persisted.set(id, entry);
      for (const id of deleted) this._persisted.delete(id);
      this._saveRetry.success();
    } catch (err) {
      for (const id of dirty) this._dirtyIds.add(id);
      this._saveRetry.failure(err);
    }
  }

  private invalidateSortedCache() {
    this._sortedCache = null;
  }

  /** Ensure we always have a valid Date (never Invalid Date). Old data may lack updatedAt. */
  private static toValidDate(value: unknown, fallback: Date): Date {
    if (value == null) return fallback;
    const d = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }

  private async initializeAsync(): Promise<void> {
    if (this.isInitialized) return;
    if (this._useLevelDB) {
      await this.initializeFromLevelDB();
    } else {
      this.initializeFromLocalStorage();
    }
    this.isInitialized = true;
    // Any sorted list built during the boot window saw a partial library.
    this.invalidateSortedCache();
  }

  /**
   * Hydrate the in-memory Map from a list of raw entries (v3/v4/v5 shapes).
   * Applies gameId migration + Dropped→On Hold + Date coercion.
   * Returns count actually inserted.
   */
  private ingestEntries(entries: LibraryGameEntry[]): {
    count: number;
    migratedStatus: boolean;
    /** ids ingested without a shape rewrite (safe to treat as already persisted). */
    cleanIds: string[];
  } {
    let migratedStatus = false;
    let count = 0;
    const cleanIds: string[] = [];
    entries.forEach((entry) => {
      const id = migrateGameId(entry as any);
      if (!id) return;
      let status = entry.status;
      let rewritten = id !== (entry as any).gameId;
      if ((status as string) === 'Dropped') {
        status = 'On Hold';
        migratedStatus = true;
        rewritten = true;
      }
      const addedAt = LibraryStore.toValidDate(entry.addedAt, new Date());
      const updatedAt = LibraryStore.toValidDate(entry.updatedAt, addedAt);
      this.entries.set(id, {
        ...entry,
        gameId: id,
        status,
        hoursPlayed: entry.hoursPlayed ?? 0,
        rating: entry.rating ?? 0,
        addedAt,
        updatedAt,
      });
      if (!rewritten) cleanIds.push(id);
      count++;
    });
    this.invalidateSortedCache();
    return { count, migratedStatus, cleanIds };
  }

  private markPersisted(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this._persisted.set(id, entry);
    }
  }

  private async initializeFromLevelDB(): Promise<void> {
    try {
      const outcome = await readWithRetry('LibraryStore', () =>
        window.store!.getAll<LibraryGameEntry>(LEVEL_NAMESPACE),
      );
      if (!outcome.ok) {
        this.enterReadOnly(outcome.error);
        return;
      }
      const rows = outcome.value.rows ?? [];
      if (rows.length > 0) {
        const values = rows.map((r) => r.value);
        const { migratedStatus, cleanIds } = this.ingestEntries(values);
        this.markPersisted(cleanIds);
        if (migratedStatus && this.entries.size > 0) {
          // Persist Dropped→On Hold rewrite
          this.saveNow();
        }
        this.notifyListeners();
        return;
      }
      const migrated = await this.tryMigrateFromLocalStorage();
      if (!migrated) {
        this.notifyListeners();
      }
    } catch (err) {
      this.enterReadOnly(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * LevelDB could not be read (even after retries). NEVER fall back to the
   * legacy localStorage snapshot once the migration marker is set — it is
   * frozen at v1.0.61 and writing it back would roll the library back. Go
   * read-only instead (no writes this session). Pre-migration users (marker
   * absent) still see their legacy data, read-only as well.
   */
  private enterReadOnly(error: string): void {
    this._readOnly = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveRetry.cancel();
    let migrated = true;
    try { migrated = localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes'; } catch { /* assume migrated */ }
    if (!migrated) {
      const stored = this.loadFromStorage();
      if (stored && stored.entries.length > 0) this.ingestEntries(stored.entries);
    }
    reportStorageReadOnly('library', error);
    this.invalidateSortedCache();
    this.notifyListeners();
  }

  private async tryMigrateFromLocalStorage(): Promise<boolean> {
    try {
      if (localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes') return false;

      const stored = this.loadFromStorage();
      if (!stored || stored.entries.length === 0) {
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      const { count } = this.ingestEntries(stored.entries);
      if (count === 0) {
        // Migration produced nothing — do NOT stamp marker so we retry next boot.
        console.warn('[LibraryStore] Migration produced 0 entries — leaving marker unset');
        return false;
      }

      const ops = Array.from(this.entries.entries()).map(([id, entry]) => ({
        type: 'put' as const,
        namespace: LEVEL_NAMESPACE,
        key: id,
        value: entry,
      }));

      let res: { error?: string };
      try {
        res = await window.store!.batch(ops);
      } catch (err) {
        res = { error: err instanceof Error ? err.message : String(err) };
      }
      if (res.error) {
        console.error('[LibraryStore] Migration batch failed:', res.error);
        // Read-only, not an empty writable library: the legacy entries stay
        // visible and no add can write a row this session, so the namespace
        // stays empty and the next boot retries the migration (enterReadOnly
        // notifies listeners).
        this.enterReadOnly(res.error);
        return true;
      }

      this.markPersisted(this.entries.keys());
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      console.log(
        `[LibraryStore] Migrated ${this.entries.size} entries from localStorage -> LevelDB`,
      );
      this.notifyListeners();
      return true;
    } catch (err) {
      console.error('[LibraryStore] Migration failed:', err);
      return false;
    }
  }

  private initializeFromLocalStorage(): void {
    try {
      const stored = this.loadFromStorage();
      let needsResave = false;
      if (stored && stored.entries.length > 0) {
        const { migratedStatus } = this.ingestEntries(stored.entries);
        if (migratedStatus) needsResave = true;
        if (stored.version < STORAGE_VERSION) needsResave = true;
      }
      if (needsResave && this.entries.size > 0) {
        this.saveToStorage();
        console.log(`[LibraryStore] Migrated ${this.entries.size} entries to v5 (string gameId)`);
      } else if (needsResave && this.entries.size === 0) {
        console.warn('[LibraryStore] Migration produced 0 entries — skipping save to prevent data loss');
      }
    } catch (error) {
      console.error('Failed to load library data:', error);
    }
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

  // Subscribe to status / collection changes (adds, removes, status/priority/meta edits).
  // Does NOT fire on session-driven hours-only ticks. Use this for expensive top-level
  // memos and Oracle-signature rebuilds so 15s session ticks don't invalidate them.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to hours changes — fires on session-tracker ticks AND on regular
   * status/collection mutations (superset of `subscribe`). Use this for
   * per-card live-hours displays that need to update on every session tick.
   */
  subscribeHours(listener: () => void): () => void {
    this.hoursListeners.add(listener);
    return () => this.hoursListeners.delete(listener);
  }

  private notifyListeners() {
    this._version++;
    this.listeners.forEach((listener) => listener());
    // Regular mutations are a superset — anyone watching hours also cares
    // about status/collection changes (which can change hoursPlayed too).
    this.hoursListeners.forEach((listener) => listener());
  }

  /** Monotonic counter — bumps on every non-hours mutation. */
  getVersion(): number {
    return this._version;
  }

  /** Fire ONLY the hours channel — used by updateHoursFromSessions. */
  private notifyHoursListeners() {
    this.hoursListeners.forEach((listener) => listener());
  }

  // Add a game to the library
  addToLibrary(input: CreateLibraryEntry): LibraryGameEntry {
    const now = new Date();
    const gameId = input.gameId;
    
    if (!gameId) {
      throw new Error('No game ID provided');
    }
    
    const hoursPlayed = input.hoursPlayed ?? 0;
    const entry: LibraryGameEntry = {
      ...input,
      gameId,
      hoursPlayed,
      rating: input.rating ?? 0,
      addedAt: now,
      updatedAt: now,
    };
    // Set baseline when adding with initial hours so session updates add on top from the start
    if (hoursPlayed > 0) {
      const sessionTotal = sessionStore.getTotalHours(gameId);
      entry.hoursBaseline = Math.max(0, hoursPlayed - sessionTotal);
    }

    this.entries.set(gameId, entry);
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
    // Re-added after a removal: the journey row must stop counting it as removed.
    journeyStore.clearRemoved(gameId);

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
  /**
   * @param opts.source who made a status change (recorded on the status-history row). Callers that
   *   change status automatically pass their source; omitted for ordinary user edits.
   */
  updateEntry(
    gameId: string,
    input: UpdateLibraryEntry,
    opts: { source?: StatusChangeSource } = {},
  ): LibraryGameEntry | undefined {
    const existing = this.entries.get(gameId);
    if (!existing) return undefined;

    // Detect status change before merging
    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const updatedStatus = input.status ?? existing.status;
    const isNowPlaying = updatedStatus === 'Playing' || updatedStatus === 'Playing Now';
    const isCompleted = updatedStatus === 'Completed';
    const isWantToPlay = updatedStatus === 'Want to Play';
    // v1.0.45: propagate status to same-title siblings on other stores
    // AFTER the primary mutation is committed and listeners have fired.
    const shouldPropagate =
      statusChanged && PROPAGATABLE_STATUSES.has(updatedStatus);

    const updated: LibraryEntryWithStatusStamp = {
      ...existing,
      ...input,
      updatedAt: new Date(), // Always app-managed (last save time)
    };
    if (statusChanged) {
      // App-managed: lets the auto On-Hold sweep measure staleness from the
      // moment the user (or a sync) moved the game into its current status.
      updated.statusChangedAt = new Date().toISOString();
    }
    if (input.addedAt !== undefined) {
      updated.addedAt = LibraryStore.toValidDate(input.addedAt, existing.addedAt);
    }

    // When user edits hours, set baseline so session updates add on top instead of overwriting
    if (input.hoursPlayed !== undefined) {
      const sessionTotal = sessionStore.getTotalHours(gameId);
      updated.hoursBaseline = Math.max(0, input.hoursPlayed - sessionTotal);
    }

    this.entries.set(gameId, updated);
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();

    // Outcome logging for Oracle evaluation — a rating is the strongest label we get.
    if (input.rating !== undefined && input.rating !== existing.rating) {
      oracleEventLog.record({ type: 'rating', gameId, data: { rating: input.rating, previous: existing.rating } });
      if (input.rating > 0) recoHistoryStore.recordRating(gameId, input.rating);
    }

    const hasJourney = journeyStore.has(gameId);
    const addedAtIso = LibraryStore.toValidDate(updated.addedAt, new Date()).toISOString();
    const nowIso = new Date().toISOString();

    // Create journey entry when game first reaches Playing (or Playing Now) so it appears in Your Ark / Logs
    if (statusChanged && isNowPlaying && !hasJourney) {
      const meta = updated.cachedMeta ?? existing.cachedMeta;
      journeyStore.record({
        gameId,
        title: resolveJourneyTitleForRecord(updated, existing),
        coverUrl: meta?.coverUrl,
        genre: meta?.genre ?? [],
        platform: meta?.platform ?? [],
        releaseDate: meta?.releaseDate,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        // Earliest real evidence of play; otherwise now (the moment the user set Playing).
        firstPlayedAt: resolveFirstPlayedAt(gameId, nowIso),
        lastPlayedAt: updated.lastPlayedAt,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && isCompleted && !hasJourney) {
      const meta = updated.cachedMeta ?? existing.cachedMeta;
      // Earliest real evidence of play (first session or first move into Playing);
      // otherwise lastPlayedAt (best-effort from a data source like Steam), then addedAt.
      const firstPlayedAt = resolveFirstPlayedAt(gameId, updated.lastPlayedAt ?? addedAtIso ?? nowIso);
      journeyStore.record({
        gameId,
        title: resolveJourneyTitleForRecord(updated, existing),
        coverUrl: meta?.coverUrl,
        genre: meta?.genre ?? [],
        platform: meta?.platform ?? [],
        releaseDate: meta?.releaseDate,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        firstPlayedAt,
        lastPlayedAt: updated.lastPlayedAt ?? nowIso,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && isWantToPlay && !hasJourney) {
      const meta = updated.cachedMeta ?? existing.cachedMeta;
      journeyStore.record({
        gameId,
        title: resolveJourneyTitleForRecord(updated, existing),
        coverUrl: meta?.coverUrl,
        genre: meta?.genre ?? [],
        platform: meta?.platform ?? [],
        releaseDate: meta?.releaseDate,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        addedAt: addedAtIso,
      });
    } else {
      // The journey row already exists (e.g. it was created as Want to Play). The first move into
      // Playing must still date it, otherwise the game never gets a "first played" date and the
      // Captain's Log cannot place it. syncProgress keeps the earliest value.
      const row = journeyStore.getEntry(gameId);
      const firstPlayedAt = statusChanged && !row?.firstPlayedAt
        ? isNowPlaying
          ? resolveFirstPlayedAt(gameId, nowIso)
          : isCompleted
            ? firstPlayEvidenceIso(gameId)
            : undefined
        : undefined;
      // Sync progress to journey history
      journeyStore.syncProgress(gameId, {
        status: updated.status,
        hoursPlayed: updated.hoursPlayed,
        rating: updated.rating,
        lastPlayedAt: updated.lastPlayedAt,
        ...(firstPlayedAt ? { firstPlayedAt } : {}),
      });
    }

    // Record status transition in status history
    if (statusChanged) {
      const journeyEntry = journeyStore.getEntry(gameId);
      const title = journeyEntry?.title || `Game ${gameId}`;
      statusHistoryStore.record(gameId, title, existing.status, updated.status, { source: opts.source });
    }

    if (journeyStore.has(gameId)) {
      const t = updated.cachedMeta?.title?.trim();
      if (t) journeyStore.syncTitleIfPlaceholder(gameId, t);
    }

    // v1.0.45: cross-store title sync. Defer so listeners already saw the
    // primary mutation; the propagation itself will fire its own notifyListeners.
    if (shouldPropagate) {
      setTimeout(() => this.propagateStatusByTitle(updated, updated.status), 0);
    }

    return updated;
  }

  /**
   * v1.0.45 — Cross-store status sync.
   * When a library entry's status becomes Playing / Playing Now / Completed,
   * mirror it onto every other library entry whose normalized title matches.
   *
   *   • Completed  → propagates to any non-Completed sibling
   *   • Playing / Playing Now → propagates to Want-to-Play / On-Hold siblings only
   *
   * Never overwrites Completed (terminal) or Playing Now (in-session) on the
   * target. Stamps `crossStoreSyncedFrom` + `autoTransitionedAt` on updated
   * siblings for diagnostic traceability.
   *
   * 1.0.97: only syncs ACROSS stores (Steam <-> Epic). Same-store titles that
   * normalise alike (remasters / remakes: "Age of Empires II HD" vs "Definitive
   * Edition") and pairs whose confirmed release years differ by more than one
   * are left alone. Custom games are never touched.
   *
   * Called automatically from `updateEntry` (deferred via `setTimeout(0)` so
   * listeners see a consistent state) and once at startup via
   * `syncCrossStoreStatusesOnce()` to catch pre-existing v1.0.44 mismatches.
   */
  propagateStatusByTitle(sourceEntry: LibraryGameEntry, newStatus: GameStatus): number {
    if (!PROPAGATABLE_STATUSES.has(newStatus)) return 0;

    const sourceTitle =
      sourceEntry.cachedMeta?.title?.trim() ||
      (this.entries.get(sourceEntry.gameId)?.cachedMeta?.title?.trim() ?? '');
    const sourceKey = normalizeTitle(sourceTitle);
    if (!sourceKey) return 0;

    const nowIso = new Date().toISOString();
    let changed = 0;

    // Iterate the raw Map (not getAllEntries) — this is a write path,
    // no need to sort, and we're skipping the source entry anyway.
    for (const sibling of this.entries.values()) {
      if (sibling.gameId === sourceEntry.gameId) continue;
      const siblingTitle = sibling.cachedMeta?.title?.trim();
      if (!siblingTitle) continue;
      // Cheap store check first so same-store siblings skip normalizeTitle.
      if (!this.isCrossStorePair(sourceEntry, sibling)) continue;
      if (normalizeTitle(siblingTitle) !== sourceKey) continue;
      if (this.applyPropagation(sourceEntry, sibling, newStatus, nowIso)) changed++;
    }

    if (changed > 0) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
    return changed;
  }

  /** Steam <-> Epic only; never same-store or custom. */
  private isCrossStorePair(a: LibraryGameEntry, b: LibraryGameEntry): boolean {
    const sa = storeOf(a);
    const sb = storeOf(b);
    return sa !== null && sb !== null && sa !== sb;
  }

  /**
   * Apply one sibling's propagation (all the rules, the status-history row and the
   * journey sync) without saving or notifying — callers batch that. Returns true
   * when the sibling changed.
   */
  private applyPropagation(
    source: LibraryGameEntry,
    sibling: LibraryGameEntry,
    newStatus: GameStatus,
    nowIso: string,
  ): boolean {
    if (!this.isCrossStorePair(source, sibling)) return false;
    // Same title but release years apart is a remake, not the same game on another store.
    if (this.isReleaseDateConfirmed(source) && this.isReleaseDateConfirmed(sibling)) {
      const ya = releaseYearOf(source.cachedMeta?.releaseDate);
      const yb = releaseYearOf(sibling.cachedMeta?.releaseDate);
      if (ya !== null && yb !== null && Math.abs(ya - yb) > 1) return false;
    }
    const isSourceCompleted = newStatus === 'Completed';
    const targets = isSourceCompleted ? COMPLETED_OVERWRITE_TARGETS : PLAYING_OVERWRITE_TARGETS;
    if (NEVER_OVERWRITE_STATUSES.has(sibling.status) && !isSourceCompleted) return false;
    if (!targets.has(sibling.status)) return false;
    if (sibling.status === newStatus) return false;

    const mutated: LibraryEntryWithStatusStamp = {
      ...sibling,
      status: newStatus,
      autoTransitionedAt: nowIso,
      crossStoreSyncedFrom: source.gameId,
      statusChangedAt: nowIso,
      updatedAt: new Date(),
    };
    this.entries.set(sibling.gameId, mutated);
    // Record the transition so status history reflects the sync.
    const title = sibling.cachedMeta?.title?.trim() || `Game ${sibling.gameId}`;
    try {
      statusHistoryStore.record(sibling.gameId, title, sibling.status, newStatus, { source: 'sync' });
    } catch {
      // Status history is best-effort — never let its failure block the sync.
    }
    // Keep journey history in step with the new status.
    try {
      if (journeyStore.has(sibling.gameId)) {
        journeyStore.syncProgress(sibling.gameId, { status: newStatus });
      }
    } catch {
      // Non-critical
    }
    return true;
  }

  /**
   * v1.0.45 — one-shot startup sweep to reconcile pre-existing cross-store
   * status mismatches for users upgrading from v1.0.44. Idempotent; safe to
   * call more than once but internally guarded to only actually sweep once
   * per process. For each normalized title with at least one Playing /
   * Playing Now / Completed entry, propagates the strongest observed status
   * onto matching siblings using the same rules as `propagateStatusByTitle`.
   *
   * 1.0.97: normalises each title once (the buckets ARE the sibling sets), and
   * saves + notifies once at the end instead of once per bucket. Skipped when
   * the library is read-only (nothing could be persisted).
   */
  syncCrossStoreStatusesOnce(): void {
    if (this._crossStoreSweepDone) return;
    this._crossStoreSweepDone = true;
    if (this._readOnly) return;

    // Group entries by normalized title. Only keys with a propagatable status
    // among their members can drive propagation.
    const byKey = new Map<string, LibraryGameEntry[]>();
    for (const entry of this.entries.values()) {
      const t = entry.cachedMeta?.title?.trim();
      if (!t) continue;
      const key = normalizeTitle(t);
      if (!key) continue;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(entry);
      else byKey.set(key, [entry]);
    }

    // Rank: Completed (2) > Playing Now (1.5) > Playing (1) > others (0).
    const rank = (s: GameStatus): number =>
      s === 'Completed' ? 2 : s === 'Playing Now' ? 1.5 : s === 'Playing' ? 1 : 0;

    const nowIso = new Date().toISOString();
    let changed = 0;
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue;
      let best: LibraryGameEntry | null = null;
      for (const e of bucket) {
        if (!PROPAGATABLE_STATUSES.has(e.status)) continue;
        if (!best || rank(e.status) > rank(best.status)) best = e;
      }
      if (!best) continue;
      for (const member of bucket) {
        if (member.gameId === best.gameId) continue;
        // Re-read: an earlier write in this sweep may have replaced the entry object.
        const sibling = this.entries.get(member.gameId) ?? member;
        if (this.applyPropagation(best, sibling, best.status, nowIso)) changed++;
      }
    }

    if (changed > 0) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
  }

  /**
   * v1.0.45 — Backlog filtering. A release date is "confirmed" only when
   * it exists, isn't a TBA-style placeholder, and isn't a far-future sentinel
   * (year >= 2090, matching dedup.ts SENTINEL_YEAR).
   *
   * The backlog is meant to answer "what can I actually play next?" —
   * unreleased / unannounced games belong on a wishlist view, not here.
   */
  isReleaseDateConfirmed(entry: LibraryGameEntry): boolean {
    const raw = entry.cachedMeta?.releaseDate;
    if (raw === undefined || raw === null) return false;
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) return false;

    const lower = trimmed.toLowerCase();
    for (const marker of UNANNOUNCED_MARKERS) {
      if (lower === marker || lower.includes(marker)) return false;
    }

    // Try to parse — if it parses, sentinel-year cutoff applies. If it doesn't
    // parse but survived the marker check above, we treat it as confirmed
    // (some titles ship with e.g. "Q1 2027" that Date can't parse but is
    // still a real announced window).
    const ts = Date.parse(trimmed);
    if (!Number.isNaN(ts)) {
      const year = new Date(ts).getFullYear();
      if (year >= SENTINEL_YEAR_LOCAL) return false;
    }
    return true;
  }

  /**
   * v1.0.45 — Want-to-Play entries with a confirmed release date only.
   * Excludes TBA / Coming Soon / sentinel-year (2099-01-01 style) entries
   * per user complaint: "backlog cannot include games that are yet to be
   * announced".
   */
  getBacklogEntries(): LibraryGameEntry[] {
    return this.getAllEntries().filter(
      (e) => e.status === 'Want to Play' && this.isReleaseDateConfirmed(e),
    );
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
    // v1.0.45: lazily run the one-shot cross-store sweep the first time
    // any consumer reads the library. This covers pre-existing v1.0.44
    // mismatches for upgraders without adding a wire-up call at every
    // possible boot site. Guarded internally so it's a no-op after run.
    // 1.0.97: wait for hydration (this store plus journey / status history) —
    // before it the map is empty and the sweep used to mark itself done on nothing.
    if (!this._crossStoreSweepDone && this.isInitialized && this._sweepDepsReady) {
      this.syncCrossStoreStatusesOnce();
    }
    if (this._sortedCache) return this._sortedCache;
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
    // Before hydration finishes the library is partial (often empty): never
    // cache that view, or early readers pin it for the whole session.
    if (!this.isInitialized) return sorted;
    this._sortedCache = sorted;
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

  // Update hoursPlayed from session tracking totals (preserves baseline so user-entered hours are not lost)
  updateHoursFromSessions(gameId: string, sessionTotalHours: number, lastPlayedAt?: string) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    const safeSessionHours = Number.isFinite(sessionTotalHours) ? Math.max(0, sessionTotalHours) : 0;

    // Guard against accidental reset-to-zero. This method only ever ADDS tracked
    // session time on top of a baseline, so it must never reduce a positive total
    // to 0. That can happen when session history is cleared (e.g. an import with
    // no sessionHistory) or a live update arrives with ~0 active minutes while
    // baseline is also 0. Explicit user resets go through updateEntry instead.
    if (safeSessionHours === 0 && (existing.hoursBaseline ?? 0) === 0 && (existing.hoursPlayed ?? 0) > 0) {
      return;
    }

    // Migrate: if no baseline yet, treat current hoursPlayed as effective and infer baseline
    if (existing.hoursBaseline === undefined) {
      existing.hoursBaseline = Math.max(0, (existing.hoursPlayed ?? 0) - safeSessionHours);
    }
    const baseline = existing.hoursBaseline ?? 0;
    const effectiveHours = baseline + safeSessionHours;
    // Mutated in place on purpose (holders of the entry see live hours); the
    // dirty mark makes the next save write just this row.
    existing.hoursPlayed = effectiveHours;
    if (lastPlayedAt !== undefined) existing.lastPlayedAt = lastPlayedAt;
    existing.updatedAt = new Date();
    this._dirtyIds.add(gameId);
    this.invalidateSortedCache();
    this.scheduleSave();
    // Fire the hours-only channel — 15s session ticks must NOT invalidate
    // the games grid memo, Oracle library-signature, or other top-level
    // consumers that only care about status/collection changes.
    this.notifyHoursListeners();

    journeyStore.syncProgress(gameId, { hoursPlayed: effectiveHours, lastPlayedAt });
  }

  /**
   * Bulk cachedMeta write for the backfill: applies ONLY cachedMeta to each id still
   * in the library, keeps placeholder journey titles in step, then invalidates /
   * saves / notifies once for the whole batch (updateEntry would notify per game).
   * Returns how many entries were updated.
   */
  setCachedMetaBatch(metaById: Map<string, CachedGameMeta>): number {
    let changed = 0;
    for (const [gameId, meta] of metaById) {
      const existing = this.entries.get(gameId);
      if (!existing) continue;
      this.entries.set(gameId, { ...existing, cachedMeta: meta, updatedAt: new Date() });
      changed++;
      const t = meta.title?.trim();
      if (t && journeyStore.has(gameId)) journeyStore.syncTitleIfPlaceholder(gameId, t);
    }
    if (changed > 0) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
    return changed;
  }

  /** Changes whenever the whole library is cleared or replaced by an import. */
  getReplaceEpoch(): number {
    return this._replaceEpoch;
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
    this._replaceEpoch++;
    this.invalidateSortedCache();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._useLevelDB && !this._readOnly) {
      // Queued: any save issued after this (e.g. importData) runs only once
      // the namespace wipe has completed — the two can no longer interleave.
      void this._writeQueue.run(async () => {
        const res = await window.store!.clearNamespace(LEVEL_NAMESPACE);
        if (res.error) {
          console.error('[LibraryStore] clearNamespace failed:', res.error);
          return; // keep _persisted so the next save emits explicit deletes
        }
        this._persisted = new Map();
      });
    }
    this._dirtyIds.clear();
    if (!this._readOnly) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(MIGRATION_MARKER_KEY);
    }
    this.notifyListeners();
  }

  /**
   * Clear library (Dashboard "Clear library"): Steam/Epic entries AND custom
   * games. Their journey rows are flagged removed first, with one shared
   * timestamp, so Voyage and Oracle stop counting them as owned. The ids must
   * be collected before the clears or they are lost. Generic clear() stays
   * side-effect free.
   */
  clearAll(): { libraryCount: number; customCount: number } {
    const libraryIds = Array.from(this.entries.keys());
    const customIds = customGameStore.getAllGames().map((g) => g.id);
    journeyStore.markRemovedBatch([...libraryIds, ...customIds]);
    this.clear();
    customGameStore.clear();
    return { libraryCount: libraryIds.length, customCount: customIds.length };
  }

  // Export library data (includes custom games, journey history, status history, and session history)
  exportData(): string {
    return JSON.stringify(
      {
        entries: Array.from(this.entries.values()),
        customGames: customGameStore.exportData(),
        journeyHistory: journeyStore.exportData(),
        statusHistory: statusHistoryStore.exportData(),
        sessionHistory: sessionStore.exportData(),
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
  }

  /**
   * Parse + validate a backup file without touching any store, so the UI can
   * show what an import will replace before the user confirms.
   */
  parseImport(jsonData: string): { success: true; plan: LibraryImportPlan } | { success: false; error: string } {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonData);
    } catch {
      return { success: false, error: 'Failed to parse import data' };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return { success: false, error: 'Invalid data format' };
    }
    const entries = (parsed.entries as unknown[]).filter(
      (e): e is LibraryGameEntry => !!e && typeof e === 'object',
    );
    const rawCustom = parsed.customGames;
    const customGames =
      rawCustom && typeof rawCustom === 'object' && Array.isArray(rawCustom.entries)
        ? {
            entries: rawCustom.entries as CustomGameEntry[],
            nextCounter: typeof rawCustom.nextCounter === 'number' ? rawCustom.nextCounter : undefined,
          }
        : undefined;
    return {
      success: true,
      plan: {
        entries,
        ...(Array.isArray(parsed.journeyHistory) ? { journeyHistory: parsed.journeyHistory as JourneyEntry[] } : {}),
        ...(Array.isArray(parsed.statusHistory) ? { statusHistory: parsed.statusHistory as StatusChangeEntry[] } : {}),
        ...(Array.isArray(parsed.sessionHistory) ? { sessionHistory: parsed.sessionHistory as GameSession[] } : {}),
        ...(customGames ? { customGames } : {}),
        counts: {
          currentGames: this.entries.size,
          fileGames: entries.length,
          currentCustomGames: customGameStore.getCount(),
          fileCustomGames: customGames ? customGames.entries.length : null,
        },
      },
    };
  }

  /**
   * Apply a parsed backup. REPLACES the library; custom games, status history,
   * sessions and journey are replaced only when the file carries them (an old
   * or partial backup keeps the existing data for what it lacks). Before
   * anything is cleared, the current state is snapshotted (memory + LevelDB)
   * so "Restore previous library" can undo the import.
   */
  applyImport(plan: LibraryImportPlan, opts: { snapshot?: boolean } = {}): LibraryImportResult {
    if (opts.snapshot !== false) {
      const snapshot = this.exportData();
      this._lastImportSnapshot = snapshot;
      this.persistImportSnapshot(snapshot);
    }

    // Custom games first: the history replay below may reference their ids.
    let customCount = customGameStore.getCount();
    if (plan.customGames) {
      const res = customGameStore.importData(plan.customGames.entries, plan.customGames.nextCounter);
      if (res.success) customCount = res.count;
    }

    // Library rows go through the same sanitising as hydrate (gameId migration,
    // Dropped → On Hold, valid dates) and the sorted-cache invalidation.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._replaceEpoch++;
    this.entries.clear();
    this._dirtyIds.clear();
    const { count } = this.ingestEntries(plan.entries);

    // Status history and sessions before the journey: its first-played
    // backfill looks up first sessions and first Playing transitions.
    if (plan.statusHistory) {
      statusHistoryStore.clear();
      statusHistoryStore.importData(plan.statusHistory);
    }
    if (plan.sessionHistory) {
      sessionStore.clear();
      sessionStore.importData(plan.sessionHistory);
    }
    if (plan.journeyHistory) {
      journeyStore.clear();
      journeyStore.importData(plan.journeyHistory);
    }

    if (!plan.customGames) {
      // Old file without custom games: existing ones stay, but the counter
      // must still clear every custom-N the imported history mentions.
      const ids: string[] = [];
      for (const s of plan.sessionHistory ?? []) if (s && typeof s.gameId === 'string') ids.push(s.gameId);
      for (const s of plan.statusHistory ?? []) if (s && typeof s.gameId === 'string') ids.push(s.gameId);
      for (const j of plan.journeyHistory ?? []) if (j && typeof j.gameId === 'string') ids.push(j.gameId);
      customGameStore.ensureCounterAbove(ids);
    }

    // Everything now owned is not "removed", whatever the file's journey says.
    journeyStore.clearRemovedFor([
      ...this.entries.keys(),
      ...customGameStore.getAllGames().map((g) => g.id),
    ]);

    // Imported Playing games get a fresh 4 weeks before the idle sweep may put them On Hold.
    try {
      localStorage.setItem('ark:libraryImportedAt', new Date().toISOString());
    } catch {
      /* non-critical */
    }

    this.saveNow();
    this.notifyListeners();
    return { success: true, count, customCount };
  }

  // Import library data — REPLACES the library (see applyImport for what else is replaced)
  importData(jsonData: string): LibraryImportResult {
    try {
      const parsed = this.parseImport(jsonData);
      if (!parsed.success) return { success: false, count: 0, customCount: 0, error: parsed.error };
      return this.applyImport(parsed.plan);
    } catch (error) {
      console.error('[LibraryStore] import failed:', error);
      return { success: false, count: 0, customCount: 0, error: 'Failed to import data' };
    }
  }


  /** The library as it was right before the last import this session (export JSON), if any. */
  getLastImportSnapshot(): string | null {
    return this._lastImportSnapshot;
  }

  /** Undo the last import: re-apply the pre-import snapshot (without snapshotting again). */
  restoreLastImportSnapshot(): LibraryImportResult {
    const snapshot = this._lastImportSnapshot;
    if (!snapshot) return { success: false, count: 0, customCount: 0, error: 'Nothing to restore' };
    const parsed = this.parseImport(snapshot);
    if (!parsed.success) return { success: false, count: 0, customCount: 0, error: parsed.error };
    const result = this.applyImport(parsed.plan, { snapshot: false });
    if (result.success) this._lastImportSnapshot = null;
    return result;
  }

  /** Best-effort on-disk copy (userData LevelDB) of the pre-import snapshot. */
  private persistImportSnapshot(snapshot: string): void {
    const store = typeof window !== 'undefined' ? window.store : undefined;
    if (!store) return;
    try {
      void Promise.resolve(
        store.put(IMPORT_SNAPSHOT_NAMESPACE, IMPORT_SNAPSHOT_KEY, {
          takenAt: new Date().toISOString(),
          data: snapshot,
        }),
      )
        .then((res) => {
          if (res && res.error) console.error('[LibraryStore] import snapshot write failed:', res.error);
        })
        .catch((err) => console.error('[LibraryStore] import snapshot write failed:', err));
    } catch (err) {
      console.error('[LibraryStore] import snapshot write failed:', err);
    }
  }
}

/**
 * One-time boot repair: before v1.0.97 re-adding a removed game never cleared
 * its journey removedAt, so it stayed "Removed" in Voyage and near-zero in
 * Oracle. Once the library, custom-game and journey stores have hydrated,
 * clear the flag for every id that is owned again. Idempotent.
 */
let _removedRepairDone = false;
export async function repairJourneyRemovedFlags(): Promise<number> {
  if (_removedRepairDone) return 0;
  _removedRepairDone = true;
  await Promise.all([
    libraryStore.ready.catch(() => undefined),
    customGameStore.ready.catch(() => undefined),
    journeyStore.ready.catch(() => undefined),
  ]);
  return journeyStore.clearRemovedFor([
    ...libraryStore.getAllGameIds(),
    ...customGameStore.getAllGames().map((g) => g.id),
  ]);
}

// Singleton instance
export const libraryStore = new LibraryStore();
