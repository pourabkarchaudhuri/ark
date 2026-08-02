import { GameSession, migrateGameId } from '@/types/game';

const STORAGE_KEY = 'ark-session-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

/**
 * One-shot marker stamped in localStorage after the LevelDB migration
 * copies the ark-session-history payload across. Presence => never migrate
 * again. The original STORAGE_KEY stays intact for one release as rollback.
 */
const MIGRATION_MARKER_KEY = 'ark-session-history-migrated-v1';

/** LevelDB namespace this store owns. Keys within it are `session.id`. */
const LEVEL_NAMESPACE = 'session';

interface StoredSessionData {
  version: number;
  entries: GameSession[];
  lastUpdated: string;
}

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _sessionBeforeUnloadInstalled = false;

/**
 * Session Store — persists a chronological log of play sessions.
 *
 * Each session records when a game's executable was running, how long the
 * user actively played (minus idle time), and the idle time detected.
 *
 * This data enriches the Journey view with play-time analytics.
 *
 * v1.0.61: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface (see `electron/ipc/store-handlers.ts`). The
 * public sync API is unchanged — an in-memory cache is hydrated on init and
 * every read still returns synchronously. When `window.store` is unavailable
 * (unit tests, jsdom, pre-preload boot window) the store transparently
 * falls back to the previous localStorage path.
 */
export class SessionStore {
  private entries: GameSession[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  /**
   * Set of session IDs currently persisted in LevelDB. On every debounced
   * batch we diff `entries` against this to emit `del` ops for anything
   * that disappeared (e.g. via a future single-session delete or a
   * post-import prune). Simplification for v1.0.61: we still batch-put
   * ALL current sessions every debounce cycle (delta-writes come later).
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
    if (typeof window !== 'undefined' && !_sessionBeforeUnloadInstalled) {
      _sessionBeforeUnloadInstalled = true;
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
   *   1. Load rows from namespace `session`. If any exist, hydrate.
   *   2. If empty AND `localStorage[STORAGE_KEY]` exists AND no migration
   *      marker => copy the JSON payload into LevelDB, stamp the marker.
   *   3. On any hard failure fall back to the localStorage path so the
   *      user never loses their session log.
   */
  private async initializeFromLevelDB(): Promise<void> {
    try {
      const res = await window.store!.getAll<GameSession>(LEVEL_NAMESPACE);
      if (res.error) {
        console.error('[SessionStore] getAll(session) IPC error:', res.error);
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
      console.error('[SessionStore] Failed to init from LevelDB, falling back:', err);
      this.initializeFromLocalStorage();
    }
  }

  /**
   * One-shot copy of `localStorage[STORAGE_KEY]` -> LevelDB namespace `session`.
   *
   * Runs only when:
   *   - migration marker is absent (never migrated before), AND
   *   - LevelDB session namespace is empty (caller already checked), AND
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

      const parsed = JSON.parse(raw) as StoredSessionData;
      if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      const migrated = parsed.entries.map((entry) => ({
        ...entry,
        gameId: migrateGameId(entry as any),
      }));

      const ops = migrated
        .filter((e) => typeof e.id === 'string' && e.id.length > 0)
        .map((e) => ({
          type: 'put' as const,
          namespace: LEVEL_NAMESPACE,
          key: e.id,
          value: e,
        }));

      if (ops.length === 0) {
        localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        return false;
      }

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[SessionStore] Migration batch failed:', res.error);
        return false;
      }

      // IMPORTANT: keep the original STORAGE_KEY intact for one release as
      // rollback insurance. Only stamp the marker.
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      this.hydrateFromRows(migrated);
      console.log(
        `[SessionStore] Migrated ${migrated.length} sessions from localStorage -> LevelDB`,
      );
      return true;
    } catch (err) {
      console.error('[SessionStore] Migration failed:', err);
      return false;
    }
  }

  /** Legacy path — used both as fallback and in test/jsdom environments. */
  private initializeFromLocalStorage(): void {
    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSessionData;
        if (Array.isArray(parsed.entries)) {
          this.entries = parsed.entries.map((entry) => ({
            ...entry,
            gameId: migrateGameId(entry as any),
          }));
          if (parsed.version < STORAGE_VERSION) {
            needsResave = true;
          }
        }
      }
    } catch (error) {
      console.error('[SessionStore] Failed to load:', error);
    }

    if (needsResave && this.entries.length > 0) {
      this.saveNowLocalStorage();
      console.log('[SessionStore] Migrated entries to v2 (string gameId)');
    }
  }

  /**
   * Populate the in-memory cache from a list of GameSession rows (from
   * either LevelDB or the localStorage migration payload) and notify.
   * Sort chronologically for parity with the legacy stored order.
   */
  private hydrateFromRows(rows: GameSession[]): void {
    this.entries = rows.map((r) => ({ ...r, gameId: migrateGameId(r as any) }));
    this.entries.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
    this._knownKeys = new Set(this.entries.map((e) => e.id));
    this.notifyListeners();
  }

  /**
   * Debounced save — coalesces bursts of session writes (e.g. rapid session
   * records during import) into a single persistence hit ~300ms later.
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

  private saveNow(): void {
    if (this._useLevelDB) {
      // Fire-and-forget; errors are logged. Preserves the current
      // synchronous callsite contract used by importData().
      void this.saveNowLevelDB();
      return;
    }
    this.saveNowLocalStorage();
  }

  private saveNowLocalStorage(): void {
    try {
      const data: StoredSessionData = {
        version: STORAGE_VERSION,
        entries: this.entries,
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('[SessionStore] Failed to save:', error);
    }
  }

  private async saveNowLevelDB(): Promise<void> {
    try {
      const currentIds = new Set<string>();
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];

      for (const e of this.entries) {
        if (!e.id) continue;
        currentIds.add(e.id);
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: e.id, value: e });
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
        console.error('[SessionStore] batch save failed:', res.error);
        return;
      }
      this._knownKeys = currentIds;
    } catch (err) {
      console.error('[SessionStore] Failed to save (LevelDB):', err);
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
   * Record a completed play session.
   */
  record(session: GameSession): void {
    this.entries.push(session);
    this.save();
    this.notifyListeners();
  }

  // ------ Queries ------

  /**
   * Get all sessions for a specific game, ordered chronologically.
   */
  getForGame(gameId: string): GameSession[] {
    return this.entries.filter((e) => e.gameId === gameId);
  }

  /**
   * Get all sessions, ordered chronologically (oldest first).
   */
  getAll(): GameSession[] {
    return [...this.entries];
  }

  /**
   * Calculate total active hours played for a game from recorded sessions.
   */
  getTotalHours(gameId: string): number {
    const sessions = this.getForGame(gameId);
    const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
    return Math.round(totalMinutes / 60 * 100) / 100;
  }

  /**
   * Get the number of sessions for a game.
   */
  getSessionCount(gameId: string): number {
    return this.entries.filter((e) => e.gameId === gameId).length;
  }

  /**
   * Get the earliest session start time (ms since epoch) for a game.
   * Returns 0 if no sessions have been recorded for the game.
   *
   * Used by library-store / journey-store / custom-game-store to prime the
   * journey row's `firstPlayedAt` — the first time we actually detected the
   * game running is more accurate than fall-back timestamps like
   * `lastPlayedAt` or `addedAt`.
   */
  getFirstSessionStart(gameId: string): number {
    let earliest = 0;
    for (const s of this.entries) {
      if (s.gameId !== gameId) continue;
      const ts = new Date(s.startTime).getTime();
      if (!Number.isFinite(ts)) continue;
      if (earliest === 0 || ts < earliest) earliest = ts;
    }
    return earliest;
  }

  // ------ Import / Export ------

  exportData(): GameSession[] {
    return [...this.entries];
  }

  /**
   * Import session entries (merges, skipping exact duplicates).
   * Duplicates are detected by matching session id.
   */
  importData(entries: GameSession[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;

    const existingIds = new Set(this.entries.map((e) => e.id));

    for (const incoming of entries) {
      if (!incoming.id || !incoming.gameId) {
        skipped++;
        continue;
      }

      if (existingIds.has(incoming.id)) {
        skipped++;
      } else {
        this.entries.push(incoming);
        existingIds.add(incoming.id);
        added++;
      }
    }

    if (added > 0) {
      // Sort chronologically after merge
      this.entries.sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
      this.saveNow(); // direct save for bulk import
      this.notifyListeners();
    }

    return { added, skipped };
  }

  // ------ Analytics ------

  /**
   * Get a heatmap of daily play activity.
   * Returns a map of YYYY-MM-DD → total minutes played for the last N days.
   */
  getSessionHeatmap(days = 365): Map<string, number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    const cutoffMs = cutoff.getTime();

    const map = new Map<string, number>();
    for (const s of this.entries) {
      const ts = new Date(s.startTime).getTime();
      if (ts < cutoffMs) continue;
      const d = new Date(s.startTime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      map.set(key, (map.get(key) || 0) + s.durationMinutes);
    }
    return map;
  }

  /**
   * Current play streak — consecutive calendar days (backwards from today)
   * with at least one session.
   */
  getCurrentStreak(): number {
    const days = this.getActiveDaySet();
    if (days.size === 0) return 0;

    const now = new Date();
    const todayKey = this.dayKey(now.getTime());

    // Step backwards one calendar day at a time using Date to avoid DST issues
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (!days.has(todayKey)) {
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(this.dayKey(cursor.getTime()))) return 0;
    }

    let streak = 0;
    while (days.has(this.dayKey(cursor.getTime()))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  /**
   * Longest play streak in the entire session history.
   */
  getLongestStreak(): number {
    const days = this.getActiveDaySet();
    if (days.size === 0) return 0;

    const sorted = Array.from(days).sort();

    let streak = 1;
    let max = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = this.parseDay(sorted[i - 1]);
      const curr = this.parseDay(sorted[i]);
      const diffDays = Math.round((curr - prev) / 86400000);
      if (diffDays === 1) {
        streak++;
        if (streak > max) max = streak;
      } else if (diffDays > 1) {
        streak = 1;
      }
    }
    return max;
  }

  /**
   * Number of unique days with at least one session in the current calendar year.
   */
  getActiveDaysThisYear(): number {
    const year = new Date().getFullYear();
    const seen = new Set<string>();
    for (const s of this.entries) {
      const d = new Date(s.startTime);
      if (d.getFullYear() !== year) continue;
      seen.add(this.dayKey(d.getTime()));
    }
    return seen.size;
  }

  private getActiveDaySet(): Set<string> {
    const days = new Set<string>();
    for (const s of this.entries) {
      const d = new Date(s.startTime);
      days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return days;
  }

  private dayKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Parse a YYYY-MM-DD key into a UTC noon timestamp (DST-safe for day arithmetic). */
  private parseDay(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  }

  /** Clear all session data (mainly for testing / reset). */
  clear() {
    this.entries = [];
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
          if (res.error) console.error('[SessionStore] clearNamespace failed:', res.error);
        } catch (err) {
          console.error('[SessionStore] Failed to clear LevelDB namespace:', err);
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
export const sessionStore = new SessionStore();
