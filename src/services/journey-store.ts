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

  constructor() {
    this.initialize();
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
      ...entry,
      addedAt,
      removedAt: undefined, // clear removedAt — the game is (back) in library
    });

    this.save();
    this.notifyListeners();
  }

  /**
   * Mark a game as removed (sets removedAt but does NOT delete).
   */
  markRemoved(gameId: string) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    existing.removedAt = new Date().toISOString();
    this.save();
    this.notifyListeners();
  }

  /**
   * Sync status / hours / rating for a game already in the journey.
   */
  syncProgress(gameId: string, fields: { status?: GameStatus; hoursPlayed?: number; rating?: number }) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    if (fields.status !== undefined) existing.status = fields.status;
    if (fields.hoursPlayed !== undefined) existing.hoursPlayed = fields.hoursPlayed;
    if (fields.rating !== undefined) existing.rating = fields.rating;

    this.save();
    this.notifyListeners();
  }

  // ------ Queries ------

  getEntry(gameId: string): JourneyEntry | undefined {
    return this.entries.get(gameId);
  }

  /**
   * Returns all journey entries sorted newest-first by addedAt.
   */
  getAllEntries(): JourneyEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
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

        if (JSON.stringify(existing) !== JSON.stringify(merged)) {
          this.entries.set(migratedId, merged);
          updated++;
        } else {
          skipped++;
        }
      }
    }

    if (added > 0 || updated > 0) {
      this.save();
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
      this.save();
      this.notifyListeners();
    }
    return existed;
  }

  /** Clear all journey data (mainly for testing / reset). */
  clear() {
    this.entries.clear();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const journeyStore = new JourneyStore();
