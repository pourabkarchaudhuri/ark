/**
 * Overlay Window — a lightweight, transparent, click-through HUD that renders
 * a small corner badge (game name + live session timer) while a tracked game
 * is running.
 *
 * Design constraints (see the "Ark in-game overlay HUD" plan):
 *  - Non-injecting: plain topmost Electron window, NOT a DirectX/Present hook
 *    (same trust class as Discord/OBS overlays — zero anti-cheat risk).
 *  - Lazy lifecycle: the HWND is created only when a session is active AND the
 *    overlay is enabled. Deactivate fully destroys the window so an idle
 *    topmost BrowserWindow cannot steal GPU/CPU or interfere with mouse input.
 *  - Click-through WITHOUT `{ forward: true }` — forwarding forces Chromium to
 *    hit-test every mouse move into the overlay process and is a known source
 *    of in-game mouse lag. `focusable: false` keeps the game in focus.
 *  - `backgroundThrottling` starts true at create; we disable it only while the
 *    HUD is shown so the clock/fades keep running under a foreground game.
 *  - Detail levels (collapsed ↔ compact) resize the HWND; cycling is
 *    a global hotkey so the renderer stays click-through.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { logger } from './safe-logger.js';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import {
  DEFAULT_OVERLAY_DETAIL_LEVEL,
  OVERLAY_CYCLE_HOTKEY,
  OVERLAY_TOGGLE_HOTKEY,
  coerceOverlayDetailLevel,
  cycleDetailLevel,
  overlaySizeForLevel,
  type OverlayDetailLevel,
} from '../src/overlay/detail-level.js';

const require = createRequire(import.meta.url);
const electron = require('electron');

// `require('electron')` via createRequire bypasses vi.mock, so tests swap these
// through __setOverlayElectronForTests instead (same seam style as launch-handlers).
type OverlayElectronDeps = {
  app: any;
  BrowserWindow: any;
  screen: any;
  globalShortcut: any;
};
const realElectronDeps: OverlayElectronDeps = {
  app: electron?.app,
  BrowserWindow: electron?.BrowserWindow,
  screen: electron?.screen,
  globalShortcut: electron?.globalShortcut,
};
let { app, BrowserWindow, screen, globalShortcut } = realElectronDeps;

// ESM has no __dirname; required for loadFile/preload paths when run as a module.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Margin (DIP) from the top-right corner of the active display's work area. */
const OVERLAY_MARGIN = 24;
/** Debounce for display-metrics-changed (DPI / resolution / layout churn). */
const DISPLAY_METRICS_DEBOUNCE_MS = 150;
/**
 * Overlay renderer crash recovery budget: at most this many recreates per
 * rolling window. Separate from the main window's safe-mode counter.
 */
const OVERLAY_CRASH_RECREATE_LIMIT = 3;
const OVERLAY_CRASH_WINDOW_MS = 60_000;

export { OVERLAY_TOGGLE_HOTKEY, OVERLAY_CYCLE_HOTKEY };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let overlayWindow: BrowserWindowType | null = null;
let overlayPreloadPath: string | null = null;
let toggleHotkeyRegistered = false;
let cycleHotkeyRegistered = false;
/** True only after a cycle-hotkey register attempt failed (not when merely unregistered). */
let cycleHotkeyBindFailed = false;
/** Timestamps of recent crash-driven recreates (rolling OVERLAY_CRASH_WINDOW_MS). */
let crashRecreateTimes: number[] = [];
/** Called by settings:setOverlayEnabled after saving, so main can (un)register hotkeys. */
let overlayEnabledChangedHook: ((enabled: boolean) => void) | null = null;
/** Kept so we can detach the screen listener on destroy (avoids leaks). */
let displayMetricsHandler: (() => void) | null = null;
let displayMetricsTimer: ReturnType<typeof setTimeout> | null = null;
/** Survives dismiss/re-enable within the app session. */
let detailLevel: OverlayDetailLevel = DEFAULT_OVERLAY_DETAIL_LEVEL;

export type OverlayLifecycleHooks = {
  onCreated?: (win: BrowserWindowType) => void;
  onDestroyed?: () => void;
  /**
   * Crash recovery ended without a recreate (HUD was hidden, or the crash
   * budget is spent) — main resets the session-tracker show latch.
   */
  onCrashLatchReset?: () => void;
};

let lifecycleHooks: OverlayLifecycleHooks = {};

// ---------------------------------------------------------------------------
// Load target — dev server entry vs packaged file
// ---------------------------------------------------------------------------

/**
 * Load the overlay HTML. Mirrors the dev/packaged resolution used by
 * `createWindow()` in main.ts. Both targets are produced by the parallel
 * renderer/build agent (`overlay.html` dev entry, `dist/overlay.html` packaged).
 */
function loadOverlayContent(win: BrowserWindowType): void {
  const isDev = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';

  if (isDev || (!app.isPackaged && !isProd && !isTest)) {
    const devBase = (process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173').replace(/\/$/, '');
    win.loadURL(`${devBase}/overlay.html`).catch((err) => {
      logger.error('[Overlay] Failed to load dev overlay URL:', err);
    });
  } else {
    const overlayPath = app.isPackaged
      ? path.join(app.getAppPath(), 'dist', 'overlay.html')
      : path.join(__dirname, '../../dist/overlay.html');
    win.loadFile(overlayPath).catch((err) => {
      logger.error('[Overlay] Failed to load overlay file:', err);
    });
  }
}

function applyWindowSize(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { width, height } = overlaySizeForLevel(detailLevel);
  try {
    overlayWindow.setSize(width, height);
  } catch (err) {
    logger.warn('[Overlay] Failed to resize overlay:', err);
  }
}

/** Push the current detail level to the overlay renderer (no-op if no HWND). */
function pushDetailLevelToRenderer(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayWindow.webContents.send('overlay:detailLevel', detailLevel);
  } catch (err) {
    logger.warn('[Overlay] Failed to push detail level:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API — configuration / hooks
// ---------------------------------------------------------------------------

/** Store the preload path used when the overlay window is lazily created. */
export function setOverlayPreloadPath(preloadPath: string): void {
  overlayPreloadPath = preloadPath;
}

/** Hooks so session-tracker can track the overlay webContents across create/destroy. */
export function setOverlayLifecycleHooks(hooks: OverlayLifecycleHooks): void {
  lifecycleHooks = hooks ?? {};
}

// ---------------------------------------------------------------------------
// Public API — detail level
// ---------------------------------------------------------------------------

export function getOverlayDetailLevel(): OverlayDetailLevel {
  return detailLevel;
}

export function setOverlayDetailLevel(level: OverlayDetailLevel | string): void {
  const next = coerceOverlayDetailLevel(level);
  if (detailLevel === next) {
    pushDetailLevelToRenderer();
    return;
  }
  detailLevel = next;
  applyWindowSize();
  positionOverlay();
  pushDetailLevelToRenderer();
}

/** Cycle collapsed ↔ compact; resize + notify renderer. */
export function cycleOverlayDetailLevel(): OverlayDetailLevel {
  detailLevel = cycleDetailLevel(detailLevel);
  applyWindowSize();
  positionOverlay();
  pushDetailLevelToRenderer();
  logger.log(`[Overlay] Detail level → ${detailLevel}`);
  return detailLevel;
}

/**
 * False only when a Super+Shift+D (Shift+Win+D) registration was attempted and
 * failed. With the overlay disabled the hotkey is intentionally unregistered,
 * which is not a bind failure (Settings would otherwise warn "already in use").
 */
export function isOverlayCycleHotkeyRegistered(): boolean {
  return !cycleHotkeyBindFailed;
}

// ---------------------------------------------------------------------------
// Public API — window lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the overlay window (idempotent — returns the existing one if alive).
 * Prefer calling via `activateOverlay()`; do not create at app startup.
 */
export function createOverlayWindow(preloadPath?: string): BrowserWindowType {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const resolvedPreload = preloadPath || overlayPreloadPath;
  if (!resolvedPreload) {
    throw new Error('[Overlay] Preload path not set — call setOverlayPreloadPath() first');
  }

  const { width, height } = overlaySizeForLevel(detailLevel);

  overlayWindow = new BrowserWindow({
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    // Do NOT set alwaysOnTop here — elevate only when showing.
    webPreferences: {
      preload: resolvedPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Start throttled; disable only while the HUD is visible.
      backgroundThrottling: true,
    },
  });

  // Click-through WITHOUT forward — `{ forward: true }` hit-tests every mouse
  // move into the overlay process and causes in-game mouse lag.
  overlayWindow.setIgnoreMouseEvents(true);

  loadOverlayContent(overlayWindow);
  positionOverlay();

  // Hydrate the renderer after each load (covers recreate after dismiss).
  overlayWindow.webContents.on('did-finish-load', () => {
    pushDetailLevelToRenderer();
  });

  // Reposition when the monitor layout / DPI / resolution changes — debounced,
  // and only while the HUD is actually visible.
  displayMetricsHandler = () => {
    if (displayMetricsTimer) clearTimeout(displayMetricsTimer);
    displayMetricsTimer = setTimeout(() => {
      displayMetricsTimer = null;
      if (isOverlayVisible()) positionOverlay();
    }, DISPLAY_METRICS_DEBOUNCE_MS);
  };
  screen.on('display-metrics-changed', displayMetricsHandler);

  const win = overlayWindow;
  win.on('closed', () => {
    // A stale window's late 'closed' must not null a newer overlay.
    if (overlayWindow === win) overlayWindow = null;
  });

  // Crash recovery: with renderer-process-limit=1 the HUD can share a process
  // with the main UI, so a main-UI crash leaves this window blank while
  // isOverlayVisible() stays true. Recreate (bounded) instead.
  win.webContents.on('render-process-gone', (_e: unknown, details: { reason?: string } | undefined) => {
    if (details?.reason === 'clean-exit') return;
    logger.warn(`[Overlay] Overlay renderer gone (${details?.reason ?? 'unknown'})`);
    setImmediate(() => {
      if (win !== overlayWindow) return;
      const wasVisible = isOverlayVisible();
      destroyOverlay();
      if (wasVisible && takeCrashRecreateBudget()) {
        try {
          activateOverlay();
          logger.log('[Overlay] Overlay recreated after renderer crash');
          return;
        } catch (err) {
          logger.error('[Overlay] Failed to recreate overlay after crash:', err);
        }
      } else if (wasVisible) {
        logger.warn('[Overlay] Overlay crash budget exhausted — leaving HUD down');
      }
      try {
        lifecycleHooks.onCrashLatchReset?.();
      } catch (err) {
        logger.error('[Overlay] onCrashLatchReset hook failed:', err);
      }
    });
  });

  try {
    lifecycleHooks.onCreated?.(win);
  } catch (err) {
    logger.error('[Overlay] onCreated hook failed:', err);
  }

  logger.log('[Overlay] Overlay window created');
  return win;
}

/** Consume one crash-recreate slot if the rolling budget allows it. */
function takeCrashRecreateBudget(): boolean {
  const now = Date.now();
  crashRecreateTimes = crashRecreateTimes.filter((t) => now - t < OVERLAY_CRASH_WINDOW_MS);
  if (crashRecreateTimes.length >= OVERLAY_CRASH_RECREATE_LIMIT) return false;
  crashRecreateTimes.push(now);
  return true;
}

/**
 * Position the overlay at the top-right of the display currently under the
 * cursor. Uses the display's `workArea` (DIP, DPI-aware) so placement is correct
 * at 100% and 150% scaling and across multi-monitor setups.
 */
export function positionOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width } = display.workArea;
    const [winWidth] = overlayWindow.getSize();
    const targetX = Math.round(x + width - winWidth - OVERLAY_MARGIN);
    const targetY = Math.round(y + OVERLAY_MARGIN);
    overlayWindow.setPosition(targetX, targetY);
  } catch (err) {
    logger.error('[Overlay] Failed to position overlay:', err);
  }
}

/**
 * Lazily create (if needed) and show the overlay WITHOUT stealing focus.
 * Elevates always-on-top only for the visible lifetime of the HWND.
 */
export function activateOverlay(): void {
  const win = createOverlayWindow();
  applyWindowSize();
  positionOverlay();
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch (err) {
    logger.warn('[Overlay] Failed to disable background throttling:', err);
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // showInactive() never activates the window, so the game keeps OS focus.
  win.showInactive();
  pushDetailLevelToRenderer();
}

/** Alias — prefer `activateOverlay` for the lazy create+show path. */
export function showOverlay(): void {
  activateOverlay();
}

/** Thin hide without destroying the HWND. Prefer `deactivateOverlay`. */
export function hideOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.hide();
}

/**
 * Fully destroy the overlay HWND and notify lifecycle hooks so session-tracker
 * clears its webContents ref. This is the path that ends a play session or
 * turns the setting off — hide alone leaves a topmost window around.
 */
export function deactivateOverlay(): void {
  destroyOverlay();
}

export function isOverlayVisible(): boolean {
  return !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
}

export function getOverlayWindow(): BrowserWindowType | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

/**
 * Register the global dismiss/re-enable hotkey. `onToggle` is invoked on each
 * press — the caller (main.ts) gates on `overlayEnabled` and active sessions.
 */
export function registerOverlayHotkey(onToggle: () => void): void {
  if (toggleHotkeyRegistered) return;
  try {
    const ok = globalShortcut.register(OVERLAY_TOGGLE_HOTKEY, onToggle);
    if (ok) {
      toggleHotkeyRegistered = true;
      logger.log(`[Overlay] Registered toggle hotkey ${OVERLAY_TOGGLE_HOTKEY}`);
    } else {
      logger.warn(`[Overlay] Failed to register hotkey ${OVERLAY_TOGGLE_HOTKEY} (already in use?)`);
    }
  } catch (err) {
    logger.error('[Overlay] Error registering hotkey:', err);
  }
}

/**
 * Register the global detail-cycle hotkey. Cycles even when the HWND is down so
 * the next activate opens at the chosen level; when visible, resizes live.
 */
export function registerOverlayCycleHotkey(onCycle?: () => void): void {
  if (cycleHotkeyRegistered) return;
  const handler = onCycle ?? (() => { cycleOverlayDetailLevel(); });
  try {
    const ok = globalShortcut.register(OVERLAY_CYCLE_HOTKEY, handler);
    if (ok) {
      cycleHotkeyRegistered = true;
      cycleHotkeyBindFailed = false;
      logger.log(`[Overlay] Registered cycle hotkey ${OVERLAY_CYCLE_HOTKEY}`);
    } else {
      cycleHotkeyBindFailed = true;
      logger.warn(`[Overlay] Failed to register hotkey ${OVERLAY_CYCLE_HOTKEY} (already in use?)`);
    }
  } catch (err) {
    cycleHotkeyBindFailed = true;
    logger.error('[Overlay] Error registering cycle hotkey:', err);
  }
}

export function unregisterOverlayHotkey(): void {
  if (toggleHotkeyRegistered) {
    try {
      globalShortcut.unregister(OVERLAY_TOGGLE_HOTKEY);
    } catch (err) {
      logger.error('[Overlay] Error unregistering toggle hotkey:', err);
    }
    toggleHotkeyRegistered = false;
  }
  if (cycleHotkeyRegistered) {
    try {
      globalShortcut.unregister(OVERLAY_CYCLE_HOTKEY);
    } catch (err) {
      logger.error('[Overlay] Error unregistering cycle hotkey:', err);
    }
    cycleHotkeyRegistered = false;
  }
}

/** Destroy the overlay window and detach listeners. Call on deactivate / quit. */
export function destroyOverlay(): void {
  if (displayMetricsTimer) {
    clearTimeout(displayMetricsTimer);
    displayMetricsTimer = null;
  }
  if (displayMetricsHandler) {
    try {
      screen.removeListener('display-metrics-changed', displayMetricsHandler);
    } catch {
      // ignore — screen listener may already be gone during shutdown
    }
    displayMetricsHandler = null;
  }

  const hadWindow = !!overlayWindow && !overlayWindow.isDestroyed();
  if (hadWindow && overlayWindow) {
    try {
      // Drop topmost before teardown so we don't leave elevated z-order state.
      overlayWindow.setAlwaysOnTop(false);
    } catch {
      // ignore
    }
    try {
      overlayWindow.destroy();
    } catch (err) {
      logger.error('[Overlay] Error destroying overlay:', err);
    }
  }
  overlayWindow = null;

  if (hadWindow) {
    try {
      lifecycleHooks.onDestroyed?.();
    } catch (err) {
      logger.error('[Overlay] onDestroyed hook failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — enable/disable wiring (main.ts owns the policy; these are seams)
// ---------------------------------------------------------------------------

/**
 * Register the global hotkeys only while the overlay is enabled. The overlay
 * is opt-in, so grabbing Ctrl+Shift+O / Win+Shift+D system-wide with it off
 * would break those shortcuts in every other app while Ark runs.
 */
export function applyOverlayHotkeys(enabled: boolean, onToggle: () => void): void {
  if (enabled) {
    registerOverlayHotkey(onToggle);
    registerOverlayCycleHotkey();
  } else {
    unregisterOverlayHotkey();
  }
}

/** main.ts installs this once; settings:setOverlayEnabled notifies after saving. */
export function setOverlayEnabledChangedHook(hook: ((enabled: boolean) => void) | null): void {
  overlayEnabledChangedHook = hook;
}

export function notifyOverlayEnabledChanged(enabled: boolean): void {
  try {
    overlayEnabledChangedHook?.(enabled);
  } catch (err) {
    logger.error('[Overlay] overlayEnabledChanged hook failed:', err);
  }
}

export type OverlayGateDeps = {
  isEnabled: () => boolean;
  getActiveSessionCount: () => number;
  syncLatch: (shouldShow: boolean) => void;
};

/**
 * Session-tracker visibility callback. Show is edge-triggered upstream; with
 * the overlay disabled a show edge is a no-op so the latch keeps meaning
 * "show edge already handled" for this session.
 */
export function handleOverlayVisibilityChange(shouldShow: boolean, deps: OverlayGateDeps): void {
  if (shouldShow) {
    if (!deps.isEnabled()) return;
    activateOverlay();
    deps.syncLatch(true);
  } else {
    deactivateOverlay();
    deps.syncLatch(false);
  }
}

/**
 * Ctrl+Shift+O handler. Dismiss leaves the latch set so the next poll does not
 * immediately re-show (and rebuild) the HUD; the level-triggered hide when all
 * sessions end resets it, so the next game shows the HUD again.
 */
export function handleOverlayToggleHotkey(deps: OverlayGateDeps): void {
  if (isOverlayVisible()) {
    deactivateOverlay();
  } else if (deps.isEnabled() && deps.getActiveSessionCount() > 0) {
    activateOverlay();
    deps.syncLatch(true);
  }
}

/** Test seam — swap electron deps and reset module state. Omit deps to restore real. */
export function __setOverlayElectronForTests(deps?: Partial<OverlayElectronDeps>): void {
  ({ app, BrowserWindow, screen, globalShortcut } = { ...realElectronDeps, ...(deps ?? {}) });
  if (displayMetricsTimer) clearTimeout(displayMetricsTimer);
  displayMetricsTimer = null;
  displayMetricsHandler = null;
  overlayWindow = null;
  overlayPreloadPath = null;
  toggleHotkeyRegistered = false;
  cycleHotkeyRegistered = false;
  cycleHotkeyBindFailed = false;
  crashRecreateTimes = [];
  detailLevel = DEFAULT_OVERLAY_DETAIL_LEVEL;
  lifecycleHooks = {};
  overlayEnabledChangedHook = null;
}
