import * as React from 'react';
import {
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  ReferenceLine,
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
  pacingWeeklyPoints,
  weeklyAggregate,
  type PacingPoint,
  type WeeklyBucket,
} from '@/services/telemetry-derivations';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

const MIN_SESSIONS = 3;
const PRIMARY = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

const chartConfig: ChartConfig = {
  points: { label: 'Weekly cadence', color: PRIMARY },
  sessions: { label: 'Sessions', color: PRIMARY },
};

interface ScatterPoint {
  x: number;
  y: number;
  z: number;
  weekLabel: string;
}

interface WeeklyBar {
  weekLabel: string;
  sessions: number;
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function formatWeek(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function PacingPanel({
  sessions,
}: {
  gameId: string;
  sessions: GameSessionLike[];
}): JSX.Element {
  const points: PacingPoint[] = React.useMemo(
    () => pacingWeeklyPoints(sessions),
    [sessions],
  );
  const weekly: WeeklyBucket[] = React.useMemo(
    () => weeklyAggregate(sessions),
    [sessions],
  );

  const scatter: ScatterPoint[] = React.useMemo(
    () =>
      points.map((p) => ({
        x: p.sessionsPerWeek,
        y: p.avgMinutes,
        z: p.totalMinutes,
        weekLabel: formatWeek(p.weekStart),
      })),
    [points],
  );

  const medianX = React.useMemo(() => median(scatter.map((p) => p.x)), [scatter]);
  const medianY = React.useMemo(() => median(scatter.map((p) => p.y)), [scatter]);

  const lastTwelve: WeeklyBar[] = React.useMemo(
    () =>
      weekly.slice(-12).map((w) => ({
        weekLabel: formatWeek(w.weekStart),
        sessions: w.sessions,
      })),
    [weekly],
  );

  const {
    weeksObserved,
    weeksWithSession,
    peakFrequency,
    longestAvgMinutes,
  } = React.useMemo(() => {
    let peak = 0;
    let longest = 0;
    let withSession = 0;
    for (const w of weekly) {
      if (w.sessions > peak) peak = w.sessions;
      if (w.avgMinutes > longest) longest = w.avgMinutes;
      if (w.sessions > 0) withSession += 1;
    }
    return {
      weeksObserved: weekly.length,
      weeksWithSession: withSession,
      peakFrequency: peak,
      longestAvgMinutes: longest,
    };
  }, [weekly]);

  if (sessions.length < MIN_SESSIONS) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pacing</CardTitle>
          <CardDescription>Weekly cadence, average length, and volume.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Scatter needs at least {MIN_SESSIONS} sessions.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pacing</CardTitle>
        <CardDescription>Weekly cadence, average length, and volume.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Weeks observed" value={weeksObserved.toLocaleString()} />
          <StatTile label="Active weeks" value={weeksWithSession.toLocaleString()} />
          <StatTile label="Peak weekly sessions" value={peakFrequency.toLocaleString()} />
          <StatTile label="Longest avg-length" value={`${longestAvgMinutes.toFixed(0)}m`} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Sessions per week × avg minutes (bubble = total minutes)
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                name="sessions/wk"
                tickLine={false}
                axisLine={false}
                fontSize={10}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="avg min"
                unit="m"
                tickLine={false}
                axisLine={false}
                fontSize={10}
                width={36}
              />
              <ZAxis type="number" dataKey="z" range={[24, 260]} name="total min" />
              <ReferenceLine
                x={medianX}
                stroke={MUTED}
                strokeDasharray="4 4"
                strokeOpacity={0.6}
              />
              <ReferenceLine
                y={medianY}
                stroke={MUTED}
                strokeDasharray="4 4"
                strokeOpacity={0.6}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Scatter data={scatter} fill={PRIMARY} fillOpacity={0.7} />
            </ScatterChart>
          </ChartContainer>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Sessions per week — last 12
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <BarChart data={lastTwelve} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="weekLabel" tickLine={false} axisLine={false} fontSize={10} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="sessions" fill={PRIMARY} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
