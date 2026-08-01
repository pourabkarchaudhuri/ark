import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    syncProgress: vi.fn(),
    syncJourneyTitle: vi.fn(),
    markRemoved: vi.fn(),
  },
}));

vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getTotalHours: vi.fn().mockReturnValue(0),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    getFirstPlayingTransition: vi.fn().mockReturnValue(null),
  },
}));

import { customGameStore } from '@/services/custom-game-store';
import { journeyStore } from '@/services/journey-store';

describe('customGameStore updateHoursFromSessions quiet path', () => {
  beforeEach(() => {
    localStorage.clear();
    customGameStore.clear();
    vi.mocked(journeyStore.syncProgress).mockClear();
  });

  it('updates hours without notifying on live ticks (no lastPlayedAt)', () => {
    const entry = customGameStore.addGame({
      title: 'Indie Title',
      status: 'Playing',
    });
    const listener = vi.fn();
    const unsub = customGameStore.subscribe(listener);
    listener.mockClear();

    customGameStore.updateHoursFromSessions(entry.id, 1.5);

    expect(customGameStore.getGame(entry.id)?.hoursPlayed).toBe(1.5);
    expect(listener).not.toHaveBeenCalled();
    expect(journeyStore.syncProgress).toHaveBeenCalledWith(entry.id, {
      hoursPlayed: 1.5,
      lastPlayedAt: undefined,
    });
    unsub();
  });

  it('notifies subscribers when lastPlayedAt is set (session end)', () => {
    const entry = customGameStore.addGame({
      title: 'Indie Title',
      status: 'Playing',
    });
    const listener = vi.fn();
    const unsub = customGameStore.subscribe(listener);
    listener.mockClear();

    const end = new Date().toISOString();
    customGameStore.updateHoursFromSessions(entry.id, 2, end);

    expect(customGameStore.getGame(entry.id)?.hoursPlayed).toBe(2);
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});
