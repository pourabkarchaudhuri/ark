/**
 * Recommendation History Store — Dismissals + Conversion Tracking
 *
 * Tracks:
 *   1. Dismissed game IDs ("Not Interested") — filtered from future recommendations.
 *      Persists dismiss metadata (franchise/developer/at) for hard-negative expand (F3).
 *   2. Recommendation conversions: click → library add → play → rate.
 *
 * Persists to localStorage with a simple versioned key.
 */

import { canonicalFranchiseBase } from '@/services/franchise';
import type { DismissMeta } from '@/services/hard-negative';

const LS_DISMISSED_KEY = 'ark-reco-dismissed-v1';
const LS_HISTORY_KEY = 'ark-reco-history-v1';

/** Soft bound — drop oldest dismissals by `at`. */
const MAX_DISMISSALS = 500;
/** Soft bound — drop oldest conversion history by `clickedAt`. */
const MAX_HISTORY = 200;

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
  /** Quick thumbs feedback: 1 = positive, -1 = negative, undefined = none. */
  thumbs?: 1 | -1;
}

export type { DismissMeta };

class RecoHistoryStore {
  /** Rich dismiss records (migrated from bare id arrays). */
  private dismissals: Map<string, DismissMeta>;
  private history: Map<string, RecoConversion>;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.dismissals = new Map();
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
        const parsed = JSON.parse(rawDismissed) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string') {
              // Legacy bare-id format
              this.dismissals.set(item, { gameId: item, at: 0 });
            } else if (item && typeof item === 'object' && typeof (item as DismissMeta).gameId === 'string') {
              const m = item as DismissMeta;
              this.dismissals.set(m.gameId, {
                gameId: m.gameId,
                at: typeof m.at === 'number' ? m.at : 0,
                franchiseBase: m.franchiseBase,
                developer: m.developer,
                title: m.title,
              });
            }
          }
        }
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

  private pruneSoftCaps() {
    if (this.dismissals.size > MAX_DISMISSALS) {
      const sorted = [...this.dismissals.values()].sort((a, b) => {
        const atDiff = (a.at || 0) - (b.at || 0);
        return atDiff !== 0 ? atDiff : a.gameId.localeCompare(b.gameId);
      });
      const drop = sorted.slice(0, sorted.length - MAX_DISMISSALS);
      for (const d of drop) this.dismissals.delete(d.gameId);
    }
    if (this.history.size > MAX_HISTORY) {
      const sorted = [...this.history.values()].sort((a, b) => {
        const tDiff = (a.clickedAt || 0) - (b.clickedAt || 0);
        return tDiff !== 0 ? tDiff : a.gameId.localeCompare(b.gameId);
      });
      const drop = sorted.slice(0, sorted.length - MAX_HISTORY);
      for (const h of drop) this.history.delete(h.gameId);
    }
  }

  private save() {
    this.pruneSoftCaps();
    try {
      localStorage.setItem(LS_DISMISSED_KEY, JSON.stringify([...this.dismissals.values()]));
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([...this.history.values()]));
    } catch { /* storage full */ }
  }

  // ── Dismissed Games ──

  /**
   * Dismiss a game — it won't be recommended again.
   * Optional meta enables franchise/developer hard-negative expand (F3).
   */
  dismiss(
    gameId: string,
    meta?: { title?: string; developer?: string; franchiseBase?: string },
  ) {
    const title = meta?.title;
    const franchiseBase =
      meta?.franchiseBase
      || (title ? canonicalFranchiseBase(title) : undefined);
    const prev = this.dismissals.get(gameId);
    this.dismissals.set(gameId, {
      gameId,
      at: prev?.at && prev.at > 0 ? prev.at : Date.now(),
      franchiseBase: franchiseBase || prev?.franchiseBase,
      developer: meta?.developer || prev?.developer,
      title: title || prev?.title,
    });
    this.save();
    this.notify();
  }

  /** Un-dismiss a game. */
  undismiss(gameId: string) {
    this.dismissals.delete(gameId);
    this.save();
    this.notify();
  }

  /** Check if a game is dismissed. */
  isDismissed(gameId: string): boolean {
    return this.dismissals.has(gameId);
  }

  /** Get all dismissed game IDs (API preserved). */
  getDismissedIds(): string[] {
    return [...this.dismissals.keys()];
  }

  /** Rich dismiss metadata for hard-negative expand. */
  getDismissals(): DismissMeta[] {
    return [...this.dismissals.values()];
  }

  /** Get count of dismissed games. */
  getDismissedCount(): number {
    return this.dismissals.size;
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
      this.save();
      this.notify();
    }
  }

  /** Record that a user added a recommended game to their library. */
  recordLibraryAdd(gameId: string, title = '', shelfType = 'oracle') {
    let entry = this.history.get(gameId);
    if (!entry) {
      entry = {
        gameId,
        title,
        shelfType,
        clickedAt: Date.now(),
        converted: false,
      };
      this.history.set(gameId, entry);
    }
    if (!entry.addedAt) {
      entry.addedAt = Date.now();
      entry.converted = true;
      this.save();
      this.notify();
    }
  }

  /** Record that a user played a recommended game. */
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

  /** Record thumbs-up or thumbs-down feedback on a recommendation. */
  recordThumbs(
    gameId: string,
    value: 1 | -1,
    title = '',
    shelfType = '',
    meta?: { developer?: string },
  ) {
    let entry = this.history.get(gameId);
    if (!entry) {
      entry = {
        gameId,
        title,
        shelfType,
        clickedAt: Date.now(),
        converted: false,
      };
      this.history.set(gameId, entry);
    }
    entry.thumbs = value;
    if (value === 1) entry.converted = true;
    // Thumbs-down closes the loop: dismiss so it won't resurface (with franchise meta)
    if (value === -1) {
      this.dismiss(gameId, {
        title: title || entry.title,
        developer: meta?.developer,
      });
      return; // dismiss already save+notify
    }
    this.save();
    this.notify();
  }

  /** Get thumbs feedback for a game. */
  getThumbs(gameId: string): 1 | -1 | undefined {
    return this.history.get(gameId)?.thumbs;
  }

  /** All game ids the user thumbs-downed (for negative profile mining). */
  getThumbsDownIds(): string[] {
    return [...this.history.values()]
      .filter(e => e.thumbs === -1)
      .map(e => e.gameId);
  }

  /** Get positive feedback ratio (for signal quality measurement). */
  getPositiveFeedbackRate(): number {
    const withThumbs = [...this.history.values()].filter(e => e.thumbs !== undefined);
    if (withThumbs.length === 0) return 0;
    return withThumbs.filter(e => e.thumbs === 1).length / withThumbs.length;
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
    this.dismissals.clear();
    this.save();
    this.notify();
  }

  /** Reset everything. */
  reset() {
    this.dismissals.clear();
    this.history.clear();
    localStorage.removeItem(LS_DISMISSED_KEY);
    localStorage.removeItem(LS_HISTORY_KEY);
    this.notify();
  }
}

export const recoHistoryStore = new RecoHistoryStore();
