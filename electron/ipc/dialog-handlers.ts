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
import { isValidExePath } from './exe-path.js';

/**
 * Files this session saved through the save dialog. "Show file" on the Settings export toast may
 * reveal only these, so the renderer cannot ask Explorer to open an arbitrary path.
 */
export function createSavedFileRegistry(max = 20) {
  const saved: string[] = [];
  return {
    add(filePath: string): void {
      const i = saved.indexOf(filePath);
      if (i >= 0) saved.splice(i, 1);
      saved.push(filePath);
      if (saved.length > max) saved.shift();
    },
    has(filePath: unknown): filePath is string {
      return typeof filePath === 'string' && saved.includes(filePath);
    },
  };
}

export function register(getMainWindow: () => BrowserWindowType | null): void {
  /**
   * Show save file dialog and write content to file
   */
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
  const savedFiles = createSavedFileRegistry();

  /** Reveal a file this session just saved (the Settings export toast's "Show file"). */
  ipcMain.handle('dialog:showFile', (_event: any, filePath: unknown) => {
    if (!savedFiles.has(filePath)) return { success: false, error: 'Only a file saved in this session can be shown.' };
    try {
      electron.shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      logger.error('[Dialog] Error showing file:', error);
      return { success: false, error: 'Could not show the file.' };
    }
  });

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
      savedFiles.add(result.filePath);
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
   * Save a base64-encoded image (from canvas.toDataURL) to disk via native save dialog
   */
  ipcMain.handle('dialog:saveImage', async (_event: any, options: {
    dataUrl: string;
    defaultName?: string;
  }) => {
    try {
      const { app } = electron;
      const downloadsDir = app.getPath('downloads');
      const defaultName = options.defaultName || `ark-screenshot-${Date.now()}.png`;

      const result = await dialog.showSaveDialog(getMainWindow()!, {
        defaultPath: path.join(downloadsDir, defaultName),
        filters: [
          { name: 'PNG Image', extensions: ['png'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const base64 = options.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      fs.writeFileSync(result.filePath, buffer);
      return { success: true, filePath: result.filePath };
    } catch (error) {
      logger.error('[Dialog] Error saving image:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Show open file dialog to select a game executable (returns path only, no content)
   */
  ipcMain.handle('dialog:selectExecutable', async () =>
    selectExecutable((opts) => dialog.showOpenDialog(getMainWindow()!, opts))
  );
}

export const NOT_AN_EXE_ERROR =
  "Pick the game's .exe (shortcuts and .bat/.cmd files cannot be tracked)";

export interface SelectExecutableResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

type ShowOpenDialogFn = (opts: {
  title: string;
  properties: Array<'openFile'>;
  filters: Array<{ name: string; extensions: string[] }>;
}) => Promise<{ canceled: boolean; filePaths: string[] }>;

// Test-only injectable seam (see launch-handlers.ts for why vi.mock('electron')
// can't reach createRequire'd modules).
const realReadShortcutTarget = (p: string): string | null => {
  try {
    return electron.shell.readShortcutLink(p)?.target ?? null;
  } catch {
    return null;
  }
};
let _readShortcutTarget: (p: string) => string | null = realReadShortcutTarget;

export function __setDialogDepsForTests(deps?: {
  readShortcutTarget?: (p: string) => string | null;
}): void {
  _readShortcutTarget = deps?.readShortcutTarget ?? realReadShortcutTarget;
}

/**
 * Pick a game executable. Only .exe paths are returned — session tracking and
 * launch reject anything else, so handing back a .bat/.cmd would store a path
 * that is never tracked. A .lnk is resolved to its target and accepted when
 * that target is an .exe.
 */
export async function selectExecutable(
  showOpenDialog: ShowOpenDialogFn
): Promise<SelectExecutableResult> {
  try {
    const result = await showOpenDialog({
      title: 'Select Game Executable',
      properties: ['openFile'],
      filters: [
        { name: 'Executables', extensions: ['exe'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    let filePath = result.filePaths[0];
    if (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.lnk')) {
      filePath = _readShortcutTarget(filePath) ?? filePath;
    }
    if (!isValidExePath(filePath)) {
      return { success: false, error: NOT_AN_EXE_ERROR };
    }

    return { success: true, filePath };
  } catch (error) {
    logger.error('[Dialog] Error selecting executable:', error);
    return { success: false, error: String(error) };
  }
}
