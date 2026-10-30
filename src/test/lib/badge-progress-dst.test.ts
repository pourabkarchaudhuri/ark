/**
 * Session streaks across a DST fall-back day (v1.0.97 B27, hooks#25).
 * Node re-reads TZ on assignment, so this file pins a DST zone before any
 * date math runs.
 */
process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import type { GameSession } from '@/types/game';
import { computeDerivedStats } from '@/lib/badge-progress';

function session(id: string, start: Date): GameSession {
  return {
    id,
    gameId: 'steam-1',
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 3600_000).toISOString(),
    durationMinutes: 60,
  } as GameSession;
}

describe('streaks across DST', () => {
  it('Nov 1, 2, 3 2025 in New York is a 3-day streak', () => {
    // Guard: the zone really is in effect (Nov 2 local day is 25 hours long).
    expect(new Date(2025, 10, 3).getTime() - new Date(2025, 10, 2).getTime()).toBe(25 * 3600_000);
    const sessions = [
      session('a', new Date(2025, 10, 1, 20)),
      session('b', new Date(2025, 10, 2, 20)),
      session('c', new Date(2025, 10, 3, 20)),
    ];
    expect(computeDerivedStats([], [], sessions, [], { currentStreakDays: 0 }).longestStreakDays).toBe(3);
  });
});
