import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import type { BrowserWindow as BrowserWindowType } from 'electron';
const { BrowserWindow, ipcMain } = electron;

let mainWindow: BrowserWindowType | null = null;
let isInitialized = false;

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
    sendToRenderer('updater:update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[AutoUpdater] No updates available. Current version:', info.version);
    sendToRenderer('updater:update-not-available', {
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
    sendToRenderer('updater:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    sendToRenderer('updater:update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('error', (error: Error) => {
    console.error('[AutoUpdater] Error:', error.message);
    sendToRenderer('updater:error', {
      message: error.message,
    });
  });

  // Check for updates after a short delay (let app fully load first)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
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
 * Check for available updates
 */
async function checkForUpdates() {
  try {
    console.log('[AutoUpdater] Initiating update check...');
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('[AutoUpdater] Failed to check for updates:', error);
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

    // If electron-updater is initialized, use it (handles download flow)
    if (isInitialized) {
      console.log('[AutoUpdater] Manual update check requested');
      try {
        const result = await autoUpdater.checkForUpdates();
        const latestVersion = result?.updateInfo?.version || currentVersion;
        const updateAvailable = isVersionGreater(latestVersion, currentVersion);
        return {
          updateAvailable,
          currentVersion,
          latestVersion,
        };
      } catch (error) {
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

  // Download the update
  ipcMain.handle('updater:download', async () => {
    if (!isInitialized) {
      return { success: false };
    }
    console.log('[AutoUpdater] Download requested');
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
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
