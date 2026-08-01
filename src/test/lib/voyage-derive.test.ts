import { describe, it, expect } from 'vitest';
import type { GameSession } from '@/types/game';
import {
  clusterSessionsIntoScenes,
  classifyScene,
  computeSceneGaps,
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
