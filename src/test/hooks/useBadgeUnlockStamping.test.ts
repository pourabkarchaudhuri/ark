/**
 * App-level badge unlock stamping (v1.0.97 B27, ui-voyage#2): unlock dates are
 * written from a store subscription, not from BadgeCard's render, and each id
 * is stamped once.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { JourneyEntry } from '@/types/game';
import { ALL_BADGES } from '@/data/badges';
import { useBadgeUnlockStamping } from '@/hooks/useBadgeUnlockStamping';
import { stampUnlockedBadges, type BadgeStamperDeps } from '@/services/badge-unlock-stamper';

function entry(i: number): JourneyEntry {
  return {
    gameId: `steam-${i}`, title: `G${i}`, genre: [], platform: [], status: 'Want to Play',
    hoursPlayed: 2, rating: 0, addedAt: new Date(2024, 0, i + 1).toISOString(),
  } as JourneyEntry;
}

const idOf = (name: string) => ALL_BADGES.find(b => b.name === name)!.id;

function makeDeps(initial: JourneyEntry[]) {
  let journey = initial;
  const stamped = new Map<number, number>();
  const listeners = new Set<() => void>();
  let resolveReady!: () => void;
  const readyP = new Promise<void>(r => { resolveReady = r; });
  const stampMany = vi.fn((entries: Iterable<[number, number]>) => {
    let n = 0;
    for (const [id, ts] of entries) if (!stamped.has(id)) { stamped.set(id, ts); n++; }
    return n;
  });
  const unsubscribe = vi.fn();
  const deps: BadgeStamperDeps = {
    ready: () => readyP,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); unsubscribe(); }; },
    snapshot: () => ({ journeyEntries: journey, statusHistory: [], sessions: [], libraryEntries: [], currentStreakDays: 0 }),
    stampMany,
    isStamped: (id) => stamped.has(id),
    schedule: (fn) => { fn(); return () => {}; },
    now: () => 1_700_000_000_000,
  };
  return {
    deps, stamped, stampMany, unsubscribe,
    resolveReady,
    setJourney: (j: JourneyEntry[]) => { journey = j; listeners.forEach(l => l()); },
  };
}

describe('stampUnlockedBadges', () => {
  it('stamps currently unlocked ids once with the given time', () => {
    const h = makeDeps([entry(1)]);
    expect(stampUnlockedBadges(h.deps)).toBeGreaterThan(0);
    expect(h.stamped.get(idOf('Signal Flare'))).toBe(1_700_000_000_000);
    expect(h.stamped.has(idOf('Hull Christening'))).toBe(false);
    expect(stampUnlockedBadges(h.deps)).toBe(0);
  });
});

describe('useBadgeUnlockStamping', () => {
  it('waits for hydration, stamps once, then only new unlocks on store changes', async () => {
    const h = makeDeps([entry(1)]);
    const { unmount } = renderHook(() => useBadgeUnlockStamping(h.deps));
    expect(h.stampMany).not.toHaveBeenCalled();

    h.resolveReady();
    await vi.waitFor(() => expect(h.stampMany).toHaveBeenCalledTimes(1));
    expect(h.stamped.has(idOf('Signal Flare'))).toBe(true);
    const firstCount = h.stamped.size;

    // Same data again: nothing new to stamp, no write call.
    h.setJourney([entry(1)]);
    expect(h.stampMany).toHaveBeenCalledTimes(1);

    // Three games: Hull Christening unlocks and is the only kind of new stamp.
    h.setJourney([entry(1), entry(2), entry(3)]);
    expect(h.stampMany).toHaveBeenCalledTimes(2);
    expect(h.stamped.has(idOf('Hull Christening'))).toBe(true);
    const newIds = [...(h.stampMany.mock.calls[1][0] as Iterable<[number, number]>)].map(([id]) => id);
    expect(newIds.every(id => !Number.isNaN(id))).toBe(true);
    expect(h.stamped.size).toBe(firstCount + newIds.length);

    unmount();
    expect(h.unsubscribe).toHaveBeenCalled();
  });

  it('does nothing if unmounted before hydration finishes', async () => {
    const h = makeDeps([entry(1)]);
    const { unmount } = renderHook(() => useBadgeUnlockStamping(h.deps));
    unmount();
    h.resolveReady();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.stampMany).not.toHaveBeenCalled();
  });
});
