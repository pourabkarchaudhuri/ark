import * as React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { GameSession } from '@/types/game';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  bucketSessionLengths,
  weekdayHourHeatmap,
  immersionForSession,
  type HistogramBucket,
  type HeatmapCell,
} from '@/services/telemetry-derivations';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

const MIN_SESSIONS = 1;
const PRIMARY = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

const chartConfig: ChartConfig = {
  count: { label: 'Sessions', color: PRIMARY },
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

interface StripRow {
  id: string;
  durationMinutes: number;
  activeMinutes: number;
  index: number;
}

function HeatmapSVG({ cells }: { cells: HeatmapCell[] }): JSX.Element {
  const cellSize = 12;
  const gap = 2;
  const left = 30;
  const top = 16;
  const width = left + 24 * (cellSize + gap);
  const height = top + 7 * (cellSize + gap) + 12;
  let maxCount = 0;
  for (const c of cells) {
    if (c.count > maxCount) maxCount = c.count;
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Weekday hour heatmap"
      className="w-full h-auto"
    >
      {Array.from({ length: 24 }).map((_, h) =>
        h % 3 === 0 ? (
          <text
            key={`h-${h}`}
            x={left + h * (cellSize + gap) + cellSize / 2}
            y={top - 4}
            fontSize={8}
            textAnchor="middle"
            fill={MUTED}
          >
            {h}
          </text>
        ) : null,
      )}
      {WEEKDAY_LABELS.map((d, i) => (
        <text
          key={`d-${d}`}
          x={left - 4}
          y={top + i * (cellSize + gap) + cellSize - 2}
          fontSize={9}
          textAnchor="end"
          fill={MUTED}
        >
          {d}
        </text>
      ))}
      {cells.map((cell) => {
        const opacity = maxCount > 0 ? 0.08 + (cell.count / maxCount) * 0.92 : 0.05;
        return (
          <rect
            key={`c-${cell.weekday}-${cell.hour}`}
            x={left + cell.hour * (cellSize + gap)}
            y={top + cell.weekday * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={PRIMARY}
            fillOpacity={opacity}
          >
            <title>{`${WEEKDAY_LABELS[cell.weekday]} ${cell.hour}:00 — ${cell.count} sessions`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function SessionStripSVG({ rows }: { rows: StripRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  const barW = 10;
  const gap = 4;
  const width = rows.length * (barW + gap);
  const height = 80;
  let maxDuration = 1;
  for (const r of rows) {
    if (r.durationMinutes > maxDuration) maxDuration = r.durationMinutes;
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent sessions strip"
      className="w-full h-20"
    >
      {rows.map((row, i) => {
        const total = row.durationMinutes;
        const h = (total / maxDuration) * (height - 4);
        const activeH = total > 0 ? (row.activeMinutes / total) * h : 0;
        const idleH = h - activeH;
        const x = i * (barW + gap);
        const yBase = height - 2;
        return (
          <g key={row.id}>
            <rect
              x={x}
              y={yBase - h}
              width={barW}
              height={idleH}
              fill={MUTED}
              fillOpacity={0.35}
              rx={1}
            >
              <title>{`Session ${row.index + 1} · ${total.toFixed(0)}m total`}</title>
            </rect>
            <rect
              x={x}
              y={yBase - activeH}
              width={barW}
              height={activeH}
              fill={PRIMARY}
              rx={1}
            >
              <title>{`Active ${row.activeMinutes.toFixed(0)}m / ${total.toFixed(0)}m`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export default function SessionAnalyticsPanel({
  sessions,
}: {
  gameId: string;
  sessions: GameSessionLike[];
}): JSX.Element {
  const buckets: HistogramBucket[] = React.useMemo(
    () => bucketSessionLengths(sessions),
    [sessions],
  );
  const heat: HeatmapCell[] = React.useMemo(
    () => weekdayHourHeatmap(sessions),
    [sessions],
  );

  const { mean, p95, longestGapDays, last7Count, strip } = React.useMemo(() => {
    if (sessions.length === 0) {
      return { mean: 0, p95: 0, longestGapDays: 0, last7Count: 0, strip: [] as StripRow[] };
    }
    const durations = sessions
      .map((s) => (Number.isFinite(s.durationMinutes) ? s.durationMinutes : 0))
      .filter((n) => n >= 0);
    const total = durations.reduce((acc, n) => acc + n, 0);
    const meanVal = durations.length > 0 ? total / durations.length : 0;
    const sortedDur = [...durations].sort((a, b) => a - b);
    const p95Val = percentile(sortedDur, 95);
    const sortedByStart = [...sessions].sort(
      (a, b) => toMs(a.startTime) - toMs(b.startTime),
    );
    let longestGapMs = 0;
    for (let i = 1; i < sortedByStart.length; i += 1) {
      const gap = toMs(sortedByStart[i].startTime) - toMs(sortedByStart[i - 1].startTime);
      if (gap > longestGapMs) longestGapMs = gap;
    }
    const nowMs = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let last7 = 0;
    for (const s of sessions) {
      if (nowMs - toMs(s.startTime) <= sevenDaysMs) last7 += 1;
    }
    const last30 = sortedByStart.slice(-30);
    const stripRows: StripRow[] = last30.map((s, i) => {
      const ratio = immersionForSession(s);
      const duration = Math.max(0, s.durationMinutes || 0);
      return {
        id: s.id,
        durationMinutes: duration,
        activeMinutes: duration * ratio,
        index: i,
      };
    });
    return {
      mean: meanVal,
      p95: p95Val,
      longestGapDays: longestGapMs / (1000 * 60 * 60 * 24),
      last7Count: last7,
      strip: stripRows,
    };
  }, [sessions]);

  if (sessions.length < MIN_SESSIONS) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Session analytics</CardTitle>
          <CardDescription>Length distribution, weekday-hour density, recent strip.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            No sessions recorded yet.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session analytics</CardTitle>
        <CardDescription>Length distribution, weekday-hour density, recent strip.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Mean length" value={`${mean.toFixed(0)}m`} />
          <StatTile label="P95 length" value={`${p95.toFixed(0)}m`} />
          <StatTile label="Longest gap" value={`${longestGapDays.toFixed(1)}d`} />
          <StatTile label="Last 7 days" value={last7Count.toLocaleString()} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Length distribution
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <BarChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} width={28} />
              <ChartTooltip content={<ChartTooltipContent hideLabel={false} />} />
              <Bar dataKey="count" fill={PRIMARY} radius={[3, 3, 0, 0]}>
                {buckets.map((b) => (
                  <Cell key={b.label} fill={PRIMARY} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Weekday x hour density
          </div>
          <HeatmapSVG cells={heat} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Last {strip.length} sessions (active over total)
          </div>
          <SessionStripSVG rows={strip} />
        </div>
      </CardContent>
    </Card>
  );
}
