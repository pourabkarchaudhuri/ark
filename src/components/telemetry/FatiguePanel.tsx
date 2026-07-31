import * as React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
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
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  weeklyAggregate,
  linearRegression,
  percentChange,
  type WeeklyBucket,
} from '@/services/telemetry-derivations';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

const MIN_SESSIONS = 4;
const PRIMARY = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

const chartConfig: ChartConfig = {
  avgMinutes: { label: 'Average', color: PRIMARY },
  maxMinutes: { label: 'Peak', color: PRIMARY },
  trend: { label: 'Trend', color: MUTED },
};

interface WeeklySeriesRow {
  weekLabel: string;
  avgMinutes: number;
  maxMinutes: number;
  trend: number;
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function formatWeek(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function FatiguePanel({
  sessions,
}: {
  gameId: string;
  sessions: GameSessionLike[];
}): JSX.Element {
  const weekly: WeeklyBucket[] = React.useMemo(
    () => weeklyAggregate(sessions),
    [sessions],
  );

  const {
    series,
    slope,
    changePct,
    peakLabel,
    troughLabel,
  } = React.useMemo(() => {
    if (weekly.length === 0) {
      return {
        series: [] as WeeklySeriesRow[],
        slope: 0,
        changePct: 0,
        peakLabel: '—',
        troughLabel: '—',
      };
    }
    const regressionPoints = weekly.map((w, i) => ({ x: i, y: w.avgMinutes }));
    const regression = linearRegression(regressionPoints);
    const rows: WeeklySeriesRow[] = weekly.map((w, i) => ({
      weekLabel: formatWeek(w.weekStart),
      avgMinutes: w.avgMinutes,
      maxMinutes: w.maxMinutes,
      trend: regression.intercept + regression.slope * i,
    }));

    const recent = weekly.slice(-4);
    const prior = weekly.slice(-8, -4);
    const recentAvg =
      recent.length > 0
        ? recent.reduce((acc, w) => acc + w.avgMinutes, 0) / recent.length
        : 0;
    const priorAvg =
      prior.length > 0
        ? prior.reduce((acc, w) => acc + w.avgMinutes, 0) / prior.length
        : 0;
    const change = percentChange(recentAvg, priorAvg);

    let peak: WeeklyBucket | null = null;
    let trough: WeeklyBucket | null = null;
    for (const w of weekly) {
      if (!peak || w.avgMinutes > peak.avgMinutes) peak = w;
      if (!trough || w.avgMinutes < trough.avgMinutes) trough = w;
    }
    const fmt = (w: WeeklyBucket | null): string =>
      w ? `${formatWeek(w.weekStart)} · ${w.avgMinutes.toFixed(0)}m` : '—';

    return {
      series: rows,
      slope: regression.slope,
      changePct: change,
      peakLabel: fmt(peak),
      troughLabel: fmt(trough),
    };
  }, [weekly]);

  if (sessions.length < MIN_SESSIONS) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Endurance</CardTitle>
          <CardDescription>Weekly average and peak session length with a trend line.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Slope needs at least {MIN_SESSIONS} sessions.
          </div>
        </CardContent>
      </Card>
    );
  }

  const changeLabel = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Endurance</CardTitle>
        <CardDescription>Weekly average and peak session length with a trend line.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Weeks with data" value={series.length.toLocaleString()} />
          <StatTile label="Peak avg week" value={peakLabel} />
          <StatTile label="Trough avg week" value={troughLabel} />
          <StatTile
            label="Slope"
            value={`${slope >= 0 ? '+' : ''}${slope.toFixed(2)} m/wk`}
          />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Last 4 vs prior 4: {changeLabel}
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="weekLabel" tickLine={false} axisLine={false} fontSize={10} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                type="monotone"
                dataKey="avgMinutes"
                stroke={PRIMARY}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="maxMinutes"
                stroke={PRIMARY}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="trend"
                stroke={MUTED}
                strokeWidth={1.5}
                strokeDasharray="2 3"
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
