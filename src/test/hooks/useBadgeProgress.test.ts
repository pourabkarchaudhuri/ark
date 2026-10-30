/**
 * useBadgeProgress latching (v1.0.97 B27, ui-voyage#3): active-streak badges
 * stay unlocked once stamped, and the hook re-derives when the timestamp map
 * hydrates.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { JourneyEntry, GameSession } from '@/types/game';
import { ALL_BADGES } from '@/data/badges';

let streak = 0;
vi.mock('@/services/session-store', () => ({
  sessionStore: { getCurrentStreak: () => streak },
}));

const entries: JourneyEntry[] = [{
  gameId: 'steam-1', title: 'G', genre: [], platform: [], status: 'Playing',
  hoursPlayed: 3, rating: 0, addedAt: '2024-01-01T00:00:00.000Z',
} as JourneyEntry];
const burning = ALL_BADGES.find(b => b.name === 'Burning Bright')!.id;
const undimmed = ALL_BADGES.find(b => b.name === 'Undimmed Flame')!.id;

// The timestamp module picks LevelDB vs localStorage once at load, so a gated
// fake bridge is installed before the first (dynamic) import and both tests
// share that module instance.
let open!: () => void;
const gate = new Promise<void>(r => { open = r; });
Object.defineProperty(window, 'store', {
  configurable: true,
  writable: true,
  value: {
    getAll: vi.fn(async () => { await gate; return { rows: [{ key: String(burning), value: 1 }] }; }),
    batch: vi.fn(async () => ({ ok: true })),
    clearNamespace: vi.fn(async () => ({ ok: true })),
  },
});
localStorage.setItem('ark-badge-unlock-timestamps-migrated-v1', 'yes');

const load = async () => ({
  ...(await import('@/hooks/useBadgeProgress')),
  ts: await import('@/services/badge-unlock-timestamps'),
});

describe('useBadgeProgress latching', () => {
  it('a stored stamp latches once the timestamp map hydrates (locked before, unlocked after)', async () => {
    const { useBadgeProgress, ts } = await load();
    streak = 0;
    const { result } = renderHook(() => useBadgeProgress(entries, [], [], []));
    const unlockedOf = (id: number) => result.current.badges.find(r => r.badge.id === id)!.unlocked;
    expect(ts.isBadgeUnlockTimestampsHydrated()).toBe(false);
    expect(unlockedOf(burning)).toBe(false);

    await act(async () => { open(); await ts.badgeUnlockTimestampsReady(); });
    expect(unlockedOf(burning)).toBe(true);
    expect(unlockedOf(undimmed)).toBe(false);
  });

  it('streak 7 unlocks Undimmed Flame; after stamping, streak 0 keeps it and the count stable', async () => {
    const { useBadgeProgress, ts } = await load();
    streak = 7;
    let sessions: GameSession[] = [];
    const { result, rerender } = renderHook(() => useBadgeProgress(entries, [], sessions, []));
    const unlockedOf = (id: number) => result.current.badges.find(r => r.badge.id === id)!.unlocked;
    expect(unlockedOf(undimmed)).toBe(true);
    const count = result.current.unlockedCount;
    const points = result.current.totalPoints;

    act(() => {
      ts.setBadgeUnlockedAtMany(result.current.badges.filter(r => r.unlocked).map(r => [r.badge.id, 1] as [number, number]));
    });

    streak = 0;
    sessions = [];  // new array identity → stats recompute
    rerender();
    expect(unlockedOf(burning)).toBe(true);
    expect(unlockedOf(undimmed)).toBe(true);
    expect(result.current.unlockedCount).toBe(count);
    expect(result.current.totalPoints).toBe(points);
  });
});
