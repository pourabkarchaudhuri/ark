import * as React from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
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
import { useTrackerOverhead } from '@/hooks/useTrackerOverhead';
import type { OverheadSample } from '@/services/tracker-overhead-store';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

const MIN_SAMPLES = 1;
const PRIMARY = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

const chartConfig: ChartConfig = {
  v: { label: 'Value', color: PRIMARY },
};

interface SeriesPoint {
  t: number;
  v: number;
}

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

function formatTs(t: number): string {
  const d = new Date(t);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export default function OverheadPanel({
  gameId,
}: {
  gameId: string;
  sessions?: GameSessionLike[];
}): JSX.Element {
  const samples: OverheadSample[] = useTrackerOverhead(gameId);

  const {
    cpuSeries,
    memSeries,
    latencySeries,
    peakCpu,
    peakMem,
    p50,
    p95,
  } = React.useMemo(() => {
    const cpu: SeriesPoint[] = samples.map((s) => ({ t: s.timestamp, v: s.cpuPercent }));
    const mem: SeriesPoint[] = samples.map((s) => ({ t: s.timestamp, v: s.rssMb }));
    const latency: SeriesPoint[] = samples.map((s) => ({
      t: s.timestamp,
      v: s.hookLatencyMs,
    }));
    const latenciesSorted = samples
      .map((s) => s.hookLatencyMs)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    let maxCpu = 0;
    let maxMem = 0;
    for (const s of samples) {
      if (s.cpuPercent > maxCpu) maxCpu = s.cpuPercent;
      if (s.rssMb > maxMem) maxMem = s.rssMb;
    }
    return {
      cpuSeries: cpu,
      memSeries: mem,
      latencySeries: latency,
      peakCpu: maxCpu,
      peakMem: maxMem,
      p50: percentile(latenciesSorted, 50),
      p95: percentile(latenciesSorted, 95),
    };
  }, [samples]);

  if (samples.length < MIN_SAMPLES) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tracker overhead</CardTitle>
          <CardDescription>CPU, memory, and hook latency of the tracker process.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Sampling starts when a session begins.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tracker overhead</CardTitle>
        <CardDescription>CPU, memory, and hook latency of the tracker process.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Peak CPU" value={`${peakCpu.toFixed(2)}%`} />
          <StatTile label="Peak RAM" value={`${peakMem.toFixed(0)} MB`} />
          <StatTile label="Median latency" value={`${p50.toFixed(1)} ms`} />
          <StatTile label="P95 latency" value={`${p95.toFixed(1)} ms`} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              CPU %
            </div>
            <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
              <AreaChart data={cpuSeries} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="cpu-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  tickFormatter={(v: number) => formatTs(v)}
                />
                <YAxis tickLine={false} axisLine={false} fontSize={10} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke={PRIMARY}
                  strokeWidth={2}
                  fill="url(#cpu-grad)"
                />
              </AreaChart>
            </ChartContainer>
          </div>

          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              RSS MB
            </div>
            <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
              <AreaChart data={memSeries} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="mem-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  tickFormatter={(v: number) => formatTs(v)}
                />
                <YAxis tickLine={false} axisLine={false} fontSize={10} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke={PRIMARY}
                  strokeWidth={2}
                  fill="url(#mem-grad)"
                />
              </AreaChart>
            </ChartContainer>
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Hook latency (ms)
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <LineChart data={latencySeries} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                tickLine={false}
                axisLine={false}
                fontSize={10}
                tickFormatter={(v: number) => formatTs(v)}
              />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={32} />
              <ReferenceLine
                y={p50}
                stroke={MUTED}
                strokeDasharray="4 4"
                strokeOpacity={0.6}
                label={{ value: 'p50', fontSize: 9, fill: MUTED, position: 'right' }}
              />
              <ReferenceLine
                y={p95}
                stroke={MUTED}
                strokeDasharray="2 3"
                strokeOpacity={0.6}
                label={{ value: 'p95', fontSize: 9, fill: MUTED, position: 'right' }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="monotone"
                dataKey="v"
                stroke={PRIMARY}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
