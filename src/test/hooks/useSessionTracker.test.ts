/**
 * useSessionTracker (audit item 1): the renderer bridge records every session
 * main still holds un-acked (crash recovery / missed while the renderer was
 * down), replays idempotently, and only ACKs after the session is persisted.
 * It also must not send the tracked-games list before the stores hydrated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { GameSession } from '@/types/game';

// isolate:false → import the hook and its stores from one fresh registry.
let useSessionTracker: typeof import('@/hooks/useSessionTracker').useSessionTracker;
let sessionStore: typeof import('@/services/session-store').sessionStore;
let libraryStore: typeof import('@/services/library-store').libraryStore;

function session(id: string, gameId = 'steam-11'): GameSession {
  return {
    id,
    gameId,
    executablePath: 'C:\\Games\\g.exe',
    startTime: '2026-02-01T10:00:00.000Z',
    endTime: '2026-02-01T11:30:00.000Z',
    durationMinutes: 90,
    idleMinutes: 0,
  };
}

function installTracker(pending: GameSession[]) {
  const endedHandlers: Array<(d: { gameId: string; session: GameSession }) => void> = [];
  const tracker = {
    setTrackedGames: vi.fn(async () => ({ success: true })),
    getActiveSessions: vi.fn(async () => []),
    getRecoveredSessions: vi.fn(async () => pending),
    ackSessions: vi.fn(async (ids: string[]) => ({ success: true, removed: ids.length })),
    onStatusChange: vi.fn(() => () => {}),
    onSessionStarted: vi.fn(() => () => {}),
    onLiveUpdate: vi.fn(() => () => {}),
    onSessionEnded: vi.fn((cb: (d: { gameId: string; session: GameSession }) => void) => {
      endedHandlers.push(cb);
      return () => {};
    }),
    removeAllListeners: vi.fn(),
  };
  Object.defineProperty(window, 'sessionTracker', { value: tracker, writable: true, configurable: true });
  return { tracker, endedHandlers };
}

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  vi.resetModules();
  ({ useSessionTracker } = await import('@/hooks/useSessionTracker'));
  ({ sessionStore } = await import('@/services/session-store'));
  ({ libraryStore } = await import('@/services/library-store'));
  sessionStore.clear();
  libraryStore.clear();
  libraryStore.addToLibrary({
    gameId: 'steam-11',
    status: 'Playing',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    executablePath: 'C:\\Games\\g.exe',
  });
});

afterEach(() => {
  Object.defineProperty(window, 'sessionTracker', { value: undefined, writable: true, configurable: true });
});

describe('useSessionTracker — pending-session replay', () => {
  it('records un-acked sessions from main once, then acks them', async () => {
    const { tracker } = installTracker([session('p1'), session('p2')]);
    renderHook(() => useSessionTracker());

    await waitFor(() => expect(tracker.ackSessions).toHaveBeenCalled());
    expect(tracker.ackSessions).toHaveBeenCalledWith(['p1', 'p2']);
    expect(sessionStore.getForGame('steam-11').map((s) => s.id).sort()).toEqual(['p1', 'p2']);
    expect(libraryStore.getEntry('steam-11')?.hoursPlayed).toBe(3);
    // Tracked list is sent (after stores are ready) with the exe-bearing game.
    expect(tracker.setTrackedGames).toHaveBeenCalledWith([
      { gameId: 'steam-11', executablePath: 'C:\\Games\\g.exe' },
    ]);
  });

  it('a replayed session that was already recorded is not double-counted', async () => {
    sessionStore.record(session('dup'));
    const { tracker, endedHandlers } = installTracker([session('dup')]);
    renderHook(() => useSessionTracker());

    await waitFor(() => expect(tracker.ackSessions).toHaveBeenCalled());
    // Live re-delivery of the same id is also idempotent.
    endedHandlers.forEach((h) => h({ gameId: 'steam-11', session: session('dup') }));
    expect(sessionStore.getForGame('steam-11')).toHaveLength(1);
  });
});
