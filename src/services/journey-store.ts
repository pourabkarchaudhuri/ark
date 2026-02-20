import { JourneyEntry, GameStatus, migrateGameId } from '@/types/game';

const STORAGE_KEY = 'ark-journey-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

interface StoredJourneyData {
  version: number;
  entries: JourneyEntry[];
  lastUpdated: string;
}

/**
 * Journey Store — persists a historical record of every game the user adds to their library.
 * Unlike the library store, entries here are NEVER deleted when a game is removed.
 * This powers the Journey timeline view.
 */
class JourneyStore {
  private entries: Map<string, JourneyEntry> = new Map(); // keyed by universal gameId string
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortedCache: JourneyEntry[] | null = null;

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
      this.save();
    }, 300);
  }

  private flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.save();
    }
  }

  private invalidateSortedCache() {
    this._sortedCache = null;
  }

  private initialize() {
    if (this.isInitialized) return;

    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredJourneyData;
        if (Array.isArray(parsed.entries)) {
          for (const entry of parsed.entries) {
            const id = migrateGameId(entry as any);
            if (id) {
              this.entries.set(id, { ...entry, gameId: id });
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
      this.save();
      console.log(`[JourneyStore] Migrated ${this.entries.size} entries to v2 (string gameId)`);
    } else if (needsResave && this.entries.size === 0) {
      console.warn('[JourneyStore] Migration produced 0 entries — skipping save to prevent data loss');
    }

    this.isInitialized = true;
  }

  private save() {
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
    const addedAt = existing?.addedAt ?? entry.addedAt ?? new Date().toISOString();

    this.entries.set(entry.gameId, {
      ...existing,  // preserve existing fields (firstPlayedAt, lastPlayedAt, etc.)
      ...entry,     // caller-provided fields override
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
      const addedAt = existing?.addedAt ?? entry.addedAt ?? new Date().toISOString();
      this.entries.set(entry.gameId, {
        ...existing,
        ...entry,
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
    if (fields.firstPlayedAt !== undefined) existing.firstPlayedAt = fields.firstPlayedAt;
    if (fields.lastPlayedAt !== undefined) existing.lastPlayedAt = fields.lastPlayedAt;

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
      const migratedIncoming = { ...incoming, gameId: migratedId };

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
    const noTimingStatuses: GameStatus[] = ['Want to Play'];
    let backfilled = 0;
    for (const entry of this.entries.values()) {
      if (!entry.firstPlayedAt && !entry.lastPlayedAt && !noTimingStatuses.includes(entry.status)) {
        entry.firstPlayedAt = entry.addedAt;
        backfilled++;
      }
    }
    if (added > 0 || updated > 0 || backfilled > 0) {
      this.invalidateSortedCache();
      this.save(); // direct save for bulk import
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
    this.flushSave();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const journeyStore = new JourneyStore();
