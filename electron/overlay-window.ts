/**
 * Overlay Window — a lightweight, transparent, click-through, always-on-top HUD
 * that renders a small corner badge (game name + live session timer) while a
 * tracked game is running.
 *
 * Design constraints (see the "Ark in-game overlay HUD" plan):
 *  - Non-injecting: this is a plain topmost Electron window, NOT a DirectX/Present
 *    hook, so it carries the same trust class as Discord/OBS overlays (zero
 *    anti-cheat risk).
 *  - `backgroundThrottling: false` is mandatory. The overlay never holds OS focus
 *    (the game does), and Electron otherwise throttles an unfocused window's
 *    timers/rAF down to ~1fps, which would freeze the HUD clock and fades.
 *  - Click-through + focusable:false so the game receives every click under the
 *    HUD and the overlay never steals focus.
 *
 * The overlay reuses the EXISTING preload (`preload.cjs`) — the `sessionTracker`
 * bridge exposed there is all the HUD renderer needs. `session-tracker.ts`
 * forwards the same `session:*` payloads to this window's webContents.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { logger } from './safe-logger.js';
import type { BrowserWindow as BrowserWindowType } from 'electron';

const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, screen, globalShortcut } = electron;

// ESM has no __dirname; required for loadFile/preload paths when run as a module.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** HUD card size (DIP). The renderer draws inside these bounds. */
const OVERLAY_WIDTH = 260;
const OVERLAY_HEIGHT = 84;
/** Margin (DIP) from the top-right corner of the active display's work area. */
const OVERLAY_MARGIN = 24;
/** Global toggle hotkey. */
const OVERLAY_HOTKEY = 'Control+Shift+O';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let overlayWindow: BrowserWindowType | null = null;
let hotkeyRegistered = false;
/** Kept so we can detach the screen listener on destroy (avoids leaks). */
let displayMetricsHandler: (() => void) | null = null;

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the overlay window (idempotent — returns the existing one if alive).
 * Pass the SAME `preloadPath` that main.ts resolves for the main window so the
 * `sessionTracker` bridge is available to the HUD renderer.
 */
export function createOverlayWindow(preloadPath: string): BrowserWindowType {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Mandatory: keep the HUD clock/fades running while the game is foreground.
      backgroundThrottling: false,
    },
  });

  // Never intercept clicks — forward mouse events to whatever is underneath.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Sit above fullscreen games / screensavers.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Stay visible across virtual desktops and while a game is fullscreen.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadOverlayContent(overlayWindow);
  positionOverlay();

  // Reposition when the monitor layout / DPI / resolution changes.
  displayMetricsHandler = () => positionOverlay();
  screen.on('display-metrics-changed', displayMetricsHandler);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  logger.log('[Overlay] Overlay window created');
  return overlayWindow;
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

/** Show the overlay WITHOUT stealing focus from the foreground game. */
export function showOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  positionOverlay();
  // showInactive() never activates the window, so the game keeps OS focus.
  overlayWindow.showInactive();
  // Re-assert topmost after showing (some drivers drop it on show).
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

export function hideOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.hide();
}

export function isOverlayVisible(): boolean {
  return !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
}

export function getOverlayWindow(): BrowserWindowType | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

/**
 * Register the global toggle hotkey. `onToggle` is invoked on each press — the
 * caller (main.ts) decides the actual show/hide behaviour so it can gate on the
 * `overlayEnabled` setting.
 */
export function registerOverlayHotkey(onToggle: () => void): void {
  if (hotkeyRegistered) return;
  try {
    const ok = globalShortcut.register(OVERLAY_HOTKEY, onToggle);
    if (ok) {
      hotkeyRegistered = true;
      logger.log(`[Overlay] Registered toggle hotkey ${OVERLAY_HOTKEY}`);
    } else {
      logger.warn(`[Overlay] Failed to register hotkey ${OVERLAY_HOTKEY} (already in use?)`);
    }
  } catch (err) {
    logger.error('[Overlay] Error registering hotkey:', err);
  }
}

export function unregisterOverlayHotkey(): void {
  if (!hotkeyRegistered) return;
  try {
    globalShortcut.unregister(OVERLAY_HOTKEY);
  } catch (err) {
    logger.error('[Overlay] Error unregistering hotkey:', err);
  }
  hotkeyRegistered = false;
}

/** Destroy the overlay window and detach listeners. Call on app quit. */
export function destroyOverlay(): void {
  if (displayMetricsHandler) {
    try {
      screen.removeListener('display-metrics-changed', displayMetricsHandler);
    } catch {
      // ignore — screen listener may already be gone during shutdown
    }
    displayMetricsHandler = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.destroy();
    } catch (err) {
      logger.error('[Overlay] Error destroying overlay:', err);
    }
  }
  overlayWindow = null;
}
