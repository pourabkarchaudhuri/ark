import { GameSession, migrateGameId } from '@/types/game';

const STORAGE_KEY = 'ark-session-history';
const STORAGE_VERSION = 2; // v2: gameId migrated from number to string

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
 * This data enriches the Journey view with play-time analytics.
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

    let needsResave = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSessionData;
        if (Array.isArray(parsed.entries)) {
          this.entries = parsed.entries.map(entry => ({
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
      this.save();
      console.log('[SessionStore] Migrated entries to v2 (string gameId)');
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
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton
export const sessionStore = new SessionStore();
