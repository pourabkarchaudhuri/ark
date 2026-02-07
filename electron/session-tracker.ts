/**
 * Session Tracker — monitors running game processes in the Electron main process.
 *
 * Works with ANY executable on the system (not Steam-specific).
 * Detects game launches/exits by polling process lists and uses
 * Electron's powerMonitor for idle detection.
 *
 * Sends events to the renderer:
 *   - session:statusChange  { gameId, status: 'Playing Now' | 'Playing' }
 *   - session:started       { gameId, startTime }
 *   - session:ended         { gameId, session: GameSession }
 */

import { execSync } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserWindow as BrowserWindowType } from 'electron';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const electron = require('electron');
const { powerMonitor } = electron;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackedGame {
  gameId: number;
  executablePath: string;
}

interface ActiveSession {
  gameId: number;
  executablePath: string;
  startTime: Date;
  idleAccumulatedMs: number; // Total idle time accumulated during the session
  lastIdleCheck: boolean;    // Whether system was idle on the previous tick
}

export interface CompletedSession {
  id: string;
  gameId: number;
  executablePath: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  idleMinutes: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;   // Check every 15 seconds
const IDLE_THRESHOLD_S = 300;      // 5 minutes idle threshold

// ---------------------------------------------------------------------------
// Process detection
// ---------------------------------------------------------------------------

function isProcessRunning(exePath: string): boolean {
  const exeName = path.basename(exePath);
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `tasklist /FI "IMAGENAME eq ${exeName}" /NH`,
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      );
      return output.toLowerCase().includes(exeName.toLowerCase());
    } else {
      // macOS / Linux
      const output = execSync(`pgrep -f "${exeName}"`, { encoding: 'utf-8', timeout: 5000 });
      return output.trim().length > 0;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tracker state
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
let mainWindowRef: BrowserWindowType | null = null;
let trackedGames: TrackedGame[] = [];
const activeSessions: Map<number, ActiveSession> = new Map(); // gameId -> session

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

function pollTick() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;

  // Get system idle time (seconds)
  let systemIdleS = 0;
  try {
    systemIdleS = powerMonitor.getSystemIdleTime();
  } catch {
    // powerMonitor may not be available in all environments
  }
  const isSystemIdle = systemIdleS >= IDLE_THRESHOLD_S;

  for (const game of trackedGames) {
    const running = isProcessRunning(game.executablePath);
    const existingSession = activeSessions.get(game.gameId);

    if (running && !existingSession) {
      // ---- Game just started ----
      const session: ActiveSession = {
        gameId: game.gameId,
        executablePath: game.executablePath,
        startTime: new Date(),
        idleAccumulatedMs: 0,
        lastIdleCheck: false,
      };
      activeSessions.set(game.gameId, session);

      sendToRenderer('session:statusChange', { gameId: game.gameId, status: 'Playing Now' });
      sendToRenderer('session:started', { gameId: game.gameId, startTime: session.startTime.toISOString() });

      console.log(`[SessionTracker] Game ${game.gameId} started (${path.basename(game.executablePath)})`);

    } else if (running && existingSession) {
      // ---- Game still running — accumulate idle if applicable ----
      if (isSystemIdle) {
        existingSession.idleAccumulatedMs += POLL_INTERVAL_MS;
      }
      existingSession.lastIdleCheck = isSystemIdle;

    } else if (!running && existingSession) {
      // ---- Game stopped ----
      const endTime = new Date();
      const rawDurationMs = endTime.getTime() - existingSession.startTime.getTime();
      const activeDurationMs = Math.max(0, rawDurationMs - existingSession.idleAccumulatedMs);

      const completed: CompletedSession = {
        id: uuidv4(),
        gameId: game.gameId,
        executablePath: game.executablePath,
        startTime: existingSession.startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationMinutes: Math.round(activeDurationMs / 60_000 * 100) / 100,
        idleMinutes: Math.round(existingSession.idleAccumulatedMs / 60_000 * 100) / 100,
      };

      activeSessions.delete(game.gameId);

      sendToRenderer('session:statusChange', { gameId: game.gameId, status: 'Playing' });
      sendToRenderer('session:ended', { gameId: game.gameId, session: completed });

      console.log(
        `[SessionTracker] Game ${game.gameId} ended — ` +
        `active: ${completed.durationMinutes.toFixed(1)}min, idle: ${completed.idleMinutes.toFixed(1)}min`
      );
    }
    // If !running && !existingSession → nothing to do
  }
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function sendToRenderer(channel: string, data: unknown) {
  try {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(channel, data);
    }
  } catch (err) {
    console.error(`[SessionTracker] Failed to send ${channel}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startSessionTracker(mainWindow: BrowserWindowType) {
  mainWindowRef = mainWindow;

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
  console.log('[SessionTracker] Started (polling every 15s)');
}

export function stopSessionTracker() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Finalize any active sessions
  for (const [gameId, session] of activeSessions) {
    const endTime = new Date();
    const rawDurationMs = endTime.getTime() - session.startTime.getTime();
    const activeDurationMs = Math.max(0, rawDurationMs - session.idleAccumulatedMs);

    const completed: CompletedSession = {
      id: uuidv4(),
      gameId,
      executablePath: session.executablePath,
      startTime: session.startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMinutes: Math.round(activeDurationMs / 60_000 * 100) / 100,
      idleMinutes: Math.round(session.idleAccumulatedMs / 60_000 * 100) / 100,
    };

    sendToRenderer('session:statusChange', { gameId, status: 'Playing' });
    sendToRenderer('session:ended', { gameId, session: completed });
  }

  activeSessions.clear();
  mainWindowRef = null;
  console.log('[SessionTracker] Stopped');
}

/**
 * Update the list of games to monitor.
 * Called from an IPC handler when the renderer sends its tracked games list.
 */
export function setTrackedGames(games: TrackedGame[]) {
  trackedGames = games;
  console.log(`[SessionTracker] Now tracking ${games.length} game(s)`);
}

/**
 * Get currently active sessions (for IPC queries).
 */
export function getActiveSessions(): Array<{ gameId: number; startTime: string; elapsedMinutes: number }> {
  const now = Date.now();
  return Array.from(activeSessions.values()).map((s) => ({
    gameId: s.gameId,
    startTime: s.startTime.toISOString(),
    elapsedMinutes: Math.round((now - s.startTime.getTime()) / 60_000 * 100) / 100,
  }));
}
