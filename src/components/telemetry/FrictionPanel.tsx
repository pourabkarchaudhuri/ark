import * as React from 'react';
import {
  ScatterChart,
  Scatter,
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
import { useTrackerOverhead } from '@/hooks/useTrackerOverhead';
import type { OverheadSample } from '@/services/tracker-overhead-store';
import {
  frictionAnomalies,
  pearson,
  type FrictionAnomaly,
} from '@/services/telemetry-derivations';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

/** Live insights: one in-progress session + samples is enough to chart anomalies. */
const MIN_SESSIONS = 1;
const PRIMARY = 'hsl(var(--primary))';

const SESSION_HUES = ['210', '30', '150', '280', '350', '90'];

const chartConfig: ChartConfig = {
  points: { label: 'Anomalies', color: PRIMARY },
};

interface ScatterRow {
  latencyMs: number;
  idleDeltaMinutes: number;
  sessionId: string;
  sessionColor: string;
  timestamp: number;
  sessionDate: number;
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

function formatTs(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${d
    .getHours()
    .toString()
    .padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${(d.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

interface SessionSpan {
  session: GameSessionLike;
  start: number;
  end: number;
}

function nearestSession(spans: SessionSpan[], t: number): SessionSpan | null {
  if (spans.length === 0) return null;
  const inside = spans.find((s) => t >= s.start && t <= s.end);
  if (inside) return inside;
  let best: SessionSpan | null = null;
  let bestDist = Infinity;
  for (const s of spans) {
    const distance = t < s.start ? s.start - t : t - s.end;
    if (distance < bestDist) {
      bestDist = distance;
      best = s;
    }
  }
  return best;
}

export default function FrictionPanel({
  gameId,
  sessions,
}: {
  gameId: string;
  sessions: GameSessionLike[];
}): JSX.Element {
  const samples: OverheadSample[] = useTrackerOverhead(gameId);

  const spans: SessionSpan[] = React.useMemo(() => {
    const out: SessionSpan[] = [];
    const now = Date.now();
    for (const s of sessions) {
      const start = toDate(s.startTime).getTime();
      // Open (in-progress) sessions must span through "now" so live samples match.
      const end = s.endTime ? toDate(s.endTime).getTime() : now;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        out.push({ session: s, start, end });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }, [sessions]);

  const sessionColor = React.useCallback(
    (sessionId: string): string => {
      const idx = sessions.findIndex((s) => s.id === sessionId);
      const bucket = ((idx >= 0 ? idx : 0) % SESSION_HUES.length + SESSION_HUES.length) %
        SESSION_HUES.length;
      return `hsl(${SESSION_HUES[bucket]}, 65%, 55%)`;
    },
    [sessions],
  );

  const anomalies: FrictionAnomaly[] = React.useMemo(
    () => frictionAnomalies(samples, sessions),
    [samples, sessions],
  );

  const scatter: ScatterRow[] = React.useMemo(
    () =>
      anomalies.map((a) => ({
        latencyMs: a.latencyMs,
        idleDeltaMinutes: a.idleDeltaMinutes,
        sessionId: a.sessionId,
        sessionColor: sessionColor(a.sessionId),
        timestamp: a.timestamp,
        sessionDate: a.sessionDate.getTime(),
      })),
    [anomalies, sessionColor],
  );

  const { pearsonR, sessionsWithAnomaly, latencyIdlePairs } = React.useMemo(() => {
    const pairsX: number[] = [];
    const pairsY: number[] = [];
    for (const sample of samples) {
      if (!Number.isFinite(sample.hookLatencyMs)) continue;
      const span = nearestSession(spans, sample.timestamp);
      if (!span) continue;
      const idle = Math.max(0, span.session.idleMinutes ?? 0);
      pairsX.push(sample.hookLatencyMs);
      pairsY.push(idle);
    }
    const r = pearson(pairsX, pairsY);
    const set = new Set<string>();
    for (const a of anomalies) set.add(a.sessionId);
    return {
      pearsonR: r,
      sessionsWithAnomaly: set.size,
      latencyIdlePairs: pairsX.length,
    };
  }, [samples, spans, anomalies]);

  if (sessions.length < MIN_SESSIONS) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Friction</CardTitle>
          <CardDescription>Hook latency spikes joined to idle deltas per session.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Correlation needs at least one tracked session with overhead samples.
          </div>
        </CardContent>
      </Card>
    );
  }

  const rows = anomalies.slice(0, 20);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Friction</CardTitle>
        <CardDescription>Hook latency spikes joined to idle deltas per session.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label="Anomalies detected" value={anomalies.length.toLocaleString()} />
          <StatTile label="Pearson r" value={pearsonR.toFixed(2)} />
          <StatTile label="Sessions with >= 1" value={sessionsWithAnomaly.toLocaleString()} />
          <StatTile label="Samples analyzed" value={latencyIdlePairs.toLocaleString()} />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Latency (ms) × idle delta (min)
          </div>
          <ChartContainer config={chartConfig} className="aspect-[3/1] w-full">
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="latencyMs"
                name="latency"
                unit="ms"
                tickLine={false}
                axisLine={false}
                fontSize={10}
              />
              <YAxis
                type="number"
                dataKey="idleDeltaMinutes"
                name="idle delta"
                unit="m"
                tickLine={false}
                axisLine={false}
                fontSize={10}
                width={40}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Scatter data={scatter}>
                {scatter.map((row, i) => (
                  <Cell key={`${row.sessionId}-${i}`} fill={row.sessionColor} />
                ))}
              </Scatter>
            </ScatterChart>
          </ChartContainer>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Recent anomalies
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Timestamp</th>
                  <th className="py-1 pr-3 font-medium">Latency ms</th>
                  <th className="py-1 pr-3 font-medium">Idle delta</th>
                  <th className="py-1 font-medium">Session date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.sessionId}-${r.timestamp}-${i}`} className="border-b border-border/30">
                    <td className="py-1 pr-3 tabular-nums">{formatTs(r.timestamp)}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.latencyMs.toFixed(1)} ms</td>
                    <td className="py-1 pr-3 tabular-nums">
                      {r.idleDeltaMinutes >= 0 ? '+' : ''}
                      {r.idleDeltaMinutes.toFixed(1)}m
                    </td>
                    <td className="py-1 tabular-nums">{formatDay(r.sessionDate.getTime())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
