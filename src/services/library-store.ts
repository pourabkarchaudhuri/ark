import {
  LibraryGameEntry,
  GameStatus,
  GamePriority,
  CreateLibraryEntry,
  UpdateLibraryEntry,
  migrateGameId,
} from '@/types/game';
import { journeyStore } from './journey-store';
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

const STORAGE_KEY = 'ark-library-data';
const STORAGE_VERSION = 5; // v5: gameId migrated from number to string

interface StoredData {
  version: number;
  entries: LibraryGameEntry[];
  lastUpdated: string;
}

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _libraryBeforeUnloadInstalled = false;

/**
 * Library Store - Manages user's personal game library
 * Stores only user-specific data (status, priority, notes) for games added from Steam/Epic
 */
class LibraryStore {
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
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortedCache: LibraryGameEntry[] | null = null;
  /** v1.0.45 — guard so `syncCrossStoreStatusesOnce` only ever sweeps once. */
  private _crossStoreSweepDone = false;

  constructor() {
    this.initialize();
    if (typeof window !== 'undefined' && !_libraryBeforeUnloadInstalled) {
      _libraryBeforeUnloadInstalled = true;
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

  /** Ensure we always have a valid Date (never Invalid Date). Old data may lack updatedAt. */
  private static toValidDate(value: unknown, fallback: Date): Date {
    if (value == null) return fallback;
    const d = value instanceof Date ? value : new Date(value as string | number);
    return Number.isNaN(d.getTime()) ? fallback : d;
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
    this.listeners.forEach((listener) => listener());
    // Regular mutations are a superset — anyone watching hours also cares
    // about status/collection changes (which can change hoursPlayed too).
    this.hoursListeners.forEach((listener) => listener());
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
    const isWantToPlay = updatedStatus === 'Want to Play';
    // v1.0.45: propagate status to same-title siblings on other stores
    // AFTER the primary mutation is committed and listeners have fired.
    const shouldPropagate =
      statusChanged && PROPAGATABLE_STATUSES.has(updatedStatus);

    const updated: LibraryGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(), // Always app-managed (last save time)
    };
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

    const hasJourney = journeyStore.has(gameId);
    const addedAtIso = (updated.addedAt instanceof Date ? updated.addedAt : new Date(updated.addedAt)).toISOString();
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
        firstPlayedAt: nowIso, // so it appears in this month (when user set Playing)
        lastPlayedAt: updated.lastPlayedAt,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && isCompleted && !hasJourney) {
      const meta = updated.cachedMeta ?? existing.cachedMeta;
      // Prefer the earliest evidence of play we can find so the journey row
      // has an accurate `firstPlayedAt`, in this order:
      //   1. first recorded play session (executable actually ran)
      //   2. first transition into Playing / Playing Now (manual status flip)
      //   3. lastPlayedAt (best-effort from a data source like Steam)
      //   4. addedAt (definitely earlier than nowIso)
      const firstSession = sessionStore.getFirstSessionStart(gameId);
      const firstPlayingTs = statusHistoryStore.getFirstPlayingTransition(gameId);
      const firstPlayedAt =
        firstSession > 0
          ? new Date(firstSession).toISOString()
          : firstPlayingTs !== null
            ? new Date(firstPlayingTs).toISOString()
            : (updated.lastPlayedAt ?? addedAtIso ?? nowIso);
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

    const isSourceCompleted = newStatus === 'Completed';
    const targets = isSourceCompleted
      ? COMPLETED_OVERWRITE_TARGETS
      : PLAYING_OVERWRITE_TARGETS;

    const nowIso = new Date().toISOString();
    let changed = 0;

    // Iterate the raw Map (not getAllEntries) — this is a write path,
    // no need to sort, and we're skipping the source entry anyway.
    for (const sibling of this.entries.values()) {
      if (sibling.gameId === sourceEntry.gameId) continue;
      const siblingTitle = sibling.cachedMeta?.title?.trim();
      if (!siblingTitle) continue;
      if (normalizeTitle(siblingTitle) !== sourceKey) continue;
      if (NEVER_OVERWRITE_STATUSES.has(sibling.status) && !isSourceCompleted) continue;
      if (!targets.has(sibling.status)) continue;
      if (sibling.status === newStatus) continue;

      const mutated: LibraryGameEntry = {
        ...sibling,
        status: newStatus,
        autoTransitionedAt: nowIso,
        crossStoreSyncedFrom: sourceEntry.gameId,
        updatedAt: new Date(),
      };
      this.entries.set(sibling.gameId, mutated);
      // Record the transition so status history reflects the sync.
      const title = sibling.cachedMeta?.title?.trim() || `Game ${sibling.gameId}`;
      try {
        statusHistoryStore.record(sibling.gameId, title, sibling.status, newStatus);
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
      changed++;
    }

    if (changed > 0) {
      this.invalidateSortedCache();
      this.scheduleSave();
      this.notifyListeners();
    }
    return changed;
  }

  /**
   * v1.0.45 — one-shot startup sweep to reconcile pre-existing cross-store
   * status mismatches for users upgrading from v1.0.44. Idempotent; safe to
   * call more than once but internally guarded to only actually sweep once
   * per process. For each normalized title with at least one Playing /
   * Playing Now / Completed entry, propagates the strongest observed status
   * onto matching siblings using the same rules as `propagateStatusByTitle`.
   */
  syncCrossStoreStatusesOnce(): void {
    if (this._crossStoreSweepDone) return;
    this._crossStoreSweepDone = true;

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

    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue;
      let best: LibraryGameEntry | null = null;
      for (const e of bucket) {
        if (!PROPAGATABLE_STATUSES.has(e.status)) continue;
        if (!best || rank(e.status) > rank(best.status)) best = e;
      }
      if (!best) continue;
      this.propagateStatusByTitle(best, best.status);
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
    if (!this._crossStoreSweepDone) {
      this.syncCrossStoreStatusesOnce();
    }
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
    existing.hoursPlayed = effectiveHours;
    if (lastPlayedAt !== undefined) existing.lastPlayedAt = lastPlayedAt;
    existing.updatedAt = new Date();
    // Live ticks (~15s) only need in-memory hours for cards. Persisting and
    // resorting on every tick storms localStorage + sorted-cache while gaming;
    // session-end (lastPlayedAt set) still persists.
    if (lastPlayedAt !== undefined) {
      this.invalidateSortedCache();
      this.scheduleSave();
    }
    // Fire the hours-only channel — 15s session ticks must NOT invalidate
    // the games grid memo, Oracle library-signature, or other top-level
    // consumers that only care about status/collection changes.
    this.notifyHoursListeners();

    journeyStore.syncProgress(gameId, { hoursPlayed: effectiveHours, lastPlayedAt });
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
