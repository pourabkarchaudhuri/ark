import {
  CustomGameEntry,
  CreateCustomGameEntry,
  UpdateCustomGameEntry,
  Game,
} from '@/types/game';
import type { StatusChangeSource } from '@/types/game';
import { journeyStore } from '@/services/journey-store';
import { sessionStore } from '@/services/session-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { SerialWriteQueue, readWithRetry, reportStorageReadOnly } from '@/services/storage-health';
import { firstPlayEvidenceIso, resolveFirstPlayedAt } from '@/services/first-played';

const STORAGE_KEY = 'ark-custom-games';
const STORAGE_VERSION = 2; // v2: id migrated from negative number to "custom-N" string

/**
 * One-shot marker stamped in localStorage after LevelDB migration copies
 * the ark-custom-games payload across. Presence => never migrate again.
 * Original STORAGE_KEY stays intact one release for rollback.
 */
const MIGRATION_MARKER_KEY = 'ark-custom-games-migrated-v1';

/**
 * LevelDB namespace this store owns. Keys are prefixed so the nextCounter
 * meta row co-lives with entry rows without namespace pollution:
 *   `e:{id}`   → CustomGameEntry
 *   `m:nextCounter` → { nextCounter: number }
 */
const LEVEL_NAMESPACE = 'custom-game';
const KEY_PREFIX_ENTRY = 'e:';
const KEY_META_NEXT_COUNTER = 'm:nextCounter';

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _customGameBeforeUnloadInstalled = false;

/**
 * Compute the most accurate `firstPlayedAt` for a game: the earliest of the first recorded play
 * session and the first Playing/Playing Now transition, then the caller-supplied fallback.
 */
const computeFirstPlayedAt = resolveFirstPlayedAt;

interface StoredData {
  version: number;
  entries: CustomGameEntry[];
  nextCounter: number; // Counter for generating custom IDs
  lastUpdated: string;
}

/**
 * Custom Game Store - Manages user-created games not from Steam/Epic
 * Uses "custom-N" string IDs to distinguish from store games
 */
export class CustomGameStore {
  private entries: Map<string, CustomGameEntry> = new Map(); // keyed by "custom-N"
  private nextCounter: number = 1; // Start from 1, increment for each new game
  private listeners: Set<() => void> = new Set();
  /**
   * Hours-only channel (mirrors LibraryStore.subscribeHours). Session-driven
   * hours ticks fire ONLY this channel, so they no longer bump `_version`
   * (Dashboard grid recompute), re-send the tracked-games IPC, or rebuild the
   * Oracle signature every 15s. General mutations fire both (superset).
   */
  private hoursListeners: Set<() => void> = new Set();
  /** Monotonic version counter — see LibraryStore.getVersion() for rationale. */
  private _version = 0;
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Gate flag captured once at construction — LevelDB path vs. legacy. */
  private readonly _useLevelDB: boolean;

  /**
   * id -> exact entry object last written to LevelDB. Every mutation path
   * replaces the entry object, so saves diff by identity and write only
   * changed rows (+ deletes for removed ids) instead of every entry per tick.
   */
  private _persisted: Map<string, CustomGameEntry> = new Map();

  /** Serializes every LevelDB write (saves + clearNamespace). */
  private readonly _writeQueue = new SerialWriteQueue('CustomGameStore');

  /** LevelDB unreadable this session → no writes at all (see storage-health). */
  private _readOnly = false;

  /** Last persisted nextCounter; skip meta-write if unchanged. */
  private _lastPersistedCounter: number = 1;

  /** Resolves when async LevelDB hydration finishes. */
  readonly ready: Promise<void>;

  constructor() {
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
    this.ready = this.initializeAsync();
    if (typeof window !== 'undefined' && !_customGameBeforeUnloadInstalled) {
      _customGameBeforeUnloadInstalled = true;
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
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      if (this._useLevelDB && !this._readOnly) {
        // Unloading — can't wait behind an in-flight batch; send the delta now.
        void this.saveNowLevelDB();
        return;
      }
      this.saveNow();
    }
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
    try {
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];
      const written: Array<[string, CustomGameEntry]> = [];
      const deleted: string[] = [];

      for (const [id, entry] of this.entries) {
        if (!id) continue;
        if (this._persisted.get(id) === entry) continue; // unchanged
        ops.push({
          type: 'put',
          namespace: LEVEL_NAMESPACE,
          key: `${KEY_PREFIX_ENTRY}${id}`,
          value: entry,
        });
        written.push([id, entry]);
      }

      for (const oldKey of this._persisted.keys()) {
        if (!this.entries.has(oldKey)) {
          ops.push({
            type: 'del',
            namespace: LEVEL_NAMESPACE,
            key: `${KEY_PREFIX_ENTRY}${oldKey}`,
          });
          deleted.push(oldKey);
        }
      }

      const counter = this.nextCounter;
      if (counter !== this._lastPersistedCounter) {
        ops.push({
          type: 'put',
          namespace: LEVEL_NAMESPACE,
          key: KEY_META_NEXT_COUNTER,
          value: { nextCounter: counter },
        });
      }

      if (ops.length === 0) return;

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[CustomGameStore] batch save failed:', res.error);
        return;
      }
      for (const [id, entry] of written) this._persisted.set(id, entry);
      for (const id of deleted) this._persisted.delete(id);
      this._lastPersistedCounter = counter;
    } catch (err) {
      console.error('[CustomGameStore] Failed to save (LevelDB):', err);
    }
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
    this.backfillJourneyEntries();
  }

  private ingestEntries(entries: CustomGameEntry[]): number {
    let count = 0;
    entries.forEach((entry) => {
      const id = this.migrateId(entry.id);
      const addedAt = CustomGameStore.toValidDate(entry.addedAt, new Date());
      const updatedAt = CustomGameStore.toValidDate(entry.updatedAt, addedAt);
      this.entries.set(id, { ...entry, id, addedAt, updatedAt });
      count++;
    });
    return count;
  }

  private recomputeCounterFromEntries(): number {
    let maxCounter = 0;
    for (const key of this.entries.keys()) {
      const num = parseInt(key.replace('custom-', ''), 10);
      if (!isNaN(num) && num > maxCounter) maxCounter = num;
    }
    return maxCounter + 1;
  }

  private async initializeFromLevelDB(): Promise<void> {
    try {
      const outcome = await readWithRetry('CustomGameStore', () =>
        window.store!.getAll<any>(LEVEL_NAMESPACE),
      );
      if (!outcome.ok) {
        this.enterReadOnly(outcome.error);
        return;
      }
      const rows = outcome.value.rows ?? [];
      const entryRows: CustomGameEntry[] = [];
      let storedCounter: number | null = null;
      for (const r of rows) {
        if (r.key.startsWith(KEY_PREFIX_ENTRY)) {
          entryRows.push(r.value as CustomGameEntry);
        } else if (r.key === KEY_META_NEXT_COUNTER) {
          const c = (r.value as any)?.nextCounter;
          if (typeof c === 'number' && Number.isFinite(c) && c >= 1) storedCounter = c;
        }
      }
      if (entryRows.length > 0) {
        this.ingestEntries(entryRows);
        for (const r of entryRows) {
          const id = this.migrateId(r.id);
          const entry = this.entries.get(id);
          // Rows whose id needed migration are rewritten on the next save.
          if (entry && id === r.id) this._persisted.set(id, entry);
        }
        this.nextCounter = storedCounter ?? this.recomputeCounterFromEntries();
        this._lastPersistedCounter = this.nextCounter;
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
   * LevelDB unreadable after retries. Never fall back to the legacy
   * localStorage snapshot once migrated (frozen at v1.0.61) — go read-only so
   * nothing stale overwrites LevelDB. Pre-migration users see their legacy
   * custom games, read-only as well.
   */
  private enterReadOnly(error: string): void {
    this._readOnly = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    let migrated = true;
    try { migrated = localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes'; } catch { /* assume migrated */ }
    if (!migrated) {
      const stored = this.loadFromStorage();
      if (stored) {
        this.ingestEntries(stored.entries);
        this.nextCounter = Math.max(this.nextCounter, this.recomputeCounterFromEntries());
      }
    }
    reportStorageReadOnly('custom-games', error);
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

      const count = this.ingestEntries(stored.entries);
      if (count === 0) {
        console.warn('[CustomGameStore] Migration produced 0 entries — leaving marker unset');
        return false;
      }

      // Preserve the stored counter if v2; otherwise recompute (matches
      // legacy initialize() semantics for v1 payloads).
      this.nextCounter = stored.version >= STORAGE_VERSION
        ? stored.nextCounter
        : this.recomputeCounterFromEntries();

      const ops: Array<{ type: 'put'; namespace: string; key: string; value: unknown }> = [];
      for (const [id, entry] of this.entries) {
        ops.push({
          type: 'put',
          namespace: LEVEL_NAMESPACE,
          key: `${KEY_PREFIX_ENTRY}${id}`,
          value: entry,
        });
      }
      ops.push({
        type: 'put',
        namespace: LEVEL_NAMESPACE,
        key: KEY_META_NEXT_COUNTER,
        value: { nextCounter: this.nextCounter },
      });

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[CustomGameStore] Migration batch failed:', res.error);
        this.entries.clear();
        this.nextCounter = 1;
        return false;
      }

      for (const [id, entry] of this.entries) this._persisted.set(id, entry);
      this._lastPersistedCounter = this.nextCounter;
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      console.log(
        `[CustomGameStore] Migrated ${this.entries.size} entries from localStorage -> LevelDB`,
      );
      this.notifyListeners();
      return true;
    } catch (err) {
      console.error('[CustomGameStore] Migration failed:', err);
      return false;
    }
  }

  private initializeFromLocalStorage(): void {
    let needsResave = false;
    try {
      const stored = this.loadFromStorage();
      if (stored) {
        this.ingestEntries(stored.entries);
        if (stored.version < STORAGE_VERSION) {
          this.nextCounter = this.recomputeCounterFromEntries();
          needsResave = true;
        } else {
          this.nextCounter = stored.nextCounter;
        }
      }
    } catch (error) {
      console.error('Failed to load custom games data:', error);
    }

    if (needsResave) {
      this.saveToStorage();
      console.log('[CustomGameStore] Migrated entries to v2 (string id)');
    }
  }

  private backfillJourneyEntries(): void {
    const arkStatuses: Array<'Playing' | 'Playing Now' | 'Completed'> = ['Playing', 'Playing Now', 'Completed'];
    for (const entry of this.entries.values()) {
      if (!arkStatuses.includes(entry.status as any) || journeyStore.has(entry.id)) continue;
      const addedAtIso = entry.addedAt instanceof Date ? entry.addedAt.toISOString() : String(entry.addedAt);
      const fallback = entry.lastPlayedAt ?? addedAtIso;
      const firstPlayedAt = computeFirstPlayedAt(entry.id, fallback);
      journeyStore.record({
        gameId: entry.id,
        title: entry.title,
        coverUrl: undefined,
        genre: [],
        platform: entry.platform,
        releaseDate: undefined,
        status: entry.status,
        hoursPlayed: entry.hoursPlayed ?? 0,
        rating: entry.rating ?? 0,
        firstPlayedAt,
        lastPlayedAt: entry.lastPlayedAt ?? (entry.status === 'Completed' ? fallback : undefined),
        addedAt: addedAtIso,
      });
    }
  }

  /** Migrate legacy negative numeric ID to "custom-N" string format */
  private migrateId(id: string | number): string {
    if (typeof id === 'string') {
      return id.startsWith('custom-') ? id : `custom-${id}`;
    }
    // Legacy negative numeric IDs: -1 → "custom-1", -2 → "custom-2"
    return `custom-${Math.abs(id)}`;
  }

  private loadFromStorage(): StoredData | null {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;

      const parsed = JSON.parse(data);
      // Accept v1 or v2 data (v1 will be migrated in initialize())
      if (!parsed.version || parsed.version < 1) {
        console.log('Custom games storage version too old, resetting data');
        return null;
      }

      return {
        version: parsed.version,
        entries: parsed.entries || [],
        nextCounter: parsed.nextCounter ?? Math.abs(parsed.nextId ?? -1),
        lastUpdated: parsed.lastUpdated,
      };
    } catch (error) {
      console.error('Failed to parse custom games data:', error);
      return null;
    }
  }

  private saveToStorage() {
    try {
      const data: StoredData = {
        version: STORAGE_VERSION,
        entries: Array.from(this.entries.values()),
        nextCounter: this.nextCounter,
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save custom games to storage:', error);
    }
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this._version++;
    this.listeners.forEach((listener) => listener());
    this.hoursListeners.forEach((listener) => listener());
  }

  /**
   * Subscribe to hours changes — fires on session-tracker ticks AND on every
   * general mutation (superset of `subscribe`).
   */
  subscribeHours(listener: () => void): () => void {
    this.hoursListeners.add(listener);
    return () => this.hoursListeners.delete(listener);
  }

  /** Fire ONLY the hours channel — used by updateHoursFromSessions. */
  private notifyHoursListeners() {
    this.hoursListeners.forEach((listener) => listener());
  }

  /** Monotonic counter — bumps on every mutation. */
  getVersion(): number {
    return this._version;
  }

  // Add a custom game
  addGame(input: CreateCustomGameEntry): CustomGameEntry {
    const now = new Date();
    const id = `custom-${this.nextCounter++}`;
    const hoursPlayed = input.hoursPlayed ?? 0;

    const entry: CustomGameEntry = {
      id,
      title: input.title,
      platform: input.platform,
      status: input.status,
      executablePath: input.executablePath,
      addedAt: now,
      updatedAt: now,
    };
    if (hoursPlayed > 0) {
      entry.hoursPlayed = hoursPlayed;
      const sessionTotal = sessionStore.getTotalHours(id);
      entry.hoursBaseline = Math.max(0, hoursPlayed - sessionTotal);
    }

    this.entries.set(id, entry);
    this.scheduleSave();
    this.notifyListeners();

    // Status history, like library games (custom games had none before v1.0.87).
    statusHistoryStore.record(id, entry.title, null, entry.status, { source: 'user' });

    // Create journey entry when status is Playing, Playing Now, or Completed (so they appear in Your Ark / Logs)
    const showInArk = entry.status === 'Playing' || entry.status === 'Playing Now' || entry.status === 'Completed';
    if (showInArk) {
      const nowIso = new Date().toISOString();
      const addedAtIso = entry.addedAt instanceof Date ? entry.addedAt.toISOString() : String(entry.addedAt);
      const fallback = entry.status === 'Completed' ? (entry.lastPlayedAt ?? addedAtIso ?? nowIso) : nowIso;
      // Prefer real play evidence over `nowIso` — even brand-new custom games
      // may already have session history if the user re-imported or re-created them.
      const firstPlayedAt = computeFirstPlayedAt(id, fallback);
      journeyStore.record({
        gameId: id,
        title: entry.title,
        coverUrl: undefined,
        genre: [],
        platform: entry.platform,
        releaseDate: undefined,
        status: entry.status,
        hoursPlayed: entry.hoursPlayed ?? 0,
        rating: 0,
        firstPlayedAt,
        lastPlayedAt: entry.lastPlayedAt ?? (entry.status === 'Completed' ? fallback : undefined),
        addedAt: addedAtIso,
      });
    }

    return entry;
  }

  // Remove a custom game
  removeGame(id: string): boolean {
    if (!this.isCustomGame(id)) return false;
    
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.scheduleSave();
      this.notifyListeners();

      // Mark as removed in journey store (preserves history)
      journeyStore.markRemoved(id);
    }
    return deleted;
  }

  // Update a custom game
  /** @param opts.source who made a status change (recorded on the status-history row; default user). */
  updateGame(
    id: string,
    input: UpdateCustomGameEntry,
    opts: { source?: StatusChangeSource } = {},
  ): CustomGameEntry | undefined {
    if (!this.isCustomGame(id)) return undefined;

    const existing = this.entries.get(id);
    if (!existing) return undefined;

    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const updatedStatus = input.status ?? existing.status;
    const isNowPlaying = updatedStatus === 'Playing' || updatedStatus === 'Playing Now';

    const updated: CustomGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(), // Always app-managed (last save time)
    };
    if (input.addedAt !== undefined) {
      updated.addedAt = CustomGameStore.toValidDate(input.addedAt, existing.addedAt);
    }

    // When user edits hours, set baseline so session updates add on top instead of overwriting
    if (input.hoursPlayed !== undefined) {
      const sessionTotal = sessionStore.getTotalHours(id);
      updated.hoursBaseline = Math.max(0, input.hoursPlayed - sessionTotal);
    }

    this.entries.set(id, updated);
    this.scheduleSave();
    this.notifyListeners();

    const hasJourney = journeyStore.has(id);
    const addedAtIso = (updated.addedAt instanceof Date ? updated.addedAt : new Date(updated.addedAt)).toISOString();
    const nowIso = new Date().toISOString();

    // Create journey entry when status first becomes Playing, Playing Now, or Completed (so they appear in Your Ark / Logs)
    if (statusChanged && isNowPlaying && !hasJourney) {
      journeyStore.record({
        gameId: id,
        title: updated.title,
        coverUrl: undefined,
        genre: [],
        platform: updated.platform,
        releaseDate: undefined,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        firstPlayedAt: computeFirstPlayedAt(id, nowIso),
        lastPlayedAt: updated.lastPlayedAt,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && updatedStatus === 'Completed' && !hasJourney) {
      const fallback = updated.lastPlayedAt ?? addedAtIso ?? nowIso;
      // Prefer real play evidence over lastPlayedAt/addedAt for the FIRST play date.
      const firstPlayedAt = computeFirstPlayedAt(id, fallback);
      journeyStore.record({
        gameId: id,
        title: updated.title,
        coverUrl: undefined,
        genre: [],
        platform: updated.platform,
        releaseDate: undefined,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        firstPlayedAt,
        lastPlayedAt: updated.lastPlayedAt ?? fallback,
        addedAt: addedAtIso,
      });
    } else {
      // Existing journey row: date the first move into Playing (syncProgress keeps the earliest).
      const row = journeyStore.getEntry(id);
      const firstPlayedAt = statusChanged && !row?.firstPlayedAt
        ? isNowPlaying
          ? computeFirstPlayedAt(id, nowIso)
          : updatedStatus === 'Completed'
            ? firstPlayEvidenceIso(id)
            : undefined
        : undefined;
      journeyStore.syncProgress(id, {
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        lastPlayedAt: updated.lastPlayedAt,
        ...(firstPlayedAt ? { firstPlayedAt } : {}),
      });
    }

    if (statusChanged) {
      statusHistoryStore.record(id, updated.title, existing.status, updated.status, { source: opts.source ?? 'user' });
    }

    if (journeyStore.has(id) && input.title !== undefined) {
      journeyStore.syncJourneyTitle(id, updated.title);
    }

    return updated;
  }

  /**
   * Update hours from session tracking (preserves baseline so user-entered hours are not lost).
   * Call this from the session tracker instead of updateGame(..., { hoursPlayed }) for session-driven updates.
   */
  updateHoursFromSessions(gameId: string, sessionTotalHours: number, lastPlayedAt?: string): void {
    if (!this.isCustomGame(gameId)) return;

    const existing = this.entries.get(gameId);
    if (!existing) return;

    const safeSessionHours = Number.isFinite(sessionTotalHours) ? Math.max(0, sessionTotalHours) : 0;

    // Guard against accidental reset-to-zero (see library-store for rationale):
    // this method only adds tracked session time and must never wipe a positive
    // total when sessions are cleared or a live update reports ~0 minutes.
    if (safeSessionHours === 0 && (existing.hoursBaseline ?? 0) === 0 && (existing.hoursPlayed ?? 0) > 0) {
      return;
    }

    const baseline = existing.hoursBaseline === undefined
      ? Math.max(0, (existing.hoursPlayed ?? 0) - safeSessionHours)
      : existing.hoursBaseline;
    const effectiveHours = baseline + safeSessionHours;
    const updated: CustomGameEntry = {
      ...existing,
      hoursBaseline: baseline,
      hoursPlayed: effectiveHours,
      ...(lastPlayedAt !== undefined ? { lastPlayedAt } : {}),
      updatedAt: new Date(),
    };
    this.entries.set(gameId, updated);
    this.scheduleSave();
    // Hours-only channel: a 15s session tick must not bump `_version`
    // (Dashboard grid memo), re-send setTrackedGames over IPC, or invalidate
    // the Oracle library signature (reco-store subscribes to the general
    // channel). Mirrors LibraryStore.updateHoursFromSessions.
    this.notifyHoursListeners();
    journeyStore.syncProgress(gameId, { hoursPlayed: effectiveHours, lastPlayedAt });
  }

  // Get a custom game by ID
  getGame(id: string): CustomGameEntry | undefined {
    return this.entries.get(id);
  }

  // Get all custom games
  getAllGames(): CustomGameEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
  }

  // Get count
  getCount(): number {
    return this.entries.size;
  }

  // Check if ID is a custom game
  isCustomGame(id: string | number): boolean {
    if (typeof id === 'string') return id.startsWith('custom-');
    return id < 0; // Legacy check
  }

  // Convert custom game to Game type for display
  toGame(entry: CustomGameEntry): Game {
    return {
      id: entry.id,
      store: 'custom',
      title: entry.title,
      developer: 'Custom Entry',
      publisher: '',
      genre: [],
      platform: entry.platform,
      metacriticScore: null,
      releaseDate: '',
      summary: '',
      coverUrl: undefined,
      screenshots: [],
      status: entry.status,
      priority: entry.priority || 'Medium',
      publicReviews: entry.publicReviews || '',
      recommendationSource: entry.recommendationSource || '',
      createdAt: entry.addedAt,
      updatedAt: entry.updatedAt,
      isInLibrary: true,
      isCustom: true,
      executablePath: entry.executablePath,
    };
  }

  // Get all custom games as Game type
  getAllAsGames(): Game[] {
    return this.getAllGames().map((entry) => this.toGame(entry));
  }

  // Clear all custom games
  clear() {
    this.entries.clear();
    this.nextCounter = 1;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._useLevelDB && !this._readOnly) {
      // Queued so any later save lands strictly after the namespace wipe.
      void this._writeQueue.run(async () => {
        const res = await window.store!.clearNamespace(LEVEL_NAMESPACE);
        if (res.error) {
          console.error('[CustomGameStore] clearNamespace failed:', res.error);
          return; // keep _persisted so the next save emits explicit deletes
        }
        this._persisted = new Map();
        this._lastPersistedCounter = 1;
      });
    }
    if (!this._readOnly) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(MIGRATION_MARKER_KEY);
    }
    this.notifyListeners();
  }
}

// Singleton instance
export const customGameStore = new CustomGameStore();
