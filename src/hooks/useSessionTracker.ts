import { useState, useEffect, useCallback, useRef } from 'react';
import { GameSession } from '@/types/game';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { sessionStore } from '@/services/session-store';

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
      // Compute live total: previously recorded hours + current active session
      const previousHours = sessionStore.getTotalHours(gameId);
      const liveTotal = previousHours + activeMinutes / 60;

      if (gameId.startsWith('custom-')) {
        const existing = customGameStore.getGame(gameId);
        if (existing) {
          customGameStore.updateGame(gameId, { hoursPlayed: liveTotal });
        }
      } else {
        libraryStore.updateHoursFromSessions(gameId, liveTotal);
      }
    });

    // Listen for completed sessions
    const unsubEnded = window.sessionTracker.onSessionEnded((data) => {
      const session: GameSession = {
        ...data.session,
        gameId: typeof data.session.gameId === 'number'
          ? `steam-${data.session.gameId}`
          : String(data.session.gameId),
      };

      // Record the session
      sessionStore.record(session);

      // Update hoursPlayed — route to correct store based on ID prefix
      const totalHours = sessionStore.getTotalHours(session.gameId);
      if (session.gameId.startsWith('custom-')) {
        // Custom game — update custom game store
        const existing = customGameStore.getGame(session.gameId);
        if (existing) {
          customGameStore.updateGame(session.gameId, { hoursPlayed: totalHours });
        }
      } else {
        // Library game — update library store
        libraryStore.updateHoursFromSessions(session.gameId, totalHours);
      }
    });

    cleanupRef.current = [unsubLibrary, unsubCustom, unsubStatus, unsubLive, unsubEnded];

    return () => {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      window.sessionTracker?.removeAllListeners();
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
