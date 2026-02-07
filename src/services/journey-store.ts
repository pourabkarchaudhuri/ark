import { JourneyEntry, GameStatus } from '@/types/game';

const STORAGE_KEY = 'ark-journey-history';
const STORAGE_VERSION = 1;

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
  private entries: Map<number, JourneyEntry> = new Map(); // keyed by gameId
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  private initialize() {
    if (this.isInitialized) return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredJourneyData;
        if (parsed.version === STORAGE_VERSION && Array.isArray(parsed.entries)) {
          for (const entry of parsed.entries) {
            if (entry.gameId) {
              this.entries.set(entry.gameId, entry);
            }
          }
        }
      }
    } catch (error) {
      console.error('[JourneyStore] Failed to load:', error);
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
  markRemoved(gameId: number) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    existing.removedAt = new Date().toISOString();
    this.save();
    this.notifyListeners();
  }

  /**
   * Sync status / hours / rating for a game already in the journey.
   */
  syncProgress(gameId: number, fields: { status?: GameStatus; hoursPlayed?: number; rating?: number }) {
    const existing = this.entries.get(gameId);
    if (!existing) return;

    if (fields.status !== undefined) existing.status = fields.status;
    if (fields.hoursPlayed !== undefined) existing.hoursPlayed = fields.hoursPlayed;
    if (fields.rating !== undefined) existing.rating = fields.rating;

    this.save();
    this.notifyListeners();
  }

  // ------ Queries ------

  getEntry(gameId: number): JourneyEntry | undefined {
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

  has(gameId: number): boolean {
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
      if (!incoming.gameId) { skipped++; continue; }

      const existing = this.entries.get(incoming.gameId);

      if (!existing) {
        this.entries.set(incoming.gameId, incoming);
        added++;
      } else {
        // Keep earliest addedAt
        const keepAddedAt =
          new Date(existing.addedAt).getTime() <= new Date(incoming.addedAt).getTime()
            ? existing.addedAt
            : incoming.addedAt;

        // Keep removedAt only if both have it; otherwise prefer the one that doesn't
        const removedAt = !incoming.removedAt ? undefined : (!existing.removedAt ? undefined : incoming.removedAt);

        const merged: JourneyEntry = {
          ...existing,
          ...incoming,
          addedAt: keepAddedAt,
          removedAt,
        };

        if (JSON.stringify(existing) !== JSON.stringify(merged)) {
          this.entries.set(incoming.gameId, merged);
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

  /** Clear all journey data (mainly for testing / reset). */
  clear() {
    this.entries.clear();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const journeyStore = new JourneyStore();
