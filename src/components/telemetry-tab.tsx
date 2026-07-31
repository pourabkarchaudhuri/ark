import * as React from 'react';
import type { GameSession } from '@/types/game';
import { sessionStore } from '@/services/session-store';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import SessionAnalyticsPanel from '@/components/telemetry/SessionAnalyticsPanel';
import ImmersionPanel from '@/components/telemetry/ImmersionPanel';
import PacingPanel from '@/components/telemetry/PacingPanel';
import FatiguePanel from '@/components/telemetry/FatiguePanel';
import OverheadPanel from '@/components/telemetry/OverheadPanel';
import FrictionPanel from '@/components/telemetry/FrictionPanel';

export type GameSessionLike = GameSession & { activeInputMinutes?: number };

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
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function formatRange(sessions: GameSessionLike[]): string {
  if (sessions.length === 0) return '—';
  const sorted = [...sessions].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );
  const first = formatDate(sorted[0].startTime);
  const last = formatDate(sorted[sorted.length - 1].endTime || sorted[sorted.length - 1].startTime);
  return `${first} → ${last}`;
}

export default function TelemetryTab({
  gameId,
  gameTitle,
  gameCoverUrl,
}: {
  gameId: string;
  gameTitle?: string;
  gameCoverUrl?: string;
}): JSX.Element {
  const [sessions, setSessions] = React.useState<GameSessionLike[]>([]);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      const raw = await Promise.resolve(sessionStore.getForGame(gameId));
      if (alive) setSessions(raw as GameSessionLike[]);
    };
    load();
    return () => {
      alive = false;
    };
  }, [gameId]);

  const totalHours = React.useMemo(
    () => sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0) / 60,
    [sessions],
  );
  const medianSessionMin = React.useMemo(
    () => median(sessions.map((s) => s.durationMinutes || 0)),
    [sessions],
  );
  const rangeLabel = React.useMemo(() => formatRange(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telemetry</CardTitle>
          <CardDescription>Per-session analytics for this title.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            Insufficient data — start a tracked session to populate telemetry.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            {gameCoverUrl ? (
              <img
                src={gameCoverUrl}
                alt=""
                className="h-14 w-10 rounded-sm object-cover border border-border/60"
              />
            ) : null}
            <div>
              <CardTitle>{gameTitle ? `${gameTitle} — Telemetry` : 'Telemetry'}</CardTitle>
              <CardDescription>Per-session analytics for this title.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatTile label="Total hours" value={totalHours.toFixed(1)} />
            <StatTile label="Sessions" value={sessions.length.toLocaleString()} />
            <StatTile label="Median session" value={`${medianSessionMin.toFixed(0)}m`} />
            <StatTile label="Range" value={rangeLabel} />
          </div>
        </CardContent>
      </Card>

      <SessionAnalyticsPanel gameId={gameId} sessions={sessions} />
      <ImmersionPanel gameId={gameId} sessions={sessions} />
      <PacingPanel gameId={gameId} sessions={sessions} />
      <FatiguePanel gameId={gameId} sessions={sessions} />
      <OverheadPanel gameId={gameId} sessions={sessions} />
      <FrictionPanel gameId={gameId} sessions={sessions} />
    </div>
  );
}
