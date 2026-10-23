import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, shell, session, Tray, Menu, nativeImage, dialog, ipcMain } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import path from 'path';
import https from 'node:https';

let tray: any = null;
let isQuitting = false;
import { FiltersEngine, Request } from '@ghostery/adblocker';
import fetch from 'cross-fetch';

// ESM has no __dirname; required for loadFile/preload paths when run as module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env — project root in dev, installation directory when packaged
const envPath = app.isPackaged
  ? path.join(path.dirname(process.execPath), '.env')
  : path.resolve(__dirname, '..', '..', '.env');
loadEnv({ path: envPath });

// Set Node.js process title — visible in system monitors and some task managers
process.title = 'Ark';

// EPIPE error handlers are installed by safe-logger.ts (imported below).

/**
 * True once the main window has reached `ready-to-show` (or a 60s fallback).
 * Before that, an uncaught exception is a STARTUP failure (dialog + exit);
 * after it, stray exceptions are logged and the app keeps running — quitting
 * a tray app silently mid-session used to drop the user's in-progress
 * session tracking for no reason.
 */
let startupComplete = false;

const ERROR_LOG_MAX_BYTES = 1024 * 1024;

/** Append (never overwrite) a timestamped entry; roll the file past 1 MB. */
function appendErrorLog(fileName: string, kind: string, err: unknown): string {
  const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err);
  try {
    const userData = app?.getPath?.('userData');
    if (userData) {
      const file = path.join(userData, fileName);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > ERROR_LOG_MAX_BYTES) {
          fs.renameSync(file, file + '.old');
        }
      } catch { /* rotation is best-effort */ }
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${msg}\n\n`, 'utf-8');
    }
  } catch {
    // ignore
  }
  return msg;
}

// Log startup errors to a file when packaged (app doesn't show console)
function logStartupError(err: unknown) {
  const msg = appendErrorLog('ark-startup-error.log', 'startup', err);
  logger.error('[Ark] Startup error:', msg);
}

process.on('uncaughtException', (err) => {
  if (startupComplete) {
    // Runtime stray exception: record it and keep the app (and its session
    // tracker / tray) alive.
    const msg = appendErrorLog('ark-error.log', 'uncaughtException', err);
    logger.error('[Ark] Uncaught exception (continuing):', msg);
    return;
  }
  logStartupError(err);
  if (!app.isPackaged) return; // dev: keep the process up for debugging
  try {
    const detail = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'Ark failed to start',
      `Ark hit an unexpected error while starting and has to close.\n\n${detail}\n\n` +
        'Details were written to ark-startup-error.log in the Ark data folder.',
    );
  } catch { /* dialog unavailable — exit anyway */ }
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('[Ark] Unhandled promise rejection:', reason);
  // Don't quit — just log. The rejection is already "handled" once this listener exists.
});

// ---------------------------------------------------------------------------
// Startup timeout helper — wraps a promise with a max-wait, returning null on timeout
// ---------------------------------------------------------------------------
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return v; }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => { logger.warn(`[Startup] ${label} timed out after ${ms}ms`); resolve(null); }, ms);
    }),
  ]);
}

import { steamAPI } from './steam-api.js';
import { epicAPI } from './epic-api.js';
import { chatStore, processMessage } from './ai-chat.js';
import { settingsStore } from './settings-store.js';
import { trackAppLaunch } from './analytics.js';
import { initAutoUpdater, registerUpdaterIpcHandlers } from './auto-updater.js';
import {
  startSessionTracker,
  stopSessionTracker,
  registerOverlayWindow,
  getActiveSessions,
  syncOverlayVisibilityLatch,
} from './session-tracker.js';
import {
  setOverlayPreloadPath,
  setOverlayLifecycleHooks,
  activateOverlay,
  deactivateOverlay,
  isOverlayVisible,
  registerOverlayHotkey,
  registerOverlayCycleHotkey,
  unregisterOverlayHotkey,
  destroyOverlay,
} from './overlay-window.js';
import { logger } from './safe-logger.js';
import { setEmbeddingBackgroundMode } from './ipc/ollama-handlers.js';
import { atomicWriteFileSync } from './safe-write.js';
let mainWindow: BrowserWindowType | null = null;

// ---------------------------------------------------------------------------
// Crash-loop breaker (boot health)
//
// Persists renderer crashes and abnormal exits across launches in
// `<userData>/boot-health.json`. If CRASH_LOOP_THRESHOLD of them happen within
// CRASH_LOOP_WINDOW_MS, the next launch starts in SAFE MODE (the renderer asks
// via `app:getSafeMode` and skips its heavy startup work). A launch that runs
// STABLE_RUN_MS without a renderer crash clears the counter; a clean quit
// clears the "boot in progress" marker so it isn't counted as a crash.
// ---------------------------------------------------------------------------

interface BootHealthFile {
  /** Timestamps (ms) of renderer crashes / abnormal exits. */
  crashes: number[];
  /** Set while a launch is running; still present on next start ⇒ abnormal exit. */
  pendingBoot: { startedAt: number; stable?: boolean } | null;
}

const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
const CRASH_LOOP_THRESHOLD = 3;
/** In-session: reload into safe mode once this many crashes are in the window. */
const IN_SESSION_SAFE_MODE_THRESHOLD = 2;
const STABLE_RUN_MS = 3 * 60_000;

let bootHealth: BootHealthFile = { crashes: [], pendingBoot: null };
let bootHealthInitialized = false;
let lastRendererCrashAt = 0;
let stableTimer: NodeJS.Timeout | null = null;
const safeModeState: { safeMode: boolean; reason?: string; recentCrashes: number } = {
  safeMode: false,
  recentCrashes: 0,
};

function bootHealthPath(): string | null {
  try {
    return path.join(app.getPath('userData'), 'boot-health.json');
  } catch {
    return null;
  }
}

function writeBootHealth(): void {
  if (!app.isPackaged) return; // dev runs never feed the packaged build's crash counter
  const file = bootHealthPath();
  if (!file) return;
  try {
    atomicWriteFileSync(file, JSON.stringify(bootHealth));
  } catch (err) {
    logger.warn('[BootHealth] write failed (non-fatal):', err);
  }
}

function recentCrashes(now = Date.now()): number[] {
  return bootHealth.crashes.filter((t) => Number.isFinite(t) && now - t >= 0 && now - t <= CRASH_LOOP_WINDOW_MS);
}

function initBootHealth(): void {
  if (bootHealthInitialized) return;
  bootHealthInitialized = true;
  // Dev restarts kill main without a clean quit — three quick rebuilds would otherwise
  // drop the dev build into safe mode. Crash-loop protection is for packaged builds.
  if (!app.isPackaged) return;
  const now = Date.now();
  try {
    const file = bootHealthPath();
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BootHealthFile>;
      bootHealth = {
        crashes: Array.isArray(parsed.crashes) ? parsed.crashes.filter((t) => typeof t === 'number') : [],
        pendingBoot: parsed.pendingBoot && typeof parsed.pendingBoot.startedAt === 'number' ? parsed.pendingBoot : null,
      };
    }
  } catch (err) {
    logger.warn('[BootHealth] unreadable — starting fresh:', err);
    bootHealth = { crashes: [], pendingBoot: null };
  }
  // Previous launch never quit cleanly and never became stable → it crashed
  // (or was killed) during startup.
  if (bootHealth.pendingBoot && !bootHealth.pendingBoot.stable) {
    bootHealth.crashes.push(bootHealth.pendingBoot.startedAt);
    logger.warn('[BootHealth] Previous launch exited abnormally during startup');
  }
  bootHealth.crashes = recentCrashes(now);
  bootHealth.pendingBoot = { startedAt: now };
  const recent = bootHealth.crashes.length;
  safeModeState.recentCrashes = recent;
  if (recent >= CRASH_LOOP_THRESHOLD) {
    safeModeState.safeMode = true;
    safeModeState.reason = `${recent} crashes in the last ${CRASH_LOOP_WINDOW_MS / 60_000} minutes`;
    logger.warn(`[BootHealth] Crash loop detected (${recent}) — starting in SAFE MODE`);
  }
  writeBootHealth();
  scheduleStableReset();
}

/** After STABLE_RUN_MS without a renderer crash, forget past crashes. */
function scheduleStableReset(): void {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    const sinceCrash = Date.now() - lastRendererCrashAt;
    if (sinceCrash < STABLE_RUN_MS) {
      scheduleStableReset();
      return;
    }
    bootHealth.crashes = [];
    if (bootHealth.pendingBoot) bootHealth.pendingBoot.stable = true;
    writeBootHealth();
    logger.log('[BootHealth] Stable run — crash counter reset (next launch starts normally)');
  }, STABLE_RUN_MS);
  stableTimer.unref?.();
}

/** Record a renderer crash; may switch the current run into safe mode. */
function recordRendererCrash(reason: string): void {
  const now = Date.now();
  lastRendererCrashAt = now;
  bootHealth.crashes.push(now);
  bootHealth.crashes = recentCrashes(now);
  if (bootHealth.pendingBoot) bootHealth.pendingBoot.stable = false;
  const recent = bootHealth.crashes.length;
  safeModeState.recentCrashes = recent;
  if (!safeModeState.safeMode && recent >= IN_SESSION_SAFE_MODE_THRESHOLD) {
    safeModeState.safeMode = true;
    safeModeState.reason = `renderer crashed ${recent} times recently (${reason})`;
    logger.warn('[BootHealth] Repeated renderer crashes — reloads will use SAFE MODE');
  }
  writeBootHealth();
  if (bootHealthInitialized) scheduleStableReset();
}

/** Clean quit — this launch must not count as an abnormal exit. */
function markCleanExit(): void {
  if (!bootHealthInitialized) return;
  bootHealth.pendingBoot = null;
  writeBootHealth();
}

// ---------- Data migration: game-tracker → ark ----------
// When we renamed the package from "game-tracker" to "ark", the userData
// directory changed from %APPDATA%/game-tracker to %APPDATA%/ark.
// Copy existing data so users don't lose their library, cache, or settings.
(function migrateUserData() {
  try {
    const newUserData = app.getPath('userData'); // …/ark
    const oldUserData = path.join(path.dirname(newUserData), 'game-tracker');

    if (fs.existsSync(oldUserData) && !fs.existsSync(path.join(newUserData, '.migrated'))) {
      logger.log(`[Migration] Migrating user data from ${oldUserData} → ${newUserData}`);
      if (!fs.existsSync(newUserData)) {
        fs.mkdirSync(newUserData, { recursive: true });
      }

      // Copy every file from the old directory (shallow — no subdirs needed)
      const files = fs.readdirSync(oldUserData);
      for (const file of files) {
        const src = path.join(oldUserData, file);
        const dest = path.join(newUserData, file);
        if (fs.statSync(src).isFile() && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          logger.log(`[Migration] Copied ${file}`);
        }
      }

      // Write a marker so we only migrate once
      fs.writeFileSync(path.join(newUserData, '.migrated'), 'migrated from game-tracker', 'utf-8');
      logger.log('[Migration] Done');
    }
  } catch (err) {
    logger.warn('[Migration] Non-fatal error during data migration:', err);
  }
})();

// Set the app name early — affects window titles, tray labels, and process
// descriptions where the runtime can influence them.
app.name = 'Ark';
app.setAppUserModelId('com.ark.gametracker');

// ---------------------------------------------------------------------------
// Single Instance Lock — prevent multiple instances from running
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
const isChatPromptsTest = process.argv.includes('--run-chat-prompts');
if (!gotTheLock && !isChatPromptsTest) {
  // Another instance already owns the lock — quit immediately (unless we're the chat-prompts test runner).
  app.quit();
} else if (gotTheLock) {
  app.on('second-instance', () => {
    // A second instance was attempted — bring the existing window to front
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Suppress noisy Chromium/Electron errors on Windows
// ---------------------------------------------------------------------------
// GPU shader disk cache causes "Unable to move the cache: Access is denied"
// and "Gpu Cache Creation failed" on Windows due to file locking conflicts.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Reduce quota database errors ("Could not open the quota database, resetting")
// caused by stale locks when multiple Electron instances fight over storage.
app.commandLine.appendSwitch('disable-features', 'ServiceWorkerBypassFetchHandler');

// Resource throttling: keep the app lightweight when running alongside games.
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '256');
app.commandLine.appendSwitch('max-active-webgl-contexts', '1');
// Aggressively throttle background renderers (timers, rAF).
app.commandLine.appendSwitch('enable-features', 'IntensiveWakeUpThrottling,OptOutOfSharedZygote');
// Limit max renderer processes to 1 (single-window app).
app.commandLine.appendSwitch('renderer-process-limit', '1');

// Register updater IPC handlers early so the renderer never hits
// "No handler registered" errors — even in dev mode.
registerUpdaterIpcHandlers();

/**
 * Resolve the preload script path. Shared by the main window and the overlay
 * window so both load the SAME `preload.cjs` (which exposes the `sessionTracker`
 * bridge the overlay HUD relies on).
 */
function getPreloadPath(): string {
  if (app.isPackaged) {
    // Preload is unpacked (asarUnpack) so load from app.asar.unpacked to avoid Windows asar issues
    const resourcesPath = process.resourcesPath;
    const unpacked = path.join(resourcesPath, 'app.asar.unpacked', 'dist-electron', 'electron', 'preload.cjs');
    // Fallback if unpacked path doesn't exist (e.g. older build)
    if (!fs.existsSync(unpacked)) {
      return path.join(app.getAppPath(), 'dist-electron', 'electron', 'preload.cjs');
    }
    return unpacked;
  }
  return path.join(__dirname, 'preload.cjs');
}

function createWindow() {
  // Resolve paths: when packaged, use app path so loadFile/preload work from installed location
  const preloadPath = getPreloadPath();
  let indexPath: string;
  if (app.isPackaged) {
    indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
  } else {
    indexPath = path.join(__dirname, '../../dist/index.html');
  }

  // Resolve the window icon — use the ICO for Windows taskbar / ALT+TAB.
  // In dev mode the icon lives in build/; in production electron-builder embeds it.
  const projectRoot = path.join(__dirname, '../..');
  let windowIcon;
  if (app.isPackaged) {
    const icoCandidates = [
      path.join(process.resourcesPath, 'icons', 'icon.ico'),
      path.join(process.resourcesPath, 'icons', 'icon-256.png'),
    ];
    const found = icoCandidates.find((p) => fs.existsSync(p));
    if (found) windowIcon = nativeImage.createFromPath(found);
  } else {
    const icoCandidates = [
      path.join(projectRoot, 'build', 'icon.ico'),
      path.join(projectRoot, 'build', 'icon.png'),
    ];
    const found = icoCandidates.find((p) => fs.existsSync(p));
    if (found) windowIcon = nativeImage.createFromPath(found);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 680,
    minHeight: 500,
    title: 'Ark',
    ...(windowIcon && !windowIcon.isEmpty() ? { icon: windowIcon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
      backgroundThrottling: true,
    },
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    show: false,
  });

  // Start maximized
  mainWindow.maximize();

  // In development, load from Vite dev server
  const isDev = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';
  
  if (isDev || (!app.isPackaged && !isProd && !isTest)) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(indexPath);
  }

  // ---- Navigation guards ----
  // Redirect any link that tries to open a NEW window (target="_blank", window.open, etc.)
  // to the default OS browser instead of spawning an Electron BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url);
      logger.log(`[Navigation] Redirected new-window request to OS browser: ${url}`);
    }
    return { action: 'deny' }; // Never open a child Electron window
  });

  // Prevent the main window from navigating away from the app.
  // Any external http(s) URL is opened in the OS browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the Vite dev server or the local file in production
    const currentUrl = mainWindow?.webContents.getURL() || '';
    const isInternalNav =
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith(currentUrl.split('#')[0]); // hash-based routing

    if (!isInternalNav) {
      event.preventDefault();
      shell.openExternal(url);
      logger.log(`[Navigation] Blocked in-window navigation, opened in OS browser: ${url}`);
    }
  });

  // ---- Renderer crash recovery (with circuit breaker) ----
  // Every crash is also recorded in the persisted boot-health counter: after
  // repeated crashes the reload (and the next launch) runs in SAFE MODE, so we
  // don't reload straight back into the same crash. Completed sessions are
  // safe across the reload — main keeps them queued until the renderer acks.
  const crashTimestamps: number[] = [];
  const CRASH_WINDOW_MS = 30_000;
  const MAX_CRASHES_IN_WINDOW = 3;

  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    logger.error('[Ark] Renderer process gone:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit') return;

    recordRendererCrash(String(details.reason));

    const now = Date.now();
    crashTimestamps.push(now);
    // Keep only crashes within the rolling window
    while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    if (crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      logger.error(`[Ark] ${MAX_CRASHES_IN_WINDOW} crashes in ${CRASH_WINDOW_MS / 1000}s — stopping reload loop`);
      return;
    }

    logger.log(`[Ark] Attempting renderer reload…${safeModeState.safeMode ? ' (safe mode)' : ''}`);
    mainWindow?.webContents.reload();
  });

  mainWindow.webContents.on('console-message', (_ev: any, level: number, message: string) => {
    if (level >= 2) {
      logger.log(`[Renderer:${level === 3 ? 'ERR' : 'WARN'}] ${message}`);
    } else if (
      message.startsWith('[Galaxy') ||
      message.startsWith('[Projection') ||
      message.startsWith('[EmbeddingService]')
    ) {
      logger.log(`[Renderer] ${message}`);
    }
  });

  mainWindow.once('ready-to-show', () => {
    startupComplete = true;
    // If launched with --hidden (auto-start), stay hidden in tray
    if (!process.argv.includes('--hidden')) {
      mainWindow?.show();
    } else {
      logger.log('[Startup] Launched with --hidden flag, staying in tray');
    }
    
    // Initialize auto-updater in production mode
    if (app.isPackaged && mainWindow) {
      initAutoUpdater(mainWindow);
    }

    // Start session tracker for game process monitoring
    if (mainWindow) {
      startSessionTracker(mainWindow);
    }

    // ---- In-game overlay HUD ----
    // Wire lazy create/destroy (no HWND at startup). Session activity + setting
    // gate when the transparent click-through overlay appears.
    setupOverlay();
  });

  // Intercept close to hide to tray instead of quitting
  mainWindow.on('close', (e: any) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    destroyWebContentsView();
    mainWindow = null;
  });

  // ─── Polite-to-foreground-game mode ──────────────────────────────────────
  // When our window loses focus for ≥2s, assume the user is in another app
  // (likely a fullscreen game). Switch the embedding pipeline to a polite
  // GPU profile (smaller batches, single in-flight, cooldown) so the game
  // gets uncontended GPU windows. Focus instantly restores full throughput.
  // The 2s debounce avoids flickering profile on quick alt-tabs.
  const BG_DEBOUNCE_MS = 2_000;
  let bgTimer: NodeJS.Timeout | null = null;

  mainWindow.on('blur', () => {
    if (bgTimer) clearTimeout(bgTimer);
    bgTimer = setTimeout(() => {
      setEmbeddingBackgroundMode(true);
      bgTimer = null;
    }, BG_DEBOUNCE_MS);
  });

  mainWindow.on('focus', () => {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    setEmbeddingBackgroundMode(false);
  });

  // Minimize / hide are also "user is elsewhere" signals — apply immediately,
  // no debounce (intentional action, not an incidental click-away).
  mainWindow.on('minimize', () => {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    setEmbeddingBackgroundMode(true);
  });
  mainWindow.on('hide', () => {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    setEmbeddingBackgroundMode(true);
  });
  mainWindow.on('restore', () => {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    setEmbeddingBackgroundMode(false);
  });
  mainWindow.on('show', () => {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    if (mainWindow?.isFocused()) setEmbeddingBackgroundMode(false);
  });
}

/**
 * Wire the in-game overlay HUD without creating a window at startup.
 * Non-fatal on failure — the overlay is optional/opt-in and must never block boot.
 */
function setupOverlay() {
  try {
    setOverlayPreloadPath(getPreloadPath());
    setOverlayLifecycleHooks({
      onCreated: (win) => registerOverlayWindow(win),
      onDestroyed: () => registerOverlayWindow(null),
    });

    // Tracker calls back when sessions exist / clear. Activate only when
    // enabled; deactivate always destroys the HWND (not a mere hide).
    registerOverlayWindow(null, (shouldShow) => {
      if (shouldShow && settingsStore.getOverlayEnabled()) {
        activateOverlay();
        syncOverlayVisibilityLatch(true);
      } else {
        deactivateOverlay();
        syncOverlayVisibilityLatch(false);
      }
    });

    // Hotkey toggles visibility. Never show an empty topmost window — require
    // an active tracked session in addition to the opt-in setting.
    registerOverlayHotkey(() => {
      if (isOverlayVisible()) {
        deactivateOverlay();
        syncOverlayVisibilityLatch(false);
      } else if (settingsStore.getOverlayEnabled() && getActiveSessions().length > 0) {
        activateOverlay();
        syncOverlayVisibilityLatch(true);
      }
    });
    // Cycle collapsed ↔ compact even when HWND is down so the next
    // activate opens at the chosen level (Super+Shift+D / Shift+Win+D).
    registerOverlayCycleHotkey();
  } catch (err) {
    logger.warn('[Overlay] Failed to set up in-game overlay (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// IPC handlers registered at start of whenReady (see below) so they exist before any window loads
// ---------------------------------------------------------------------------
import { registerAllHandlers, webviewHandlers } from './ipc/index.js';
import { runFullCatalogAdultFilterTest } from './ipc/catalog-handlers.js';
import { getLevelStore } from './storage/level-store.js';

// Access the webview's destroy function for window cleanup
function destroyWebContentsView() {
  (webviewHandlers as any).destroyWebContentsView?.();
}


// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
  // Register IPC handlers first so renderer can call them as soon as the window loads
  registerAllHandlers(() => mainWindow);

  // CLI: run chat prompts test (Azure OpenAI) then exit. Keep one hidden window so the app doesn't exit on some platforms.
  if (process.argv.includes('--run-chat-prompts')) {
    const keepAliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
    keepAliveWindow.setMenuBarVisibility(false);
    keepAliveWindow.loadURL('about:blank').catch(() => {});
    const promptIndexEnv = process.env.CHAT_PROMPT_INDEX != null ? parseInt(process.env.CHAT_PROMPT_INDEX, 10) : -1;
    const singleRun = promptIndexEnv >= 0;
    const resultsPath = path.join(
      process.cwd(),
      'tests',
      singleRun ? `chat-prompts-results-${promptIndexEnv}.json` : 'chat-prompts-results.json'
    );
    const results: Array<{
      id: number;
      category: string;
      prompt: string;
      content: string;
      toolsUsed: string[];
      responseTimeMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      error?: string;
    }> = [];
    const writeResults = (partial = false) => {
      try {
        fs.writeFileSync(resultsPath, JSON.stringify({
          description: partial ? 'Chat prompt test results (partial)' : 'Chat prompt test results',
          ranAt: new Date().toISOString(),
          results,
          ...(partial ? { runError: 'Run failed before completion' } : {}),
        }, null, 2), 'utf-8');
      } catch (e) {
        logger.error('[ChatPrompts] Failed to write results:', e);
      }
    };
    // Keep process alive on unhandled rejection during test (log only)
    const rejectHandler = (reason: unknown) => {
      logger.error('[ChatPrompts] Unhandled rejection:', reason);
    };
    process.prependListener('unhandledRejection', rejectHandler);
    try {
      const promptsPath = path.join(process.cwd(), 'tests', 'chat-prompts.json');
      if (!fs.existsSync(promptsPath)) {
        logger.error('[ChatPrompts] File not found: ' + promptsPath);
        app.quit();
        return;
      }
      // .env is loaded at startup; set AZURE_OPENAI_* env vars
      const strip = (s: string) => s.replace(/^[\s`'"]+|[\s`'"]+$/g, '').trim();
      const endpoint = strip(process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_ENDPOINT || '');
      const apiKey = strip(process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY || '');
      const deployment = strip(process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || '');
      const apiVersion = strip(process.env.AZURE_OPENAI_KEY_VERSION || process.env.AZURE_OPENAI_API_VERSION || '');
      if (!endpoint || !apiKey || !deployment) {
        logger.error('[ChatPrompts] Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT (or AZURE_OPENAI_* variants). Use .env in project root or export in shell.');
        app.quit();
        return;
      }
      settingsStore.setPreferredChatProvider('azure-openai');
      const raw = fs.readFileSync(promptsPath, 'utf-8');
      const { prompts } = JSON.parse(raw) as { description?: string; prompts: Array<{ id: number; category: string; prompt: string }> };
      const limitArg = process.argv.find((a) => a.startsWith('--run-chat-prompts='));
      const promptLimit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 50) : 50;
      const promptsToRun = singleRun && promptIndexEnv < prompts.length
        ? [prompts[promptIndexEnv]]
        : prompts.slice(0, promptLimit);
      logger.log(`[ChatPrompts] Running ${promptsToRun.length} prompts with Azure OpenAI (no window)...`);
      writeResults(); // create file immediately so we can see if process exits before first prompt
      const providerOptions = { azure: { endpoint: endpoint.replace(/\/+$/, ''), apiKey, deployment, ...(apiVersion ? { apiVersion } : {}) } };
      const PER_PROMPT_MS = 120_000; // 2 min per prompt (tool loops + web search can be slow)
      for (let i = 0; i < promptsToRun.length; i++) {
        const { id, category, prompt } = promptsToRun[i];
        logger.log(`[ChatPrompts] Starting ${i + 1}/${promptsToRun.length} id=${id}...`);
        const startMs = Date.now();
        try {
          const out = await Promise.race([
            processMessage(prompt, undefined, [], undefined, undefined, providerOptions),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Timeout after ${PER_PROMPT_MS / 1000}s`)), PER_PROMPT_MS)
            ),
          ]);
          const responseTimeMs = Date.now() - startMs;
          results.push({
            id,
            category,
            prompt,
            content: out.content,
            toolsUsed: out.toolsUsed || [],
            responseTimeMs,
            ...(out.usage && {
              inputTokens: out.usage.inputTokens,
              outputTokens: out.usage.outputTokens,
              totalTokens: out.usage.totalTokens,
            }),
          });
          logger.log(`[ChatPrompts] ${i + 1}/${promptsToRun.length} id=${id} category=${category} tools=${(out.toolsUsed || []).join(',') || 'none'} ${responseTimeMs}ms ${out.usage?.totalTokens ?? '-'} tok`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            id,
            category,
            prompt,
            content: '',
            toolsUsed: [],
            responseTimeMs: Date.now() - startMs,
            error: msg,
          });
          logger.warn(`[ChatPrompts] ${i + 1}/${promptsToRun.length} id=${id} ERROR:`, msg);
        }
        writeResults();
      }
      logger.log('[ChatPrompts] Results written to ' + resultsPath);
    } catch (err) {
      logStartupError(err);
      if (results.length > 0) writeResults(true);
    } finally {
      process.removeListener('unhandledRejection', rejectHandler);
      try { keepAliveWindow.destroy(); } catch { /* ignore */ }
    }
    app.quit();
    return;
  }

  // CLI: run full-catalog adult filter test then exit
  if (process.argv.includes('--run-adult-filter-test')) {
    // Keep one hidden window so the process is not killed by OS/tooling during long runs
    const testWindow = new BrowserWindow({ width: 1, height: 1, show: false });
    try {
      logger.log('[Startup] Running full-catalog adult filter test...');
      const result = await runFullCatalogAdultFilterTest();
      logger.log(`[Startup] Done. Steam excluded: ${result.steam.excluded}, Epic excluded: ${result.epic.excluded}`);
    } catch (err) {
      logStartupError(err);
    }
    testWindow.destroy();
    app.quit();
    return;
  }

  // CLI: fetch Epic system requirements for a game (e.g. Death Stranding 2) then exit
  // Uses same Epic APIs as the app (getProductContent = CMS REST; searchGames = GraphQL).
  // Run: npm run fetch-epic-requirements   or   electron . --fetch-epic-requirements [slug]
  if (process.argv.includes('--fetch-epic-requirements')) {
    const idx = process.argv.indexOf('--fetch-epic-requirements');
    const slugArg = process.argv[idx + 1];
    const defaultSlug = 'death-stranding-2-on-the-beach-7773ec';
    const slugsToTry: string[] = slugArg && !slugArg.startsWith('--') ? [slugArg] : [defaultSlug];
    const testWindow = new BrowserWindow({ width: 1, height: 1, show: false });
    const outPath = path.join(app.getPath('userData'), 'epic-requirements-output.txt');
    try {
      const append = (s: string) => { fs.appendFileSync(outPath, s + '\n', 'utf-8'); };
      fs.writeFileSync(outPath, '[fetch-epic-requirements] Slugs: ' + slugsToTry.join(', ') + '\n', 'utf-8');
      let result: Awaited<ReturnType<typeof epicAPI.getProductContent>> = null;
      let usedSlug: string | null = null;

      // Bypass: direct HTTPS with TLS verification disabled (for strict/proxy environments)
      const directFetch = (slug: string): Promise<typeof result> =>
        new Promise((resolve) => {
          const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;
          const req = https.get(
            url,
            { rejectUnauthorized: false, headers: { 'Accept': 'application/json' } },
            (res) => {
              let body = '';
              res.on('data', (ch) => { body += ch; });
              res.on('end', () => {
                try {
                  const json = JSON.parse(body);
                  const pages = json?.pages ?? [];
                  let requirements: any[] | undefined;
                  for (const page of pages) {
                    const data = page?.data;
                    if (data?.requirements?.systems) {
                      requirements = data.requirements.systems;
                      break;
                    }
                  }
                  resolve(requirements?.length ? { requirements } : null);
                } catch {
                  resolve(null);
                }
              });
            }
          );
          req.on('error', () => resolve(null));
          req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        });

      for (const slug of slugsToTry) {
        append('Trying direct HTTPS (bypass): ' + slug);
        try {
          result = await Promise.race([
            directFetch(slug),
            new Promise<null>((resolve) => {
              setTimeout(() => {
                append('  -> bypass timeout 10s');
                resolve(null);
              }, 10000);
            }),
          ]);
          append('  -> requirements: ' + (result?.requirements?.length ?? 0));
          if (result?.requirements?.length) {
            usedSlug = slug;
            break;
          }
        } catch (e) {
          append('  -> error: ' + (e as Error).message);
        }
      }
      if (!result?.requirements?.length) {
        for (const slug of slugsToTry) {
          append('Trying getProductContent: ' + slug);
          try {
            result = await Promise.race([
              epicAPI.getProductContent(slug),
              new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout 12s')), 12000)),
            ]);
            append('  -> requirements: ' + (result?.requirements?.length ?? 0));
            if (result?.requirements?.length) {
              usedSlug = slug;
              break;
            }
          } catch (e) {
            append('  -> error: ' + (e as Error).message);
          }
        }
      }
      if (!result?.requirements?.length) {
        append('Trying searchGames("Death Stranding 2")...');
        try {
          const searchResults = await epicAPI.searchGames('Death Stranding 2', 10);
          append('  -> results: ' + (searchResults?.length ?? 0));
          for (const el of searchResults) {
            const s = el.catalogNs?.mappings?.[0]?.pageSlug || el.offerMappings?.[0]?.pageSlug || el.productSlug || (el.urlSlug && !/^[0-9a-f]{32}$/i.test(el.urlSlug || '') ? el.urlSlug : undefined);
            if (s && !slugsToTry.includes(s)) {
              const content = await epicAPI.getProductContent(s);
              if (content?.requirements?.length) {
                result = content;
                usedSlug = s;
                break;
              }
            }
          }
        } catch (e) {
          append('  -> error: ' + (e as Error).message);
        }
      }
      if (!result?.requirements?.length) {
        for (const s of ['death-stranding-2-on-the-beach', 'death-stranding-2']) {
          if (slugsToTry.includes(s)) continue;
          const content = await epicAPI.getProductContent(s);
          if (content?.requirements?.length) {
            result = content;
            usedSlug = s;
            break;
          }
        }
      }
      const lines: string[] = [];
      if (result?.requirements?.length) {
        lines.push('\n=== Epic system requirements (Death Stranding 2) ===');
        lines.push('Slug: ' + (usedSlug ?? slugsToTry[0]));
        for (const sys of result.requirements) {
          lines.push('\nPlatform: ' + (sys.systemType || 'unknown'));
          for (const d of sys.details || []) {
            const title = d.title || 'Spec';
            const min = d.minimum && typeof d.minimum === 'object' ? Object.entries(d.minimum).map(([k, v]) => `${k}: ${v}`).join(', ') : String(d.minimum ?? '—');
            const rec = d.recommended && typeof d.recommended === 'object' ? Object.entries(d.recommended).map(([k, v]) => `${k}: ${v}`).join(', ') : String(d.recommended ?? '—');
            lines.push(`  ${title} — Min: ${min} | Rec: ${rec}`);
          }
        }
        lines.push('\n=== End ===\n');
      } else {
        lines.push('\nNo system requirements returned. Try running the full app once (Epic Cloudflare clearance), then run this again.\n');
      }
      fs.appendFileSync(outPath, lines.join('\n'), 'utf-8');
      for (const line of lines) console.log(line);
    } catch (err) {
      try {
        fs.appendFileSync(outPath, 'FATAL: ' + (err as Error).message + '\n', 'utf-8');
      } catch (_) {}
      console.error('Fetch Epic requirements failed:', err);
    }
    try { testWindow.destroy(); } catch (_) {}
    app.quit();
    return;
  }

  // Apply auto-launch setting on startup
  try {
    const autoLaunchEnabled = settingsStore.getAutoLaunch();
    app.setLoginItemSettings({
      openAtLogin: autoLaunchEnabled,
      args: autoLaunchEnabled ? ['--hidden'] : [],
    });
    logger.log(`[Startup] Auto-launch is ${autoLaunchEnabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    logger.warn('[Startup] Failed to apply auto-launch setting:', err);
  }

  // Security: deny all permission requests the app doesn't need
  // (camera, microphone, geolocation, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Desktop notifications for Ark's own window only (Ark Wrapped season notice) —
    // embedded web content keeps the deny-all policy.
    if (permission === 'notifications' && mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
      callback(true);
      return;
    }
    logger.warn(`[Security] Denied permission request: ${permission}`);
    callback(false);
  });

  // Crash-loop breaker: count the previous launch if it died during startup
  // and decide whether this launch runs in safe mode. Only the instance that
  // owns the single-instance lock gets here (CLI modes returned above).
  initBootHealth();
  ipcMain.handle('app:getSafeMode', () => ({ ...safeModeState }));
  // Bring Ark forward (also from the tray) — e.g. clicking the Ark Wrapped notification.
  ipcMain.handle('app:showAndFocus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return true;
  });

  // Show window as early as possible — don't block on ad blocker
  try {
    createWindow();
    trackAppLaunch();
  } catch (err) {
    logStartupError(err);
    app.quit();
  }
  // Fallback: treat startup as complete even if ready-to-show never fires
  // (e.g. a hung first paint) so runtime exceptions don't hard-exit.
  setTimeout(() => { startupComplete = true; }, 60_000).unref?.();

  // Initialize ad blocker in the background (non-blocking — runs after window is shown)
  (async () => {
  try {
    const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');
    let engine: FiltersEngine;

    // Try loading from cache first for fast startup
    if (fs.existsSync(cachePath)) {
      const buf = await fs.promises.readFile(cachePath);
      engine = FiltersEngine.deserialize(buf);
        logger.log('[AdBlocker] Loaded engine from cache');
    } else {
        // Download filter lists (EasyList + EasyPrivacy) with a 15 s timeout
        const lists = await withTimeout(
          Promise.all([
        fetch('https://easylist.to/easylist/easylist.txt').then((r: any) => r.text()),
        fetch('https://easylist.to/easylist/easyprivacy.txt').then((r: any) => r.text()),
          ]),
          15000,
          'Ad blocker filter download',
        );
        if (!lists) {
          logger.warn('[AdBlocker] Skipping — filter download timed out');
          return;
        }
      engine = FiltersEngine.parse(lists.join('\n'));
      // Cache for faster startup next time
      await fs.promises.writeFile(cachePath, Buffer.from(engine.serialize()));
        logger.log('[AdBlocker] Downloaded filter lists and cached engine');
    }

    // Block matching network requests via session.webRequest
    // Allow-list: connectivity probes must never be blocked, even if a filter list matches.
    const ALLOWED_PROBE_HOSTS = ['connectivitycheck.gstatic.com', 'www.gstatic.com'];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details: any, callback: any) => {
        try {
      const { url, resourceType, referrer } = details;
      if (resourceType === 'mainFrame') {
        callback({ cancel: false });
        return;
      }
      const host = new URL(url).host.toLowerCase();
      if (ALLOWED_PROBE_HOSTS.includes(host)) {
        callback({});
        return;
      }
      const request = Request.fromRawDetails({ url, type: resourceType || 'other', sourceUrl: referrer || '' });
      const { match } = engine.match(request);
          callback({ cancel: !!match });
        } catch {
          // Never hang a request — allow it through if matching throws
        callback({ cancel: false });
      }
    });

      logger.log('[AdBlocker] Initialized and enabled');
  } catch (err) {
      logger.warn('[AdBlocker] Failed to initialize (non-fatal):', err);
    }
  })();

  // ML model is lazy-loaded on first score request (see ml-handlers.ts)

  // ---- Epic Cloudflare clearance (background, non-blocking) ----
  // Epic's GraphQL API is behind Cloudflare JS challenge.  We solve it once
  // at startup using a hidden BrowserWindow so all Epic catalog queries work.
  withTimeout(epicAPI.initCloudflare(), 20000, 'Epic Cloudflare clearance').then(ok => {
    if (ok) logger.log('[Startup] Epic Cloudflare clearance ready');
    else logger.warn('[Startup] Epic Cloudflare clearance failed or timed out — REST fallback active');
  }).catch((err: any) => { logger.warn('[Epic] Cloudflare init Non-fatal:', err); });

  // ---- System Tray ----
  try {
    // Build candidate list for the tray icon.
    // Prefer the pre-made 16×16 PNG (exact tray size, no resize needed).
    // Avoid .ico — Electron's nativeImage.createFromPath + resize can produce
    // a blank image from multi-size ICO files on Windows.
    const candidates: string[] = [];
    const projectRoot = path.join(__dirname, '../..');

    if (app.isPackaged) {
      // extraResources copies icons to <resourcesPath>/icons/
      const iconsDir = path.join(process.resourcesPath, 'icons');
      candidates.push(
        path.join(iconsDir, 'icon-16.png'),   // exact tray size — no resize needed
        path.join(iconsDir, 'icon-32.png'),
        path.join(iconsDir, 'icon-256.png'),
      );
    } else {
      candidates.push(
        path.join(projectRoot, 'build', 'icon-16.png'),
        path.join(projectRoot, 'build', 'icon-32.png'),
        path.join(projectRoot, 'build', 'icon.png'),
        path.join(projectRoot, 'build', 'icon-256.png'),
      );
    }

    let iconPath = candidates.find((p) => fs.existsSync(p));
    logger.log('[Tray] Icon candidates:', candidates, '| resolved:', iconPath);

    let trayIcon;
    if (iconPath) {
      const raw = nativeImage.createFromPath(iconPath);
      const size = raw.getSize();
      logger.log('[Tray] Loaded icon:', iconPath, '| size:', size.width, 'x', size.height, '| empty:', raw.isEmpty());
      // Only resize if the image isn't already 16×16
      trayIcon = (size.width === 16 && size.height === 16) ? raw : raw.resize({ width: 16, height: 16 });
    } else {
      logger.warn('[Tray] No icon file found in any candidate path - using empty icon');
      trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Ark');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Ark',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);

    // Double-click to show window
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    logger.log('[Tray] System tray initialized');
  } catch (err) {
    logger.warn('[Tray] Failed to create system tray (non-fatal):', err);
  }
});

// Set isQuitting flag before quit so close interceptor lets through
// Also flush caches synchronously so no data is lost on shutdown
app.on('before-quit', () => {
  isQuitting = true;
  // Finalize in-progress play sessions NOW. app.quit() from the tray skips
  // window-all-closed (window close is intercepted to hide-to-tray), so
  // stopSessionTracker used to never run on quit. Finalized sessions land in
  // the persisted pending queue and are recorded by the renderer (now, or on
  // the next launch if it's already gone). Idempotent.
  try { stopSessionTracker(); } catch (e) { logger.error('[Shutdown] Session tracker stop failed:', e); }
  // Tear down the overlay HUD and release its global hotkey.
  try { unregisterOverlayHotkey(); } catch (e) { logger.error('[Shutdown] Overlay hotkey unregister failed:', e); }
  try { destroyOverlay(); } catch (e) { logger.error('[Shutdown] Overlay destroy failed:', e); }
  try { steamAPI.flushCache(); } catch (e) { logger.error('[Shutdown] Steam cache flush failed:', e); }
  try { epicAPI.flushCache(); } catch (e) { logger.error('[Shutdown] Epic cache flush failed:', e); }
  try { chatStore.flushSync(); } catch (e) { logger.error('[Shutdown] Chat store flush failed:', e); }
});

// Flush LevelDB on shutdown. Fires after all windows have closed but before
// process exit. We hold the quit (preventDefault) until the close — which
// waits for in-flight writes, including the renderer's beforeunload flush
// batches — has finished, then exit explicitly. Bounded so quit never hangs;
// LevelDB self-recovers from its WAL if the cap is ever hit.
const SHUTDOWN_CLOSE_TIMEOUT_MS = 3_000;
let shutdownFinalized = false;
app.on('will-quit', (event: any) => {
  if (shutdownFinalized) return;
  shutdownFinalized = true;
  event.preventDefault();
  markCleanExit();
  // One macrotask lets already-dispatched store:* IPC handlers enqueue their
  // writes before we start closing.
  const closeDb = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => getLevelStore().close())
    .catch((err) => { logger.error('[Shutdown] LevelDB close failed:', err); });
  const cap = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_CLOSE_TIMEOUT_MS));
  void Promise.race([closeDb, cap]).finally(() => {
    try { app.exit(0); } catch { process.exit(0); }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on window-all-closed; app stays in tray
  // Only stop session tracker if actually quitting
  if (isQuitting) {
    stopSessionTracker();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
