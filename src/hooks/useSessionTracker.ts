import { useState, useEffect, useCallback, useRef } from 'react';
import { GameSession } from '@/types/game';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { sessionStore } from '@/services/session-store';
import { useAutoOnHold } from '@/hooks/useAutoOnHold';

/** Minimum active minutes for a session to trigger the Want-to-Play → Playing transition. */
const AUTO_TRANSITION_MIN_MINUTES = 10;
/** LocalStorage fallback so the renderer can gate the feature before the main-process
 *  IPC bridge lands. Keeps the setting persistable without touching preload.cjs here. */
const AUTO_TRANSITION_LS_KEY = 'ark:autoStatusTransition';

/**
 * Read the opt-in "auto status transition" flag. Prefers the main-process settings
 * bridge (when a future preload wiring exposes `getAutoStatusTransition`); falls
 * back to localStorage, then to `false`. Never throws.
 */
async function isAutoStatusTransitionEnabled(): Promise<boolean> {
  try {
    // Future-safe: if/when preload exposes `window.settings.getAutoStatusTransition`,
    // it wins over the localStorage mirror.
    const bridge = (window as unknown as { settings?: { getAutoStatusTransition?: () => Promise<boolean> | boolean } }).settings;
    if (bridge && typeof bridge.getAutoStatusTransition === 'function') {
      const value = await bridge.getAutoStatusTransition();
      return value === true;
    }
  } catch {
    /* fall through to localStorage */
  }
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem(AUTO_TRANSITION_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Best-effort exe launcher check. Returns `true` when
 * `window.exeInfo.analyze(exePath)` reports `isLikelyLauncher: true`; returns
 * `false` when the exe looks like a real game OR the analyze call fails / the
 * bridge is missing (v1.0.42). Fire-and-forget friendly — non-blocking on the
 * caller's happy path.
 */
async function detectLauncher(exePath: string | undefined | null): Promise<boolean> {
  if (!exePath || typeof window === 'undefined') return false;
  const exeInfo = (window as unknown as {
    exeInfo?: { analyze?: (p: string) => Promise<{ isLikelyLauncher?: boolean } | null> };
  }).exeInfo;
  if (!exeInfo || typeof exeInfo.analyze !== 'function') return false;
  try {
    const info = await exeInfo.analyze(exePath);
    return info?.isLikelyLauncher === true;
  } catch {
    // Honest games should not be punished by a failed analyze — treat any
    // failure as "not a launcher" so the transition still fires.
    return false;
  }
}

/**
 * If the ended session belongs to a library game currently marked "Want to Play"
 * and was long enough to count as real play, promote it to "Playing" and stamp
 * `autoTransitionedAt`. Gated by the opt-in `autoStatusTransition` setting.
 * Custom games are skipped — they live in a different store.
 *
 * v1.0.42 — Before promoting, consult `window.exeInfo.analyze` on the entry's
 * executable. If it looks like a launcher (Steam / EA / Epic client / etc.),
 * skip the transition and stamp `launcherDetected: true` so consumer UI can
 * surface a "that exe is a launcher, tracking may be inaccurate" hint. The
 * analyze call is non-blocking — a failure means we proceed as normal.
 */
async function maybeAutoTransitionStatus(rawSession: GameSession): Promise<void> {
  try {
    const gameId = typeof rawSession.gameId === 'number'
      ? `steam-${rawSession.gameId}`
      : String(rawSession.gameId);

    // Custom games do not live in libraryStore — nothing to transition.
    if (gameId.startsWith('custom-')) return;

    if (!Number.isFinite(rawSession.durationMinutes)) return;
    if (rawSession.durationMinutes < AUTO_TRANSITION_MIN_MINUTES) return;

    const enabled = await isAutoStatusTransitionEnabled();
    if (!enabled) return;

    const entry = libraryStore.getEntry(gameId);
    if (!entry || entry.status !== 'Want to Play') return;

    // v1.0.42 — exe metadata gate. If the tracked exe looks like a launcher,
    // 10+ minutes of "runtime" doesn't mean the game was actually played, so
    // skip the promotion and mark the entry for the UI to warn about.
    const exePath = entry.executablePath ?? rawSession.executablePath;
    const launcher = await detectLauncher(exePath);
    if (launcher) {
      console.warn(
        '[useSessionTracker] Skipped auto-transition: exe looks like a launcher, tracking may be inaccurate.',
      );
      // Persist the detection so downstream UI (Voyage / dashboard) can nudge
      // the user to pick the game's own .exe. Never overwrites status.
      libraryStore.updateEntry(gameId, { launcherDetected: true });
      return;
    }

    libraryStore.updateEntry(gameId, {
      status: 'Playing',
      autoTransitionedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Never let a status-transition failure disturb session recording.
    console.warn('[useSessionTracker] auto-transition skipped:', err);
  }
}

/** Normalise a raw session's gameId (legacy numeric Steam appIds → "steam-N"). */
function normalizeSession(raw: GameSession): GameSession {
  return {
    ...raw,
    gameId: typeof raw.gameId === 'number' ? `steam-${raw.gameId}` : String(raw.gameId),
  };
}

/**
 * Resolve once every store the tracker writes into has finished hydrating.
 * Recording into (or syncing the tracked list from) a half-hydrated store is
 * how sessions used to get lost: hydration replaced the in-memory cache, and
 * an empty library sent `setTrackedGames([])`, which made main finalize every
 * active session as an orphan.
 */
function whenTrackerStoresReady(): Promise<void> {
  return Promise.all([
    libraryStore.ready.catch(() => undefined),
    customGameStore.ready.catch(() => undefined),
    sessionStore.ready.catch(() => undefined),
  ]).then(() => undefined);
}

/**
 * useSessionTracker — connects the renderer to the Electron session tracker.
 *
 * Mounted ONCE at the app root (SessionTrackerProvider in App.tsx), outside
 * the splash "Enter Ark" gate, so tracking works from launch — including a
 * hidden `--hidden` auto-start where nobody ever clicks Enter.
 *
 * Responsibilities:
 * 1. Waits for library / custom-game / session stores to hydrate, then sends
 *    the list of trackable games (exe path set) to the main process.
 * 2. Listens for live status changes (Playing Now / Playing).
 * 3. Records completed sessions (idempotent by id) and ACKs them to main once
 *    they are persisted. Main keeps every un-acked session queued on disk, so
 *    a renderer crash/reload re-delivers them via getRecoveredSessions.
 * 4. Auto-updates hoursPlayed in library store (or custom game store).
 */
export function useSessionTracker() {
  // v1.0.42 — Compose the Playing → On Hold sweep at the same app-root
  // lifecycle. Kept as a hook call (not an effect inside this one) so its own
  // interval is cleaned up independently and unit tests can mount it alone.
  useAutoOnHold();

  const [liveGames, setLiveGames] = useState<Set<string>>(new Set());
  const cleanupRef = useRef<Array<() => void>>([]);

  // Send tracked games list to the main process — stable ref, never changes
  const syncTrackedGames = useCallback(() => {
    if (!window.sessionTracker) return;

    // Library games with executable paths
    const libraryTrackable = libraryStore.getTrackableEntries();

    // Custom games with executable paths
    const customTrackable = customGameStore
      .getAllGames()
      .filter((g) => g.executablePath)
      .map((g) => ({ gameId: g.id, executablePath: g.executablePath! }));

    void window.sessionTracker.setTrackedGames([...libraryTrackable, ...customTrackable]);
  }, []);

  useEffect(() => {
    const tracker = window.sessionTracker;
    if (!tracker) return;

    let disposed = false;
    let storesReady = false;
    /** session:ended events that arrived before the stores hydrated. */
    const buffered: GameSession[] = [];
    const unsubs: Array<() => void> = [];

    // Record a completed session into the store + update hours. Shared by the
    // live "session ended" event and the main-process pending queue.
    // Returns true when the session was new (not a replay).
    const recordCompletedSession = (raw: GameSession): boolean => {
      const session = normalizeSession(raw);
      const isNew = sessionStore.record(session);
      if (!isNew) return false;
      // Read-only session store = it holds only this run's sessions; deriving hours from it
      // would overwrite the library's real total with a few minutes. Leave hours alone.
      if (sessionStore.isReadOnly()) return true;
      const totalHours = sessionStore.getTotalHours(session.gameId);
      const lastPlayedAt = session.endTime;
      if (session.gameId.startsWith('custom-')) {
        if (customGameStore.getGame(session.gameId)) {
          customGameStore.updateHoursFromSessions(session.gameId, totalHours, lastPlayedAt);
        }
      } else {
        libraryStore.updateHoursFromSessions(session.gameId, totalHours, lastPlayedAt);
      }
      return true;
    };

    // ACK only after the session row is actually persisted. In read-only
    // storage mode nothing is persisted, so we never ack — main keeps the
    // sessions queued and the next healthy launch records them.
    const ackPersisted = (ids: string[]) => {
      if (ids.length === 0 || typeof tracker.ackSessions !== 'function') return;
      void sessionStore.persistNow().then(() => {
        const persisted = ids.filter((id) => sessionStore.isPersisted(id));
        if (persisted.length === 0) return;
        return tracker.ackSessions!(persisted);
      }).catch(() => { /* un-acked sessions are simply re-delivered next mount */ });
    };

    const handleEnded = (raw: GameSession) => {
      const isNew = recordCompletedSession(raw);
      if (raw.id) ackPersisted([raw.id]);
      // v1.0.41 — opt-in auto Want-to-Play → Playing transition.
      // Kept fire-and-forget so it can never stall session persistence.
      if (isNew) void maybeAutoTransitionStatus(raw);
    };

    // Hydrate liveGames with any sessions already running in the main process
    // (covers app reload / renderer crash where main kept polling but the
    // renderer lost its in-memory state).
    tracker.getActiveSessions().then((active) => {
      if (disposed || !active || active.length === 0) return;
      setLiveGames((prev) => {
        const next = new Set(prev);
        for (const s of active) {
          const gid = typeof s.gameId === 'number' ? `steam-${s.gameId}` : String(s.gameId);
          next.add(gid);
        }
        return next;
      });
    }).catch(() => { /* non-critical — fresh start has no sessions */ });

    // Listen for live status changes
    unsubs.push(tracker.onStatusChange((data) => {
      const gameId = typeof data.gameId === 'number' ? `steam-${data.gameId}` : String(data.gameId);
      setLiveGames((prev) => {
        const next = new Set(prev);
        if (data.status === 'Playing Now') {
          next.add(gameId);
        } else {
          next.delete(gameId);
        }
        return next;
      });
    }));

    // Listen for live playtime updates (every 15s while game is running)
    unsubs.push(tracker.onLiveUpdate((data) => {
      if (!storesReady) return; // next tick (15s) will carry the running total
      if (sessionStore.isReadOnly()) return; // see recordCompletedSession
      const gameId = typeof data.gameId === 'number' ? `steam-${data.gameId}` : String(data.gameId);
      const activeMinutes = data.activeMinutes;
      const previousHours = sessionStore.getTotalHours(gameId);
      const liveSessionTotal = previousHours + activeMinutes / 60;

      if (gameId.startsWith('custom-')) {
        const existing = customGameStore.getGame(gameId);
        if (existing) {
          customGameStore.updateHoursFromSessions(gameId, liveSessionTotal);
        }
      } else {
        libraryStore.updateHoursFromSessions(gameId, liveSessionTotal);
      }
    }));

    // Listen for completed sessions — buffered until the stores are hydrated.
    unsubs.push(tracker.onSessionEnded((data) => {
      if (!storesReady) {
        buffered.push(data.session);
        return;
      }
      handleEnded(data.session);
    }));

    void whenTrackerStoresReady().then(() => {
      if (disposed) return;
      storesReady = true;

      // Initial sync — send the (now hydrated) tracked games list to main.
      syncTrackedGames();
      // Re-sync whenever the library or custom games change (general channel
      // only — hours ticks don't change exe paths).
      unsubs.push(libraryStore.subscribe(syncTrackedGames));
      unsubs.push(customGameStore.subscribe(syncTrackedGames));

      // Events that raced hydration.
      for (const s of buffered.splice(0)) handleEnded(s);

      // Every session main still holds un-acked: crashed-run recoveries plus
      // live-ended sessions a crashed/reloading renderer never recorded.
      tracker.getRecoveredSessions?.().then((pending) => {
        if (disposed || !pending || pending.length === 0) return;
        const ids: string[] = [];
        for (const s of pending) {
          recordCompletedSession(s);
          if (s.id) ids.push(s.id);
        }
        ackPersisted(ids);
      }).catch(() => { /* non-critical — retried on next mount */ });
    });

    cleanupRef.current = unsubs;

    return () => {
      disposed = true;
      // Only detach the listeners this effect registered. Do NOT call the global
      // removeAllListeners() — that wipes every session:* listener for the whole
      // process and previously caused completed sessions to be silently dropped
      // whenever this hook unmounted (e.g. navigating off the dashboard).
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
  }, [syncTrackedGames]);

  /**
   * Check if a game is currently being played (exe is running).
   * Accepts both numeric Steam appId (for backwards compat) and string gameId.
   */
  const isPlayingNow = useCallback(
    (gameId: number | string) => {
      const key = typeof gameId === 'number' ? `steam-${gameId}` : gameId;
      return liveGames.has(key);
    },
    [liveGames]
  );

  return {
    /** Set of gameIds whose executables are currently running */
    liveGames,
    /** Check if a specific game is live */
    isPlayingNow,
  };
}
