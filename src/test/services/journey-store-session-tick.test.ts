import { describe, it, expect, beforeEach, vi } from 'vitest';
import { journeyStore } from '@/services/journey-store';

describe('syncProgress session-tick quiet path', () => {
  beforeEach(() => {
    localStorage.clear();
    journeyStore.clear();
  });

  it('updates hoursPlayed in memory without notifying subscribers (live tick)', () => {
    journeyStore.record({
      gameId: 'steam-1',
      title: 'Hades',
      genre: [],
      platform: [],
      status: 'Playing',
      hoursPlayed: 1,
      rating: 0,
      addedAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    const unsub = journeyStore.subscribe(listener);

    // Live session tick: hours only, no lastPlayedAt / status — must not wake dashboard.
    journeyStore.syncProgress('steam-1', { hoursPlayed: 1.25 });

    expect(journeyStore.getEntry('steam-1')?.hoursPlayed).toBe(1.25);
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('notifies subscribers when lastPlayedAt is set (session end)', () => {
    journeyStore.record({
      gameId: 'steam-2',
      title: 'Hades',
      genre: [],
      platform: [],
      status: 'Playing',
      hoursPlayed: 1,
      rating: 0,
      addedAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    const unsub = journeyStore.subscribe(listener);

    const end = new Date().toISOString();
    journeyStore.syncProgress('steam-2', { hoursPlayed: 1.5, lastPlayedAt: end });

    expect(journeyStore.getEntry('steam-2')?.hoursPlayed).toBe(1.5);
    expect(journeyStore.getEntry('steam-2')?.lastPlayedAt).toBe(end);
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('notifies subscribers on status change', () => {
    journeyStore.record({
      gameId: 'steam-3',
      title: 'Hades',
      genre: [],
      platform: [],
      status: 'Want to Play',
      hoursPlayed: 0,
      rating: 0,
      addedAt: new Date().toISOString(),
    });

    const listener = vi.fn();
    const unsub = journeyStore.subscribe(listener);
    journeyStore.syncProgress('steam-3', { status: 'Playing', hoursPlayed: 0.1 });
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});
