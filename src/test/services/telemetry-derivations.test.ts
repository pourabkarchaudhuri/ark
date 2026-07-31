import { describe, it, expect } from 'vitest';
import {
  weeklyAggregate,
  immersionForSession,
  linearRegression,
  percentChange,
  bucketSessionLengths,
  weekdayHourHeatmap,
  pearson,
  frictionAnomalies,
  pacingWeeklyPoints,
  immersionRollingSeries,
  type GameSessionLike,
  type OverheadSample,
} from '@/services/telemetry-derivations';

function session(overrides: Partial<GameSessionLike> & { id: string; startTime: string | Date }): GameSessionLike {
  return {
    gameId: 'g1',
    durationMinutes: 60,
    ...overrides,
  } as GameSessionLike;
}

describe('weeklyAggregate', () => {
  it('returns empty for empty input', () => {
    expect(weeklyAggregate([])).toEqual([]);
  });

  it('aggregates a single week', () => {
    const sessions: GameSessionLike[] = [
      session({ id: 'a', startTime: new Date('2026-01-05T10:00:00'), durationMinutes: 30 }),
      session({ id: 'b', startTime: new Date('2026-01-06T12:00:00'), durationMinutes: 90 }),
      session({ id: 'c', startTime: new Date('2026-01-07T14:00:00'), durationMinutes: 60 }),
    ];
    const out = weeklyAggregate(sessions);
    expect(out).toHaveLength(1);
    expect(out[0].sessions).toBe(3);
    expect(out[0].totalMinutes).toBe(180);
    expect(out[0].avgMinutes).toBe(60);
    expect(out[0].maxMinutes).toBe(90);
  });

  it('splits multiple weeks with gaps and returns them sorted', () => {
    const sessions: GameSessionLike[] = [
      session({ id: 'w3', startTime: new Date('2026-01-20T10:00:00'), durationMinutes: 45 }),
      session({ id: 'w1', startTime: new Date('2026-01-05T10:00:00'), durationMinutes: 30 }),
    ];
    const out = weeklyAggregate(sessions);
    expect(out).toHaveLength(2);
    expect(out[0].weekStart.getTime()).toBeLessThan(out[1].weekStart.getTime());
    expect(out[0].sessions).toBe(1);
    expect(out[1].sessions).toBe(1);
  });
});

describe('immersionForSession', () => {
  it('falls back to (duration - idle) / duration when activeInputMinutes missing', () => {
    const r = immersionForSession(session({ id: 's1', startTime: new Date(), durationMinutes: 100, idleMinutes: 25 }));
    expect(r).toBeCloseTo(0.75, 5);
  });

  it('uses activeInputMinutes when present', () => {
    const r = immersionForSession(
      session({ id: 's1', startTime: new Date(), durationMinutes: 100, idleMinutes: 90, activeInputMinutes: 40 }),
    );
    expect(r).toBeCloseTo(0.4, 5);
  });

  it('clamps ratio into [0, 1]', () => {
    const above = immersionForSession(
      session({ id: 's', startTime: new Date(), durationMinutes: 10, activeInputMinutes: 999 }),
    );
    const below = immersionForSession(
      session({ id: 's', startTime: new Date(), durationMinutes: 10, idleMinutes: 999 }),
    );
    expect(above).toBe(1);
    expect(below).toBe(0);
  });

  it('returns 0 for zero-duration sessions', () => {
    expect(immersionForSession(session({ id: 'z', startTime: new Date(), durationMinutes: 0 }))).toBe(0);
  });
});

describe('immersionRollingSeries', () => {
  it('produces one sample per session in chronological order', () => {
    const sessions: GameSessionLike[] = [
      session({ id: 'a', startTime: new Date('2026-01-02T10:00:00'), durationMinutes: 100, idleMinutes: 0 }),
      session({ id: 'b', startTime: new Date('2026-01-01T10:00:00'), durationMinutes: 100, idleMinutes: 50 }),
    ];
    const out = immersionRollingSeries(sessions, 2);
    expect(out.map(s => s.sessionId)).toEqual(['b', 'a']);
    expect(out[0].ratio).toBeCloseTo(0.5, 5);
    expect(out[1].ratio).toBeCloseTo(0.75, 5);
  });
});

describe('linearRegression', () => {
  it('computes slope for a perfect line y=x', () => {
    const r = linearRegression([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(r.slope).toBeCloseTo(1, 5);
    expect(r.intercept).toBeCloseTo(0, 5);
    expect(r.r2).toBeCloseTo(1, 5);
  });

  it('handles single-point input', () => {
    const r = linearRegression([{ x: 5, y: 3 }]);
    expect(r.slope).toBe(0);
    expect(r.intercept).toBe(3);
    expect(r.r2).toBe(0);
  });

  it('handles empty input', () => {
    expect(linearRegression([])).toEqual({ slope: 0, intercept: 0, r2: 0 });
  });
});

describe('percentChange', () => {
  it('returns 0 on divide-by-zero', () => {
    expect(percentChange(10, 0)).toBe(0);
  });

  it('computes positive change', () => {
    expect(percentChange(150, 100)).toBeCloseTo(50, 5);
  });

  it('computes negative change', () => {
    expect(percentChange(50, 100)).toBeCloseTo(-50, 5);
  });
});

describe('bucketSessionLengths', () => {
  it('places boundary values into the correct bucket (min inclusive, max exclusive)', () => {
    const sessions: GameSessionLike[] = [
      session({ id: '1', startTime: new Date(), durationMinutes: 0 }),
      session({ id: '2', startTime: new Date(), durationMinutes: 14.9 }),
      session({ id: '3', startTime: new Date(), durationMinutes: 15 }),
      session({ id: '4', startTime: new Date(), durationMinutes: 30 }),
      session({ id: '5', startTime: new Date(), durationMinutes: 60 }),
      session({ id: '6', startTime: new Date(), durationMinutes: 120 }),
      session({ id: '7', startTime: new Date(), durationMinutes: 240 }),
      session({ id: '8', startTime: new Date(), durationMinutes: 500 }),
    ];
    const out = bucketSessionLengths(sessions);
    const byLabel = Object.fromEntries(out.map(b => [b.label, b.count]));
    expect(byLabel['<15m']).toBe(2);
    expect(byLabel['15-30m']).toBe(1);
    expect(byLabel['30-60m']).toBe(1);
    expect(byLabel['1-2h']).toBe(1);
    expect(byLabel['2-4h']).toBe(1);
    expect(byLabel['4h+']).toBe(2);
  });
});

describe('weekdayHourHeatmap', () => {
  it('produces 168 cells with correct counts', () => {
    const sessions: GameSessionLike[] = [
      session({ id: 'a', startTime: new Date(2026, 0, 5, 14, 0, 0) }),
      session({ id: 'b', startTime: new Date(2026, 0, 5, 14, 30, 0) }),
      session({ id: 'c', startTime: new Date(2026, 0, 6, 9, 0, 0) }),
    ];
    const out = weekdayHourHeatmap(sessions);
    expect(out).toHaveLength(168);
    const mon14 = out.find(c => c.weekday === 1 && c.hour === 14);
    const tue9 = out.find(c => c.weekday === 2 && c.hour === 9);
    const sun0 = out.find(c => c.weekday === 0 && c.hour === 0);
    expect(mon14?.count).toBe(2);
    expect(tue9?.count).toBe(1);
    expect(sun0?.count).toBe(0);
  });
});

describe('pearson', () => {
  it('returns 1 for perfect positive correlation', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
  });

  it('returns -1 for perfect anti-correlation', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero-variance input', () => {
    expect(pearson([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
  });

  it('returns 0 for fewer than two points', () => {
    expect(pearson([1], [1])).toBe(0);
  });
});

describe('frictionAnomalies', () => {
  const sessionStart = new Date('2026-02-01T10:00:00').getTime();
  const sessionEnd = new Date('2026-02-01T11:00:00').getTime();
  const s: GameSessionLike = {
    id: 'sess-1',
    gameId: 'g',
    startTime: new Date(sessionStart),
    endTime: new Date(sessionEnd),
    durationMinutes: 60,
    idleMinutes: 8,
  };

  it('flags samples whose latency crosses the threshold and fall inside a session window', () => {
    const samples: OverheadSample[] = [
      { timestamp: sessionStart + 60000, cpuPercent: 5, rssMb: 120, hookLatencyMs: 700 },
      { timestamp: sessionStart + 120000, cpuPercent: 5, rssMb: 120, hookLatencyMs: 100 },
    ];
    const out = frictionAnomalies(samples, [s]);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('sess-1');
    expect(out[0].idleDeltaMinutes).toBe(8);
  });

  it('does not flag samples outside session windows', () => {
    const samples: OverheadSample[] = [
      { timestamp: sessionEnd + 1000, cpuPercent: 5, rssMb: 120, hookLatencyMs: 900 },
    ];
    expect(frictionAnomalies(samples, [s])).toEqual([]);
  });

  it('returns empty when either input is empty', () => {
    expect(frictionAnomalies([], [s])).toEqual([]);
    expect(frictionAnomalies([{ timestamp: 0, cpuPercent: 0, rssMb: 0, hookLatencyMs: 9999 }], [])).toEqual([]);
  });
});

describe('pacingWeeklyPoints', () => {
  it('mirrors weekly aggregate counts', () => {
    const sessions: GameSessionLike[] = [
      session({ id: 'a', startTime: new Date('2026-01-05T10:00:00'), durationMinutes: 30 }),
      session({ id: 'b', startTime: new Date('2026-01-06T10:00:00'), durationMinutes: 90 }),
    ];
    const out = pacingWeeklyPoints(sessions);
    expect(out).toHaveLength(1);
    expect(out[0].sessionsPerWeek).toBe(2);
    expect(out[0].totalMinutes).toBe(120);
    expect(out[0].avgMinutes).toBe(60);
  });
});
