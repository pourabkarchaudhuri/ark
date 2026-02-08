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
 * 4. Auto-updates hoursPlayed in library store (or custom game store for negative IDs)
 */
export function useSessionTracker() {
  const [liveGames, setLiveGames] = useState<Set<number>>(new Set());
  const cleanupRef = useRef<Array<() => void>>([]);

  // Send tracked games list to the main process — stable ref, never changes
  const syncTrackedGames = useCallback(() => {
    if (!window.sessionTracker) return;

    // Library games with executable paths
    const libraryTrackable = libraryStore.getTrackableEntries();

    // Custom games with executable paths (negative IDs)
    const customTrackable = customGameStore
      .getAllGames()
      .filter((g) => g.executablePath)
      .map((g) => ({ gameId: g.id, executablePath: g.executablePath! }));

    window.sessionTracker.setTrackedGames([...libraryTrackable, ...customTrackable]);
  }, []);

  useEffect(() => {
    if (!window.sessionTracker) return;

    // Initial sync
    syncTrackedGames();

    // Re-sync whenever the library or custom games change
    const unsubLibrary = libraryStore.subscribe(syncTrackedGames);
    const unsubCustom = customGameStore.subscribe(syncTrackedGames);

    // Listen for live status changes
    const unsubStatus = window.sessionTracker.onStatusChange((data) => {
      setLiveGames((prev) => {
        const next = new Set(prev);
        if (data.status === 'Playing Now') {
          next.add(data.gameId);
        } else {
          next.delete(data.gameId);
        }
        return next;
      });
    });

    // Listen for completed sessions
    const unsubEnded = window.sessionTracker.onSessionEnded((data) => {
      const session: GameSession = data.session;

      // Record the session
      sessionStore.record(session);

      // Update hoursPlayed — route to correct store based on ID sign
      const totalHours = sessionStore.getTotalHours(session.gameId);
      if (session.gameId < 0) {
        // Custom game (negative ID) — update custom game store
        const existing = customGameStore.getGame(session.gameId);
        if (existing) {
          customGameStore.updateGame(session.gameId, { hoursPlayed: totalHours });
        }
      } else {
        // Library game — update library store
        libraryStore.updateHoursFromSessions(session.gameId, totalHours);
      }
    });

    cleanupRef.current = [unsubLibrary, unsubCustom, unsubStatus, unsubEnded];

    return () => {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      window.sessionTracker?.removeAllListeners();
    };
  }, [syncTrackedGames]);

  /**
   * Check if a game is currently being played (exe is running).
   */
  const isPlayingNow = useCallback(
    (gameId: number) => liveGames.has(gameId),
    [liveGames]
  );

  return {
    /** Set of gameIds whose executables are currently running */
    liveGames,
    /** Check if a specific game is live */
    isPlayingNow,
  };
}
