import * as React from 'react';
import {
  Area,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ComposedChart,
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
  immersionForSession,
  immersionRollingSeries,
  type ImmersionSample,
} from '@/services/telemetry-derivations';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

const MIN_SESSIONS = 5;
const PRIMARY = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

const chartConfig: ChartConfig = {
  ratio: { label: 'Immersion ratio', color: PRIMARY },
  rolling: { label: 'Rolling mean', color: MUTED },
  active: { label: 'Active minutes', color: PRIMARY },
  idle: { label: 'Idle minutes', color: MUTED },
};

interface TrendPoint {
  date: string;
  ratio: number;
  rolling: number;
}

interface BreakdownRow {
  label: string;
  activeMinutes: number;
  idleMinutes: number;
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

function formatShort(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function RadialGauge({ ratio }: { ratio: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(1, ratio));
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 56;
  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const angle = startAngle + (endAngle - startAngle) * clamped;

  const toXY = (a: number): [number, number] => [
    cx + r * Math.cos(a),
    cy + r * Math.sin(a),
  ];
  const [sx, sy] = toXY(startAngle);
  const [ex, ey] = toXY(endAngle);
  const [px, py] = toXY(angle);
  const trackLarge = endAngle - startAngle > Math.PI ? 1 : 0;
  const activeLarge = angle - startAngle > Math.PI ? 1 : 0;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-36 w-36"
      role="img"
      aria-label="Trailing immersion ratio"
    >
      <path
        d={`M ${sx} ${sy} A ${r} ${r} 0 ${trackLarge} 1 ${ex} ${ey}`}
        stroke={MUTED}
        strokeOpacity={0.25}
        strokeWidth={10}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={`M ${sx} ${sy} A ${r} ${r} 0 ${activeLarge} 1 ${px} ${py}`}
        stroke={PRIMARY}
        strokeWidth={10}
        fill="none"
        strokeLinecap="round"
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize={24}
        fontWeight={600}
        fill="currentColor"
      >
        {(clamped * 100).toFixed(0)}%
      </text>
      <text x={cx} y={cy + 22} textAnchor="middle" fontSize={10} fill={MUTED}>
        trailing 5
      </text>
    </svg>
  );
}

export default function ImmersionPanel({
  sessions,
}: {
  gameId: string;
  sessions: GameSessionLike[];
}): JSX.Element {
  const rolling: ImmersionSample[] = React.useMemo(
    () => immersionRollingSeries(sessions, 1),
    [sessions],
  );

  const trend: TrendPoint[] = React.useMemo(() => {
    if (rolling.length === 0) return [];
    const window: number[] = [];
    return rolling.map((sample) => {
      window.push(sample.ratio);
      if (window.length > 5) window.shift();
      const mean = window.reduce((acc, n) => acc + n, 0) / window.length;
      return {
        date: formatShort(sample.date),
        ratio: sample.ratio,
        rolling: mean,
      };
    });
  }, [rolling]);

  const breakdown: BreakdownRow[] = React.useMemo(() => {
    const sortedAsc = [...sessions].sort(
      (a, b) => toDate(a.startTime).getTime() - toDate(b.startTime).getTime(),
    );
    const last = sortedAsc.slice(-20);
    return last.map((s) => {
      const dur = Math.max(0, s.durationMinutes || 0);
      const ratio = immersionForSession(s);
      const active = dur * ratio;
      const idle = Math.max(0, dur - active);
      return {
        label: formatShort(toDate(s.startTime)),
        activeMinutes: active,
        idleMinutes: idle,
      };
    });
  }, [sessions]);

  const {
    allTimeRatio,
    trailing5Ratio,
    highestLabel,
    lowestLabel,
  } = React.useMemo(() => {
    if (sessions.length === 0) {
      return {
        allTimeRatio: 0,
        trailing5Ratio: 0,
        highestLabel: '—',
        lowestLabel: '—',
      };
    }
    let totalActive = 0;
    let totalDur = 0;
    for (const s of sessions) {
      const dur = Math.max(0, s.durationMinutes || 0);
      const ratio = immersionForSession(s);
      totalActive += dur * ratio;
      totalDur += dur;
    }
    const overall = totalDur > 0 ? totalActive / totalDur : 0;

    const sortedAsc = [...sessions].sort(
      (a, b) => toDate(a.startTime).getTime() - toDate(b.startTime).getTime(),
    );
    const last5 = sortedAsc.slice(-5);
    let last5Active = 0;
    let last5Dur = 0;
    for (const s of last5) {
      const dur = Math.max(0, s.durationMinutes || 0);
      const ratio = immersionForSession(s);
      last5Active += dur * ratio;
      last5Dur += dur;
    }
    const trailing = last5Dur > 0 ? last5Active / last5Dur : 0;

    let highest: { r: number; d: Date } | null = null;
    let lowest: { r: number; d: Date } | null = null;
    for (const s of sessions) {
      const r = immersionForSession(s);
      const d = toDate(s.startTime);
      if (!highest || r > highest.r) highest = { r, d };
      if (!lowest || r < lowest.r) lowest = { r, d };
    }
    const fmt = (v: { r: number; d: Date } | null): string =>
      v ? `${formatShort(v.d)} · ${(v.r * 100).toFixed(0)}%` : '—';

    return {
      allTimeRatio: overall,
      trailing5Ratio: trailing,
      highestLabel: fmt(highest),
      lowestLabel: fmt(lowest),
    };
  }, [sessions]);

  if (sessions.length < MIN_SESSIONS) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Immersion</CardTitle>
          <CardDescription>Active-input share and per-session trend.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Trend needs at least {MIN_SESSIONS} sessions.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Immersion</CardTitle>
        <CardDescription>Active-input share and per-session trend.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="All-time ratio" value={`${(allTimeRatio * 100).toFixed(0)}%`} />
          <StatTile label="Trailing 5" value={`${(trailing5Ratio * 100).toFixed(0)}%`} />
          <StatTile label="Highest session" value={highestLabel} />
          <StatTile label="Lowest session" value={lowestLabel} />
        </div>

        <div className="flex flex-col items-center gap-2 md:flex-row md:items-center md:gap-6">
          <RadialGauge ratio={trailing5Ratio} />
          <div className="flex-1 w-full">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Per-session ratio + rolling mean (5)
            </div>
            <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
              <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="imm-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={10} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  width={32}
                  domain={[0, 1]}
                  tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="ratio"
                  stroke={PRIMARY}
                  strokeWidth={2}
                  fill="url(#imm-grad)"
                />
                <Line
                  type="monotone"
                  dataKey="rolling"
                  stroke={MUTED}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                />
              </ComposedChart>
            </ChartContainer>
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Active vs idle, last {breakdown.length}
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <BarChart data={breakdown} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="activeMinutes" stackId="a" fill={PRIMARY} radius={[0, 0, 0, 0]} />
              <Bar
                dataKey="idleMinutes"
                stackId="a"
                fill={MUTED}
                fillOpacity={0.5}
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
