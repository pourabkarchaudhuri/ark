import { useEffect, useRef, useState, useCallback } from 'react';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';

/**
 * OverlayHud — the minimal in-game corner HUD (v1).
 *
 * Renders in its own transparent, click-through, always-on-top BrowserWindow
 * (overlay.html). It is fully event-driven off the existing `session:*` stream
 * exposed on `window.sessionTracker` (see electron/preload.cjs) — it adds NO
 * new tracking logic. Because the overlay shares the same origin as the main
 * window, `libraryStore` / `customGameStore` (localStorage-backed) are readable
 * here for resolving a gameId to its display name.
 *
 * Content: an "ARK — tracking" badge, the game name, and a locally-interpolated
 * HH:MM:SS active-time timer. Fades in on `session:started`, fades out on that
 * game's `session:ended` or `statusChange -> 'Playing'`.
 */

// ─── sessionTracker bridge shape (mirrors electron/preload.cjs) ───────────────
// The overlay is a separate Vite entry, so we can't rely on the main window's
// global `Window` augmentation being loaded here. Type the bits we use locally.

type Unsubscribe = () => void;

interface SessionStartedPayload {
  gameId: number | string;
  // The main process emits an ISO-8601 string (see electron/session-tracker.ts
  // `sendToRenderer('session:started', …)`); tolerate an epoch-ms number too.
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
  // getActiveSessions() (IPC `session:getActive`) returns startTime as an ISO
  // string and the accrued time as `elapsedMinutes` (see electron/session-tracker.ts).
  // Kept permissive so either the string/number or minutes field can be used.
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

/** Normalize gameId the way the rest of the app does (numeric appId → "steam-<id>"). */
function normalizeGameId(id: number | string): string {
  return typeof id === 'number' ? `steam-${id}` : String(id);
}

/** Coerce an epoch-ms number or an ISO date string to epoch ms (0 if unparseable). */
function toEpochMs(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Resolve a gameId to a human-readable display name using the shared stores. */
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
    /* fall through to the id */
  }
  return gameId;
}

/** Format a whole number of seconds as HH:MM:SS. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** How long the fade-out animation runs before we drop the game from state. */
const FADE_OUT_MS = 320;

interface DisplayedGame {
  gameId: string;
  name: string;
}

export function OverlayHud() {
  const [game, setGame] = useState<DisplayedGame | null>(null);
  const [visible, setVisible] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Authoritative time anchor for the currently-displayed game. `activeSeconds`
  // is the last known active time (from session:started's startTime or a
  // session:liveUpdate), captured at `anchoredAt` (performance/Date.now()).
  // The 1s interval interpolates from here so the timer stays smooth between
  // the ~15s live-update ticks.
  const anchorRef = useRef<{ gameId: string; activeSeconds: number; anchoredAt: number } | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  /** Begin (or refresh) showing a game. Anchors the timer from `startTime`. */
  const showGame = useCallback((gameId: string, startTime: number) => {
    clearFadeTimer();
    const activeSeconds = startTime > 0 ? Math.max(0, (Date.now() - startTime) / 1000) : 0;
    anchorRef.current = { gameId, activeSeconds, anchoredAt: Date.now() };
    setGame({ gameId, name: resolveGameName(gameId) });
    setElapsedSeconds(activeSeconds);
    setVisible(true);
  }, [clearFadeTimer]);

  /** Fade the HUD out for `gameId`, then drop it from state. No-op for others. */
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

  // Subscribe to the session event stream.
  useEffect(() => {
    const bridge = (window as unknown as { sessionTracker?: SessionTrackerBridge }).sessionTracker;
    if (!bridge) return;

    // Hydrate from any session already running (covers overlay reload / late show).
    bridge.getActiveSessions?.()
      .then((active) => {
        if (!active || active.length === 0) return;
        // v1: show the first active session.
        const first = active[0];
        const gid = normalizeGameId(first.gameId);
        // Prefer the authoritative startTime (ISO string or epoch ms); fall back
        // to deriving it from the accrued minutes if a start timestamp is absent.
        const startMs = toEpochMs(first.startTime);
        const start = startMs > 0
          ? startMs
          : Date.now() - (first.elapsedMinutes ?? first.activeMinutes ?? 0) * 60_000;
        showGame(gid, start);
      })
      .catch(() => { /* fresh start — no active sessions */ });

    const unsubStarted = bridge.onSessionStarted((data) => {
      showGame(normalizeGameId(data.gameId), toEpochMs(data.startTime));
    });

    const unsubLive = bridge.onLiveUpdate((data) => {
      const gid = normalizeGameId(data.gameId);
      // Only re-sync the game we're currently displaying.
      if (anchorRef.current?.gameId !== gid) return;
      const activeSeconds = Math.max(0, (data.activeMinutes ?? 0) * 60);
      anchorRef.current = { gameId: gid, activeSeconds, anchoredAt: Date.now() };
      setElapsedSeconds(activeSeconds);
    });

    const unsubStatus = bridge.onStatusChange((data) => {
      // A transition back to plain "Playing" means the exe is no longer running.
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

  // Local 1s interpolation — keeps ticking between the ~15s liveUpdate syncs.
  // Relies on backgroundThrottling:false on the overlay window (set in main).
  useEffect(() => {
    if (!game) return;
    const tick = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const extra = (Date.now() - anchor.anchoredAt) / 1000;
      setElapsedSeconds(anchor.activeSeconds + extra);
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [game]);

  useEffect(() => () => clearFadeTimer(), [clearFadeTimer]);

  // Keep the card mounted through the fade-out (game stays set until the timer
  // fires); only skip rendering when there's truly nothing to show.
  if (!game) return null;

  return (
    <div className="ark-overlay-root">
      <div className={`ark-overlay-card${visible ? ' is-visible' : ''}`}>
        <span className="ark-overlay-badge">
          <span className="ark-overlay-badge-dot" />
          ARK — tracking
        </span>
        <span className="ark-overlay-name" title={game.name}>{game.name}</span>
        <span className="ark-overlay-timer">{formatDuration(elapsedSeconds)}</span>
      </div>
    </div>
  );
}
