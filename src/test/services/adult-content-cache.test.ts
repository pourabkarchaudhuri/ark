/**
 * adult-content-filter cache layer (1.0.97 B21 hooks#1 + ui-other#13).
 *
 * The in-memory Map is the source of truth: hits never touch localStorage, misses
 * schedule one debounced persist, and the version key is read once per session.
 * Verdicts must be identical to the pre-1.0.97 implementation (golden set below).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const CACHE_KEY = 'ark-adult-classification-cache';
const VERSION_KEY = 'ark-adult-classification-cache-version';

type Mod = typeof import('@/services/adult-content-filter');

async function freshModule(): Promise<Mod> {
  vi.resetModules();
  return import('@/services/adult-content-filter');
}

function game(id: string, title: string, summary = '', longDescription = '') {
  return { id, title, summary, longDescription };
}

// Verdicts captured from the pre-1.0.97 implementation.
const GOLDEN: Array<[ReturnType<typeof game>, boolean]> = [
  [game('g-1', 'Lusty Bubbles Animated Edition'), true],
  [game('g-2', 'Femboy Futa Mania'), true],
  [game('g-3', 'Detox My Heart', 'A dating sim with sexual content and romance.'), true],
  [game('g-4', 'Black Myth: Wukong', 'Action RPG inspired by Journey to the West.'), false],
  [game('g-5', 'Assassin Creed', 'An assassin in ancient Greece.'), false],
  [game('g-6', 'Classic Puzzle Pack', 'A classic collection of puzzles for everyone.'), false],
  [game('g-7', 'Night Club Tycoon', 'Manage strippers and escorts in a neon city.'), true],
  [game('g-8', 'Hollow', 'Short'), false],
  [game('g-9', 'Space Trader', 'Trade goods across the galaxy.', 'Contains full nudity in some scenes.'), true],
  [game('g-10', 'Farm Days', 'Grow crops, raise animals and befriend villagers.'), false],
  [game('g-11', 'XXX Racer', 'Arcade racing.'), true],
  [game('g-12', 'Dungeon Crawl', 'Fight the damn goblins in the dark.'), true],
];

describe('adult-content-filter cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the same verdicts as the previous implementation (golden set)', async () => {
    const mod = await freshModule();
    for (const [g, expected] of GOLDEN) {
      expect(mod.isAdultContentByDescription(g), g.title).toBe(expected);
    }
    // Second pass (cache hits) agrees too.
    for (const [g, expected] of GOLDEN) {
      expect(mod.isAdultContentByDescription(g), g.title).toBe(expected);
    }
  });

  it('second pass over 5,200 games does no phrase scan and no localStorage access', async () => {
    const mod = await freshModule();
    const games = Array.from({ length: 5200 }, (_, i) => game(`steam-${i}`, `Game number ${i}`, 'A quiet adventure.'));
    const classify = vi.spyOn(mod.__adultFilterInternals, 'classify');
    for (const g of games) mod.isAdultContentByDescription(g);
    expect(classify).toHaveBeenCalledTimes(5200);

    classify.mockClear();
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    for (const g of games) mod.isAdultContentByDescription(g);
    expect(classify).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('misses persist once after the debounce, not once per miss', async () => {
    const mod = await freshModule();
    mod.isAdultContentByDescription(game('warm', 'Warm up title here'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    for (let i = 0; i < 3000; i++) mod.isAdultContentByDescription(game(`t-${i}`, `Title ${i} of the batch`));
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    const cacheWrites = setItem.mock.calls.filter(([k]) => k === CACHE_KEY);
    expect(cacheWrites).toHaveLength(1);
    const stored = JSON.parse(cacheWrites[0]![1] as string) as Record<string, boolean>;
    expect(Object.keys(stored)).toHaveLength(3001);
  });

  it('reads the version key once per session', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const mod = await freshModule();
    for (let i = 0; i < 50; i++) mod.isAdultContentByDescription(game(`v-${i}`, `Some title ${i}`));
    vi.advanceTimersByTime(2500);
    for (let i = 0; i < 50; i++) mod.isAdultContentByDescription(game(`v-${i}`, `Some title ${i}`));
    const versionReads = getItem.mock.calls.filter(([k]) => k === VERSION_KEY);
    expect(versionReads).toHaveLength(1);
  });

  it('cache survives a reload and is dropped when the version changes', async () => {
    let mod = await freshModule();
    mod.isAdultContentByDescription(game('keep-1', 'Lusty Bubbles Animated Edition'));
    vi.advanceTimersByTime(2500);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual({ 'keep-1': true });

    mod = await freshModule();
    const classify = vi.spyOn(mod.__adultFilterInternals, 'classify');
    expect(mod.isAdultContentByDescription(game('keep-1', 'Lusty Bubbles Animated Edition'))).toBe(true);
    expect(classify).not.toHaveBeenCalled();

    localStorage.setItem(VERSION_KEY, '1');
    mod = await freshModule();
    const classify2 = vi.spyOn(mod.__adultFilterInternals, 'classify');
    mod.isAdultContentByDescription(game('keep-1', 'Lusty Bubbles Animated Edition'));
    expect(classify2).toHaveBeenCalledTimes(1);
  });

  it('caps the persisted set at the most recently used entries', async () => {
    const mod = await freshModule();
    const total = mod.ADULT_CACHE_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i++) mod.isAdultContentByDescription(game(`c-${i}`, `Capped title ${i}`));
    // Touch the oldest entry so LRU keeps it.
    mod.isAdultContentByDescription(game('c-0', 'Capped title 0'));
    vi.advanceTimersByTime(2500);
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, boolean>;
    expect(Object.keys(stored)).toHaveLength(mod.ADULT_CACHE_MAX_ENTRIES);
    expect('c-0' in stored).toBe(true);
    expect('c-1' in stored).toBe(false);
    expect(`c-${total - 1}` in stored).toBe(true);
  });
});
