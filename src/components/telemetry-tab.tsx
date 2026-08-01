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
import { useTrackerOverhead } from '@/hooks/useTrackerOverhead';

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

function liveSessionId(gameId: string): string {
  return `live-${gameId}`;
}

function toGameId(raw: string | number): string {
  return typeof raw === 'number' ? `steam-${raw}` : String(raw);
}

/** Coalesce live-minute updates so six Recharts panels don't rebuild every poll. */
const LIVE_SESSION_UI_THROTTLE_MS = 5000;

export default function TelemetryTab({
  gameId,
  gameTitle,
  gameCoverUrl,
}: {
  gameId: string;
  gameTitle?: string;
  gameCoverUrl?: string;
}): JSX.Element {
  const [completedSessions, setCompletedSessions] = React.useState<GameSessionLike[]>([]);
  const [liveSession, setLiveSession] = React.useState<GameSessionLike | null>(null);
  const overheadSamples = useTrackerOverhead(gameId);
  const liveThrottleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLiveRef = React.useRef<{ startTime: string; activeMinutes: number } | null>(null);
  const liveStartRef = React.useRef<string | null>(null);

  // Completed history — subscribe so a session recorded while the tab is open
  // reaches the panels without a remount.
  React.useEffect(() => {
    let alive = true;
    let lastKey = '';

    const load = () => {
      const raw = sessionStore.getForGame(gameId) as GameSessionLike[];
      const key = raw
        .map((s) => `${s.id}:${s.endTime ?? ''}:${s.durationMinutes ?? 0}`)
        .join('|');
      if (!alive || key === lastKey) return;
      lastKey = key;
      setCompletedSessions(raw);
    };

    load();
    const unsubscribe = sessionStore.subscribe(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [gameId]);

  // In-progress session from the existing sessionTracker bridge (no new polls).
  React.useEffect(() => {
    let alive = true;
    const bridge = typeof window !== 'undefined' ? window.sessionTracker : undefined;
    if (!bridge) {
      setLiveSession(null);
      return;
    }

    const flushLive = () => {
      liveThrottleRef.current = null;
      const pending = pendingLiveRef.current;
      if (!alive || !pending) return;
      pendingLiveRef.current = null;
      liveStartRef.current = pending.startTime;
      setLiveSession({
        id: liveSessionId(gameId),
        gameId,
        executablePath: '',
        startTime: pending.startTime,
        endTime: '',
        durationMinutes: Math.max(0, pending.activeMinutes),
        idleMinutes: 0,
      });
    };

    /** Immediate for start/hydrate; coalesced for 15s live ticks. */
    const applyLive = (startTime: string, activeMinutes: number, immediate = false) => {
      if (!alive) return;
      pendingLiveRef.current = { startTime, activeMinutes };
      if (immediate) {
        if (liveThrottleRef.current != null) {
          clearTimeout(liveThrottleRef.current);
          liveThrottleRef.current = null;
        }
        flushLive();
        return;
      }
      if (liveThrottleRef.current != null) return;
      liveThrottleRef.current = setTimeout(flushLive, LIVE_SESSION_UI_THROTTLE_MS);
    };

    const clearLive = () => {
      if (!alive) return;
      pendingLiveRef.current = null;
      liveStartRef.current = null;
      if (liveThrottleRef.current != null) {
        clearTimeout(liveThrottleRef.current);
        liveThrottleRef.current = null;
      }
      setLiveSession(null);
    };

    bridge.getActiveSessions?.()
      .then((active) => {
        if (!alive || !active) return;
        const match = active.find((s) => toGameId(s.gameId) === gameId);
        if (match) {
          applyLive(match.startTime, match.elapsedMinutes ?? 0, true);
        } else {
          clearLive();
        }
      })
      .catch(() => {
        /* non-critical */
      });

    const unsubs: Array<() => void> = [];

    if (typeof bridge.onSessionStarted === 'function') {
      unsubs.push(
        bridge.onSessionStarted((data) => {
          if (toGameId(data.gameId) !== gameId) return;
          applyLive(data.startTime, 0, true);
        }),
      );
    }

    if (typeof bridge.onLiveUpdate === 'function') {
      unsubs.push(
        bridge.onLiveUpdate((data) => {
          if (toGameId(data.gameId) !== gameId) return;
          const startTime =
            liveStartRef.current ??
            pendingLiveRef.current?.startTime ??
            new Date().toISOString();
          applyLive(startTime, data.activeMinutes ?? 0, false);
        }),
      );
    }

    if (typeof bridge.onSessionEnded === 'function') {
      unsubs.push(
        bridge.onSessionEnded((data) => {
          if (toGameId(data.gameId) !== gameId) return;
          clearLive();
        }),
      );
    }

    if (typeof bridge.onStatusChange === 'function') {
      unsubs.push(
        bridge.onStatusChange((data) => {
          if (toGameId(data.gameId) !== gameId) return;
          if (data.status !== 'Playing Now') clearLive();
        }),
      );
    }

    return () => {
      alive = false;
      if (liveThrottleRef.current != null) {
        clearTimeout(liveThrottleRef.current);
        liveThrottleRef.current = null;
      }
      pendingLiveRef.current = null;
      unsubs.forEach((fn) => fn());
    };
  }, [gameId]);

  const sessions = React.useMemo(() => {
    if (!liveSession) return completedSessions;
    const withoutDup = completedSessions.filter((s) => s.id !== liveSession.id);
    return [...withoutDup, liveSession];
  }, [completedSessions, liveSession]);

  const totalHours = React.useMemo(
    () => sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0) / 60,
    [sessions],
  );
  const medianSessionMin = React.useMemo(
    () => median(sessions.map((s) => s.durationMinutes || 0)),
    [sessions],
  );
  const rangeLabel = React.useMemo(() => formatRange(sessions), [sessions]);

  // False empty-state fix: completed history is empty while a game is mid-session
  // (sessions are only recorded on end). Live session + overhead samples count.
  const hasLiveSignal = liveSession != null || overheadSamples.length > 0;
  if (sessions.length === 0 && !hasLiveSignal) {
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
              <CardDescription>
                {liveSession
                  ? 'Live session in progress — overhead updates every few seconds.'
                  : 'Per-session analytics for this title.'}
              </CardDescription>
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
