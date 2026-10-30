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
 *
 * Delivery guarantee: every completed session is kept in a persisted
 * pending queue (`pending-sessions.json`) until the renderer acknowledges it
 * via `session:ack`. A renderer crash/reload (or a hidden auto-launch where the
 * UI never mounted) therefore can no longer drop playtime: the renderer drains
 * the queue on mount (`session:getRecovered`) and records idempotently by id.
 */

import { execFile, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import * as fs from 'fs';
import { logger } from './safe-logger.js';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { nativeSessionEnumerate, type NativeProcessInfo } from './native-bridge.js';
import { atomicWriteFileSync } from './safe-write.js';
import { reportGameActivity } from './game-activity.js';

/**
 * Async execFile (no shell, so no extra cmd.exe per poll) — process snapshots
 * never block Electron's main/input pump.
 */
const execFileAsync = promisify(execFile);

async function runFileDefault(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    ...options,
    encoding: 'utf8',
  });
  return String(stdout ?? '');
}

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const electron = require('electron');
const { powerMonitor, app } = electron;

/**
 * Everything the poll loop reads from the OS, injectable so tests can drive
 * the tracker without Electron (`require('electron')` is only a path string
 * under vitest) — same seam pattern as launch-handlers / native-bridge.
 */
interface SessionTrackerDeps {
  now: () => number;
  getSystemIdleTime: () => number;
  nativeEnumerate: () => NativeProcessInfo[] | null;
  runFile: (file: string, args: string[], options: ExecFileOptions) => Promise<string>;
  realpath: (p: string) => string;
  platform: NodeJS.Platform;
}

const defaultDeps: SessionTrackerDeps = {
  now: () => Date.now(),
  getSystemIdleTime: () => powerMonitor.getSystemIdleTime(),
  nativeEnumerate: nativeSessionEnumerate,
  runFile: runFileDefault,
  realpath: (p) => fs.realpathSync.native(p),
  platform: process.platform,
};

let deps: SessionTrackerDeps = defaultDeps;

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
  idleConfirmed: boolean;    // Idle already confirmed (its back-dated start counted) for the current AFK break
  idleFloorMs: number;       // Idle before this instant is already accounted (session start, or the end of a sleep)
  suspendedMs: number;       // System-suspend span reported by powerMonitor, applied as idle on the next seen tick
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
/**
 * A gap this long between two sightings of a still-running process means the
 * poll loop was not running (system sleep / hibernate, or every snapshot
 * failing). The span is idle, not play.
 */
const SLEEP_GAP_MS = 4 * POLL_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Process detection — single OS call per poll tick, not per game
// ---------------------------------------------------------------------------

/** Cache of lowercased process basenames from the most recent snapshot. */
let _runningBasenames: Set<string> = new Set();
/** Cache of lowercased, normalized full executable paths from the most recent snapshot. */
let _runningPaths: Set<string> = new Set();
/** basename → every full path seen for it in the most recent path snapshot. */
let _basenamePaths: Map<string, Set<string>> = new Map();
/**
 * Basenames with at least one process whose path could not be read (elevated
 * or protected process). Only these may still match by basename alone when a
 * fresh path snapshot shows the name living in some other folder.
 */
let _unresolvedBasenames: Set<string> = new Set();
/**
 * True when the path snapshot failed on the most recent tick, so
 * `_runningPaths` is empty and must not be trusted — `isProcessRunning`
 * falls back to basename matching only. The previous good path set is never
 * kept: a game that has just exited would appear "running" forever and
 * `MISSES_BEFORE_END` would never accumulate, so `session:ended` is never
 * emitted (v1.0.60 tracker-never-ends bug).
 */
let _pathSnapshotStale = false;
/**
 * True when no basename source (native names / tasklist) answered this tick
 * and `_runningBasenames` was derived from the path snapshot instead. The
 * previous tick's basenames are never reused: a game that exited would keep
 * matching them forever (1.0.97).
 */
let _basenameSnapshotStale = false;
/** Logged once per failure streak so a blocked snapshot doesn't spam every 15s. */
let _snapshotFailureLogged = false;

/**
 * Basenames we have already warned about falling back to basename-only
 * matching for. Prevents the log from filling up with the same "possible
 * collision" line every 15s while a game is running.
 */
const _basenameCollisionWarned: Set<string> = new Set();

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Lowercased, separator/`..`-normalized form used for every path comparison. */
function normalizeExePath(p: string): string {
  const normalized = isWindowsPath(p) ? path.win32.normalize(p) : path.posix.normalize(p);
  return normalized.toLowerCase();
}

function exeBasename(p: string): string {
  return (isWindowsPath(p) ? path.win32.basename(p) : path.posix.basename(p)).toLowerCase();
}

/** exePath → canonical keys (normalized path, plus its realpath when that resolves). */
const _canonicalKeyCache: Map<string, string[]> = new Map();

/**
 * Canonical keys for a tracked exe: the normalized path and, when it resolves,
 * the realpath (junctions, symlinked library folders). Cached — computed once
 * per path, not per tick.
 */
function canonicalKeys(exePath: string): string[] {
  const cached = _canonicalKeyCache.get(exePath);
  if (cached) return cached;
  const keys = [normalizeExePath(exePath)];
  try {
    const real = normalizeExePath(deps.realpath(exePath));
    if (real && !keys.includes(real)) keys.push(real);
  } catch {
    // Missing / unreadable file — the normalized path is all we have.
  }
  _canonicalKeyCache.set(exePath, keys);
  return keys;
}

/**
 * Publish one tick's snapshot. `names` has one entry per process (duplicates
 * kept); `paths` one entry per process whose path resolved, or `null` when no
 * path snapshot is available this tick.
 */
function applySnapshot(names: string[], paths: string[] | null, trackUnresolved: boolean): void {
  _runningBasenames = new Set(names);
  _runningPaths = new Set(paths ?? []);
  _pathSnapshotStale = paths === null;
  _basenamePaths = new Map();
  _unresolvedBasenames = new Set();
  if (paths === null || !trackUnresolved) return;
  const resolvedCount = new Map<string, number>();
  for (const p of paths) {
    const b = exeBasename(p);
    let set = _basenamePaths.get(b);
    if (!set) _basenamePaths.set(b, (set = new Set()));
    set.add(p);
    resolvedCount.set(b, (resolvedCount.get(b) ?? 0) + 1);
  }
  const nameCount = new Map<string, number>();
  for (const n of names) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  // More processes of this name than resolved paths for it → at least one
  // could not be read. (Two snapshots a few ms apart can disagree; the error
  // direction is "allow the basename match", i.e. the pre-1.0.97 behaviour.)
  for (const [n, count] of nameCount) {
    if (count > (resolvedCount.get(n) ?? 0)) _unresolvedBasenames.add(n);
  }
}

/** One basename per process from `tasklist /FO CSV /NH`. */
function parseTasklist(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    // Extract the first quoted field (image name)
    const match = line.match(/^"([^"]+)"/);
    if (match) names.push(match[1].toLowerCase());
  }
  return names;
}

/**
 * Snapshot all running processes into `_runningBasenames` / `_runningPaths`.
 * Called once per poll tick — avoids spawning N per-game commands. Returns
 * false when no source answered at all; the caller must then neither extend
 * nor end any session for this tick.
 *
 * On Windows the native module (ark-native: one Toolhelp32 snapshot + a
 * QueryFullProcessImageName per PID, ~10-20ms in-process) supplies both the
 * basename and the full path of every process, so nothing is spawned. Only
 * when it is unavailable (missing binary, wrong arch, corrupted install) or
 * returns no basenames (binary built before 1.0.97) do we fall back to
 * `tasklist` for basenames and, without native, PowerShell for paths — both
 * via execFile, no shell. When tasklist fails but paths are known, basenames
 * are derived from the paths for that tick.
 */
async function refreshProcessSnapshot(): Promise<boolean> {
  if (deps.platform === 'win32') {
    // A real Windows system always has hundreds of processes running (Ark
    // itself, explorer.exe, system services) — an empty native result can
    // only mean the enumeration call itself failed, so it is treated as
    // "native unavailable", never as "nothing is running".
    const nativeResult = deps.nativeEnumerate();
    const nativeOk = nativeResult !== null && nativeResult.length > 0;

    let paths: string[] | null = null;
    let names: string[] | null = null;
    if (nativeOk) {
      paths = [];
      for (const proc of nativeResult) {
        if (proc.path) paths.push(normalizeExePath(proc.path));
      }
      if (nativeResult.every((proc) => proc.name || proc.path)) {
        names = nativeResult.map((proc) => (proc.name ? proc.name.toLowerCase() : exeBasename(proc.path!)));
      }
    }

    if (names === null) {
      // /FO CSV /NH → one line per process: "imagename","PID","sessionname","session#","memUsage"
      try {
        names = parseTasklist(await deps.runFile('tasklist', ['/FO', 'CSV', '/NH'], {
          timeout: 10_000,
          windowsHide: true,
        }));
      } catch {
        names = null;
      }
    }

    if (paths === null) {
      try {
        const psOut = await deps.runFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path',
          ],
          { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
        paths = [];
        for (const line of psOut.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) paths.push(normalizeExePath(trimmed));
        }
      } catch {
        // Path snapshot failed — basename-only matching for this tick.
        paths = null;
      }
    }

    if (names === null && paths === null) {
      // Nothing answered. The old basename list must not be reused (it would
      // keep exited games alive), and an empty one would end every session.
      _runningPaths = new Set();
      _pathSnapshotStale = true;
      _basenameSnapshotStale = true;
      return false;
    }

    _basenameSnapshotStale = names === null;
    applySnapshot(names ?? paths!.map(exeBasename), paths, true);
    return true;
  }

  // macOS / Linux — `ps -eo comm=,command=` prints basename + full command per line
  try {
    const output = await deps.runFile('ps', ['-eo', 'comm=,command='], { timeout: 5000 });
    const names: string[] = [];
    const paths: string[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      const comm = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
      const command = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : trimmed;
      names.push(comm.toLowerCase());
      // First token of `command` is the executable (usually an absolute path)
      const firstArg = command.split(/\s+/)[0];
      if (firstArg && firstArg.startsWith('/')) paths.push(normalizeExePath(firstArg));
    }
    _basenameSnapshotStale = false;
    // `comm` is truncated / not always the path basename here, so name and
    // path counts can't be compared: keep the plain basename fallback.
    applySnapshot(names, paths, false);
    return true;
  } catch {
    _runningPaths = new Set();
    _pathSnapshotStale = true;
    _basenameSnapshotStale = true;
    return false;
  }
}

/**
 * Check the cached snapshot for a specific executable.
 *
 * Prefers a full-path match against the exe's canonical keys (avoids treating
 * two unrelated `game.exe` binaries as the same tracked game). Falls back to
 * a basename match — and logs a one-time warning — only when the path
 * snapshot can't rule it out: the snapshot is stale, the name has no known
 * path, or some process of that name has an unreadable path (elevated game).
 */
function isProcessRunning(exePath: string): boolean {
  const keys = canonicalKeys(exePath);

  // Primary: exact full-path match. Only trusted when the path snapshot is
  // fresh — a stale set from an old good snapshot would keep just-exited
  // games "running" forever (v1.0.60 tracker-never-ends bug).
  if (!_pathSnapshotStale && keys.some((k) => _runningPaths.has(k))) return true;

  const basename = exeBasename(keys[0]);
  if (!_runningBasenames.has(basename)) return false;
  // Basenames were only derived from the (fresh) path snapshot this tick, and
  // the path itself did not match — nothing left to fall back on.
  if (_basenameSnapshotStale && !_pathSnapshotStale) return false;

  // A fresh snapshot shows every process of this name living somewhere else:
  // a different program with the same filename, not the tracked game.
  if (!_pathSnapshotStale) {
    const known = _basenamePaths.get(basename);
    if (known && known.size > 0 && !_unresolvedBasenames.has(basename)
      && !keys.some((k) => known.has(k))) {
      return false;
    }
  }

  // Warn once per basename per app run — we're guessing based on a filename.
  if (!_pathSnapshotStale && _runningPaths.size > 0 && !_basenameCollisionWarned.has(basename)) {
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

// ---------------------------------------------------------------------------
// Tracker state
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Skip overlapping ticks when a slow PowerShell snapshot outlives POLL_INTERVAL_MS. */
let pollInFlight = false;
let mainWindowRef: BrowserWindowType | null = null;
let trackedGames: TrackedGame[] = [];
/**
 * The merged list the renderer last sent, before one-owner-per-exe dedupe.
 * `keepSources` re-uses its entries for a store the renderer could not read.
 */
let lastInputGames: TrackedGame[] = [];
/** Signature of the last logged shared-exe collision set (log once per change). */
let lastCollisionSignature = '';
/** powerMonitor 'suspend' time; consumed by 'resume'. */
let suspendStartMs: number | null = null;
let powerEventsWired = false;
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

// Completed sessions not yet acknowledged by the renderer (id -> session).
// Includes sessions recovered from a crashed previous run. Persisted to
// `pending-sessions.json` on every change; entries leave only on `session:ack`.
const pendingSessions: Map<string, CompletedSession> = new Map();
/** Hard cap so a renderer that never acks can't grow the file forever. */
const MAX_PENDING_SESSIONS = 1000;
let pendingLoaded = false;

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
  /** Optional for files written by older builds. */
  activeInputMs?: number;
}

function getPersistPath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'active-sessions.json');
  } catch {
    return null;
  }
}

function getPendingPath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'pending-sessions.json');
  } catch {
    return null;
  }
}

function persistPendingSessions(): void {
  const file = getPendingPath();
  if (!file) return;
  try {
    if (pendingSessions.size === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    atomicWriteFileSync(file, JSON.stringify(Array.from(pendingSessions.values())));
  } catch (err) {
    logger.error('[SessionTracker] Failed to persist pending sessions:', err);
  }
}

function isCompletedSession(v: unknown): v is CompletedSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === 'string' && typeof s.gameId === 'string'
    && typeof s.startTime === 'string' && typeof s.endTime === 'string'
    && typeof s.durationMinutes === 'number' && Number.isFinite(s.durationMinutes);
}

function loadPendingSessions(): void {
  if (pendingLoaded) return;
  pendingLoaded = true;
  const file = getPendingPath();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (isCompletedSession(item)) pendingSessions.set(item.id, item);
    }
    if (pendingSessions.size > 0) {
      logger.log(`[SessionTracker] ${pendingSessions.size} completed session(s) awaiting renderer ack`);
    }
  } catch (err) {
    logger.error('[SessionTracker] Failed to load pending sessions:', err);
  }
}

function addPending(completed: CompletedSession): void {
  pendingSessions.set(completed.id, completed);
  while (pendingSessions.size > MAX_PENDING_SESSIONS) {
    const oldest = pendingSessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingSessions.delete(oldest);
    logger.warn(`[SessionTracker] Pending-session cap reached — dropped ${oldest}`);
  }
  persistPendingSessions();
}

/**
 * Queue a completed session for guaranteed delivery and push it to the
 * renderer. It stays queued (and on disk) until the renderer acks it.
 */
function finalizeCompleted(completed: CompletedSession): void {
  addPending(completed);
  sendToRenderer('session:statusChange', { gameId: completed.gameId, status: 'Playing' });
  sendToRenderer('session:ended', { gameId: completed.gameId, session: completed });
}

function buildCompleted(gameId: string, session: ActiveSession, endMs: number): CompletedSession {
  const rawDurationMs = endMs - session.startTime.getTime();
  const activeDurationMs = Math.max(0, rawDurationMs - session.idleAccumulatedMs);
  return {
    id: uuidv4(),
    gameId,
    executablePath: session.executablePath,
    startTime: session.startTime.toISOString(),
    endTime: new Date(endMs).toISOString(),
    durationMinutes: Math.round(activeDurationMs / 60_000 * 100) / 100,
    idleMinutes: Math.round(session.idleAccumulatedMs / 60_000 * 100) / 100,
    activeInputMinutes: Math.round(session.activeInputMs / 60_000 * 100) / 100,
  };
}

function persistActiveSessions(): void {
  const file = getPersistPath();
  if (!file) return;
  try {
    if (activeSessions.size === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    const data: PersistedSession[] = Array.from(activeSessions.values()).map((s) => ({
      gameId: s.gameId,
      executablePath: s.executablePath,
      startTime: s.startTime.toISOString(),
      idleAccumulatedMs: s.idleAccumulatedMs,
      lastSeenMs: s.lastSeenMs,
      activeInputMs: s.activeInputMs,
    }));
    atomicWriteFileSync(file, JSON.stringify(data));
  } catch (err) {
    logger.error('[SessionTracker] Failed to persist active sessions:', err);
  }
}

function recoverPersistedSessions(): void {
  loadPendingSessions();
  const file = getPersistPath();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      fs.unlinkSync(file);
      return;
    }
    const recovered: CompletedSession[] = [];

    for (const item of parsed as PersistedSession[]) {
      if (!item || typeof item.gameId !== 'string' || typeof item.startTime !== 'string') continue;
      const startMs = new Date(item.startTime).getTime();
      const endMs = Number.isFinite(item.lastSeenMs) ? item.lastSeenMs : startMs;
      if (!Number.isFinite(startMs) || endMs <= startMs) continue;
      const idleMs = Number.isFinite(item.idleAccumulatedMs) ? Math.max(0, item.idleAccumulatedMs) : 0;
      const activeMs = Math.max(0, endMs - startMs - idleMs);
      const activeInputMs = typeof item.activeInputMs === 'number' && Number.isFinite(item.activeInputMs)
        ? Math.max(0, item.activeInputMs)
        : undefined;
      recovered.push({
        id: uuidv4(),
        gameId: item.gameId,
        executablePath: item.executablePath ?? '',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        durationMinutes: Math.round((activeMs / 60_000) * 100) / 100,
        idleMinutes: Math.round((idleMs / 60_000) * 100) / 100,
        ...(activeInputMs !== undefined
          ? { activeInputMinutes: Math.round((activeInputMs / 60_000) * 100) / 100 }
          : {}),
      });
    }
    // Write the pending queue BEFORE consuming the snapshot so a crash in
    // between can never lose the recovered sessions.
    for (const c of recovered) pendingSessions.set(c.id, c);
    if (recovered.length > 0) persistPendingSessions();
    fs.unlinkSync(file); // consume once
    if (recovered.length > 0) {
      logger.log(`[SessionTracker] Recovered ${recovered.length} unfinalized session(s) from previous run`);
    }
  } catch (err) {
    logger.error('[SessionTracker] Failed to recover persisted sessions:', err);
  }
}

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

/**
 * When a session ends without a final sighting (untracked, Ark quitting, the
 * miss window running out): the last time the process was actually seen, so
 * neither the miss window nor a suspension after it counts as playtime.
 */
function sessionEndMs(session: ActiveSession, nowMs: number): number {
  return Math.max(session.startTime.getTime(), Math.min(nowMs, session.lastSeenMs || nowMs));
}

/** Add idle time, never letting total idle exceed the session's elapsed time. */
function addIdle(session: ActiveSession, ms: number, nowMs: number): void {
  if (!(ms > 0)) return;
  const elapsed = Math.max(0, nowMs - session.startTime.getTime());
  session.idleAccumulatedMs = Math.min(elapsed, session.idleAccumulatedMs + ms);
}

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
    // Measure OS-probe duration so we can surface hook latency in telemetry.
    const _hookStart = performance.now();
    const snapshotOk = await refreshProcessSnapshot();
    const hookLatencyMs = Math.round((performance.now() - _hookStart) * 100) / 100;

    if (!snapshotOk) {
      // No source could say what is running. Freeze: don't bump lastSeenMs
      // (that would extend sessions of games that may have exited) and don't
      // count misses (that would end sessions of games still running). If the
      // outage outlasts SLEEP_GAP_MS, the next good sighting books it as idle.
      if (!_snapshotFailureLogged) {
        _snapshotFailureLogged = true;
        logger.warn('[SessionTracker] Every process snapshot failed — sessions frozen until one succeeds');
      }
      return;
    }
    _snapshotFailureLogged = false;

    // Sample process resource usage for telemetry samples emitted below.
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

    // Get system idle time (seconds)
    let systemIdleS = 0;
    try {
      systemIdleS = deps.getSystemIdleTime();
    } catch {
      // powerMonitor may not be available in all environments
    }
    const isSystemIdle = systemIdleS >= IDLE_THRESHOLD_S;
    const nowMs = deps.now();

    for (const game of trackedGames) {
    const running = isProcessRunning(game.executablePath);
    const existingSession = activeSessions.get(game.gameId);

    if (running && !existingSession) {
      // ---- Game just started ----
      const session: ActiveSession = {
        gameId: game.gameId,
        executablePath: game.executablePath,
        startTime: new Date(nowMs),
        idleAccumulatedMs: 0,
        lastIdleCheck: false,
        missedPolls: 0,
        lastSeenMs: nowMs,
        activeInputMs: 0,
        idleConfirmed: false,
        idleFloorMs: nowMs,
        suspendedMs: 0,
      };
      activeSessions.set(game.gameId, session);

      sendToRenderer('session:statusChange', { gameId: game.gameId, status: 'Playing Now' });
      sendToRenderer('session:started', { gameId: game.gameId, startTime: session.startTime.toISOString() });

      logger.log(`[SessionTracker] Game ${game.gameId} started (${path.basename(game.executablePath)})`);

    } else if (running && existingSession) {
      // ---- Game still running — accumulate idle if applicable ----
      // Sleep / hibernate: the process is still there on resume, so without
      // this the whole suspension counted as play. Either powerMonitor told
      // us (suspendedMs) or the gap since the last sighting is far longer
      // than one poll; one poll's worth stays as the normal tick.
      const sinceSeenMs = nowMs - existingSession.lastSeenMs;
      const gapIdleMs = sinceSeenMs > SLEEP_GAP_MS ? sinceSeenMs - POLL_INTERVAL_MS : 0;
      const sleptMs = Math.max(existingSession.suspendedMs, gapIdleMs);
      existingSession.suspendedMs = 0;

      // Recovered from a transient miss: clear the counter.
      existingSession.missedPolls = 0;
      existingSession.lastSeenMs = nowMs;

      if (sleptMs > 0) {
        addIdle(existingSession, sleptMs, nowMs);
        // The system idle clock spans the sleep too — restart idle
        // confirmation so it can't be counted a second time.
        existingSession.lastIdleCheck = false;
        existingSession.idleConfirmed = false;
        existingSession.idleFloorMs = nowMs;
      } else {
        // Only count idle once it has been sustained across two consecutive
        // polls, so a single idle blip (or controller-only play crossing the
        // threshold for one tick) doesn't unfairly subtract active time. On
        // the confirming tick the whole break so far is back-dated (the
        // system idle clock says how long ago the last input was), clamped
        // to this session; after that, one poll per tick.
        if (isSystemIdle && existingSession.lastIdleCheck) {
          if (!existingSession.idleConfirmed) {
            addIdle(existingSession, Math.min(systemIdleS * 1000, nowMs - existingSession.idleFloorMs), nowMs);
            existingSession.idleConfirmed = true;
          } else {
            addIdle(existingSession, POLL_INTERVAL_MS, nowMs);
          }
        } else if (!isSystemIdle) {
          existingSession.idleConfirmed = false;
        }
        existingSession.lastIdleCheck = isSystemIdle;

        // Telemetry: count this tick as active-input when the system was not idle
        // for longer than one poll interval — i.e. the user provided input recently.
        if (systemIdleS < POLL_INTERVAL_S) {
          existingSession.activeInputMs += POLL_INTERVAL_MS;
        }
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
      const completed = buildCompleted(game.gameId, existingSession, sessionEndMs(existingSession, nowMs));

      activeSessions.delete(game.gameId);

      finalizeCompleted(completed);

      logger.log(
        `[SessionTracker] Game ${game.gameId} ended — ` +
        `active: ${completed.durationMinutes.toFixed(1)}min, idle: ${completed.idleMinutes.toFixed(1)}min`
      );
    }
    // If !running && !existingSession → nothing to do
  }

  // Telemetry: emit one sample per active session per tick so per-game panels can chart it.
  if (activeSessions.size > 0) {
    const telemetryTimestamp = new Date(nowMs).toISOString();
    for (const s of activeSessions.values()) {
      sendToRenderer('session:telemetrySample', {
        timestamp: telemetryTimestamp,
        gameId: s.gameId,
        cpuPercent,
        rssMb,
        hookLatencyMs,
      });
    }
  }

  // Snapshot in-progress sessions for crash recovery on the next launch.
  persistActiveSessions();

  // Show/hide the overlay HUD based on whether anything is being played now.
  updateOverlayVisibility();
  } finally {
    pollInFlight = false;
  }
}

/** powerMonitor 'suspend': remember when the system went to sleep. */
export function handlePowerSuspend(nowMs: number = deps.now()): void {
  suspendStartMs = nowMs;
}

/**
 * powerMonitor 'resume': book the suspended span as idle on every running
 * session. Applied on the session's next sighting (not here), so a game that
 * turns out to have exited during sleep still ends at its last sighting with
 * no idle subtracted for time after it.
 */
export function handlePowerResume(nowMs: number = deps.now()): void {
  if (suspendStartMs === null) return;
  const spanMs = Math.max(0, nowMs - suspendStartMs);
  suspendStartMs = null;
  if (spanMs === 0) return;
  for (const session of activeSessions.values()) {
    session.suspendedMs += spanMs;
  }
  logger.log(`[SessionTracker] Resumed after ${Math.round(spanMs / 1000)}s suspended — counted as idle`);
}

function wirePowerEvents(): void {
  if (powerEventsWired) return;
  try {
    if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
    powerMonitor.on('suspend', () => handlePowerSuspend());
    powerMonitor.on('resume', () => handlePowerResume());
    powerEventsWired = true;
  } catch (err) {
    logger.warn('[SessionTracker] powerMonitor suspend/resume unavailable:', err);
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
  // Also forward the same payload to the overlay HUD window, if registered.
  // Guard against a destroyed window (overlay is torn down on app quit).
  try {
    if (overlayWindowRef && !overlayWindowRef.isDestroyed()) {
      overlayWindowRef.webContents.send(channel, data);
    }
  } catch (err) {
    logger.error(`[SessionTracker] Failed to forward ${channel} to overlay:`, err);
  }
}

/**
 * Fire the overlay visibility callback for the in-game HUD.
 *
 * Show path is edge-triggered (0→1) so we don't recreate the HWND every poll.
 * Hide path is **level-triggered**: whenever there are zero active sessions we
 * always request deactivate. That repairs desync when the overlay was shown via
 * Settings/hotkey without going through this gate (`lastOverlayShouldShow`
 * stayed false → a later session-end would skip the callback and leave a
 * phantom HUD with a zeroed timer).
 */
function updateOverlayVisibility(): void {
  // Every activeSessions change ends here — also feed the game-running signal
  // (Ollama unloads its models and pauses background work while gaming).
  reportGameActivity(activeSessions.size);
  if (!overlayVisibilityCallback) return;
  const shouldShow = activeSessions.size > 0;
  if (!shouldShow) {
    lastOverlayShouldShow = false;
    try {
      overlayVisibilityCallback(false);
    } catch (err) {
      logger.error('[SessionTracker] Overlay visibility callback failed:', err);
    }
    return;
  }
  if (lastOverlayShouldShow) return;
  lastOverlayShouldShow = true;
  try {
    overlayVisibilityCallback(true);
  } catch (err) {
    logger.error('[SessionTracker] Overlay visibility callback failed:', err);
  }
}

/**
 * Keep the session-gate latch in sync when main/settings show or hide the
 * overlay outside `updateOverlayVisibility` (hotkey / Settings toggle).
 */
export function syncOverlayVisibilityLatch(shouldShow: boolean): void {
  lastOverlayShouldShow = shouldShow;
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
  stopped = false;

  // Recover any sessions left unfinalized by a previous crash/force-kill.
  recoverPersistedSessions();
  // Sleep / hibernate: the suspended span is idle, not play.
  wirePowerEvents();

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    void pollTick();
  }, POLL_INTERVAL_MS);
  logger.log('[SessionTracker] Started (polling every 15s, async process snapshot)');
}

/**
 * Every completed session the renderer has not acknowledged yet (live-ended
 * sessions it may have missed + sessions recovered from a crashed run). NOT
 * drained: entries leave the queue only via `ackSessions`, so a renderer that
 * crashes mid-record gets them again on its next mount (recording is
 * idempotent by id on the renderer side).
 */
export function getUnackedSessions(): CompletedSession[] {
  loadPendingSessions();
  return Array.from(pendingSessions.values());
}

/** @deprecated kept for older callers — now non-destructive (see getUnackedSessions). */
export function drainRecoveredSessions(): CompletedSession[] {
  return getUnackedSessions();
}

/** Renderer confirms these sessions are persisted — drop them from the queue. */
export function ackSessions(ids: unknown): number {
  if (!Array.isArray(ids)) return 0;
  let removed = 0;
  for (const id of ids) {
    if (typeof id === 'string' && pendingSessions.delete(id)) removed++;
  }
  if (removed > 0) persistPendingSessions();
  return removed;
}

let stopped = false;

export function stopSessionTracker() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (stopped) return;
  stopped = true;

  // Finalize any active sessions (up to the last time the process was seen —
  // quitting Ark must not count time the game wasn't confirmed running).
  const nowMs = deps.now();
  for (const [gameId, session] of activeSessions) {
    finalizeCompleted(buildCompleted(gameId, session, sessionEndMs(session, nowMs)));
  }

  activeSessions.clear();
  // We finalized everything cleanly — drop the crash-recovery snapshot so we
  // don't double-count these sessions on the next launch.
  persistActiveSessions();
  updateOverlayVisibility();
  mainWindowRef = null;
  logger.log('[SessionTracker] Stopped');
}

export type TrackedSource = 'library' | 'custom';

export interface SetTrackedGamesOptions {
  /**
   * Sources the renderer could not read this time (read-only store with no
   * entries). Their previously tracked games are kept as they are and their
   * running sessions are not finalized as orphans; only the other source's
   * games are replaced.
   */
  keepSources?: readonly TrackedSource[];
}

function sourceOf(gameId: string): TrackedSource {
  return gameId.startsWith('custom-') ? 'custom' : 'library';
}

/**
 * One owner per exe. Two entries pointing at the same exe (Steam + Epic
 * copies, two titles on one launcher) would otherwise each record the full
 * session and double the hours. Owner: (1) the entry already running a
 * session for that exe, so a resync never moves a live session, (2) a library
 * entry over a custom one, (3) the first in input order.
 */
function pickExeOwners(games: readonly TrackedGame[]): TrackedGame[] {
  const groups = new Map<string, TrackedGame[]>();
  for (const g of games) {
    const key = canonicalKeys(g.executablePath)[0];
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }

  const owners = new Set<TrackedGame>();
  const collisions: string[] = [];
  for (const [key, list] of groups) {
    if (list.length === 1) {
      owners.add(list[0]);
      continue;
    }
    const owner =
      list.find((g) => {
        const s = activeSessions.get(g.gameId);
        return !!s && canonicalKeys(s.executablePath)[0] === key;
      }) ??
      list.find((g) => sourceOf(g.gameId) === 'library') ??
      list[0];
    owners.add(owner);
    const others = [...new Set(list.filter((g) => g !== owner && g.gameId !== owner.gameId).map((g) => g.gameId))];
    if (others.length > 0) collisions.push(`"${key}" → ${owner.gameId} (also: ${others.join(', ')})`);
  }

  const signature = collisions.join('|');
  if (signature !== lastCollisionSignature) {
    lastCollisionSignature = signature;
    for (const c of collisions) {
      logger.warn(`[SessionTracker] Several games share one exe; playtime goes to one owner: ${c}`);
    }
  }

  return games.filter((g) => owners.has(g));
}

/**
 * Update the list of games to monitor.
 * Called from an IPC handler when the renderer sends its tracked games list.
 *
 * Any active session whose gameId is no longer in the new list is finalized
 * immediately — prevents orphaned "Playing Now" ghosts. Games from a source
 * in `options.keepSources` are taken from the previous list instead, so a
 * store that failed to load never ends its games' sessions.
 */
export function setTrackedGames(games: TrackedGame[], options: SetTrackedGamesOptions = {}) {
  const keep = new Set(options.keepSources ?? []);
  const merged = [
    ...lastInputGames.filter((g) => keep.has(sourceOf(g.gameId))),
    ...games.filter((g) => !keep.has(sourceOf(g.gameId))),
  ];
  lastInputGames = merged;
  const owned = pickExeOwners(merged);
  // Kept-source sessions stay in `owned`: their entries are unchanged and an
  // entry with a running session always wins its exe.
  const newIds = new Set(owned.map((g) => g.gameId));
  let finalizedAny = false;
  const nowMs = deps.now();

  // Finalize sessions for games that were removed from the tracked list
  for (const [gameId, session] of activeSessions) {
    if (!newIds.has(gameId)) {
      const completed = buildCompleted(gameId, session, sessionEndMs(session, nowMs));

      activeSessions.delete(gameId);
      finalizeCompleted(completed);
      finalizedAny = true;
      logger.log(`[SessionTracker] Finalized orphaned session for ${gameId}`);
    }
  }

  trackedGames = owned;
  // Drop finalized sessions from the crash-recovery snapshot right away so a
  // crash before the next tick can't recover them a second time.
  if (finalizedAny) persistActiveSessions();
  // Untracking a game may have finalized its active session above.
  updateOverlayVisibility();
  logger.log(
    `[SessionTracker] Now tracking ${owned.length} game(s)` +
    (keep.size > 0 ? ` (kept previous ${[...keep].join(' + ')} list)` : ''),
  );
}

/**
 * Get currently active sessions (for IPC queries). `elapsedMinutes` is active
 * play time — idle subtracted, exactly like `session:liveUpdate`.
 */
export function getActiveSessions(): Array<{ gameId: string; startTime: string; elapsedMinutes: number }> {
  const now = deps.now();
  return Array.from(activeSessions.values()).map((s) => ({
    gameId: s.gameId,
    startTime: s.startTime.toISOString(),
    elapsedMinutes: Math.round(Math.max(0, now - s.startTime.getTime() - s.idleAccumulatedMs) / 60_000 * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Test seams — never called from production code.
// ---------------------------------------------------------------------------

/**
 * Reset all tracker state, point it at a fake window (no poll timer is
 * started) and override any OS dependency. Omitted deps use the real ones.
 */
export function __resetSessionTrackerForTests(
  mainWindow: BrowserWindowType | null,
  overrides: Partial<SessionTrackerDeps> = {},
): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  deps = { ...defaultDeps, ...overrides };
  mainWindowRef = mainWindow;
  stopped = false;
  pollInFlight = false;
  trackedGames = [];
  lastInputGames = [];
  lastCollisionSignature = '';
  suspendStartMs = null;
  activeSessions.clear();
  pendingSessions.clear();
  _canonicalKeyCache.clear();
  _basenameCollisionWarned.clear();
  _runningBasenames = new Set();
  _runningPaths = new Set();
  _basenamePaths = new Map();
  _unresolvedBasenames = new Set();
  _pathSnapshotStale = false;
  _basenameSnapshotStale = false;
  _snapshotFailureLogged = false;
}

/** Run one poll tick now. */
export function __pollTickForTests(): Promise<void> {
  return pollTick();
}
