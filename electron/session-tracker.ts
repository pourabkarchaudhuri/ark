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

import { exec, type ExecOptions } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import * as fs from 'fs';
import { logger } from './safe-logger.js';
import { atomicWriteFile } from './safe-write.js';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserWindow as BrowserWindowType } from 'electron';

/** Async exec so process snapshots never block Electron's main/input pump. */
const execAsync = promisify(exec);

async function runCommand(
  command: string,
  options: ExecOptions,
): Promise<string> {
  const { stdout } = await execAsync(command, {
    ...options,
    encoding: 'utf8',
  });
  return String(stdout ?? '');
}

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const electron = require('electron');
const { powerMonitor, app } = electron;

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
  missedPolls: number;       // Consecutive polls where the process was not seen
  lastSeenMs: number;        // Timestamp (ms) of the last poll where the process was running
  activeInputMs: number;     // Total ms where the user was actively providing input
}

export interface CompletedSession {
  id: string;
  gameId: string;
  executablePath: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  idleMinutes: number;
  activeInputMinutes?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;   // Check every 15 seconds
const POLL_INTERVAL_S = POLL_INTERVAL_MS / 1000; // Seconds form for powerMonitor.getSystemIdleTime() comparisons
const IDLE_THRESHOLD_S = 300;      // 5 minutes idle threshold
/**
 * Number of consecutive polls a process must be missing before we end the
 * session. `tasklist` can momentarily miss a process (CPU spike, AV scan, fast
 * relaunch), and basename matching can flicker. Requiring 4 misses (~60s)
 * tolerates the common transient blips reported by users under load —
 * antivirus full-file scans that pause tasklist for 30–45s, heavy GPU load
 * that starves our snapshot, and the brief PowerShell/wmic contention when
 * our own full-path snapshot runs in parallel — without letting the
 * "Playing Now" indicator lag more than a minute past a real quit.
 */
const MISSES_BEFORE_END = 4;

// ---------------------------------------------------------------------------
// Process detection — single OS call per poll tick, not per game
// ---------------------------------------------------------------------------

/** Cache of lowercased process basenames from the most recent snapshot. */
let _runningBasenames: Set<string> = new Set();
/** Cache of lowercased full executable paths from the most recent snapshot. */
let _runningPaths: Set<string> = new Set();

/**
 * Basenames we have already warned about falling back to basename-only
 * matching for. Prevents the log from filling up with the same "possible
 * collision" line every 15s while a game is running.
 */
const _basenameCollisionWarned: Set<string> = new Set();

/**
 * Snapshot all running processes into `_runningBasenames` and `_runningPaths`.
 * Called once per poll tick — avoids spawning N per-game commands.
 *
 * On Windows we do two calls:
 *   - `tasklist /FO CSV /NH` → basenames (fast, always works, no path info)
 *   - `powershell Get-Process | Select-Object Path` → full paths (slower, may
 *     miss elevated processes when we're not admin)
 *
 * PowerShell is expensive (~100–500ms+ of process spawn + WMI). When no session
 * is active we only need start detection — tasklist basenames are enough
 * (same fallback we already use when Path is hidden). Full paths refresh while
 * a session is running so end-detection and collision warnings stay accurate.
 */
async function refreshProcessSnapshot(opts: { includePaths?: boolean } = {}): Promise<void> {
  const includePaths = opts.includePaths !== false;
  try {
    if (process.platform === 'win32') {
      // ---- Basenames (fast, primary source of truth for "is anything named X running") ----
      // /FO CSV /NH → one line per process: "imagename","PID","sessionname","session#","memUsage"
      // Async — never block the Electron main thread (sync exec was a mouse-hitch source).
      const output = await runCommand('tasklist /FO CSV /NH', {
        timeout: 10_000,
        windowsHide: true,
      });
      const names = new Set<string>();
      for (const line of output.split('\n')) {
        // Extract the first quoted field (image name)
        const match = line.match(/^"([^"]+)"/);
        if (match) names.add(match[1].toLowerCase());
      }
      _runningBasenames = names;

      if (!includePaths) {
        // Idle poll — keep previous _runningPaths (may be empty); basename match
        // starts sessions the same way a failed PowerShell snapshot would.
        return;
      }

      // ---- Full paths (slower, best-effort — some processes hide their Path from non-admin) ----
      const paths = new Set<string>();
      try {
        const psOut = await runCommand(
          'powershell.exe -NoProfile -NonInteractive -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path"',
          { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
        for (const line of psOut.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) paths.add(trimmed.toLowerCase());
        }
      } catch {
        // PowerShell path snapshot failed — we fall through to basename matching.
        // Don't clobber the previous _runningPaths, in case this was a transient failure.
        return;
      }
      _runningPaths = paths;
    } else {
      // macOS / Linux — `ps -eo comm=,command=` prints basename + full command per line
      const output = await runCommand('ps -eo comm=,command=', { timeout: 5000 });
      const names = new Set<string>();
      const paths = new Set<string>();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.indexOf(' ');
        const comm = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
        const command = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : trimmed;
        names.add(comm.toLowerCase());
        // First token of `command` is the executable (usually an absolute path)
        const firstArg = command.split(/\s+/)[0];
        if (firstArg && firstArg.startsWith('/')) paths.add(firstArg.toLowerCase());
      }
      _runningBasenames = names;
      _runningPaths = paths;
    }
  } catch {
    // If the snapshot fails, keep the previous sets — better stale than empty
  }
}

/**
 * Check the cached snapshot for a specific executable.
 *
 * Prefers a full-path match (avoids treating two unrelated `game.exe` binaries
 * as the same tracked game). Falls back to basename match — and logs a
 * one-time warning — when the path snapshot doesn't include this process
 * (elevated processes, non-Windows, or a failed PowerShell call).
 */
function isProcessRunning(exePath: string): boolean {
  const normalizedPath = exePath.toLowerCase();

  // Primary: exact full-path match
  if (_runningPaths.has(normalizedPath)) return true;

  // Fallback: basename match. Only trust it if we can't identify by path.
  const basename = path.basename(exePath).toLowerCase();
  if (_runningBasenames.has(basename)) {
    // Warn once per basename per app run — if _runningPaths is populated but
    // this exact path isn't in it, we're guessing based on a common filename.
    if (_runningPaths.size > 0 && !_basenameCollisionWarned.has(basename)) {
      _basenameCollisionWarned.add(basename);
      logger.warn(
        `[SessionTracker] Basename-only match for "${basename}" — the full path ` +
        `"${exePath}" was not in the process-path snapshot. This may be an elevated ` +
        `process (safe) or an unrelated collision (a different program of the same ` +
        `filename). If sessions look wrong, check whether both are running.`
      );
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tracker state
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Skip overlapping ticks when a slow PowerShell snapshot outlives POLL_INTERVAL_MS. */
let pollInFlight = false;
/** Emit getAppMetrics telemetry every N active-session polls (UI is already ≥5s coalesced). */
const TELEMETRY_SAMPLE_EVERY_N_POLLS = 2;
let telemetrySampleTick = 0;
let mainWindowRef: BrowserWindowType | null = null;
let trackedGames: TrackedGame[] = [];
const activeSessions: Map<string, ActiveSession> = new Map(); // gameId -> session

// ---------------------------------------------------------------------------
// In-game overlay HUD wiring
//
// The overlay is a second BrowserWindow (see electron/overlay-window.ts). It
// consumes the exact same `session:*` event stream as the main window, so we
// simply forward every payload to its webContents as well. Separately, we tell
// main.ts when to show/hide the overlay by firing a visibility callback on the
// 0↔1 active-session transition (main.ts gates the actual show on the
// `overlayEnabled` setting). Keeping content event-driven and show/hide
// callback-driven makes the two concerns race-free.
// ---------------------------------------------------------------------------

let overlayWindowRef: BrowserWindowType | null = null;
let overlayVisibilityCallback: ((shouldShow: boolean) => void) | null = null;
let lastOverlayShouldShow = false;

// Sessions recovered from a previous run that crashed/was force-killed before it
// could finalize them. Buffered here until the renderer drains them on mount.
let recoveredSessions: CompletedSession[] = [];

// ---------------------------------------------------------------------------
// Crash-recovery persistence
//
// Active sessions live only in memory, so a crash or force-kill used to lose
// the entire in-progress play block. We snapshot them to disk every tick and,
// on the next startup, finalize any leftover sessions up to their last-seen
// timestamp (never counting the time the app was not running).
// ---------------------------------------------------------------------------

interface PersistedSession {
  gameId: string;
  executablePath: string;
  startTime: string;
  idleAccumulatedMs: number;
  lastSeenMs: number;
}

function getPersistPath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'active-sessions.json');
  } catch {
    return null;
  }
}

/** Serialize persist so overlapping async ticks can't reorder writes. */
let persistChain: Promise<void> = Promise.resolve();

function persistActiveSessions(): void {
  const file = getPersistPath();
  if (!file) return;

  // Snapshot under the current tick — don't capture a later mutation mid-write.
  const snapshot: PersistedSession[] = Array.from(activeSessions.values()).map((s) => ({
    gameId: s.gameId,
    executablePath: s.executablePath,
    startTime: s.startTime.toISOString(),
    idleAccumulatedMs: s.idleAccumulatedMs,
    lastSeenMs: s.lastSeenMs,
  }));

  persistChain = persistChain.then(
    () =>
      new Promise<void>((resolve) => {
        try {
          if (snapshot.length === 0) {
            fs.unlink(file, (err) => {
              if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.error('[SessionTracker] Failed to clear persisted sessions:', err);
              }
              resolve();
            });
            return;
          }
          atomicWriteFile(file, JSON.stringify(snapshot), (err) => {
            if (err) {
              logger.error('[SessionTracker] Failed to persist active sessions:', err);
            }
            resolve();
          });
        } catch (err) {
          logger.error('[SessionTracker] Failed to persist active sessions:', err);
          resolve();
        }
      }),
  );
}

function recoverPersistedSessions(): void {
  const file = getPersistPath();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    fs.unlinkSync(file); // consume once
    if (!Array.isArray(parsed)) return;

    for (const item of parsed as PersistedSession[]) {
      if (!item || typeof item.gameId !== 'string' || typeof item.startTime !== 'string') continue;
      const startMs = new Date(item.startTime).getTime();
      const endMs = Number.isFinite(item.lastSeenMs) ? item.lastSeenMs : startMs;
      if (!Number.isFinite(startMs) || endMs <= startMs) continue;
      const idleMs = Number.isFinite(item.idleAccumulatedMs) ? Math.max(0, item.idleAccumulatedMs) : 0;
      const activeMs = Math.max(0, endMs - startMs - idleMs);
      recoveredSessions.push({
        id: uuidv4(),
        gameId: item.gameId,
        executablePath: item.executablePath ?? '',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        durationMinutes: Math.round((activeMs / 60_000) * 100) / 100,
        idleMinutes: Math.round((idleMs / 60_000) * 100) / 100,
      });
    }
    if (recoveredSessions.length > 0) {
      logger.log(`[SessionTracker] Recovered ${recoveredSessions.length} unfinalized session(s) from previous run`);
    }
  } catch (err) {
    logger.error('[SessionTracker] Failed to recover persisted sessions:', err);
  }
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

async function pollTick(): Promise<void> {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;

  // Skip expensive process snapshot when nothing is being tracked
  if (trackedGames.length === 0 && activeSessions.size === 0) return;

  // Don't pile up overlapping tasklist/PowerShell runs — that spikes CPU and
  // made the old sync path feel like a mouse hitch every poll.
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    // Snapshot all running processes ONCE — O(1) lookups for each game below.
    // Idle (no active session): skip Windows PowerShell path scan — tasklist
    // basenames are enough for start detection and avoid a heavy spawn every 15s.
    const hasActive = activeSessions.size > 0;
    const _hookStart = performance.now();
    await refreshProcessSnapshot({ includePaths: hasActive });
    const hookLatencyMs = Math.round((performance.now() - _hookStart) * 100) / 100;

    // Get system idle time (seconds)
    let systemIdleS = 0;
    try {
      systemIdleS = powerMonitor.getSystemIdleTime();
    } catch {
      // powerMonitor may not be available in all environments
    }
    const isSystemIdle = systemIdleS >= IDLE_THRESHOLD_S;
    const nowMs = Date.now();

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
        missedPolls: 0,
        lastSeenMs: nowMs,
        activeInputMs: 0,
      };
      activeSessions.set(game.gameId, session);

      sendToRenderer('session:statusChange', { gameId: game.gameId, status: 'Playing Now' });
      sendToRenderer('session:started', { gameId: game.gameId, startTime: session.startTime.toISOString() });

      logger.log(`[SessionTracker] Game ${game.gameId} started (${path.basename(game.executablePath)})`);

    } else if (running && existingSession) {
      // ---- Game still running — accumulate idle if applicable ----
      // Recovered from a transient miss: clear the counter.
      existingSession.missedPolls = 0;
      existingSession.lastSeenMs = nowMs;

      // Only count idle once it has been sustained across two consecutive polls,
      // so a single idle blip (or controller-only play crossing the threshold for
      // one tick) doesn't unfairly subtract active time.
      if (isSystemIdle && existingSession.lastIdleCheck) {
        existingSession.idleAccumulatedMs += POLL_INTERVAL_MS;
      }
      existingSession.lastIdleCheck = isSystemIdle;

      // Telemetry: count this tick as active-input when the system was not idle
      // for longer than one poll interval — i.e. the user provided input recently.
      if (systemIdleS < POLL_INTERVAL_S) {
        existingSession.activeInputMs += POLL_INTERVAL_MS;
      }

      // Send live playtime update to the renderer
      const rawMs = nowMs - existingSession.startTime.getTime();
      const activeMs = Math.max(0, rawMs - existingSession.idleAccumulatedMs);
      sendToRenderer('session:liveUpdate', {
        gameId: game.gameId,
        activeMinutes: Math.round(activeMs / 60_000 * 100) / 100,
      });

    } else if (!running && existingSession) {
      // ---- Process not seen this tick ----
      // Debounce: require several consecutive misses before ending so a single
      // dropped poll doesn't split one session into fragments.
      existingSession.missedPolls += 1;
      if (existingSession.missedPolls < MISSES_BEFORE_END) {
        continue;
      }

      // End the session at the LAST time we actually saw it running, so the
      // missed-poll window is not counted as playtime.
      const endMs = existingSession.lastSeenMs;
      const rawDurationMs = endMs - existingSession.startTime.getTime();
      const activeDurationMs = Math.max(0, rawDurationMs - existingSession.idleAccumulatedMs);

      const completed: CompletedSession = {
        id: uuidv4(),
        gameId: game.gameId,
        executablePath: game.executablePath,
        startTime: existingSession.startTime.toISOString(),
        endTime: new Date(endMs).toISOString(),
        durationMinutes: Math.round(activeDurationMs / 60_000 * 100) / 100,
        idleMinutes: Math.round(existingSession.idleAccumulatedMs / 60_000 * 100) / 100,
        activeInputMinutes: Math.round(existingSession.activeInputMs / 60_000 * 100) / 100,
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

  // Telemetry: emit samples while playing — but not every 15s. getAppMetrics walks
  // every Chromium process; UI charts coalesce ≥5s, so every other poll (~30s) is enough.
  // timestamp is epoch ms (number) — renderer store/charts expect numeric, not ISO string.
  if (activeSessions.size > 0) {
    telemetrySampleTick += 1;
    if (telemetrySampleTick >= TELEMETRY_SAMPLE_EVERY_N_POLLS) {
      telemetrySampleTick = 0;
      const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
      let cpuPercent = 0;
      try {
        const metrics = app.getAppMetrics();
        for (const m of metrics) {
          cpuPercent += m?.cpu?.percentCPUUsage ?? 0;
        }
        cpuPercent = Math.round(cpuPercent * 100) / 100;
      } catch {
        cpuPercent = 0;
      }
      for (const s of activeSessions.values()) {
        sendToRenderer('session:telemetrySample', {
          timestamp: nowMs,
          gameId: s.gameId,
          cpuPercent,
          rssMb,
          hookLatencyMs,
        });
      }
    }
  } else {
    telemetrySampleTick = 0;
  }

  // Snapshot in-progress sessions for crash recovery on the next launch.
  persistActiveSessions();

  // Show/hide the overlay HUD based on whether anything is being played now.
  updateOverlayVisibility();
  } finally {
    pollInFlight = false;
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
  // Overlay HUD only consumes session start/live/end/status — skip telemetry
  // samples (and any other non-HUD channels) so the click-through window isn't
  // woken for chart data it never renders.
  if (channel === 'session:telemetrySample') return;
  try {
    if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
      overlayWindowRef.webContents.send(channel, data);
    }
  } catch (err) {
    logger.error(`[SessionTracker] Failed to forward ${channel} to overlay:`, err);
  }
}

/**
 * Fire the overlay visibility callback when the active-session count crosses the
 * 0↔1 boundary. Only fires on an actual change, so main.ts's handler runs once
 * per transition rather than every poll tick.
 */
function updateOverlayVisibility(): void {
  if (!overlayVisibilityCallback) return;
  const shouldShow = activeSessions.size > 0;
  if (shouldShow === lastOverlayShouldShow) return;
  lastOverlayShouldShow = shouldShow;
  try {
    overlayVisibilityCallback(shouldShow);
  } catch (err) {
    logger.error('[SessionTracker] Overlay visibility callback failed:', err);
  }
}

/**
 * Register the overlay window so `session:*` events are forwarded to it, and
 * (optionally) a callback that fires when the overlay should be shown/hidden
 * based on whether any session is active. main.ts owns the show/hide decision
 * (it gates on the `overlayEnabled` setting).
 */
export function registerOverlayWindow(
  win: BrowserWindowType | null,
  onVisibilityChange?: (shouldShow: boolean) => void,
): void {
  overlayWindowRef = win;
  if (onVisibilityChange !== undefined) {
    overlayVisibilityCallback = onVisibilityChange;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startSessionTracker(mainWindow: BrowserWindowType) {
  mainWindowRef = mainWindow;

  // Recover any sessions left unfinalized by a previous crash/force-kill.
  recoverPersistedSessions();

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    void pollTick();
  }, POLL_INTERVAL_MS);
  logger.log('[SessionTracker] Started (polling every 15s, async process snapshot)');
}

/**
 * Drain sessions recovered from a previous run. The renderer calls this once on
 * mount and records them, so playtime from a crashed session is not lost.
 */
export function drainRecoveredSessions(): CompletedSession[] {
  const out = recoveredSessions;
  recoveredSessions = [];
  return out;
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
      activeInputMinutes: Math.round(session.activeInputMs / 60_000 * 100) / 100,
    };

    sendToRenderer('session:statusChange', { gameId, status: 'Playing' });
    sendToRenderer('session:ended', { gameId, session: completed });
  }

  activeSessions.clear();
  // We finalized everything cleanly — drop the crash-recovery snapshot so we
  // don't double-count these sessions on the next launch.
  persistActiveSessions();
  updateOverlayVisibility();
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
        activeInputMinutes: Math.round(session.activeInputMs / 60_000 * 100) / 100,
      };

      activeSessions.delete(gameId);
      sendToRenderer('session:statusChange', { gameId, status: 'Playing' });
      sendToRenderer('session:ended', { gameId, session: completed });
      logger.log(`[SessionTracker] Finalized orphaned session for ${gameId}`);
    }
  }

  trackedGames = games;
  // Untracking a game may have finalized its active session above.
  updateOverlayVisibility();
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
