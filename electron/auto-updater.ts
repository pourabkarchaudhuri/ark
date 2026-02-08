import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import type { BrowserWindow as BrowserWindowType } from 'electron';
const { BrowserWindow, ipcMain, Notification, nativeImage, app: electronApp } = electron;
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindowType | null = null;
let isInitialized = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

// Guard flags to prevent duplicate downloads and redundant checks
let isCheckingForUpdate = false;
let isDownloading = false;
let updateAlreadyDownloaded = false;

// Tracks which version we already showed a notification for so we don't
// spam the user every 30 minutes with the same "update available" toast.
let lastNotifiedVersion: string | null = null;

// Cached native image for the notification icon (resolved once on first use)
let notificationIcon: Electron.NativeImage | null = null;

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
    console.log('[AutoUpdater] Notification icon resolved:', found);
  } else {
    console.warn('[AutoUpdater] No icon found for notifications');
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

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
    sendToRenderer('updater:checking');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[AutoUpdater] Update available:', info.version);
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

        const notification = new Notification(notifOptions);

        notification.on('click', () => {
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

        notification.show();
        lastNotifiedVersion = info.version;
        console.log('[AutoUpdater] Native notification shown for update', info.version);
      } catch (err) {
        console.warn('[AutoUpdater] Failed to show native notification:', err);
      }
    }
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[AutoUpdater] No updates available. Current version:', info.version);
    sendToRenderer('updater:update-not-available', {
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
    isDownloading = true;
    sendToRenderer('updater:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
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

        const notification = new Notification(notifOptions);

        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
          // Trigger install
          autoUpdater.quitAndInstall(false, true);
        });

        notification.show();
        console.log('[AutoUpdater] "Update ready" notification shown for', info.version);
      } catch (err) {
        console.warn('[AutoUpdater] Failed to show "update ready" notification:', err);
      }
    }
  });

  autoUpdater.on('error', (error: Error) => {
    console.error('[AutoUpdater] Error:', error.message);
    isDownloading = false;
    sendToRenderer('updater:error', {
      message: error.message,
    });
  });

  // NOTE: No initial checkForUpdates() here — the renderer snackbar
  // performs a manual check on mount via the 'updater:check' IPC handler,
  // so a duplicate call here would cause overlapping checks and double events.

  // Schedule a delayed first poll (2 min) so users who minimise to tray
  // still get an early check, then switch to the regular 30-min interval.
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  setTimeout(() => {
    console.log('[AutoUpdater] Delayed first-poll update check...');
    checkForUpdates();

    // Start periodic polling for updates (every 30 minutes)
    pollingInterval = setInterval(() => {
      console.log('[AutoUpdater] Periodic update check...');
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

/**
 * Check for available updates.
 * Skips the check if a download is already in progress, already completed,
 * or another check is currently running.
 */
async function checkForUpdates() {
  if (isDownloading) {
    console.log('[AutoUpdater] Skipping update check — download already in progress');
    return;
  }
  if (updateAlreadyDownloaded) {
    console.log('[AutoUpdater] Skipping update check — update already downloaded');
    return;
  }
  if (isCheckingForUpdate) {
    console.log('[AutoUpdater] Skipping update check — check already in progress');
    return;
  }
  try {
    isCheckingForUpdate = true;
    console.log('[AutoUpdater] Initiating update check...');
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('[AutoUpdater] Failed to check for updates:', error);
  } finally {
    isCheckingForUpdate = false;
  }
}

/**
 * Returns true only when a is a higher version than b (e.g. 1.0.16 > 1.0.15).
 * Treats x.y.z as semver-like; only "update available" when remote is strictly greater.
 */
function isVersionGreater(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

/**
 * Fetch the latest release tag directly from GitHub.
 * Works regardless of electron-updater state and supports non-sequential versions.
 */
async function fetchLatestGitHubRelease(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch('https://api.github.com/repos/pourabkarchaudhuri/ark/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name: string; html_url: string };
    // tag_name is typically "v1.0.15" — strip the leading "v" if present
    const tag = data.tag_name.replace(/^v/, '');
    return { tag, url: data.html_url };
  } catch (err) {
    console.warn('[AutoUpdater] GitHub release fetch failed:', err);
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
    const { app: electronApp } = electron;
    const currentVersion = isInitialized
      ? (autoUpdater.currentVersion?.version || electronApp.getVersion())
      : electronApp.getVersion();

    // Skip full check if download is already in progress or complete
    if (isDownloading || updateAlreadyDownloaded) {
      console.log('[AutoUpdater] Check skipped (downloading or already downloaded)');
      return { updateAvailable: true, currentVersion, latestVersion: currentVersion };
    }

    // If electron-updater is initialized, use it (handles download flow)
    if (isInitialized) {
      console.log('[AutoUpdater] Manual update check requested');
      try {
        isCheckingForUpdate = true;
        const result = await autoUpdater.checkForUpdates();
        isCheckingForUpdate = false;
        const latestVersion = result?.updateInfo?.version || currentVersion;
        const updateAvailable = isVersionGreater(latestVersion, currentVersion);
        return {
          updateAvailable,
          currentVersion,
          latestVersion,
        };
      } catch (error) {
        isCheckingForUpdate = false;
        console.error('[AutoUpdater] electron-updater check failed, falling back to GitHub API:', error);
      }
    }

    // Fallback / dev mode: query GitHub releases API directly
    console.log('[AutoUpdater] Checking latest GitHub release tag...');
    const release = await fetchLatestGitHubRelease();
    if (release) {
      const updateAvailable = isVersionGreater(release.tag, currentVersion);
      console.log(`[AutoUpdater] GitHub latest: ${release.tag}, current: ${currentVersion}, update: ${updateAvailable}`);
      return { updateAvailable, currentVersion, latestVersion: release.tag };
    }

    return { updateAvailable: false, currentVersion, latestVersion: currentVersion };
  });

  // Download the update (guarded against duplicate calls)
  ipcMain.handle('updater:download', async () => {
    if (!isInitialized) {
      return { success: false };
    }
    if (isDownloading) {
      console.log('[AutoUpdater] Download already in progress, ignoring duplicate request');
      return { success: true };
    }
    if (updateAlreadyDownloaded) {
      console.log('[AutoUpdater] Update already downloaded, skipping re-download');
      return { success: true };
    }
    console.log('[AutoUpdater] Download requested');
    isDownloading = true;
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      isDownloading = false;
      console.error('[AutoUpdater] Download failed:', error);
      throw error;
    }
  });

  // Install the update (quit and install)
  ipcMain.handle('updater:install', () => {
    if (!isInitialized) return;
    console.log('[AutoUpdater] Install requested - quitting and installing...');
    autoUpdater.quitAndInstall(false, true);
  });

  // Get current version
  ipcMain.handle('updater:getVersion', () => {
    if (!isInitialized) {
      // Return version from package.json when updater isn't initialized
      const { app: electronApp } = electron;
      return electronApp?.getVersion?.() || '0.0.0';
    }
    return autoUpdater.currentVersion?.version || '1.0.0';
  });
}
