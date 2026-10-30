import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import runtimePkg from 'builder-util-runtime';
const { CancellationToken } = runtimePkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import type { BrowserWindow as BrowserWindowType } from 'electron';
// `let` so __setUpdaterDepsForTests can swap them: require() bypasses vi.mock.
let { ipcMain, Notification, nativeImage, shell, session, app: electronApp } = electron;
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from './safe-logger.js';
import { classifyUpdateError } from './updater-diagnostics.js';
import { cleanupStaleUpdateFiles, resolveInstallerUrl, runFallbackDownload } from './updater-fallback.js';
import { isVersionGreater } from './updater-version.js';

export { isVersionGreater };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindowType | null = null;
let isInitialized = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

// Guard flags to prevent duplicate downloads and redundant checks
let isCheckingForUpdate = false;
let isDownloading = false;
let updateAlreadyDownloaded = false;

// The newest release manifest we saw (installer url / sha512 / size). The alternate downloader
// needs it, and electron-updater does not expose it again after a failed download.
let lastUpdateInfo: UpdateInfo | null = null;
let isFallbackDownloading = false;

// True while the download IPC runs its retry loop. electron-updater emits 'error' for every failed
// attempt; those must neither reset isDownloading (the 30-min poll would slip in between retries)
// nor reach the renderer (only the final outcome is shown).
let downloadLoopActive = false;
// >0 while a check whose errors are reported another way is running (background poll: silent;
// manual check: returned from the IPC call).
let quietErrorDepth = 0;
let lastProgressAt = 0;

// A download that makes no progress for this long is cancelled and retried.
const DOWNLOAD_STALL_MS = 3 * 60 * 1000;
const DOWNLOAD_MAX_ATTEMPTS = 3;

// Tracks which version we already showed a notification for so we don't
// spam the user every 30 minutes with the same "update available" toast.
let lastNotifiedVersion: string | null = null;

// Cached native image for the notification icon (resolved once on first use)
let notificationIcon: Electron.NativeImage | null = null;

// The live toasts. On Windows a garbage-collected Notification stops delivering clicks, so a
// local variable is not enough: clicking the toast minutes later would do nothing.
let availableNotif: Electron.Notification | null = null;
let readyNotif: Electron.Notification | null = null;

// Temp root for the alternate download (tests point it at a scratch folder).
let updateTmpDir: string | undefined;

// Old alternate-download installers are removed this long after start, off the startup path.
const STALE_INSTALLER_CLEANUP_DELAY_MS = 5_000;

/**
 * Test seam: `require('electron')` is invisible to vi.mock, so tests pass fake Electron APIs here.
 */
export function __setUpdaterDepsForTests(deps: {
  ipcMain?: unknown;
  Notification?: unknown;
  nativeImage?: unknown;
  shell?: unknown;
  session?: unknown;
  app?: unknown;
  tmpDir?: string;
}) {
  if (deps.ipcMain) ipcMain = deps.ipcMain;
  if (deps.Notification) Notification = deps.Notification;
  if (deps.nativeImage) nativeImage = deps.nativeImage;
  if (deps.shell) shell = deps.shell;
  if (deps.session) session = deps.session;
  if (deps.app) electronApp = deps.app;
  updateTmpDir = deps.tmpDir;
}

export function __getUpdaterNotificationsForTests() {
  return { available: availableNotif, ready: readyNotif };
}

/**
 * Show a notification and keep a module-level reference to it until it is clicked or closed.
 * A previous toast in the same slot is closed first so only the newest one is live.
 */
function showRetainedNotification(
  slot: 'available' | 'ready',
  options: Electron.NotificationConstructorOptions,
  onClick: () => void,
) {
  const get = () => (slot === 'available' ? availableNotif : readyNotif);
  const set = (n: Electron.Notification | null) => {
    if (slot === 'available') availableNotif = n;
    else readyNotif = n;
  };
  get()?.close();
  const notification: Electron.Notification = new Notification(options);
  // Release only if this is still the live instance (a replaced toast's late 'close' must not
  // drop its successor).
  const release = () => {
    if (get() === notification) set(null);
  };
  notification.on('click', () => {
    release();
    onClick();
  });
  notification.on('close', release);
  set(notification);
  notification.show();
}

// Polling interval: 30 minutes
const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000;

// First poll delay: 2 minutes (gives user time to minimise to tray)
const FIRST_POLL_DELAY_MS = 2 * 60 * 1000;

/**
 * Resolve the app icon path for use in native notifications.
 * Uses the same candidate-list approach as the system tray setup.
 */
function resolveNotificationIcon(): Electron.NativeImage | null {
  if (notificationIcon) return notificationIcon;

  const candidates: string[] = [];
  const projectRoot = path.join(__dirname, '../..');

  if (electronApp.isPackaged) {
    // extraResources copies icons to <resourcesPath>/icons/
    const iconsDir = path.join(process.resourcesPath, 'icons');
    candidates.push(
      path.join(iconsDir, 'icon-256.png'),
      path.join(iconsDir, 'icon-32.png'),
      path.join(iconsDir, 'icon-16.png'),
    );
  } else {
    candidates.push(
      path.join(projectRoot, 'build', 'icon.png'),
      path.join(projectRoot, 'build', 'icon-256.png'),
    );
  }

  const found = candidates.find((p) => fs.existsSync(p));
  if (found) {
    notificationIcon = nativeImage.createFromPath(found);
    logger.log('[AutoUpdater] Notification icon resolved:', found);
  } else {
    logger.warn('[AutoUpdater] No icon found for notifications');
  }

  return notificationIcon;
}

/**
 * Register IPC handlers for the updater.
 * Call this ONCE at app startup (before initAutoUpdater) so the renderer
 * never hits "No handler registered" errors.
 */
export function registerUpdaterIpcHandlers() {
  registerIpcHandlers();
}

/**
 * Initialize the auto-updater with a reference to the main window.
 * Only call this when app.isPackaged — it sets up event forwarding and
 * triggers the first update check.
 */
export function initAutoUpdater(window: BrowserWindowType) {
  mainWindow = window;
  isInitialized = true;

  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't auto-download, let user decide
  autoUpdater.autoInstallOnAppQuit = true;

  // Disable differential (blockmap) downloads and force full-installer downloads.
  // v1.0.41 → v1.0.42 hotfix: users on v1.0.40 reported "Failed to update" during
  // upgrade to v1.0.41. Root cause was almost certainly a blockmap/SHA drift on
  // large releases — differential download compares the previous installer's
  // blocks against the new one, and any per-block hash mismatch aborts the whole
  // download. Full-download is slightly slower but never fails from block drift.
  autoUpdater.disableDifferentialDownload = true;

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    logger.log('[AutoUpdater] Checking for updates...');
    sendToRenderer('updater:checking');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.log('[AutoUpdater] Update available:', info.version);
    lastUpdateInfo = info;
    const updatePayload = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    };
    sendToRenderer('updater:update-available', updatePayload);

    // Show native OS notification — always, unless we already notified for this version.
    // This ensures the user sees the toast even if the window is focused but they
    // tabbed away, and avoids spamming the same toast on every 30-min poll.
    if (Notification.isSupported() && lastNotifiedVersion !== info.version) {
      try {
        const icon = resolveNotificationIcon();
        const notifOptions: Electron.NotificationConstructorOptions = {
          title: 'Ark Update Available',
          body: `Version ${info.version} is ready to download. Click to update.`,
          silent: false,
        };
        if (icon && !icon.isEmpty()) {
          notifOptions.icon = icon;
        }

        showRetainedNotification('available', notifOptions, () => {
          // Show and focus the main window
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
            // Re-fire update-available so the snackbar picks it up
            sendToRenderer('updater:update-available', updatePayload);
            // Auto-trigger the download
            sendToRenderer('updater:auto-download', updatePayload);
          }
        });
        lastNotifiedVersion = info.version;
        logger.log('[AutoUpdater] Native notification shown for update', info.version);
      } catch (err) {
        logger.warn('[AutoUpdater] Failed to show native notification:', err);
      }
    }
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger.log('[AutoUpdater] No updates available. Current version:', info.version);
    sendToRenderer('updater:update-not-available', {
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    logger.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
    isDownloading = true;
    lastProgressAt = Date.now();
    sendToRenderer('updater:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logger.log('[AutoUpdater] Update downloaded:', info.version);
    isDownloading = false;
    updateAlreadyDownloaded = true;
    sendToRenderer('updater:update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });

    // Show a native notification so the user knows the update is ready to install,
    // especially useful when the app is minimised to the system tray.
    if (Notification.isSupported()) {
      try {
        const icon = resolveNotificationIcon();
        const notifOptions: Electron.NotificationConstructorOptions = {
          title: 'Ark Update Ready',
          body: `Version ${info.version} has been downloaded. Click to install and restart.`,
          silent: false,
        };
        if (icon && !icon.isEmpty()) {
          notifOptions.icon = icon;
        }

        showRetainedNotification('ready', notifOptions, () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
          // Trigger install
          autoUpdater.quitAndInstall(false, true);
        });
        logger.log('[AutoUpdater] "Update ready" notification shown for', info.version);
      } catch (err) {
        logger.warn('[AutoUpdater] Failed to show "update ready" notification:', err);
      }
    }
  });

  autoUpdater.on('error', (error: Error) => {
    // Log everything we have — name, message, stack — so we can diagnose
    // from user log dumps without needing to reproduce locally.
    logger.error('[AutoUpdater] Error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    if (downloadLoopActive || quietErrorDepth > 0) return; // reported by the IPC call that is running
    isDownloading = false;
    sendUpdateError(error);
  });

  // Old alternate-download installers (this version or older) are dead weight in %TEMP%.
  setTimeout(() => {
    try {
      const removed = cleanupStaleUpdateFiles({ currentVersion: electronApp.getVersion(), tmpDir: updateTmpDir });
      if (removed.length) logger.log('[AutoUpdater] Removed old update installers:', removed);
    } catch (err) {
      logger.warn('[AutoUpdater] Update folder cleanup failed:', err);
    }
  }, STALE_INSTALLER_CLEANUP_DELAY_MS);

  // NOTE: No initial checkForUpdates() here — the renderer snackbar
  // performs a manual check on mount via the 'updater:check' IPC handler,
  // so a duplicate call here would cause overlapping checks and double events.

  // Schedule a delayed first poll (2 min) so users who minimise to tray
  // still get an early check, then switch to the regular 30-min interval.
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  setTimeout(() => {
    logger.log('[AutoUpdater] Delayed first-poll update check...');
    checkForUpdates();

    // Start periodic polling for updates (every 30 minutes)
    pollingInterval = setInterval(() => {
      logger.log('[AutoUpdater] Periodic update check...');
      checkForUpdates();
    }, UPDATE_POLL_INTERVAL_MS);
  }, FIRST_POLL_DELAY_MS);
}

/**
 * Send a message to the renderer process
 */
function sendToRenderer(channel: string, data?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/** Broadcast an update failure (with its diagnosis) to every renderer listener. */
function sendUpdateError(error: Error | null) {
  const diag = classifyUpdateError(error);
  sendToRenderer('updater:error', {
    message: error?.message || 'Unknown update error',
    name: error?.name,
    kind: diag.kind,
    code: diag.code,
    hint: diag.hint,
    downloadUrl: resolveInstallerUrl(lastUpdateInfo),
  });
}

/**
 * Check for available updates.
 * Skips the check if a download is already in progress, already completed,
 * or another check is currently running.
 */
async function checkForUpdates() {
  if (isDownloading) {
    logger.log('[AutoUpdater] Skipping update check — download already in progress');
    return;
  }
  if (updateAlreadyDownloaded) {
    logger.log('[AutoUpdater] Skipping update check — update already downloaded');
    return;
  }
  if (isCheckingForUpdate) {
    logger.log('[AutoUpdater] Skipping update check — check already in progress');
    return;
  }
  try {
    isCheckingForUpdate = true;
    quietErrorDepth++;
    logger.log('[AutoUpdater] Initiating update check...');
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) lastUpdateInfo = result.updateInfo;
  } catch (error) {
    // Background poll: never interrupt the user; the next manual check reports problems.
    logger.error('[AutoUpdater] Failed to check for updates:', error);
  } finally {
    quietErrorDepth--;
    isCheckingForUpdate = false;
  }
}

/**
 * Fetch the latest release tag directly from GitHub.
 * Works regardless of electron-updater state and supports non-sequential versions.
 */
async function fetchLatestGitHubRelease(): Promise<{ tag: string; url: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://api.github.com/repos/pourabkarchaudhuri/ark/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { tag_name: string; html_url: string };
    // tag_name is typically "v1.0.15" — strip the leading "v" if present
    const tag = data.tag_name.replace(/^v/, '');
    return { tag, url: data.html_url };
  } catch (err) {
    logger.warn('[AutoUpdater] GitHub release fetch failed:', err);
    return null;
  }
}

/**
 * Register IPC handlers for updater commands.
 * Handlers are safe to call even before initAutoUpdater() runs —
 * they return sensible defaults when the updater isn't ready.
 */
function registerIpcHandlers() {
  // Manual update check — always queries the latest GitHub release tag
  ipcMain.handle('updater:check', async () => {
    const currentVersion = isInitialized
      ? (autoUpdater.currentVersion?.version || electronApp.getVersion())
      : electronApp.getVersion();

    // Skip full check if download is already in progress or complete. Report the version being
    // downloaded (not the installed one) and the status, so About can offer Install.
    if (isDownloading || updateAlreadyDownloaded) {
      logger.log('[AutoUpdater] Check skipped (downloading or already downloaded)');
      return {
        updateAvailable: true,
        currentVersion,
        latestVersion: lastUpdateInfo?.version ?? currentVersion,
        status: isDownloading ? 'downloading' : 'downloaded',
      };
    }

    let checkError: unknown = null;

    // If electron-updater is initialized, use it (handles download flow)
    if (isInitialized) {
      logger.log('[AutoUpdater] Manual update check requested');
      try {
        isCheckingForUpdate = true;
        quietErrorDepth++;
        const result = await autoUpdater.checkForUpdates();
        if (result?.updateInfo) lastUpdateInfo = result.updateInfo;
        const latestVersion = result?.updateInfo?.version || currentVersion;
        const updateAvailable = isVersionGreater(latestVersion, currentVersion);
        return {
          updateAvailable,
          currentVersion,
          latestVersion,
        };
      } catch (error) {
        checkError = error;
        logger.error('[AutoUpdater] electron-updater check failed, falling back to GitHub API:', error);
      } finally {
        quietErrorDepth--;
        isCheckingForUpdate = false;
      }
    }

    // Fallback / dev mode: query GitHub releases API directly
    logger.log('[AutoUpdater] Checking latest GitHub release tag...');
    const release = await fetchLatestGitHubRelease();
    if (release) {
      const updateAvailable = isVersionGreater(release.tag, currentVersion);
      logger.log(`[AutoUpdater] GitHub latest: ${release.tag}, current: ${currentVersion}, update: ${updateAvailable}`);
      return { updateAvailable, currentVersion, latestVersion: release.tag };
    }

    // Neither source answered. Say so instead of claiming "you're up to date".
    const diag = classifyUpdateError(checkError ?? new Error('Could not reach GitHub'));
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      error: checkError instanceof Error ? checkError.message : 'Could not reach GitHub',
      kind: diag.kind,
      hint: diag.hint,
    };
  });

  // Download the update (guarded against duplicate calls).
  // Returns { success, error?, errorName? } — errors are structured, not thrown,
  // so the renderer can preserve the electron-updater 'error' event's real
  // message (which fires BEFORE the promise rejects) instead of being clobbered
  // by a generic catch on the renderer side.
  ipcMain.handle('updater:download', async () => {
    if (!isInitialized) {
      return { success: false, error: 'Auto-updater not initialised (dev mode?)' };
    }
    // `status` tells a caller that started its own download (About) whether it may offer Install.
    if (isDownloading) {
      logger.log('[AutoUpdater] Download already in progress, ignoring duplicate request');
      return { success: true, status: 'downloading' };
    }
    if (updateAlreadyDownloaded) {
      logger.log('[AutoUpdater] Update already downloaded, skipping re-download');
      return { success: true, status: 'downloaded' };
    }
    logger.log('[AutoUpdater] Download requested');
    isDownloading = true;
    downloadLoopActive = true;
    let lastError: Error | null = null;
    try {
      for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
        const token = new CancellationToken();
        lastProgressAt = Date.now();
        // Watchdog: a transfer that stalls (no progress events) is cancelled and retried instead of
        // leaving isDownloading stuck true, which would make every later check say "update available".
        const watchdog = setInterval(() => {
          if (Date.now() - lastProgressAt > DOWNLOAD_STALL_MS) {
            logger.warn(`[AutoUpdater] Download stalled for ${DOWNLOAD_STALL_MS / 1000}s — cancelling attempt ${attempt}`);
            token.cancel();
          }
        }, 15_000);
        try {
          await autoUpdater.downloadUpdate(token);
          return { success: true, status: 'downloaded' };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.error(`[AutoUpdater] Download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed:`, {
            name: lastError.name,
            message: lastError.message,
            stack: lastError.stack,
          });
          if (attempt === DOWNLOAD_MAX_ATTEMPTS) break;
          await new Promise(r => setTimeout(r, attempt * 4000));
        } finally {
          clearInterval(watchdog);
        }
      }
    } finally {
      downloadLoopActive = false;
    }
    isDownloading = false;
    // The per-attempt 'error' events were held back; send the final outcome once so every
    // listener sees it (a download started from Settings > About otherwise leaves the snackbar,
    // which only saw progress events, spinning).
    sendUpdateError(lastError);
    const diag = classifyUpdateError(lastError);
    return {
      success: false,
      error: lastError?.message || 'Download failed for unknown reason',
      errorName: lastError?.name,
      kind: diag.kind,
      code: diag.code,
      hint: diag.hint,
      downloadUrl: resolveInstallerUrl(lastUpdateInfo),
    };
  });

  // Alternate download (no arguments: the installer URL comes only from the release manifest).
  // Resumable and sha512-verified; the verified installer is opened and Ark quits so the setup
  // wizard can replace its files.
  ipcMain.handle('updater:fallback-download', async () => {
    if (!lastUpdateInfo) {
      return { success: false, error: 'No update information yet. Check for updates first.' };
    }
    if (isFallbackDownloading) {
      return { success: false, error: 'An alternate download is already running.' };
    }
    isFallbackDownloading = true;
    const info = lastUpdateInfo;
    try {
      // A dedicated session: the app's ad-blocker hooks the default session, and electron-updater
      // uses its own partition too.
      const ses = session.fromPartition('persist:ark-update');
      let lastReport = 0;
      logger.log('[AutoUpdater] Alternate download starting for', info.version);
      const result = await runFallbackDownload(info, {
        fetchImpl: (u, init) => ses.fetch(u, init),
        openPath: (p) => shell.openPath(p),
        tmpDir: updateTmpDir,
        onProgress: ({ transferred, total }) => {
          const now = Date.now();
          if (now - lastReport < 250) return;
          lastReport = now;
          sendToRenderer('updater:download-progress', {
            percent: total ? (transferred / total) * 100 : 0,
            bytesPerSecond: 0,
            transferred,
            total,
          });
        },
      });
      if (!result.launched) {
        logger.warn('[AutoUpdater] Verified installer saved but could not be opened:', result.openError);
        shell.showItemInFolder(result.path);
        return { success: true, launched: false, path: result.path };
      }
      logger.log('[AutoUpdater] Verified installer opened; quitting so it can install');
      setTimeout(() => electronApp.quit(), 2500);
      return { success: true, launched: true, path: result.path };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[AutoUpdater] Alternate download failed:', { name: err.name, message: err.message });
      const diag = classifyUpdateError(err);
      return {
        success: false,
        error: err.message,
        kind: diag.kind,
        code: diag.code,
        hint: diag.hint,
        downloadUrl: resolveInstallerUrl(info),
      };
    } finally {
      isFallbackDownloading = false;
    }
  });

  // Install the update (quit and install)
  ipcMain.handle('updater:install', () => {
    if (!isInitialized) return;
    logger.log('[AutoUpdater] Install requested - quitting and installing...');
    autoUpdater.quitAndInstall(false, true);
  });

  // Get current version
  ipcMain.handle('updater:getVersion', () => {
    if (!isInitialized) {
      // Return version from package.json when updater isn't initialized
      return electronApp?.getVersion?.() || '0.0.0';
    }
    return autoUpdater.currentVersion?.version || '1.0.0';
  });
}
