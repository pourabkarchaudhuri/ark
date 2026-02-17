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
}
