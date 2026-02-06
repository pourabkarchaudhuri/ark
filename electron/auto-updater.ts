import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import type { BrowserWindow as BrowserWindowType } from 'electron';
const { BrowserWindow, ipcMain } = electron;

let mainWindow: BrowserWindowType | null = null;

/**
 * Initialize the auto-updater with a reference to the main window
 */
export function initAutoUpdater(window: BrowserWindowType) {
  mainWindow = window;

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

  // Register IPC handlers
  registerIpcHandlers();

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
 * Register IPC handlers for updater commands
 */
function registerIpcHandlers() {
  // Manual update check
  ipcMain.handle('updater:check', async () => {
    console.log('[AutoUpdater] Manual update check requested');
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        updateAvailable: result?.updateInfo?.version !== autoUpdater.currentVersion?.version,
        currentVersion: autoUpdater.currentVersion?.version,
        latestVersion: result?.updateInfo?.version,
      };
    } catch (error) {
      console.error('[AutoUpdater] Check failed:', error);
      throw error;
    }
  });

  // Download the update
  ipcMain.handle('updater:download', async () => {
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
    console.log('[AutoUpdater] Install requested - quitting and installing...');
    autoUpdater.quitAndInstall(false, true);
  });

  // Get current version
  ipcMain.handle('updater:getVersion', () => {
    return autoUpdater.currentVersion?.version || '1.0.0';
  });
}
