/**
 * Shelf Bandit Store — Multi-Armed Bandit for Shelf Ordering
 *
 * Tracks user engagement per shelf type (clicks, scrolls, dwells) and uses
 * Thompson Sampling (Beta-Bernoulli) to reorder shelves so the ones users
 * engage with most appear earlier.
 *
 * v1.0.61: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface. The public sync API is unchanged — the
 * constructor still hydrates synchronously from localStorage so callers
 * that reorder shelves on the very first render still get their learned
 * ordering. The async LevelDB layer either migrates or overrides that
 * cache once ready. When `window.store` is unavailable (unit tests,
 * jsdom, pre-preload boot window) the store transparently falls back to
 * the previous localStorage path.
 *
 * Usage:
 *   // When user clicks a game in a shelf:
 *   shelfBanditStore.recordReward('hidden-gems', 1);
 *
 *   // When a shelf is shown but ignored:
 *   shelfBanditStore.recordReward('hidden-gems', 0);
 *
 *   // Reorder shelves before display:
 *   const ordered = shelfBanditStore.reorderShelves(shelves);
 */

import type { RecoShelf } from '@/types/reco';

const LS_KEY = 'ark-shelf-bandit-v1';

/**
 * One-shot marker stamped in localStorage after the LevelDB migration
 * copies the arms across. Presence => never migrate again. The original
 * LS_KEY stays intact for one release as rollback insurance.
 */
const MIGRATION_MARKER_KEY = 'ark-shelf-bandit-v1-migrated-v1';

/** LevelDB namespace this store owns. Row keys are shelf-type strings. */
const LEVEL_NAMESPACE = 'shelf-bandit';

/** Debounce window for coalescing bursts of writes into a single LevelDB batch. */
const SAVE_DEBOUNCE_MS = 300;

interface ArmState {
  alpha: number;  // successes + 1
  beta: number;   // failures + 1
  impressions: number;
  clicks: number;
}

const DEFAULT_ARM: ArmState = { alpha: 1, beta: 1, impressions: 0, clicks: 0 };

// Module-level guard so HMR doesn't stack duplicate beforeunload listeners.
let _shelfBanditBeforeUnloadInstalled = false;

class ShelfBanditStore {
  private arms: Map<string, ArmState>;

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set of shelf-type keys currently persisted in LevelDB. On every
   * debounced batch we diff `this.arms` against this to emit `del` ops
   * for anything that disappeared (reset, prune, etc.).
   */
  private _knownKeys: Set<string> = new Set();

  /**
   * Exposed for tests / callers that want to await the async hydration
   * finishing (LevelDB path only — localStorage path resolves immediately).
   */
  readonly ready: Promise<void>;

  constructor() {
    this.arms = new Map();
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';

    // Sync hydrate from localStorage so `reorderShelves` on the first
    // render already sees the learned arm state.
    this.hydrateFromLocalStorage();

    this.ready = this._useLevelDB ? this.initializeFromLevelDB() : Promise.resolve();

    if (typeof window !== 'undefined' && !_shelfBanditBeforeUnloadInstalled) {
      _shelfBanditBeforeUnloadInstalled = true;
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  // ── Persistence: sync load ──

  private hydrateFromLocalStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed: Record<string, ArmState> = JSON.parse(raw);
        for (const [key, state] of Object.entries(parsed)) {
          if (state && typeof state === 'object') {
            this.arms.set(key, state);
          }
        }
      }
    } catch {
      // Corrupted data — start fresh
    }
  }

  // ── Persistence: async LevelDB init ──

  /**
   * LevelDB init path:
   *   1. Load rows from namespace `shelf-bandit`. If any exist, replace
   *      the in-memory arms map.
   *   2. Otherwise, if the migration marker is missing, batch-put the
   *      current in-memory arms (already hydrated from localStorage)
   *      into LevelDB and stamp the marker. Legacy localStorage key stays
   *      intact for one-release rollback.
   *   3. On any hard IPC failure, keep the localStorage-hydrated cache;
   *      subsequent writes will still fall back through `saveNow()`.
   */
  private async initializeFromLevelDB(): Promise<void> {
    try {
      const res = await window.store!.getAll<ArmState>(LEVEL_NAMESPACE);
      if (res.error) {
        console.error('[ShelfBanditStore] getAll IPC error:', res.error);
        return;
      }
      const rows = res.rows ?? [];
      if (rows.length > 0) {
        this.hydrateFromRows(rows);
        return;
      }
      // LevelDB empty — attempt one-shot migration from localStorage.
      await this.tryMigrateFromLocalStorage();
    } catch (err) {
      console.error('[ShelfBanditStore] Failed to init from LevelDB, falling back:', err);
    }
  }

  private hydrateFromRows(rows: Array<{ key: string; value: ArmState }>) {
    const arms = new Map<string, ArmState>();
    const known = new Set<string>();
    for (const row of rows) {
      if (row.value && typeof row.value === 'object') {
        arms.set(row.key, row.value);
        known.add(row.key);
      }
    }
    this.arms = arms;
    this._knownKeys = known;
  }

  /**
   * One-shot copy of the current in-memory arms -> LevelDB namespace.
   *
   * Runs only when:
   *   - migration marker is absent (never migrated before), AND
   *   - LevelDB namespace is empty (caller already checked).
   *
   * Stamps the marker on success (or on an empty in-memory state) so we
   * don't retry every boot. Preserves the legacy localStorage key.
   */
  private async tryMigrateFromLocalStorage(): Promise<void> {
    try {
      if (localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes') return;

      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];
      const known = new Set<string>();

      for (const [shelfType, state] of this.arms) {
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: shelfType, value: state });
        known.add(shelfType);
      }

      if (ops.length > 0) {
        const res = await window.store!.batch(ops);
        if (res.error) {
          console.error('[ShelfBanditStore] Migration batch failed:', res.error);
          return;
        }
        this._knownKeys = known;
        console.log(
          `[ShelfBanditStore] Migrated ${this.arms.size} arms from localStorage -> LevelDB`,
        );
      }

      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    } catch (err) {
      console.error('[ShelfBanditStore] Migration failed:', err);
    }
  }

  // ── Persistence: debounced save ──

  private save() {
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
      const obj: Record<string, ArmState> = {};
      for (const [key, state] of this.arms) obj[key] = state;
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
      // Storage full, silently degrade
    }
  }

  private async saveNowLevelDB(): Promise<void> {
    try {
      const currentKeys = new Set<string>();
      const ops: Array<
        | { type: 'put'; namespace: string; key: string; value: unknown }
        | { type: 'del'; namespace: string; key: string }
      > = [];

      for (const [shelfType, state] of this.arms) {
        currentKeys.add(shelfType);
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: shelfType, value: state });
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
        console.error('[ShelfBanditStore] batch save failed:', res.error);
        return;
      }
      this._knownKeys = currentKeys;
    } catch (err) {
      console.error('[ShelfBanditStore] Failed to save (LevelDB):', err);
    }
  }

  // ── Core arm state ──

  private getArm(shelfType: string): ArmState {
    if (!this.arms.has(shelfType)) {
      this.arms.set(shelfType, { ...DEFAULT_ARM });
    }
    return this.arms.get(shelfType)!;
  }

  /**
   * Record a reward for a shelf type.
   * @param shelfType The shelf type that was interacted with
   * @param reward 1 for click/engagement, 0 for impression with no click
   */
  recordReward(shelfType: string, reward: 0 | 1) {
    const arm = this.getArm(shelfType);
    arm.impressions++;
    if (reward === 1) {
      arm.alpha += 1;
      arm.clicks += 1;
    } else {
      arm.beta += 1;
    }
    this.save();
  }

  /** Record that a shelf was shown (impression) without a click yet. */
  recordImpression(shelfType: string) {
    this.recordReward(shelfType, 0);
  }

  /** Record that a user clicked on a game within a shelf. */
  recordClick(shelfType: string) {
    // We need to undo the beta increment from the impression,
    // and add an alpha increment instead.
    const arm = this.getArm(shelfType);
    arm.alpha += 1;
    arm.clicks += 1;
    // Don't double-count: if we already recorded an impression,
    // the beta was already incremented. Reverse it.
    if (arm.beta > 1) arm.beta -= 1;
    this.save();
  }

  /**
   * Sample from Beta(alpha, beta) — Thompson Sampling.
   * Returns a random sample representing expected reward probability.
   */
  private sampleBeta(alpha: number, beta: number): number {
    // Jinks' method for sampling Beta distribution
    const x = this.gammaVariate(alpha);
    const y = this.gammaVariate(beta);
    return x / (x + y);
  }

  /** Marsaglia and Tsang's gamma variate method. */
  private gammaVariate(shape: number): number {
    if (shape < 1) {
      return this.gammaVariate(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
    }
    const d = shape - 1.0 / 3.0;
    const c = 1.0 / Math.sqrt(9.0 * d);
    for (;;) {
      let x: number, v: number;
      do {
        x = this.normalRandom();
        v = 1.0 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Standard normal random via Box-Muller. */
  private normalRandom(): number {
    const u = Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Reorder shelves using Thompson Sampling.
   * The 'hero' shelf always stays first.
   */
  reorderShelves(shelves: RecoShelf[]): RecoShelf[] {
    if (shelves.length <= 2) return shelves;

    // Keep hero at the top
    const hero = shelves.find(s => s.type === 'hero');
    const rest = shelves.filter(s => s.type !== 'hero');

    // Sample from each arm's Beta distribution
    const scored = rest.map(shelf => ({
      shelf,
      sample: this.sampleBeta(
        this.getArm(shelf.type).alpha,
        this.getArm(shelf.type).beta,
      ),
    }));

    // Sort by sampled value (descending)
    scored.sort((a, b) => b.sample - a.sample);

    const result: RecoShelf[] = [];
    if (hero) result.push(hero);
    result.push(...scored.map(s => s.shelf));

    return result;
  }

  /** Get engagement stats for display. */
  getStats(): Record<string, { ctr: number; impressions: number; clicks: number }> {
    const stats: Record<string, { ctr: number; impressions: number; clicks: number }> = {};
    for (const [key, arm] of this.arms) {
      stats[key] = {
        ctr: arm.impressions > 0 ? arm.clicks / arm.impressions : 0,
        impressions: arm.impressions,
        clicks: arm.clicks,
      };
    }
    return stats;
  }

  /** Reset all learning data. */
  reset() {
    this.arms.clear();
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
          if (res.error) console.error('[ShelfBanditStore] clearNamespace failed:', res.error);
        } catch (err) {
          console.error('[ShelfBanditStore] Failed to clear LevelDB namespace:', err);
        }
      })();
    }
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(MIGRATION_MARKER_KEY);
    this._knownKeys = new Set();
  }
}

// Singleton
export const shelfBanditStore = new ShelfBanditStore();
