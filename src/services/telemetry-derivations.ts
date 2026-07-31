export type GameSessionLike = {
  id: string;
  gameId: string;
  startTime: string | Date;
  endTime?: string | Date;
  durationMinutes: number;
  idleMinutes?: number;
  activeInputMinutes?: number;
};

export interface WeeklyBucket {
  weekStart: Date;
  sessions: number;
  totalMinutes: number;
  avgMinutes: number;
  maxMinutes: number;
}

export interface ImmersionSample {
  sessionId: string;
  date: Date;
  ratio: number;
}

export interface RegressionResult {
  slope: number;
  intercept: number;
  r2: number;
}

export interface HistogramBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface HeatmapCell {
  weekday: number;
  hour: number;
  count: number;
}

export interface OverheadSample {
  timestamp: number;
  cpuPercent: number;
  rssMb: number;
  hookLatencyMs: number;
}

export interface FrictionAnomaly {
  timestamp: number;
  latencyMs: number;
  idleDeltaMinutes: number;
  sessionId: string;
  sessionDate: Date;
}

export interface PacingPoint {
  weekStart: Date;
  sessionsPerWeek: number;
  avgMinutes: number;
  totalMinutes: number;
}

const FRICTION_LATENCY_MS = 500;

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + diff);
  return out;
}

export function weeklyAggregate(sessions: readonly GameSessionLike[]): WeeklyBucket[] {
  if (sessions.length === 0) return [];
  const map = new Map<number, { weekStart: Date; sessions: number; totalMinutes: number; maxMinutes: number }>();
  for (const s of sessions) {
    const start = toDate(s.startTime);
    if (Number.isNaN(start.getTime())) continue;
    const ws = startOfWeek(start);
    const key = ws.getTime();
    const entry = map.get(key);
    const dur = Math.max(0, s.durationMinutes ?? 0);
    if (entry) {
      entry.sessions += 1;
      entry.totalMinutes += dur;
      if (dur > entry.maxMinutes) entry.maxMinutes = dur;
    } else {
      map.set(key, { weekStart: ws, sessions: 1, totalMinutes: dur, maxMinutes: dur });
    }
  }
  const out: WeeklyBucket[] = [];
  for (const e of map.values()) {
    out.push({
      weekStart: e.weekStart,
      sessions: e.sessions,
      totalMinutes: e.totalMinutes,
      avgMinutes: e.sessions > 0 ? e.totalMinutes / e.sessions : 0,
      maxMinutes: e.maxMinutes,
    });
  }
  out.sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
  return out;
}

export function immersionForSession(s: GameSessionLike): number {
  const dur = s.durationMinutes;
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  const active = s.activeInputMinutes;
  if (typeof active === 'number' && Number.isFinite(active) && active >= 0) {
    return clamp01(active / dur);
  }
  const idle = typeof s.idleMinutes === 'number' && Number.isFinite(s.idleMinutes) ? Math.max(0, s.idleMinutes) : 0;
  return clamp01((dur - idle) / dur);
}

export function immersionRollingSeries(
  sessions: readonly GameSessionLike[],
  windowSize: number = 5,
): ImmersionSample[] {
  if (sessions.length === 0) return [];
  const w = Math.max(1, Math.floor(windowSize));
  const sorted = [...sessions].sort(
    (a, b) => toDate(a.startTime).getTime() - toDate(b.startTime).getTime(),
  );
  const out: ImmersionSample[] = [];
  const buffer: number[] = [];
  for (const s of sorted) {
    const r = immersionForSession(s);
    buffer.push(r);
    if (buffer.length > w) buffer.shift();
    const avg = buffer.reduce((acc, n) => acc + n, 0) / buffer.length;
    out.push({ sessionId: s.id, date: toDate(s.startTime), ratio: avg });
  }
  return out;
}

export function linearRegression(points: readonly { x: number; y: number }[]): RegressionResult {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: points[0].y, r2: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX === 0 ? 0 : num / denX;
  const intercept = meanY - slope * meanX;
  const r2 = denX === 0 || denY === 0 ? 0 : (num * num) / (denX * denY);
  return { slope, intercept, r2 };
}

export function percentChange(recent: number, prior: number): number {
  if (!Number.isFinite(recent) || !Number.isFinite(prior)) return 0;
  if (prior === 0) return 0;
  return ((recent - prior) / prior) * 100;
}

const LENGTH_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '<15m', min: 0, max: 15 },
  { label: '15-30m', min: 15, max: 30 },
  { label: '30-60m', min: 30, max: 60 },
  { label: '1-2h', min: 60, max: 120 },
  { label: '2-4h', min: 120, max: 240 },
  { label: '4h+', min: 240, max: Number.POSITIVE_INFINITY },
];

export function bucketSessionLengths(sessions: readonly GameSessionLike[]): HistogramBucket[] {
  const counts = LENGTH_BUCKETS.map(b => ({ ...b, count: 0 }));
  for (const s of sessions) {
    const d = s.durationMinutes;
    if (!Number.isFinite(d) || d < 0) continue;
    for (const b of counts) {
      if (d >= b.min && d < b.max) {
        b.count += 1;
        break;
      }
    }
  }
  return counts;
}

export function weekdayHourHeatmap(sessions: readonly GameSessionLike[]): HeatmapCell[] {
  const grid = new Array(7 * 24).fill(0) as number[];
  for (const s of sessions) {
    const d = toDate(s.startTime);
    if (Number.isNaN(d.getTime())) continue;
    const wd = d.getDay();
    const hr = d.getHours();
    grid[wd * 24 + hr] += 1;
  }
  const out: HeatmapCell[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let hr = 0; hr < 24; hr++) {
      out.push({ weekday: wd, hour: hr, count: grid[wd * 24 + hr] });
    }
  }
  return out;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

export function frictionAnomalies(
  samples: readonly OverheadSample[],
  sessions: readonly GameSessionLike[],
): FrictionAnomaly[] {
  if (samples.length === 0 || sessions.length === 0) return [];
  const indexed = sessions
    .map(s => {
      const start = toDate(s.startTime).getTime();
      const end = s.endTime
        ? toDate(s.endTime).getTime()
        : start + Math.max(0, s.durationMinutes ?? 0) * 60000;
      return { session: s, start, end };
    })
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);

  const out: FrictionAnomaly[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.hookLatencyMs)) continue;
    if (sample.hookLatencyMs < FRICTION_LATENCY_MS) continue;
    const match = indexed.find(r => sample.timestamp >= r.start && sample.timestamp <= r.end);
    if (!match) continue;
    out.push({
      timestamp: sample.timestamp,
      latencyMs: sample.hookLatencyMs,
      idleDeltaMinutes: Math.max(0, match.session.idleMinutes ?? 0),
      sessionId: match.session.id,
      sessionDate: new Date(match.start),
    });
  }
  return out;
}

export function pacingWeeklyPoints(sessions: readonly GameSessionLike[]): PacingPoint[] {
  const weekly = weeklyAggregate(sessions);
  return weekly.map(w => ({
    weekStart: w.weekStart,
    sessionsPerWeek: w.sessions,
    avgMinutes: w.avgMinutes,
    totalMinutes: w.totalMinutes,
  }));
}
