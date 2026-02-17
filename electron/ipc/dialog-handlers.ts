/**
 * File Dialog IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain, dialog } = electron;
import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { logger } from '../safe-logger.js';

export function register(getMainWindow: () => BrowserWindowType | null): void {
  /**
   * Show save file dialog and write content to file
   */
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

  ipcMain.handle('dialog:saveFile', async (_event: any, options: { 
    content: string; 
    defaultName?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => {
    try {
      if (typeof options?.content !== 'string' || options.content.length > MAX_FILE_SIZE) {
        return { success: false, error: 'Content too large or invalid (max 50 MB)' };
      }
      const result = await dialog.showSaveDialog(getMainWindow()!, {
        defaultPath: path.basename(options.defaultName || 'export.json'),
        filters: options.filters || [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      
      fs.writeFileSync(result.filePath, options.content, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      logger.error('[Dialog] Error saving file:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Show open file dialog and read content from file
   */
  ipcMain.handle('dialog:openFile', async (_event: any, options?: { 
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow()!, {
        properties: ['openFile'],
        filters: options?.filters || [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      
      const filePath = result.filePaths[0];
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 50 MB)` };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, filePath, content };
    } catch (error) {
      logger.error('[Dialog] Error opening file:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Show open file dialog to select a game executable (returns path only, no content)
   */
  ipcMain.handle('dialog:selectExecutable', async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow()!, {
        title: 'Select Game Executable',
        properties: ['openFile'],
        filters: [
          { name: 'Executables', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      return { success: true, filePath: result.filePaths[0] };
    } catch (error) {
      logger.error('[Dialog] Error selecting executable:', error);
      return { success: false, error: String(error) };
    }
  });
}
