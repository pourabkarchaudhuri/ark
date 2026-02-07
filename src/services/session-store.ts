import { GameSession } from '@/types/game';

const STORAGE_KEY = 'ark-session-history';
const STORAGE_VERSION = 1;

interface StoredSessionData {
  version: number;
  entries: GameSession[];
  lastUpdated: string;
}

/**
 * Session Store — persists a chronological log of play sessions.
 *
 * Each session records when a game's executable was running, how long the
 * user actively played (minus idle time), and the idle time detected.
 *
 * This data powers the cost-per-hour analysis and enriches the Journey view.
 */
class SessionStore {
  private entries: GameSession[] = [];
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
        const parsed = JSON.parse(raw) as StoredSessionData;
        if (parsed.version === STORAGE_VERSION && Array.isArray(parsed.entries)) {
          this.entries = parsed.entries;
        }
      }
    } catch (error) {
      console.error('[SessionStore] Failed to load:', error);
    }

    this.isInitialized = true;
  }

  private save() {
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
  getForGame(gameId: number): GameSession[] {
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
  getTotalHours(gameId: number): number {
    const sessions = this.getForGame(gameId);
    const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
    return Math.round(totalMinutes / 60 * 100) / 100;
  }

  /**
   * Get the number of sessions for a game.
   */
  getSessionCount(gameId: number): number {
    return this.entries.filter((e) => e.gameId === gameId).length;
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
      this.save();
      this.notifyListeners();
    }

    return { added, skipped };
  }

  /** Clear all session data (mainly for testing / reset). */
  clear() {
    this.entries = [];
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const sessionStore = new SessionStore();
