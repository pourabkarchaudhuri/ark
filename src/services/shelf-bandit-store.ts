/**
 * Shelf Bandit Store — Multi-Armed Bandit for Shelf Ordering
 *
 * Tracks user engagement per shelf type (clicks, scrolls, dwells) and uses
 * Thompson Sampling (Beta-Bernoulli) to reorder shelves so the ones users
 * engage with most appear earlier.
 *
 * Persists to localStorage so learning carries across sessions.
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

interface ArmState {
  alpha: number;  // successes + 1
  beta: number;   // failures + 1
  impressions: number;
  clicks: number;
}

const DEFAULT_ARM: ArmState = { alpha: 1, beta: 1, impressions: 0, clicks: 0 };

class ShelfBanditStore {
  private arms: Map<string, ArmState>;

  constructor() {
    this.arms = new Map();
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed: Record<string, ArmState> = JSON.parse(raw);
        for (const [key, state] of Object.entries(parsed)) {
          this.arms.set(key, state);
        }
      }
    } catch {
      // Corrupted data — start fresh
    }
  }

  private save() {
    try {
      const obj: Record<string, ArmState> = {};
      for (const [key, state] of this.arms) obj[key] = state;
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
      // Storage full, silently degrade
    }
  }

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
    localStorage.removeItem(LS_KEY);
  }
}

// Singleton
export const shelfBanditStore = new ShelfBanditStore();
