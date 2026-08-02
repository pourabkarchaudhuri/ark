import { JourneyEntry, GameStatus, migrateGameId } from '@/types/game';
import { sessionStore } from './session-store';
import { statusHistoryStore } from './status-history-store';

const STORAGE_KEY = 'ark-journey-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

/**
 * One-shot marker stamped in localStorage after the LevelDB migration copies
 * the ark-journey-history payload across. Presence => never migrate again.
 * The original STORAGE_KEY stays intact for one release as rollback insurance.
 */
const MIGRATION_MARKER_KEY = 'ark-journey-history-migrated-v1';

/** LevelDB namespace this store owns. Keys within it are `entry.gameId`. */
const LEVEL_NAMESPACE = 'journey';

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _journeyBeforeUnloadInstalled = false;

/**
 * Coerce a raw value into a valid ISO date string, or return `undefined` if
 * the value is missing / non-parseable. Old exports and hand-edited entries
 * can carry `"undefined"`, empty strings, or unparseable stubs — those must
 * not be persisted back into the journey.
 */
function toValidIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') {
      return undefined;
    }
    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

/** True when the journey row title should be replaced once library metadata loads. */
export function isPlaceholderJourneyTitle(title: string | undefined): boolean {
  if (title == null) return true;
  const t = title.trim();
  if (t.length === 0) return true;
  const lower = t.toLowerCase();
  if (lower === 'unknown' || lower === 'unknown game') return true;
  return false;
}

interface StoredJourneyData {
  version: number;
  entries: JourneyEntry[];
  lastUpdated: string;
}

/**
 * Sanitize an incoming entry so garbage date strings never end up persisted
 * back into storage or displayed downstream.
 */
function sanitizeEntry(entry: JourneyEntry, id: string): JourneyEntry {
  return {
    ...entry,
    gameId: id,
    addedAt: toValidIso(entry.addedAt) ?? new Date().toISOString(),
    firstPlayedAt: toValidIso(entry.firstPlayedAt),
    lastPlayedAt: toValidIso(entry.lastPlayedAt),
    removedAt: toValidIso(entry.removedAt),
  };
}

/**
 * Journey Store — persists a historical record of every game the user adds to their library.
 * Unlike the library store, entries here are NEVER deleted when a game is removed.
 * This powers the Journey timeline view.
 *
 * v1.0.61: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface (see `electron/ipc/store-handlers.ts`). The
 * public sync API is unchanged — an in-memory cache is hydrated on init and
 * every read still returns synchronously. When `window.store` is unavailable
 * (unit tests, jsdom, pre-preload boot window) the store transparently
 * falls back to the previous localStorage path.
 */
export class JourneyStore {
  private entries: Map<string, JourneyEntry> = new Map(); // keyed by universal gameId string
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortedCache: JourneyEntry[] | null = null;

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  /**
   * Set of gameIds currently persisted in LevelDB. On every debounced batch
   * we diff `entries` against this to emit `del` ops for anything that
   * disappeared (e.g. via `deleteEntry`). Simplification for v1.0.61: we
   * still batch-put ALL current entries every debounce cycle (delta-writes
   * come later).
   */
  private _knownKeys: Set<string> = new Set();

  /**
   * Exposed for tests / callers that want to await the async hydration
   * finishing (LevelDB path only — localStorage path resolves immediately).
   * Do NOT rely on this in production code — all public reads are safe
   * before it resolves; they simply return an empty cache during the
   * boot window.
   */
  readonly ready: Promise<void>;

  constructor() {
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
    this.ready = this.initialize();
    if (typeof window !== 'undefined' && !_journeyBeforeUnloadInstalled) {
      _journeyBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (this._useLevelDB) {
      await this.initializeFromLevelDB();
    } else {
      this.initializeFromLocalStorage();
    }

    this.isInitialized = true;
  }

  /**
   * LevelDB init path:
   *   1. Load rows from namespace `journey`. If any exist, hydrate.
   *   2. If empty AND `localStorage[STORAGE_KEY]` exists AND no migration
   *      marker => copy the JSON payload into LevelDB, stamp the marker.
   *   3. On any hard failure fall back to the localStorage path so the
   *      user never loses their journey.
   */
  private async initializeFromLevelDB(): Promise<void> {
    try {
      const res = await window.store!.getAll<JourneyEntry>(LEVEL_NAMESPACE);
      if (res.error) {
        console.error('[JourneyStore] getAll(journey) IPC error:', res.error);
        this.initializeFromLocalStorage();
        return;
      }
      const rows = res.rows ?? [];
      if (rows.length > 0) {
        this.hydrateFromRows(rows.map((r) => r.value));
        return;
      }
      // LevelDB empty — attempt one-shot migration from localStorage.
      const migrated = await this.tryMigrateFromLocalStorage();
      if (!migrated) {
        // Nothing to migrate: keep entries empty. Do not touch localStorage.
        this.notifyListeners();
      }
    } catch (err) {
      console.error('[JourneyStore] Failed to init from LevelDB, falling back:', err);
      this.initializeFromLocalStorage();
    }
  }

  /**
   * One-shot copy of `localStorage[STORAGE_KEY]` -> LevelDB namespace `journey`.
   *
   * Runs only when:
   *   - migration marker is absent (never migrated before), AND
   *   - LevelDB journey namespace is empty (caller already checked), AND
   *   - localStorage payload exists and parses cleanly.
   *
   * Stamps `MIGRATION_MARKER_KEY = 'yes'` on success (or on an empty/invalid
   * payload) so we don't retry every boot.
   *
   * Returns `true` if any rows were copied.
   */
  private async tryMigrateFromLocalStorage(): Promise<boolean> {
    try {
      if (localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes') return false;

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      let parsed: StoredJourneyData;
      try {
        parsed = JSON.parse(raw) as StoredJourneyData;
      } catch (e) {
        console.error('[JourneyStore] Legacy payload parse failed:', e);
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      const sanitized: JourneyEntry[] = [];
      for (const entry of parsed.entries) {
        const id = migrateGameId(entry as any);
        if (!id) continue;
        sanitized.push(sanitizeEntry(entry, id));
      }

      if (sanitized.length === 0) {
        // Migration produced 0 entries — do NOT stamp the marker or wipe
        // localStorage; something went wrong and we must not lose the journey.
        console.warn(
          '[JourneyStore] Migration produced 0 entries — skipping to prevent data loss',
        );
        return false;
      }

      const ops = sanitized.map((e) => ({
        type: 'put' as const,
        namespace: LEVEL_NAMESPACE,
        key: e.gameId,
        value: e,
      }));

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[JourneyStore] Migration batch failed:', res.error);
        return false;
      }

      // IMPORTANT: keep the original STORAGE_KEY intact for one release as
      // rollback insurance. Only stamp the marker.
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      this.hydrateFromRows(sanitized);
      console.log(
        `[JourneyStore] Migrated ${sanitized.length} entries from localStorage -> LevelDB`,
      );
      return true;
    } catch (err) {
      console.error('[JourneyStore] Migration failed:', err);
      return false;
    }
  }

  /** Legacy path — used both as fallback and in test/jsdom environments. */
  private initializeFromLocalStorage(): void {
    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredJourneyData;
        if (Array.isArray(parsed.entries)) {
          for (const entry of parsed.entries) {
            const id = migrateGameId(entry as any);
            if (id) {
              // Sanitize dates on load so pre-existing garbage never gets
              // re-persisted, and downstream views never see "Invalid Date".
              this.entries.set(id, sanitizeEntry(entry, id));
            }
          }
          if (parsed.version < STORAGE_VERSION) {
            needsResave = true;
          }
        }
      }
    } catch (error) {
      console.error('[JourneyStore] Failed to load:', error);
    }

    // GUARD: Never overwrite existing data with an empty store — if all entries
    // failed migration something went wrong and we must not wipe the journey.
    if (needsResave && this.entries.size > 0) {
      this.saveNowLocalStorage();
      console.log(`[JourneyStore] Migrated ${this.entries.size} entries to v2 (string gameId)`);
    } else if (needsResave && this.entries.size === 0) {
      console.warn(
        '[JourneyStore] Migration produced 0 entries — skipping save to prevent data loss',
      );
    }
  }

  /**
   * Populate the in-memory cache from a list of JourneyEntry rows (from
   * either LevelDB or the localStorage migration payload) and notify.
   */
  private hydrateFromRows(rows: JourneyEntry[]): void {
    this.entries.clear();
    for (const row of rows) {
      const id = migrateGameId(row as any);
      if (!id) continue;
      this.entries.set(id, sanitizeEntry(row, id));
    }
    this._knownKeys = new Set(this.entries.keys());
    this.invalidateSortedCache();
    this.notifyListeners();
  }

  /**
   * Debounced save — coalesces bursts of journey writes (rapid record()
   * calls during import, cross-store sync) into a single persistence hit
   * ~300ms later.
   */
  private scheduleSave() {
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

  private saveNow(): void {
    if (this._useLevelDB) {
      // Fire-and-forget; errors are logged. Preserves the current synchronous
      // callsite contract used by importData().
      void this.saveNowLevelDB();
      return;
    }
    this.saveNowLocalStorage();
  }

  private saveNowLocalStorage(): void {
    try {
      const data: StoredJourneyData = {
        version: STORAGE_VERSION,
        entries: Array.from(this.entries.values()),
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[JourneyStore] Failed to save:', error);
    }
  }

  private async saveNowLevelDB(): Promise<void> {
    try {
      const currentIds = new Set<string>();
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];

      for (const [gameId, entry] of this.entries.entries()) {
        if (!gameId) continue;
        currentIds.add(gameId);
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: gameId, value: entry });
      }

      // Delta-deletes: anything in _knownKeys that's no longer in entries.
      for (const oldKey of this._knownKeys) {
        if (!currentIds.has(oldKey)) {
          ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: oldKey });
        }
      }

      if (ops.length === 0) return;

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[JourneyStore] batch save failed:', res.error);
        return;
      }
      this._knownKeys = currentIds;
    } catch (err) {
      console.error('[JourneyStore] Failed to save (LevelDB):', err);
    }
  }

  private invalidateSortedCache() {
    this._sortedCache = null;
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
   * Record a game in the journey.
   * If it already exists, the addedAt is preserved (never overwritten).
   * Status / hours / rating are updated.
   */
  record(entry: Omit<JourneyEntry, 'addedAt' | 'removedAt'> & { addedAt?: string }) {
    const existing = this.entries.get(entry.gameId);
    // Sanitize date fields so garbage strings ("undefined", "") never get
    // re-persisted — mirrors the guard we already apply on load.
    const addedAt =
      toValidIso(existing?.addedAt) ?? toValidIso(entry.addedAt) ?? new Date().toISOString();
    const firstPlayedAt = toValidIso(entry.firstPlayedAt) ?? toValidIso(existing?.firstPlayedAt);
    const lastPlayedAt = toValidIso(entry.lastPlayedAt) ?? toValidIso(existing?.lastPlayedAt);

    this.entries.set(entry.gameId, {
      ...existing,  // preserve existing fields (firstPlayedAt, lastPlayedAt, etc.)
      ...entry,     // caller-provided fields override
      firstPlayedAt,
      lastPlayedAt,
      addedAt,
      removedAt: undefined, // clear removedAt — the game is (back) in library
    });

    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
  }

  /**
   * Batch-record multiple entries without triggering intermediate saves/notifications.
   * Fires a single save + notify at the end if any entries were written.
   */
  recordBatch(entries: Array<Omit<JourneyEntry, 'addedAt' | 'removedAt'> & { addedAt?: string }>) {
    if (entries.length === 0) return;
    let changed = false;
    for (const entry of entries) {
      const existing = this.entries.get(entry.gameId);
      const addedAt =
        toValidIso(existing?.addedAt) ?? toValidIso(entry.addedAt) ?? new Date().toISOString();
      const firstPlayedAt = toValidIso(entry.firstPlayedAt) ?? toValidIso(existing?.firstPlayedAt);
      const lastPlayedAt = toValidIso(entry.lastPlayedAt) ?? toValidIso(existing?.lastPlayedAt);
      this.entries.set(entry.gameId, {
        ...existing,
        ...entry,
        firstPlayedAt,
        lastPlayedAt,
        addedAt,
        removedAt: undefined,
      });
      changed = true;
    }
    if (changed) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
  }

  /**
   * Mark a game as removed (sets removedAt but does NOT delete).
   */
  markRemoved(gameId: string) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    existing.removedAt = new Date().toISOString();
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
  }

  /**
   * Sync status / hours / rating / lastPlayedAt for a game already in the journey.
   */
  syncProgress(gameId: string, fields: { status?: GameStatus; hoursPlayed?: number; rating?: number; firstPlayedAt?: string; lastPlayedAt?: string }) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    if (fields.status !== undefined) existing.status = fields.status;
    if (fields.hoursPlayed !== undefined) existing.hoursPlayed = fields.hoursPlayed;
    if (fields.rating !== undefined) existing.rating = fields.rating;
    if (fields.firstPlayedAt !== undefined) {
      // Reject garbage strings ("undefined", "") that would poison downstream views.
      const iso = toValidIso(fields.firstPlayedAt);
      if (iso) existing.firstPlayedAt = iso;
    }
    if (fields.lastPlayedAt !== undefined) {
      const iso = toValidIso(fields.lastPlayedAt);
      if (iso) existing.lastPlayedAt = iso;
    }

    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
  }

  /**
   * When library metadata arrives after the journey row was created with a placeholder title,
   * update the stored title so Voyage / Gantt show the real name.
   */
  syncTitleIfPlaceholder(gameId: string, title: string | undefined) {
    if (!title || isPlaceholderJourneyTitle(title)) return;
    const trimmed = title.trim();
    const existing = this.entries.get(gameId);
    if (!existing) return;
    if (!isPlaceholderJourneyTitle(existing.title)) return;
    if (existing.title === trimmed) return;

    existing.title = trimmed;
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
  }

  /**
   * Set the journey row title from an authoritative source (e.g. custom game rename).
   * Unlike syncTitleIfPlaceholder, this updates whenever the title differs.
   */
  syncJourneyTitle(gameId: string, title: string | undefined) {
    if (!title || !title.trim()) return;
    const trimmed = title.trim();
    const existing = this.entries.get(gameId);
    if (!existing) return;
    if (existing.title === trimmed) return;

    existing.title = trimmed;
    this.invalidateSortedCache();
    this.scheduleSave();
    this.notifyListeners();
  }

  // ------ Queries ------

  getEntry(gameId: string): JourneyEntry | undefined {
    return this.entries.get(gameId);
  }

  /**
   * Returns all journey entries sorted newest-first by addedAt (cached sort).
   */
  getAllEntries(): JourneyEntry[] {
    if (this._sortedCache) return this._sortedCache;
    this._sortedCache = Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
    return this._sortedCache;
  }

  /**
   * Returns entries that have firstPlayedAt or lastPlayedAt, for Ark and Captain's Log.
   * Sort: Playing/Playing Now first, then by latest activity (lastPlayedAt ?? firstPlayedAt) descending.
   */
  getEntriesForArkAndLog(): JourneyEntry[] {
    const playingStatuses: GameStatus[] = ['Playing', 'Playing Now'];
    const withActivity = Array.from(this.entries.values()).filter(
      (e) => e.firstPlayedAt || e.lastPlayedAt
    );
    const latest = (e: JourneyEntry) =>
      new Date(e.lastPlayedAt ?? e.firstPlayedAt ?? e.addedAt).getTime();
    return withActivity.sort((a, b) => {
      const aPlaying = playingStatuses.includes(a.status);
      const bPlaying = playingStatuses.includes(b.status);
      if (aPlaying && !bPlaying) return -1;
      if (!aPlaying && bPlaying) return 1;
      return latest(b) - latest(a);
    });
  }

  getSize(): number {
    return this.entries.size;
  }

  has(gameId: string): boolean {
    return this.entries.has(gameId);
  }

  // ------ Import / Export ------

  exportData(): JourneyEntry[] {
    return this.getAllEntries();
  }

  /**
   * Import journey entries (merges, preserving earliest addedAt per game).
   */
  importData(entries: JourneyEntry[]): { added: number; updated: number; skipped: number } {
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const incoming of entries) {
      const migratedId = migrateGameId(incoming as any);
      if (!migratedId) { skipped++; continue; }
      // Sanitize date fields on the incoming record so imports never carry
      // "undefined" / empty strings back into storage.
      const migratedIncoming: JourneyEntry = {
        ...incoming,
        gameId: migratedId,
        addedAt: toValidIso(incoming.addedAt) ?? new Date().toISOString(),
        firstPlayedAt: toValidIso(incoming.firstPlayedAt),
        lastPlayedAt: toValidIso(incoming.lastPlayedAt),
        removedAt: toValidIso(incoming.removedAt),
      };

      const existing = this.entries.get(migratedId);

      if (!existing) {
        this.entries.set(migratedId, migratedIncoming);
        added++;
      } else {
        // Keep earliest addedAt
        const keepAddedAt =
          new Date(existing.addedAt).getTime() <= new Date(migratedIncoming.addedAt).getTime()
            ? existing.addedAt
            : migratedIncoming.addedAt;

        // Keep removedAt only if both have it; otherwise prefer the one that doesn't
        const removedAt = !migratedIncoming.removedAt ? undefined : (!existing.removedAt ? undefined : migratedIncoming.removedAt);

        const merged: JourneyEntry = {
          ...existing,
          ...migratedIncoming,
          addedAt: keepAddedAt,
          removedAt,
        };

        const isDifferent =
          existing.status !== merged.status ||
          existing.hoursPlayed !== merged.hoursPlayed ||
          existing.rating !== merged.rating ||
          existing.lastPlayedAt !== merged.lastPlayedAt ||
          existing.firstPlayedAt !== merged.firstPlayedAt ||
          existing.removedAt !== merged.removedAt ||
          existing.addedAt !== merged.addedAt ||
          existing.title !== merged.title ||
          existing.coverUrl !== merged.coverUrl ||
          existing.releaseDate !== merged.releaseDate;
        if (isDifferent) {
          this.entries.set(migratedId, merged);
          updated++;
        } else {
          skipped++;
        }
      }
    }

    // Backfill firstPlayedAt for entries that were played but lack timing data,
    // so they appear in Ark and Log views (which filter on firstPlayedAt/lastPlayedAt).
    // Prefer real evidence over `addedAt`: first recorded session, then first
    // transition into Playing, then finally fall back to `addedAt`.
    const noTimingStatuses: GameStatus[] = ['Want to Play'];
    let backfilled = 0;
    for (const entry of this.entries.values()) {
      if (!entry.firstPlayedAt && !entry.lastPlayedAt && !noTimingStatuses.includes(entry.status)) {
        const firstSession = sessionStore.getFirstSessionStart(entry.gameId);
        const firstPlayingTs = statusHistoryStore.getFirstPlayingTransition(entry.gameId);
        entry.firstPlayedAt =
          firstSession > 0
            ? new Date(firstSession).toISOString()
            : firstPlayingTs !== null
              ? new Date(firstPlayingTs).toISOString()
              : entry.addedAt;
        backfilled++;
      }
    }
    if (added > 0 || updated > 0 || backfilled > 0) {
      this.invalidateSortedCache();
      this.saveNow(); // direct save for bulk import
      this.notifyListeners();
    }

    return { added, updated, skipped };
  }

  /**
   * Permanently delete a journey entry.
   * Unlike markRemoved(), this fully removes the entry from the store.
   */
  deleteEntry(gameId: string): boolean {
    const existed = this.entries.delete(gameId);
    if (existed) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
    return existed;
  }

  /** Clear all journey data (mainly for testing / reset). */
  clear() {
    this.entries.clear();
    this.invalidateSortedCache();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._useLevelDB) {
      // Fire-and-forget: also nuke the LevelDB namespace so subsequent
      // hydrates see an empty store. Errors are logged.
      void (async () => {
        try {
          const res = await window.store!.clearNamespace(LEVEL_NAMESPACE);
          if (res.error) console.error('[JourneyStore] clearNamespace failed:', res.error);
        } catch (err) {
          console.error('[JourneyStore] Failed to clear LevelDB namespace:', err);
        }
      })();
    }
    localStorage.removeItem(STORAGE_KEY);
    // Reset the migration marker so a subsequent clear-then-import cycle
    // treats the next non-empty localStorage payload as a fresh migration.
    localStorage.removeItem(MIGRATION_MARKER_KEY);
    this._knownKeys = new Set();
    this.notifyListeners();
  }
}

// Singleton
export const journeyStore = new JourneyStore();
