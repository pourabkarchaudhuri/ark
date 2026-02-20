import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, BrowserWindow, shell, session, Tray, Menu, nativeImage } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import path from 'path';

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

// Handle EPIPE errors globally to prevent crashes when stdout/stderr is closed
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

// Log startup errors to a file when packaged (app doesn't show console)
function logStartupError(err: unknown) {
  const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err);
  try {
    const userData = app?.getPath?.('userData');
    if (userData) fs.writeFileSync(path.join(userData, 'ark-startup-error.log'), msg, 'utf-8');
  } catch {
    // ignore
  }
  logger.error('[Ark] Startup error:', msg);
}

process.on('uncaughtException', (err) => {
  logStartupError(err);
  try {
    if (app.isPackaged) app.quit();
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
import { chatStore } from './ai-chat.js';
import { settingsStore } from './settings-store.js';
import { trackAppLaunch } from './analytics.js';
import { initAutoUpdater, registerUpdaterIpcHandlers } from './auto-updater.js';
import { startSessionTracker, stopSessionTracker } from './session-tracker.js';
import { logger } from './safe-logger.js';
let mainWindow: BrowserWindowType | null = null;

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
if (!gotTheLock) {
  // Another instance already owns the lock — quit immediately.
  // The 'second-instance' event on the first instance will focus its window.
  app.quit();
} else {
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

// Register updater IPC handlers early so the renderer never hits
// "No handler registered" errors — even in dev mode.
registerUpdaterIpcHandlers();

function createWindow() {
  // Resolve paths: when packaged, use app path so loadFile/preload work from installed location
  let preloadPath: string;
  let indexPath: string;
  if (app.isPackaged) {
    const appPath = app.getAppPath();
    indexPath = path.join(appPath, 'dist', 'index.html');
    // Preload is unpacked (asarUnpack) so load from app.asar.unpacked to avoid Windows asar issues
    const resourcesPath = process.resourcesPath;
    preloadPath = path.join(resourcesPath, 'app.asar.unpacked', 'dist-electron', 'electron', 'preload.cjs');
    // Fallback if unpacked path doesn't exist (e.g. older build)
    if (!fs.existsSync(preloadPath)) {
      preloadPath = path.join(appPath, 'dist-electron', 'electron', 'preload.cjs');
    }
  } else {
    preloadPath = path.join(__dirname, 'preload.cjs');
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

  // ---- Renderer crash recovery ----
  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    logger.error('[Ark] Renderer process gone:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit') {
      mainWindow?.webContents.reload();
    }
  });

  mainWindow.once('ready-to-show', () => {
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
}

// ---------------------------------------------------------------------------
// Register all IPC handlers (extracted to electron/ipc/ modules)
// ---------------------------------------------------------------------------
import { registerAllHandlers, webviewHandlers } from './ipc/index.js';
registerAllHandlers(() => mainWindow);

// Access the webview's destroy function for window cleanup
function destroyWebContentsView() {
  (webviewHandlers as any).destroyWebContentsView?.();
}


// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
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
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    logger.warn(`[Security] Denied permission request: ${permission}`);
    callback(false);
  });

  // Show window as early as possible — don't block on ad blocker
  try {
    createWindow();
    trackAppLaunch();
  } catch (err) {
    logStartupError(err);
    app.quit();
  }

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
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details: any, callback: any) => {
        try {
      const { url, resourceType, referrer } = details;
      if (resourceType === 'mainFrame') {
        callback({ cancel: false });
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
  try { steamAPI.flushCache(); } catch (e) { logger.error('[Shutdown] Steam cache flush failed:', e); }
  try { epicAPI.flushCache(); } catch (e) { logger.error('[Shutdown] Epic cache flush failed:', e); }
  try { chatStore.flushSync(); } catch (e) { logger.error('[Shutdown] Chat store flush failed:', e); }
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
