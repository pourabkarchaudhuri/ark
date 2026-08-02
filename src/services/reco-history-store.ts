/**
 * Recommendation History Store — Dismissals + Conversion Tracking
 *
 * Tracks:
 *   1. Dismissed game IDs ("Not Interested") — filtered from future recommendations.
 *      Persists dismiss metadata (franchise/developer/at) for hard-negative expand (F3).
 *   2. Recommendation conversions: click → library add → play → rate.
 *
 * v1.0.61: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface (see `electron/ipc/store-handlers.ts`). Both
 * collections live in the same namespace with prefixed keys so a single
 * `getAll` fills the in-memory cache. The public sync API is unchanged —
 * the constructor still hydrates synchronously from localStorage (so any
 * caller that reads on the same tick sees data), and the async LevelDB
 * layer either migrates or overrides that cache once ready. When
 * `window.store` is unavailable (unit tests, jsdom, pre-preload boot
 * window) the store transparently falls back to the previous localStorage
 * path.
 */

import { canonicalFranchiseBase } from '@/services/franchise';
import type { DismissMeta } from '@/services/hard-negative';

const LS_DISMISSED_KEY = 'ark-reco-dismissed-v1';
const LS_HISTORY_KEY = 'ark-reco-history-v1';

/**
 * One-shot markers stamped in localStorage after the LevelDB migration
 * copies each payload across. Presence => never migrate again. Both legacy
 * keys stay intact for one release as rollback insurance.
 */
const MIGRATION_MARKER_DISMISSED = 'ark-reco-dismissed-v1-migrated-v1';
const MIGRATION_MARKER_HISTORY = 'ark-reco-history-v1-migrated-v1';

/** LevelDB namespace this store owns. Row keys are prefixed by kind. */
const LEVEL_NAMESPACE = 'reco-history';
/** Prefix for dismissal rows within the namespace: `d:${gameId}` */
const KEY_PREFIX_DISMISS = 'd:';
/** Prefix for conversion-history rows within the namespace: `h:${gameId}` */
const KEY_PREFIX_HISTORY = 'h:';

/** Soft bound — drop oldest dismissals by `at`. */
const MAX_DISMISSALS = 500;
/** Soft bound — drop oldest conversion history by `clickedAt`. */
const MAX_HISTORY = 200;

/** Debounce window for coalescing bursts of writes into a single LevelDB batch. */
const SAVE_DEBOUNCE_MS = 300;

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

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _recoHistoryBeforeUnloadInstalled = false;

class RecoHistoryStore {
  /** Rich dismiss records (migrated from bare id arrays). */
  private dismissals: Map<string, DismissMeta>;
  private history: Map<string, RecoConversion>;
  private listeners: Set<() => void> = new Set();

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set of row keys currently persisted in LevelDB (prefixed). On every
   * debounced batch we diff the current in-memory state against this to
   * emit `del` ops for anything that disappeared (undismiss, prune, etc.).
   */
  private _knownKeys: Set<string> = new Set();

  /**
   * Exposed for tests / callers that want to await the async hydration
   * finishing (LevelDB path only — localStorage path resolves immediately).
   */
  readonly ready: Promise<void>;

  constructor() {
    this.dismissals = new Map();
    this.history = new Map();
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';

    // Always run a synchronous hydrate from localStorage so callers that
    // read immediately after construction (e.g. isDismissed during render)
    // still see data even in the LevelDB pre-hydrate boot window.
    this.hydrateFromLocalStorage();

    this.ready = this._useLevelDB ? this.initializeFromLevelDB() : Promise.resolve();

    if (typeof window !== 'undefined' && !_recoHistoryBeforeUnloadInstalled) {
      _recoHistoryBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  // ── Subscriptions ──

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  // ── Persistence: sync load ──

  private hydrateFromLocalStorage() {
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
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry && typeof entry.gameId === 'string') {
              this.history.set(entry.gameId, entry);
            }
          }
        }
      }
    } catch { /* corrupted */ }
  }

  // ── Persistence: async LevelDB init ──

  /**
   * LevelDB init path:
   *   1. Load rows from namespace `reco-history`. If any exist, replace
   *      the in-memory cache and notify.
   *   2. Otherwise, if either migration marker is missing, batch-put the
   *      current in-memory entries (already hydrated from localStorage)
   *      into LevelDB and stamp both markers. Legacy localStorage keys
   *      remain intact for one-release rollback.
   *   3. On any hard IPC failure, keep the localStorage-hydrated cache and
   *      leave `_knownKeys` empty so subsequent writes still fall back to
   *      the localStorage path via `saveNow()`.
   */
  private async initializeFromLevelDB(): Promise<void> {
    try {
      const res = await window.store!.getAll<unknown>(LEVEL_NAMESPACE);
      if (res.error) {
        console.error('[RecoHistoryStore] getAll IPC error:', res.error);
        return;
      }
      const rows = res.rows ?? [];
      if (rows.length > 0) {
        this.hydrateFromRows(rows);
        this.notify();
        return;
      }
      // LevelDB empty — attempt one-shot migration from localStorage.
      await this.tryMigrateFromLocalStorage();
    } catch (err) {
      console.error('[RecoHistoryStore] Failed to init from LevelDB, falling back:', err);
    }
  }

  private hydrateFromRows(rows: Array<{ key: string; value: unknown }>) {
    const dismissals = new Map<string, DismissMeta>();
    const history = new Map<string, RecoConversion>();
    const known = new Set<string>();

    for (const row of rows) {
      known.add(row.key);
      if (row.key.startsWith(KEY_PREFIX_DISMISS)) {
        const m = row.value as DismissMeta | null;
        if (m && typeof m.gameId === 'string') {
          dismissals.set(m.gameId, {
            gameId: m.gameId,
            at: typeof m.at === 'number' ? m.at : 0,
            franchiseBase: m.franchiseBase,
            developer: m.developer,
            title: m.title,
          });
        }
      } else if (row.key.startsWith(KEY_PREFIX_HISTORY)) {
        const e = row.value as RecoConversion | null;
        if (e && typeof e.gameId === 'string') {
          history.set(e.gameId, e);
        }
      }
    }

    this.dismissals = dismissals;
    this.history = history;
    this._knownKeys = known;
  }

  /**
   * One-shot copy of the current in-memory state -> LevelDB namespace.
   *
   * Runs only when:
   *   - migration markers are absent (never migrated before), AND
   *   - LevelDB namespace is empty (caller already checked).
   *
   * Stamps both migration markers on success (or on an empty in-memory
   * state) so we don't retry every boot. Preserves the two legacy
   * localStorage keys for one-release rollback insurance.
   */
  private async tryMigrateFromLocalStorage(): Promise<void> {
    try {
      const dismissedMarked = localStorage.getItem(MIGRATION_MARKER_DISMISSED) === 'yes';
      const historyMarked = localStorage.getItem(MIGRATION_MARKER_HISTORY) === 'yes';
      if (dismissedMarked && historyMarked) return;

      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];
      const known = new Set<string>();

      if (!dismissedMarked) {
        for (const [gameId, meta] of this.dismissals) {
          const key = KEY_PREFIX_DISMISS + gameId;
          ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key, value: meta });
          known.add(key);
        }
      }
      if (!historyMarked) {
        for (const [gameId, entry] of this.history) {
          const key = KEY_PREFIX_HISTORY + gameId;
          ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key, value: entry });
          known.add(key);
        }
      }

      if (ops.length > 0) {
        const res = await window.store!.batch(ops);
        if (res.error) {
          console.error('[RecoHistoryStore] Migration batch failed:', res.error);
          return;
        }
        this._knownKeys = known;
        console.log(
          `[RecoHistoryStore] Migrated ${this.dismissals.size} dismissals + ${this.history.size} history entries from localStorage -> LevelDB`,
        );
      }

      // Stamp both markers even if the in-memory state was empty so we
      // don't retry every boot.
      localStorage.setItem(MIGRATION_MARKER_DISMISSED, 'yes');
      localStorage.setItem(MIGRATION_MARKER_HISTORY, 'yes');
    } catch (err) {
      console.error('[RecoHistoryStore] Migration failed:', err);
    }
  }

  // ── Persistence: prune + save ──

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

  /**
   * Schedules a debounced save. Pruning is done synchronously here so
   * callers that read `getDismissedCount()` / `getHistorySize()` on the
   * same tick see the capped values.
   */
  private save() {
    this.pruneSoftCaps();
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

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
      // synchronous callsite contract.
      void this.saveNowLevelDB();
      return;
    }
    this.saveNowLocalStorage();
  }

  private saveNowLocalStorage(): void {
    try {
      localStorage.setItem(LS_DISMISSED_KEY, JSON.stringify([...this.dismissals.values()]));
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([...this.history.values()]));
    } catch { /* storage full */ }
  }

  private async saveNowLevelDB(): Promise<void> {
    try {
      const currentKeys = new Set<string>();
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];

      for (const [gameId, meta] of this.dismissals) {
        const key = KEY_PREFIX_DISMISS + gameId;
        currentKeys.add(key);
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key, value: meta });
      }
      for (const [gameId, entry] of this.history) {
        const key = KEY_PREFIX_HISTORY + gameId;
        currentKeys.add(key);
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key, value: entry });
      }

      // Delta-deletes: anything in _knownKeys that's no longer present.
      for (const oldKey of this._knownKeys) {
        if (!currentKeys.has(oldKey)) {
          ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: oldKey });
        }
      }

      if (ops.length === 0) return;

      const res = await window.store!.batch(ops);
      if (res.error) {
        console.error('[RecoHistoryStore] batch save failed:', res.error);
        return;
      }
      this._knownKeys = currentKeys;
    } catch (err) {
      console.error('[RecoHistoryStore] Failed to save (LevelDB):', err);
    }
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

  /** All game ids the user thumbs-upped (for positive profile mining). */
  getThumbsUpIds(): string[] {
    return [...this.history.values()]
      .filter(e => e.thumbs === 1)
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
          if (res.error) console.error('[RecoHistoryStore] clearNamespace failed:', res.error);
        } catch (err) {
          console.error('[RecoHistoryStore] Failed to clear LevelDB namespace:', err);
        }
      })();
    }
    localStorage.removeItem(LS_DISMISSED_KEY);
    localStorage.removeItem(LS_HISTORY_KEY);
    // Reset markers so a subsequent reset-then-repopulate cycle treats
    // the next non-empty state as a fresh migration.
    localStorage.removeItem(MIGRATION_MARKER_DISMISSED);
    localStorage.removeItem(MIGRATION_MARKER_HISTORY);
    this._knownKeys = new Set();
    this.notify();
  }
}

export const recoHistoryStore = new RecoHistoryStore();
