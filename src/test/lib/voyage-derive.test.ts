import { describe, it, expect } from 'vitest';
import type {
  GameSession,
  JourneyEntry,
  LibraryGameEntry,
  StatusChangeEntry,
} from '@/types/game';
import {
  buildGameRollups,
  classifyScene,
  clusterSessionsIntoScenes,
  computeAuditQuality,
  computeOpenItemsTrend,
  computePlayCadence,
  computeRhythmHeatmap,
  computeSceneGaps,
  computeSessionLengthHistogram,
  computeStatusDistribution,
  computeStreaks,
  DAY_MS,
  MINUTE_MS,
} from '@/lib/voyage-derive';

function session(
  gameId: string,
  startIso: string,
  minutes: number,
  endIso?: string,
): GameSession {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : new Date(start.getTime() + minutes * MINUTE_MS);
  return {
    id: `${gameId}:${startIso}`,
    gameId,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    durationMinutes: minutes,
  };
}

describe('clusterSessionsIntoScenes', () => {
  it('splits episodes when silence exceeds breakMs', () => {
    const sessions = [
      session('steam-1', '2024-01-01T10:00:00Z', 60),
      session('steam-1', '2024-01-10T10:00:00Z', 90),
    ];
    const scenes = clusterSessionsIntoScenes(sessions, (id) => id, { breakMs: 3 * DAY_MS });
    expect(scenes).toHaveLength(2);
    expect(scenes[0].sessionCount).toBe(1);
    expect(scenes[1].sessionCount).toBe(1);
    expect(scenes[0].sincePreviousMs).not.toBeNull();
  });

  it('merges sessions inside the break window into one episode', () => {
    const sessions = [
      session('steam-1', '2024-01-01T10:00:00Z', 30),
      session('steam-1', '2024-01-02T10:00:00Z', 45),
    ];
    const scenes = clusterSessionsIntoScenes(sessions, () => 'Hades', { breakMs: 3 * DAY_MS });
    expect(scenes).toHaveLength(1);
    expect(scenes[0].sessionCount).toBe(2);
    expect(scenes[0].minutes).toBe(75);
    expect(scenes[0].title).toBe('Hades');
  });

  it('labels a return after long idle silence', () => {
    const sessions = [
      session('steam-1', '2024-01-01T10:00:00Z', 120),
      session('steam-1', '2024-06-01T10:00:00Z', 180),
    ];
    const scenes = clusterSessionsIntoScenes(sessions, () => 'BG3', {
      breakMs: 3 * DAY_MS,
      returnIdleMs: 60 * DAY_MS,
    });
    expect(scenes).toHaveLength(2);
    const returned = scenes.find((s) => s.type === 'return');
    expect(returned).toBeDefined();
    expect(returned!.sincePreviousMs).toBeGreaterThanOrEqual(60 * DAY_MS);
  });

  it('returns newest-first', () => {
    const sessions = [
      session('steam-1', '2024-01-01T10:00:00Z', 30),
      session('steam-2', '2024-02-01T10:00:00Z', 30),
    ];
    const scenes = clusterSessionsIntoScenes(sessions, (id) => id);
    expect(scenes[0].startMs).toBeGreaterThan(scenes[1].startMs);
  });
});

describe('classifyScene', () => {
  it('marks a first brief look as false-start', () => {
    const type = classifyScene(
      {
        minutes: 20,
        sessionCount: 1,
        dayCount: 1,
        longestSessionMinutes: 20,
        sincePreviousMs: null,
        isFirstForGame: true,
        isLastForGame: true,
      },
      100,
    );
    expect(type).toBe('false-start');
  });
});

describe('computeSceneGaps', () => {
  it('returns gaps only above minGapMs and marks the longest', () => {
    const scenes = clusterSessionsIntoScenes(
      [
        session('steam-1', '2024-06-01T10:00:00Z', 60),
        session('steam-2', '2024-01-01T10:00:00Z', 60),
        session('steam-3', '2023-06-01T10:00:00Z', 60),
      ],
      (id) => id,
    );

    const gaps = computeSceneGaps(scenes, 14 * DAY_MS);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    const longest = gaps.filter((g) => g.isLongest);
    expect(longest).toHaveLength(1);
    expect(longest[0].ms).toBe(Math.max(...gaps.map((g) => g.ms)));
    expect(longest[0].nextTitle).toBeTruthy();
  });

  it('skips gaps shorter than minGapMs', () => {
    const scenes = clusterSessionsIntoScenes(
      [session('steam-1', '2024-01-05T10:00:00Z', 60), session('steam-2', '2024-01-01T10:00:00Z', 60)],
      (id) => id,
    );
    const gaps = computeSceneGaps(scenes, 30 * DAY_MS);
    expect(gaps).toHaveLength(0);
  });
});

// Anchor "now" to a fixed local wall-clock so day/week bucketing is
// deterministic regardless of the machine's timezone. All fixtures below use
// local-time constructors for the same reason.
const NOW = new Date(2024, 5, 15, 12, 0, 0).getTime(); // Sat 15 Jun 2024, noon

function localSession(gameId: string, d: Date, minutes: number): GameSession {
  return {
    id: `${gameId}:${d.getTime()}`,
    gameId,
    executablePath: 'game.exe',
    startTime: d.toISOString(),
    endTime: new Date(d.getTime() + minutes * MINUTE_MS).toISOString(),
    durationMinutes: minutes,
    idleMinutes: 0,
  };
}

describe('computePlayCadence', () => {
  it('returns an empty array as zero-filled contiguous weeks', () => {
    const weeks = computePlayCadence([], NOW, 12);
    expect(weeks).toHaveLength(12);
    expect(weeks.every((w) => w.sessions === 0 && w.minutes === 0)).toBe(true);
  });

  it('places recent sessions in the final week bucket', () => {
    const weeks = computePlayCadence(
      [localSession('steam-1', new Date(2024, 5, 13, 20, 0, 0), 60)],
      NOW,
      12,
    );
    const last = weeks[weeks.length - 1];
    expect(last.sessions).toBe(1);
    expect(last.minutes).toBe(60);
    // Every earlier week is empty.
    expect(weeks.slice(0, -1).every((w) => w.sessions === 0)).toBe(true);
  });

  it('handles a single session with weeks=1', () => {
    const weeks = computePlayCadence(
      [localSession('steam-1', new Date(2024, 5, 12, 9, 0, 0), 30)],
      NOW,
      1,
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0].sessions).toBe(1);
  });
});

describe('computeStreaks', () => {
  it('reports zeroes for no sessions', () => {
    expect(computeStreaks([], NOW)).toEqual({ current: 0, longest: 0, activeDays: 0 });
  });

  it('counts a single session as a one-day streak', () => {
    const streak = computeStreaks([localSession('steam-1', new Date(2024, 5, 15, 8, 0, 0), 30)], NOW);
    expect(streak).toEqual({ current: 1, longest: 1, activeDays: 1 });
  });

  it('counts consecutive days ending today as the current streak', () => {
    const sessions = [
      localSession('steam-1', new Date(2024, 5, 13, 8, 0, 0), 30),
      localSession('steam-1', new Date(2024, 5, 14, 8, 0, 0), 30),
      localSession('steam-1', new Date(2024, 5, 15, 8, 0, 0), 30),
    ];
    const streak = computeStreaks(sessions, NOW);
    expect(streak.current).toBe(3);
    expect(streak.longest).toBe(3);
    expect(streak.activeDays).toBe(3);
  });

  it('keeps the current streak alive when the latest play was yesterday', () => {
    const sessions = [
      localSession('steam-1', new Date(2024, 5, 13, 8, 0, 0), 30),
      localSession('steam-1', new Date(2024, 5, 14, 8, 0, 0), 30),
    ];
    expect(computeStreaks(sessions, NOW).current).toBe(2);
  });

  it('breaks the current streak but remembers the longest historical run', () => {
    const sessions = [
      // A 3-day run in January.
      localSession('steam-1', new Date(2024, 0, 1, 8, 0, 0), 30),
      localSession('steam-1', new Date(2024, 0, 2, 8, 0, 0), 30),
      localSession('steam-1', new Date(2024, 0, 3, 8, 0, 0), 30),
      // A lone recent day.
      localSession('steam-1', new Date(2024, 5, 15, 8, 0, 0), 30),
    ];
    const streak = computeStreaks(sessions, NOW);
    expect(streak.current).toBe(1);
    expect(streak.longest).toBe(3);
    expect(streak.activeDays).toBe(4);
  });
});

describe('computeSessionLengthHistogram', () => {
  it('returns all-zero buckets for no sessions', () => {
    const buckets = computeSessionLengthHistogram([]);
    expect(buckets).toHaveLength(6);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
  });

  it('bins durations into the right buckets and ignores negatives', () => {
    const sessions = [
      localSession('a', new Date(2024, 0, 1, 1, 0, 0), 10), // <15m
      localSession('a', new Date(2024, 0, 1, 2, 0, 0), 20), // 15–30m
      localSession('a', new Date(2024, 0, 1, 3, 0, 0), 90), // 1–2h
      localSession('a', new Date(2024, 0, 1, 4, 0, 0), 300), // 4h+
      { ...localSession('a', new Date(2024, 0, 1, 5, 0, 0), 0), durationMinutes: -5 },
    ];
    const buckets = computeSessionLengthHistogram(sessions);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.count]));
    expect(byLabel['<15m']).toBe(1);
    expect(byLabel['15–30m']).toBe(1);
    expect(byLabel['1–2h']).toBe(1);
    expect(byLabel['4h+']).toBe(1);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(4);
  });
});

describe('computeRhythmHeatmap', () => {
  it('degrades cleanly to an empty grid', () => {
    const heat = computeRhythmHeatmap([]);
    expect(heat.total).toBe(0);
    expect(heat.max).toBe(0);
    expect(heat.peakWeekday).toBeNull();
    expect(heat.peakHour).toBeNull();
    expect(heat.grid).toHaveLength(7);
    expect(heat.grid[0]).toHaveLength(4);
  });

  it('places a session in the correct weekday and daypart cell', () => {
    // Sat 15 Jun 2024, 20:00 local → weekday 6 (Sat), daypart 3 (Evening).
    const heat = computeRhythmHeatmap([localSession('a', new Date(2024, 5, 15, 20, 0, 0), 60)]);
    expect(heat.total).toBe(1);
    expect(heat.grid[6][3]).toBe(1);
    expect(heat.byWeekday[6]).toBe(1);
    expect(heat.byDaypart[3]).toBe(1);
    expect(heat.peakWeekday).toBe(6);
    expect(heat.peakHour).toBe(20);
    expect(heat.max).toBe(1);
  });
});

// ─── Audit data-quality helpers ──────────────────────────────────────────────

function library(over: Partial<LibraryGameEntry> & { gameId: string }): LibraryGameEntry {
  return {
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    hoursPlayed: 0,
    rating: 0,
    addedAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...over,
  };
}

function journey(over: Partial<JourneyEntry> & { gameId: string }): JourneyEntry {
  return {
    title: over.gameId,
    genre: [],
    platform: [],
    status: 'Want to Play',
    hoursPlayed: 0,
    rating: 0,
    addedAt: '2024-01-01T00:00:00Z',
    ...over,
  };
}

describe('computeAuditQuality', () => {
  it('returns zeroed metrics with no records', () => {
    const q = computeAuditQuality({ rollups: [], libraryEntries: [], journeyEntries: [] });
    expect(q.records).toBe(0);
    expect(q.coverageScore).toBe(0);
    expect(q.completionScore).toBe(0);
    expect(q.sessionScore).toBe(0);
    expect(q.artwork).toEqual({ filled: 0, total: 0, pct: 0 });
  });

  it('scores coverage, completion verdicts and trackability across records', () => {
    const libraryEntries: LibraryGameEntry[] = [
      library({
        gameId: 'steam-1',
        status: 'Completed',
        rating: 4,
        executablePath: 'a.exe',
        cachedMeta: {
          title: 'A',
          coverUrl: 'http://x/a.png',
          genre: ['RPG'],
          developer: 'Dev',
        },
      }),
      library({
        gameId: 'steam-2',
        status: 'Completed',
        rating: 0, // completed but no verdict
        cachedMeta: { title: 'B' }, // no artwork, no metadata
      }),
    ];
    const journeyEntries: JourneyEntry[] = [
      journey({ gameId: 'steam-1', title: 'A', status: 'Completed', genre: ['RPG'] }),
      journey({ gameId: 'steam-2', title: 'B', status: 'Completed' }),
    ];
    const statusHistory: StatusChangeEntry[] = [];
    const sessions: GameSession[] = [localSession('steam-1', new Date(2024, 0, 5, 10, 0, 0), 60)];
    const rollups = buildGameRollups({ journeyEntries, libraryEntries, statusHistory, sessions });

    const q = computeAuditQuality({ rollups, libraryEntries, journeyEntries });
    expect(q.records).toBe(2);
    expect(q.artwork.filled).toBe(1);
    expect(q.metadata.filled).toBe(1);
    expect(q.rating.filled).toBe(1);
    expect(q.completionVerdict).toEqual({ filled: 1, total: 2, pct: 0.5 });
    expect(q.trackable.filled).toBe(1);
    expect(q.sessionData.filled).toBe(1);
    expect(q.coverageScore).toBeCloseTo(0.5, 5); // (0.5 artwork + 0.5 metadata) / 2
    expect(q.completionScore).toBeCloseTo(0.5, 5);
    expect(q.sessionScore).toBeCloseTo(0.5, 5);
  });

  it('falls back to overall rating density when nothing is Completed', () => {
    const libraryEntries: LibraryGameEntry[] = [
      library({ gameId: 'steam-1', status: 'Playing', rating: 5 }),
      library({ gameId: 'steam-2', status: 'Playing', rating: 0 }),
    ];
    const journeyEntries = libraryEntries.map((l) => journey({ gameId: l.gameId, status: 'Playing' }));
    const rollups = buildGameRollups({
      journeyEntries,
      libraryEntries,
      statusHistory: [],
      sessions: [],
    });
    const q = computeAuditQuality({ rollups, libraryEntries, journeyEntries });
    expect(q.completionVerdict.total).toBe(0);
    expect(q.completionScore).toBeCloseTo(0.5, 5); // 1 of 2 rated
  });
});

describe('computeStatusDistribution', () => {
  it('counts only in-library records, in canonical order', () => {
    const libraryEntries: LibraryGameEntry[] = [
      library({ gameId: 'steam-1', status: 'Completed' }),
      library({ gameId: 'steam-2', status: 'Want to Play' }),
      library({ gameId: 'steam-3', status: 'Completed' }),
    ];
    const journeyEntries = libraryEntries.map((l) =>
      journey({ gameId: l.gameId, status: l.status }),
    );
    const rollups = buildGameRollups({
      journeyEntries,
      libraryEntries,
      statusHistory: [],
      sessions: [],
    });
    const dist = computeStatusDistribution(rollups);
    expect(dist).toEqual([
      { status: 'Want to Play', count: 1 },
      { status: 'Completed', count: 2 },
    ]);
  });

  it('returns an empty array with no records', () => {
    expect(computeStatusDistribution([])).toEqual([]);
  });
});

describe('computeOpenItemsTrend', () => {
  it('returns zero-filled months with no data', () => {
    const trend = computeOpenItemsTrend([], [], NOW, 6);
    expect(trend).toHaveLength(6);
    expect(trend.every((m) => m.added === 0 && m.decided === 0 && m.open === 0)).toBe(true);
  });

  it('tracks a record from added to decided as open then resolved', () => {
    const libraryEntries: LibraryGameEntry[] = [
      library({ gameId: 'steam-1', status: 'Completed', addedAt: new Date(2024, 3, 10) }),
    ];
    const journeyEntries: JourneyEntry[] = [
      journey({ gameId: 'steam-1', status: 'Completed', addedAt: new Date(2024, 3, 10).toISOString() }),
    ];
    const statusHistory: StatusChangeEntry[] = [
      {
        gameId: 'steam-1',
        title: 'A',
        previousStatus: 'Want to Play',
        newStatus: 'Completed',
        timestamp: new Date(2024, 4, 20).toISOString(),
      },
    ];
    const rollups = buildGameRollups({ journeyEntries, libraryEntries, statusHistory, sessions: [] });
    const trend = computeOpenItemsTrend(rollups, statusHistory, NOW, 6);
    const byLabel = Object.fromEntries(trend.map((m) => [m.key, m]));
    // Added April → open that month; decided May → open drops back to 0.
    expect(byLabel['2024-4'].added).toBe(1);
    expect(byLabel['2024-4'].open).toBe(1);
    expect(byLabel['2024-5'].decided).toBe(1);
    expect(byLabel['2024-5'].open).toBe(0);
    expect(byLabel['2024-6'].open).toBe(0);
  });
});
