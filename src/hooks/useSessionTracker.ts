import { useState, useEffect, useCallback, useRef } from 'react';
import { GameSession } from '@/types/game';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { sessionStore } from '@/services/session-store';

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
 * If the ended session belongs to a library game currently marked "Want to Play"
 * and was long enough to count as real play, promote it to "Playing" and stamp
 * `autoTransitionedAt`. Gated by the opt-in `autoStatusTransition` setting.
 * Custom games are skipped — they live in a different store.
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

    libraryStore.updateEntry(gameId, {
      status: 'Playing',
      autoTransitionedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Never let a status-transition failure disturb session recording.
    console.warn('[useSessionTracker] auto-transition skipped:', err);
  }
}

/**
 * useSessionTracker — connects the renderer to the Electron session tracker.
 *
 * Responsibilities:
 * 1. Sends the list of trackable games (those with executablePath) to the main process
 *    — includes both library games AND custom games
 * 2. Listens for live status changes (Playing Now / Playing) and tracks which games are live
 * 3. Records completed sessions to the session store
 * 4. Auto-updates hoursPlayed in library store (or custom game store for "custom-" IDs)
 */
export function useSessionTracker() {
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

    window.sessionTracker.setTrackedGames([...libraryTrackable, ...customTrackable]);
  }, []);

  useEffect(() => {
    if (!window.sessionTracker) return;

    // Initial sync — send tracked games list to the main process
    syncTrackedGames();

    // Hydrate liveGames with any sessions already running in the main process
    // (covers app reload / HMR where the main process kept polling but the
    // renderer lost its in-memory state).
    window.sessionTracker.getActiveSessions().then((active) => {
      if (!active || active.length === 0) return;
      setLiveGames((prev) => {
        const next = new Set(prev);
        for (const s of active) {
          const gid = typeof s.gameId === 'number' ? `steam-${s.gameId}` : String(s.gameId);
          next.add(gid);
        }
        return next;
      });
    }).catch(() => { /* non-critical — fresh start has no sessions */ });

    // Record a completed session into the store + update hours. Shared by both
    // the live "session ended" event and crash-recovered sessions.
    const recordCompletedSession = (raw: GameSession) => {
      const session: GameSession = {
        ...raw,
        gameId: typeof raw.gameId === 'number' ? `steam-${raw.gameId}` : String(raw.gameId),
      };
      sessionStore.record(session);
      const totalHours = sessionStore.getTotalHours(session.gameId);
      const lastPlayedAt = session.endTime;
      if (session.gameId.startsWith('custom-')) {
        if (customGameStore.getGame(session.gameId)) {
          customGameStore.updateHoursFromSessions(session.gameId, totalHours, lastPlayedAt);
        }
      } else {
        libraryStore.updateHoursFromSessions(session.gameId, totalHours, lastPlayedAt);
      }
    };

    // Drain any sessions recovered from a previous crashed/force-killed run so
    // their playtime is not lost.
    window.sessionTracker.getRecoveredSessions?.().then((recovered) => {
      if (!recovered || recovered.length === 0) return;
      for (const s of recovered) recordCompletedSession(s);
    }).catch(() => { /* non-critical */ });

    // Re-sync whenever the library or custom games change
    const unsubLibrary = libraryStore.subscribe(syncTrackedGames);
    const unsubCustom = customGameStore.subscribe(syncTrackedGames);

    // Listen for live status changes
    const unsubStatus = window.sessionTracker.onStatusChange((data) => {
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
    });

    // Listen for live playtime updates (every 15s while game is running)
    const unsubLive = window.sessionTracker.onLiveUpdate((data) => {
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
    });

    // Listen for completed sessions
    const unsubEnded = window.sessionTracker.onSessionEnded((data) => {
      recordCompletedSession(data.session);
      // v1.0.41 — opt-in auto Want-to-Play → Playing transition.
      // Kept fire-and-forget so it can never stall session persistence.
      void maybeAutoTransitionStatus(data.session);
    });

    cleanupRef.current = [unsubLibrary, unsubCustom, unsubStatus, unsubLive, unsubEnded];

    return () => {
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
