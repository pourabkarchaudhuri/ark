/**
 * v1.0.100 — Oracle display fixes: "Your Next Obsession" is a normal 5-10 game shelf, "N% match" no longer
 * saturates at 99 for the top of the pool, and shelves that show a match % are ordered best match first.
 */
import { describe, it, expect } from 'vitest';
import { buildMatchCalibrator, calibrateMatchPercent, quantileSorted } from '@/services/reco-scoring';
import { ORACLE_ENGINE_VERSION } from '@/services/oracle-engine-version';
import type { RecoShelf } from '@/types/reco';
import { FIXTURE_NOW, candidatePool, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

/** Deterministic right-skewed scores in a narrow low band, like the real pool. */
function skewedScores(n: number, seed = 11): number[] {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  return Array.from({ length: n }, () => 0.12 + 0.3 * rand() ** 2.2 + 0.1 * rand());
}

/** Shelves whose cards show "N% match" and whose title promises no other order. */
const MATCH_ORDERED = new Set([
  'hero', 'because-you-loved', 'from-studios-you-love', 'deep-in-genre', 'for-your-mood', 'finish-and-try',
  'hidden-gems', 'free-for-you', 'new-releases-for-you', 'upcoming-sequels', 'coming-soon-for-you',
]);

describe('match % calibration', () => {
  it('is monotonic in score and only the pool best reaches 99', () => {
    const scores = skewedScores(3000);
    const sorted = [...scores].sort((a, b) => a - b);
    const cal = buildMatchCalibrator(sorted);
    let prev = 0;
    for (const s of sorted) {
      const p = cal(s);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(99);
      prev = p;
    }
    expect(cal(sorted[sorted.length - 1])).toBe(99);
    expect(sorted.filter(s => cal(s) === 99)).toHaveLength(1);
  });

  it('spreads the top 100 of 3000 over several percentages (the old p5..p98 scale pinned ~60 of them at 99)', () => {
    const sorted = skewedScores(3000).sort((a, b) => a - b);
    const top100 = sorted.slice(-100).reverse();
    const lo = quantileSorted(sorted, 0.05);
    const hi = quantileSorted(sorted, 0.98);
    const old = top100.map(s => Math.min(99, Math.max(1, calibrateMatchPercent(s, lo, hi))));
    expect(old.filter(p => p === 99).length).toBeGreaterThan(50);

    const cal = buildMatchCalibrator(sorted);
    const next = top100.map(cal);
    expect(next.filter(p => p === 99)).toHaveLength(1);
    expect(new Set(next).size).toBeGreaterThanOrEqual(7);
    expect(Math.max(...next.slice(1))).toBeLessThanOrEqual(98);
  });

  it('one outlier does not compress everyone else', () => {
    const base = skewedScores(2000).sort((a, b) => a - b);
    const withOutlier = [...base, 5].sort((a, b) => a - b);
    const cal = buildMatchCalibrator(withOutlier);
    const top50 = base.slice(-50).map(cal);
    // A pure score scale to the max would put all 50 on one value; the rank share keeps them apart.
    expect(new Set(top50).size).toBeGreaterThanOrEqual(3);
    expect(cal(base[base.length - 1])).toBeLessThan(99);
  });

  it('handles tiny and flat pools', () => {
    expect(buildMatchCalibrator([])(0.4)).toBe(40);
    const flat = buildMatchCalibrator([0.3, 0.3, 0.3]);
    expect(flat(0.3)).toBeGreaterThanOrEqual(1);
    expect(flat(0.3)).toBeLessThanOrEqual(99);
    const one = buildMatchCalibrator([0.5]);
    expect(one(0.5)).toBeLessThanOrEqual(99);
  });
});

describe('Oracle shelves on a 3000-game pool', () => {
  let shelves: RecoShelf[] = [];
  let beforeAll_: Promise<void> | null = null;
  const load = () => (beforeAll_ ??= (async () => {
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(3000), FIXTURE_NOW));
    shelves = result.shelves;
  })());

  it('Your Next Obsession is the first shelf with 5-10 games', async () => {
    await load();
    expect(shelves[0].type).toBe('hero');
    expect(shelves[0].games.length).toBeGreaterThanOrEqual(5);
    expect(shelves[0].games.length).toBeLessThanOrEqual(10);
    expect(shelves.filter(s => s.type === 'hero')).toHaveLength(1);
    // No game appears on both the hero shelf and a later taste shelf.
    const heroIds = new Set(shelves[0].games.map(g => g.gameId));
    for (const s of shelves.slice(1)) {
      if (!MATCH_ORDERED.has(s.type) || s.type === 'hero') continue;
      expect(s.games.some(g => heroIds.has(g.gameId))).toBe(false);
    }
  });

  it('match percentages never rise left to right on match-ordered shelves', async () => {
    await load();
    for (const s of shelves) {
      if (!MATCH_ORDERED.has(s.type)) continue;
      const pcts = s.games.map(g => g.matchPct ?? Math.round(g.score * 100));
      for (let i = 1; i < pcts.length; i++) expect(pcts[i], `${s.type} #${i}`).toBeLessThanOrEqual(pcts[i - 1]);
    }
  });

  it('is not a wall of 99%: only the single best game reads 99 and the cards show a spread', async () => {
    await load();
    const cards = shelves.flatMap(s => s.games).filter(g => g.matchPct !== undefined);
    const unique = new Map(cards.map(g => [g.gameId, g.matchPct as number]));
    expect([...unique.values()].filter(p => p >= 99).length).toBeLessThanOrEqual(1);
    const top = [...unique.values()].sort((a, b) => b - a).slice(0, 100);
    expect(new Set(top).size).toBeGreaterThanOrEqual(5);
    const heroPcts = shelves[0].games.map(g => g.matchPct as number);
    expect(heroPcts[0]).toBeGreaterThan(heroPcts[heroPcts.length - 1] - 1);
  });
});

describe('engine version', () => {
  it('is 16 so results cached by v15 (single-game hero, 99% saturation) are discarded', () => {
    expect(ORACLE_ENGINE_VERSION).toBe(16);
  });
});
