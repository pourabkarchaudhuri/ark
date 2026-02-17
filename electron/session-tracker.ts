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
 *   - session:liveUpdate    { gameId, activeMinutes } — every poll tick while running
 *   - session:ended         { gameId, session: GameSession }
 */

import { execSync } from 'child_process';
import path from 'path';
import { logger } from './safe-logger.js';
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
  gameId: string;
  executablePath: string;
}

interface ActiveSession {
  gameId: string;
  executablePath: string;
  startTime: Date;
  idleAccumulatedMs: number; // Total idle time accumulated during the session
  lastIdleCheck: boolean;    // Whether system was idle on the previous tick
}

export interface CompletedSession {
  id: string;
  gameId: string;
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
// Process detection — single OS call per poll tick, not per game
// ---------------------------------------------------------------------------

/** Cache of lowercased process names from the most recent snapshot. */
let _runningProcesses: Set<string> = new Set();

/**
 * Snapshot all running processes into `_runningProcesses`.
 * Called once per poll tick — avoids spawning N `tasklist` commands for N games.
 */
function refreshProcessSnapshot(): void {
  try {
    if (process.platform === 'win32') {
      // /FO CSV /NH → one line per process: "imagename","PID","sessionname","session#","memUsage"
      const output = execSync('tasklist /FO CSV /NH', {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      });
      const names = new Set<string>();
      for (const line of output.split('\n')) {
        // Extract the first quoted field (image name)
        const match = line.match(/^"([^"]+)"/);
        if (match) names.add(match[1].toLowerCase());
      }
      _runningProcesses = names;
    } else {
      // macOS / Linux — `ps -eo comm=` prints just the command name, one per line
      const output = execSync('ps -eo comm=', { encoding: 'utf-8', timeout: 5000 });
      const names = new Set<string>();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) names.add(trimmed.toLowerCase());
      }
      _runningProcesses = names;
    }
  } catch {
    // If the snapshot fails, keep the previous set — better stale than empty
  }
}

/** Check the cached snapshot for a specific executable. */
function isProcessRunning(exePath: string): boolean {
  return _runningProcesses.has(path.basename(exePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Tracker state
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
let mainWindowRef: BrowserWindowType | null = null;
let trackedGames: TrackedGame[] = [];
const activeSessions: Map<string, ActiveSession> = new Map(); // gameId -> session

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

function pollTick() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;

  // Snapshot all running processes ONCE — O(1) lookups for each game below
  refreshProcessSnapshot();

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

      logger.log(`[SessionTracker] Game ${game.gameId} started (${path.basename(game.executablePath)})`);

    } else if (running && existingSession) {
      // ---- Game still running — accumulate idle if applicable ----
      if (isSystemIdle) {
        existingSession.idleAccumulatedMs += POLL_INTERVAL_MS;
      }
      existingSession.lastIdleCheck = isSystemIdle;

      // Send live playtime update to the renderer
      const rawMs = Date.now() - existingSession.startTime.getTime();
      const activeMs = Math.max(0, rawMs - existingSession.idleAccumulatedMs);
      sendToRenderer('session:liveUpdate', {
        gameId: game.gameId,
        activeMinutes: Math.round(activeMs / 60_000 * 100) / 100,
      });

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

      logger.log(
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
    logger.error(`[SessionTracker] Failed to send ${channel}:`, err);
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
  logger.log('[SessionTracker] Started (polling every 15s)');
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
  logger.log('[SessionTracker] Stopped');
}

/**
 * Update the list of games to monitor.
 * Called from an IPC handler when the renderer sends its tracked games list.
 *
 * Any active session whose gameId is no longer in the new list is finalized
 * immediately — prevents orphaned "Playing Now" ghosts.
 */
export function setTrackedGames(games: TrackedGame[]) {
  const newIds = new Set(games.map((g) => g.gameId));

  // Finalize sessions for games that were removed from the tracked list
  for (const [gameId, session] of activeSessions) {
    if (!newIds.has(gameId)) {
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

      activeSessions.delete(gameId);
      sendToRenderer('session:statusChange', { gameId, status: 'Playing' });
      sendToRenderer('session:ended', { gameId, session: completed });
      logger.log(`[SessionTracker] Finalized orphaned session for ${gameId}`);
    }
  }

  trackedGames = games;
  logger.log(`[SessionTracker] Now tracking ${games.length} game(s)`);
}

/**
 * Get currently active sessions (for IPC queries).
 */
export function getActiveSessions(): Array<{ gameId: string; startTime: string; elapsedMinutes: number }> {
  const now = Date.now();
  return Array.from(activeSessions.values()).map((s) => ({
    gameId: s.gameId,
    startTime: s.startTime.toISOString(),
    elapsedMinutes: Math.round((now - s.startTime.getTime()) / 60_000 * 100) / 100,
  }));
}
