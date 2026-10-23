import { describe, expect, it } from 'vitest';
import { computeWrappedStats, getWrappedYears, type WrappedInputs } from '@/components/year-wrapped/stats';
import { buildFlythroughKeyframes } from '@/components/year-wrapped/flythrough';
import { buildSlideList } from '@/components/year-wrapped/slides';
import type { GameSession, JourneyEntry, StatusChangeEntry } from '@/types/game';

const iso = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

let sid = 0;
function session(gameId: string, start: string, minutes: number): GameSession {
  const s = new Date(start);
  return {
    id: `s${++sid}`,
    gameId,
    executablePath: 'x.exe',
    startTime: s.toISOString(),
    endTime: new Date(s.getTime() + minutes * 60_000).toISOString(),
    durationMinutes: minutes,
    idleMinutes: 0,
  };
}

function journey(gameId: string, title: string, addedAt: string, extra: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    gameId, title, addedAt,
    genre: ['Action'], platform: ['PC'], status: 'Playing', hoursPlayed: 0, rating: 0,
    ...extra,
  };
}

function change(gameId: string, newStatus: StatusChangeEntry['newStatus'], timestamp: string): StatusChangeEntry {
  return { gameId, title: gameId, previousStatus: 'Playing', newStatus, timestamp };
}

const EMPTY: WrappedInputs = { journey: [], sessions: [], statusChanges: [] };
const NOW_2026 = new Date(2026, 11, 20, 12); // Dec 20 2026

describe('computeWrappedStats — empty data', () => {
  it('does not crash and reports no activity', () => {
    const s = computeWrappedStats(2026, EMPTY, NOW_2026);
    expect(s.hasActivity).toBe(false);
    expect(s.topGame).toBeNull();
    expect(s.top5Games).toEqual([]);
    expect(s.busiestMonth).toBeNull();
    expect(s.busiestDayOfWeek).toBeNull();
    expect(s.hasTimeOfDay).toBe(false);
    expect(s.isNightOwl).toBe(false);
    expect(s.totalHoursPlayed).toBe(0);
    expect(s.completionRate).toBe(0);
    expect(s.longestSession).toBeNull();
    expect(s.funFacts).toEqual([]);
    expect(s.gamerTitle).toBe('The Newcomer');
    expect(s.hoursSource).toBe('none');
  });

  it('tolerates missing arrays and bad records', () => {
    const s = computeWrappedStats(2026, {
      journey: [null as unknown as JourneyEntry, journey('a', 'A', 'not a date')],
      sessions: [
        { ...session('a', iso(2026, 3, 1), 30), durationMinutes: NaN },
        { ...session('a', iso(2026, 3, 1), 30), startTime: 'garbage' },
      ],
      statusChanges: undefined as unknown as StatusChangeEntry[],
    }, NOW_2026);
    expect(s.totalSessions).toBe(0);
    expect(s.hasActivity).toBe(false);
  });

  it('only shows intro, quiet and finale slides', () => {
    const s = computeWrappedStats(2026, EMPTY, NOW_2026);
    expect(buildSlideList(s).map((x) => x.id)).toEqual(['intro', 'quiet', 'finale']);
  });
});

describe('computeWrappedStats — data spanning years', () => {
  const inputs: WrappedInputs = {
    journey: [
      // Added in 2024 but played a lot in 2026 — the old implementation ignored this game entirely.
      journey('old', 'Old Favourite', iso(2024, 5, 1), { hoursPlayed: 900, rating: 5, genre: ['RPG'] }),
      journey('new', 'New Thing', iso(2026, 2, 10), { hoursPlayed: 3, rating: 3, genre: ['Puzzle'] }),
      journey('prev', 'Last Year Game', iso(2025, 12, 31, 23, 30), { hoursPlayed: 50 }),
    ],
    sessions: [
      session('old', iso(2025, 12, 31, 22), 120), // previous year — excluded
      session('old', iso(2026, 1, 1, 0, 30), 60),
      session('old', iso(2026, 1, 2, 21), 240),
      session('old', iso(2026, 1, 3, 21), 30),
      session('new', iso(2026, 2, 10, 9), 90),
      session('old', iso(2027, 1, 1, 1), 500), // next year — excluded
    ],
    statusChanges: [
      change('old', 'Completed', iso(2026, 6, 1)),
      change('prev', 'Completed', iso(2025, 12, 31)),
    ],
  };

  const s = computeWrappedStats(2026, inputs, NOW_2026);

  it('uses tracked session time within the year, not lifetime library hours', () => {
    expect(s.hoursSource).toBe('sessions');
    expect(s.totalSessions).toBe(4);
    expect(s.totalHoursPlayed).toBe(7); // (60+240+30+90)/60
    expect(s.topGame?.gameId).toBe('old');
    expect(s.topGame?.title).toBe('Old Favourite');
    expect(s.topGame?.hours).toBe(5.5);
    expect(s.topGame?.sessions).toBe(3);
    expect(s.top5Games.map((g) => g.gameId)).toEqual(['old', 'new']);
  });

  it('counts games added in earlier years that were played this year', () => {
    expect(s.gamesPlayed).toBe(2);
    expect(s.totalGamesAdded).toBe(1); // only "new" was added in 2026
    expect(s.firstGameAdded?.gameId).toBe('new');
  });

  it('counts completions by when they happened', () => {
    expect(s.gamesCompleted).toBe(1);
    expect(s.completedGames[0].gameId).toBe('old');
    const s2025 = computeWrappedStats(2025, inputs, NOW_2026);
    expect(s2025.completedGames.map((g) => g.gameId)).toEqual(['prev']);
    expect(s2025.isPartialYear).toBe(false);
  });

  it('computes year-scoped streaks and longest session titles', () => {
    expect(s.longestStreak).toBe(3); // Jan 1, 2, 3
    expect(s.currentStreak).toBe(0); // not playing in December
    expect(s.longestSession?.gameTitle).toBe('Old Favourite');
    expect(s.longestSession?.durationMinutes).toBe(240);
    expect(s.totalActiveDays).toBe(4);
  });

  it('builds a heatmap only for the selected year', () => {
    expect(Object.keys(s.heatmap).every((k) => k.startsWith('2026-'))).toBe(true);
    expect(s.heatmap['2026-01-02']).toBe(240);
  });

  it('busiest month is by hours played', () => {
    expect(s.busiestMonth?.index).toBe(0);
    expect(s.busiestMonth?.monthLong).toBe('January');
  });

  it('marks the current year as partial and scopes percentages to days so far', () => {
    expect(s.isPartialYear).toBe(true);
    expect(s.daysInScope).toBe(354); // Jan 1 → Dec 20 inclusive
    expect(s.activeDayPercentage).toBe(Math.round((4 / 354) * 100));
  });

  it('lists years with data, newest first', () => {
    expect(getWrappedYears(inputs, NOW_2026)).toEqual([2026, 2025, 2024]);
    expect(getWrappedYears(EMPTY, NOW_2026)).toEqual([2026]);
  });

  it('produces flythrough keyframes with distinct games', () => {
    const kf = buildFlythroughKeyframes(s);
    expect(kf.length).toBeGreaterThanOrEqual(2);
    expect(new Set(kf.map((k) => k.gameId)).size).toBe(kf.length);
    expect(kf[0]).toMatchObject({ gameId: 'new', title: 'New Thing' });
    expect(kf.every((k) => typeof k.subtitle === 'string' && k.subtitle.length > 0)).toBe(true);
  });
});

describe('computeWrappedStats — library-hours fallback', () => {
  it('uses library hours of games touched this year when no sessions were tracked', () => {
    const s = computeWrappedStats(2026, {
      journey: [
        journey('a', 'A', iso(2026, 3, 1), { hoursPlayed: 12 }),
        journey('b', 'B', iso(2020, 1, 1), { hoursPlayed: 400 }), // untouched in 2026 → ignored
      ],
      sessions: [],
      statusChanges: [],
    }, NOW_2026);
    expect(s.hoursSource).toBe('library');
    expect(s.totalHoursPlayed).toBe(12);
    expect(s.topGame?.gameId).toBe('a');
    expect(s.hasTimeOfDay).toBe(false);
  });
});

describe('computeWrappedStats — time of day', () => {
  it('splits sessions across bucket boundaries', () => {
    const s = computeWrappedStats(2026, {
      journey: [journey('a', 'A', iso(2026, 1, 1))],
      // 23:00 → 01:00: one hour evening, one hour late night
      sessions: [session('a', iso(2026, 3, 3, 23), 120)],
      statusChanges: [],
    }, NOW_2026);
    const byIcon = Object.fromEntries(s.playTimeOfDay.map((p) => [p.icon, p.percentage]));
    expect(byIcon.sunset).toBe(50);
    expect(byIcon.moon).toBe(50);
    expect(s.isNightOwl).toBe(true);
  });
});
