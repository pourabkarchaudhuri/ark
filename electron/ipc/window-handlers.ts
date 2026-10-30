/**
 * Window Controls IPC Handlers
 * Manages minimize, maximize, close, and shell:openExternal
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, shell } = electron;
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { logger } from '../safe-logger.js';

export function register(getMainWindow: () => BrowserWindowType | null): void {
  ipcMain.handle('window-minimize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  ipcMain.handle('window-maximize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window-close', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.close();
    }
  });

  ipcMain.handle('window-is-maximized', () => {
    const mainWindow = getMainWindow();
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  // Push maximize/unmaximize state changes to renderer (replaces 500ms polling).
  // Track which window has listeners so we re-attach after window recreation.
  let attachedWindow: BrowserWindowType | null = null;
  ipcMain.handle('window-subscribe-maximize', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow === attachedWindow) return;
    attachedWindow = mainWindow;
    const send = (maximized: boolean) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-maximized-changed', maximized);
      }
    };
    mainWindow.on('maximize', () => send(true));
    mainWindow.on('unmaximize', () => send(false));
  });

  // Open external URL in default browser
  ipcMain.handle('shell:openExternal', async (_event: any, url: string) => {
    try {
      // Validate URL to prevent security issues
      const parsedUrl = new URL(url);
      const allowedProtocols = ['http:', 'https:', 'mailto:', 'magnet:'];
      if (!allowedProtocols.includes(parsedUrl.protocol)) {
        logger.warn(`[Shell] Blocked attempt to open URL with disallowed protocol: ${parsedUrl.protocol}`);
        return { success: false, error: 'Protocol not allowed' };
      }
      
      await shell.openExternal(url);
      logger.log(`[Shell] Opened external URL: ${url}`);
      return { success: true };
    } catch (error) {
      logger.error('[Shell] Error opening external URL:', error);
      return { success: false, error: String(error) };
    }
  });

  // Launch a Steam game by appId. A narrow channel instead of adding steam:
  // to the openExternal allowlist — steam:// URLs can do far more than run a game.
  ipcMain.handle('steam:launchGame', async (_event: any, appId: unknown) => launchSteamGame(appId));
}

// Test-only injectable seam (see launch-handlers.ts for why vi.mock('electron')
// can't reach createRequire'd modules).
let _openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url);

export function __setWindowDepsForTests(deps?: { openExternal?: (url: string) => Promise<void> }): void {
  _openExternal = deps?.openExternal ?? ((url) => shell.openExternal(url));
}

/** Open `steam://rungameid/<appId>` for a strictly validated numeric appId. */
export async function launchSteamGame(appId: unknown): Promise<{ success: boolean; error?: string }> {
  if (typeof appId !== 'number' || !Number.isInteger(appId) || appId <= 0 || appId >= 2 ** 32) {
    return { success: false, error: 'Invalid Steam app id' };
  }
  try {
    await _openExternal(`steam://rungameid/${appId}`);
    logger.log(`[Shell] Launched Steam app ${appId}`);
    return { success: true };
  } catch (error) {
    logger.warn('[Shell] Could not launch Steam app:', error);
    return { success: false, error: String(error) };
  }
}
