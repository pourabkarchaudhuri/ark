import { useEffect, useRef, useState, useCallback } from 'react';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import {
  DEFAULT_OVERLAY_DETAIL_LEVEL,
  OVERLAY_SHORTCUT_HINT_LABEL,
  coerceOverlayDetailLevel,
  type OverlayDetailLevel,
} from './detail-level';

/**
 * OverlayHud — minimal translucent in-game corner HUD.
 *
 * Detail levels (cycled via Shift+Win+D / Super+Shift+D from the main process):
 *  - collapsed: tiny live pill
 *  - compact: game name + timer + shortcut hint
 *
 * Event-driven off `window.sessionTracker` — no new tracking logic.
 * Click-through is enforced by the BrowserWindow (no mouse forwarding).
 */

// ─── sessionTracker bridge shape (mirrors electron/preload.cjs) ───────────────

type Unsubscribe = () => void;

interface SessionStartedPayload {
  gameId: number | string;
  startTime: number | string;
}
interface LiveUpdatePayload {
  gameId: number | string;
  activeMinutes: number;
}
interface StatusChangePayload {
  gameId: number | string;
  status: 'Playing Now' | 'Playing';
}
interface SessionEndedPayload {
  gameId: number | string;
  session?: unknown;
}
interface ActiveSession {
  gameId: number | string;
  startTime?: number | string;
  elapsedMinutes?: number;
  activeMinutes?: number;
}

interface SessionTrackerBridge {
  onSessionStarted: (cb: (data: SessionStartedPayload) => void) => Unsubscribe;
  onLiveUpdate: (cb: (data: LiveUpdatePayload) => void) => Unsubscribe;
  onStatusChange: (cb: (data: StatusChangePayload) => void) => Unsubscribe;
  onSessionEnded: (cb: (data: SessionEndedPayload) => void) => Unsubscribe;
  getActiveSessions: () => Promise<ActiveSession[]>;
}

interface OverlayHudBridge {
  onDetailLevel: (cb: (level: OverlayDetailLevel | string) => void) => Unsubscribe;
}

function normalizeGameId(id: number | string): string {
  return typeof id === 'number' ? `steam-${id}` : String(id);
}

function toEpochMs(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function resolveGameName(gameId: string): string {
  try {
    if (gameId.startsWith('custom-')) {
      const custom = customGameStore.getGame(gameId);
      if (custom?.title) return custom.title;
    } else {
      const entry = libraryStore.getEntry(gameId);
      const title = entry?.cachedMeta?.title?.trim();
      if (title) return title;
    }
  } catch {
    /* fall through */
  }
  return gameId;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** Short MM:SS when under an hour; otherwise HH:MM:SS. */
function formatCompactDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 3600) {
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return formatDuration(s);
}

const FADE_OUT_MS = 320;

interface DisplayedGame {
  gameId: string;
  name: string;
}

export function OverlayHud() {
  const [game, setGame] = useState<DisplayedGame | null>(null);
  const [visible, setVisible] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [detailLevel, setDetailLevel] = useState<OverlayDetailLevel>(DEFAULT_OVERLAY_DETAIL_LEVEL);

  const anchorRef = useRef<{ gameId: string; activeSeconds: number; anchoredAt: number } | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const showGame = useCallback((gameId: string, startTime: number) => {
    clearFadeTimer();
    const activeSeconds = startTime > 0 ? Math.max(0, (Date.now() - startTime) / 1000) : 0;
    anchorRef.current = { gameId, activeSeconds, anchoredAt: Date.now() };
    setGame({ gameId, name: resolveGameName(gameId) });
    setElapsedSeconds(activeSeconds);
    setVisible(true);
  }, [clearFadeTimer]);

  const hideGame = useCallback((gameId: string) => {
    if (anchorRef.current?.gameId !== gameId) return;
    setVisible(false);
    clearFadeTimer();
    fadeTimerRef.current = setTimeout(() => {
      anchorRef.current = null;
      setGame(null);
      setElapsedSeconds(0);
    }, FADE_OUT_MS);
  }, [clearFadeTimer]);

  // Detail level from main-process hotkey (Super+Shift+D / Shift+Win+D).
  useEffect(() => {
    const bridge = (window as unknown as { overlayHud?: OverlayHudBridge }).overlayHud;
    if (!bridge?.onDetailLevel) return;
    return bridge.onDetailLevel((level) => {
      setDetailLevel(coerceOverlayDetailLevel(level));
    });
  }, []);

  useEffect(() => {
    const bridge = (window as unknown as { sessionTracker?: SessionTrackerBridge }).sessionTracker;
    if (!bridge) return;

    bridge.getActiveSessions?.()
      .then((active) => {
        if (!active || active.length === 0) return;
        const first = active[0];
        const gid = normalizeGameId(first.gameId);
        const startMs = toEpochMs(first.startTime);
        const start = startMs > 0
          ? startMs
          : Date.now() - (first.elapsedMinutes ?? first.activeMinutes ?? 0) * 60_000;
        showGame(gid, start);
      })
      .catch(() => { /* fresh start */ });

    const unsubStarted = bridge.onSessionStarted((data) => {
      showGame(normalizeGameId(data.gameId), toEpochMs(data.startTime));
    });

    const unsubLive = bridge.onLiveUpdate((data) => {
      const gid = normalizeGameId(data.gameId);
      if (anchorRef.current?.gameId !== gid) return;
      const activeSeconds = Math.max(0, (data.activeMinutes ?? 0) * 60);
      anchorRef.current = { gameId: gid, activeSeconds, anchoredAt: Date.now() };
      setElapsedSeconds(activeSeconds);
    });

    const unsubStatus = bridge.onStatusChange((data) => {
      if (data.status === 'Playing') hideGame(normalizeGameId(data.gameId));
    });

    const unsubEnded = bridge.onSessionEnded((data) => {
      hideGame(normalizeGameId(data.gameId));
    });

    return () => {
      unsubStarted?.();
      unsubLive?.();
      unsubStatus?.();
      unsubEnded?.();
    };
  }, [showGame, hideGame]);

  // Local 1s interpolation — only while compact (collapsed has no clock).
  useEffect(() => {
    if (!game || detailLevel === 'collapsed') return;
    const tick = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const extra = (Date.now() - anchor.anchoredAt) / 1000;
      setElapsedSeconds(anchor.activeSeconds + extra);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [game, detailLevel]);

  useEffect(() => () => clearFadeTimer(), [clearFadeTimer]);

  if (!game) return null;

  const levelClass = `level-${detailLevel}`;

  return (
    <div className="ark-overlay-root">
      <div
        className={`ark-overlay-card ${levelClass}${visible ? ' is-visible' : ''}`}
        data-level={detailLevel}
      >
        {/* Collapsed: live pill only */}
        <div className="ark-overlay-layer ark-overlay-collapsed" aria-hidden={detailLevel !== 'collapsed'}>
          <span className="ark-overlay-pill">
            <span className="ark-overlay-badge-dot" />
            <span className="ark-overlay-pill-label">ARK</span>
          </span>
        </div>

        {/* Compact: name + short timer + one-line shortcut footer */}
        <div className="ark-overlay-layer ark-overlay-compact" aria-hidden={detailLevel !== 'compact'}>
          <span className="ark-overlay-row">
            <span className="ark-overlay-badge-dot" />
            <span className="ark-overlay-name" title={game.name}>{game.name}</span>
          </span>
          <span className="ark-overlay-timer ark-overlay-timer--compact">
            {formatCompactDuration(elapsedSeconds)}
          </span>
          <span className="ark-overlay-hint" aria-hidden="true">{OVERLAY_SHORTCUT_HINT_LABEL}</span>
        </div>
      </div>
    </div>
  );
}
