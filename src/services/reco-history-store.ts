/**
 * Recommendation History Store — Dismissals + Conversion Tracking
 *
 * Tracks:
 *   1. Dismissed game IDs ("Not Interested") — filtered from future recommendations.
 *   2. Recommendation conversions: click → library add → play → rate.
 *      This data feeds back into the scoring pipeline to weight future recs.
 *
 * Persists to localStorage with a simple versioned key.
 * The dismissed list is passed to the worker so it can exclude those games.
 */

const LS_DISMISSED_KEY = 'ark-reco-dismissed-v1';
const LS_HISTORY_KEY = 'ark-reco-history-v1';

/** Tracks the lifecycle of a single recommendation. */
export interface RecoConversion {
  gameId: string;
  title: string;
  shelfType: string;
  /** When the user first clicked on this reco. */
  clickedAt: number;
  /** When the user added to library (if ever). */
  addedAt?: number;
  /** When the user first played (if ever). */
  playedAt?: number;
  /** The rating the user gave (if ever, 1-5). */
  rating?: number;
  /** Whether this reco was ultimately "successful". */
  converted: boolean;
}

class RecoHistoryStore {
  private dismissed: Set<string>;
  private history: Map<string, RecoConversion>;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.dismissed = new Set();
    this.history = new Map();
    this.load();
  }

  // ── Subscriptions ──

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  // ── Persistence ──

  private load() {
    try {
      const rawDismissed = localStorage.getItem(LS_DISMISSED_KEY);
      if (rawDismissed) {
        const arr: string[] = JSON.parse(rawDismissed);
        for (const id of arr) this.dismissed.add(id);
      }
    } catch { /* corrupted */ }

    try {
      const rawHistory = localStorage.getItem(LS_HISTORY_KEY);
      if (rawHistory) {
        const entries: RecoConversion[] = JSON.parse(rawHistory);
        for (const entry of entries) {
          this.history.set(entry.gameId, entry);
        }
      }
    } catch { /* corrupted */ }
  }

  private save() {
    try {
      localStorage.setItem(LS_DISMISSED_KEY, JSON.stringify([...this.dismissed]));
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([...this.history.values()]));
    } catch { /* storage full */ }
  }

  // ── Dismissed Games ──

  /** Dismiss a game — it won't be recommended again. */
  dismiss(gameId: string) {
    this.dismissed.add(gameId);
    this.save();
    this.notify();
  }

  /** Un-dismiss a game. */
  undismiss(gameId: string) {
    this.dismissed.delete(gameId);
    this.save();
    this.notify();
  }

  /** Check if a game is dismissed. */
  isDismissed(gameId: string): boolean {
    return this.dismissed.has(gameId);
  }

  /** Get all dismissed game IDs. */
  getDismissedIds(): string[] {
    return [...this.dismissed];
  }

  /** Get count of dismissed games. */
  getDismissedCount(): number {
    return this.dismissed.size;
  }

  // ── Conversion Tracking ──

  /** Record that a user clicked on a recommended game. */
  recordClick(gameId: string, title: string, shelfType: string) {
    if (!this.history.has(gameId)) {
      this.history.set(gameId, {
        gameId,
        title,
        shelfType,
        clickedAt: Date.now(),
        converted: false,
      });
    }
    this.save();
  }

  /** Record that a user added a recommended game to their library. */
  recordLibraryAdd(gameId: string) {
    const entry = this.history.get(gameId);
    if (entry && !entry.addedAt) {
      entry.addedAt = Date.now();
      entry.converted = true;
      this.save();
    }
  }

  /** Record that a user started playing a recommended game. */
  recordPlay(gameId: string) {
    const entry = this.history.get(gameId);
    if (entry && !entry.playedAt) {
      entry.playedAt = Date.now();
      entry.converted = true;
      this.save();
    }
  }

  /** Record the rating a user gave a recommended game. */
  recordRating(gameId: string, rating: number) {
    const entry = this.history.get(gameId);
    if (entry) {
      entry.rating = rating;
      entry.converted = true;
      this.save();
    }
  }

  // ── Feedback Analysis ──

  /** Get the overall conversion rate. */
  getConversionRate(): number {
    if (this.history.size === 0) return 0;
    const converted = [...this.history.values()].filter(e => e.converted).length;
    return converted / this.history.size;
  }

  /** Get the average rating of converted recommendations. */
  getAvgConvertedRating(): number {
    const rated = [...this.history.values()].filter(e => e.rating && e.rating > 0);
    if (rated.length === 0) return 0;
    return rated.reduce((s, e) => s + (e.rating || 0), 0) / rated.length;
  }

  /** Get shelf-level conversion stats (which shelf types lead to the most conversions). */
  getShelfConversionStats(): Record<string, { clicks: number; conversions: number; avgRating: number }> {
    const stats: Record<string, { clicks: number; conversions: number; ratingSum: number; ratedCount: number }> = {};

    for (const entry of this.history.values()) {
      if (!stats[entry.shelfType]) {
        stats[entry.shelfType] = { clicks: 0, conversions: 0, ratingSum: 0, ratedCount: 0 };
      }
      stats[entry.shelfType].clicks++;
      if (entry.converted) stats[entry.shelfType].conversions++;
      if (entry.rating) {
        stats[entry.shelfType].ratingSum += entry.rating;
        stats[entry.shelfType].ratedCount++;
      }
    }

    const result: Record<string, { clicks: number; conversions: number; avgRating: number }> = {};
    for (const [type, data] of Object.entries(stats)) {
      result[type] = {
        clicks: data.clicks,
        conversions: data.conversions,
        avgRating: data.ratedCount > 0 ? data.ratingSum / data.ratedCount : 0,
      };
    }
    return result;
  }

  /** Get history entries (for debugging / stats display). */
  getHistory(): RecoConversion[] {
    return [...this.history.values()];
  }

  /** Get total conversion history size. */
  getHistorySize(): number {
    return this.history.size;
  }

  /** Clear all dismissed games. */
  clearDismissed() {
    this.dismissed.clear();
    this.save();
    this.notify();
  }

  /** Reset everything. */
  reset() {
    this.dismissed.clear();
    this.history.clear();
    localStorage.removeItem(LS_DISMISSED_KEY);
    localStorage.removeItem(LS_HISTORY_KEY);
    this.notify();
  }
}

export const recoHistoryStore = new RecoHistoryStore();
