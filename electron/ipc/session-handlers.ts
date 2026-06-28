/**
 * Session Tracker IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import path from 'path';
import { logger } from '../safe-logger.js';
import { setTrackedGames, getActiveSessions, drainRecoveredSessions } from '../session-tracker.js';

export function register(): void {
  /**
   * Receive the list of games to track from the renderer
   */
  ipcMain.handle('session:setTrackedGames', async (_event: any, games: Array<{ gameId: string; executablePath: string }>) => {
    // Security: validate each executable path — must be absolute and end with .exe
    const validated = (Array.isArray(games) ? games : []).filter(g => {
      if (!g || typeof g.executablePath !== 'string' || !g.executablePath) return false;
      const p = g.executablePath;
      const isAbsolute = path.isAbsolute(p);
      const isExe = p.toLowerCase().endsWith('.exe');
      if (!isAbsolute || !isExe) {
        logger.warn(`[Session] Rejected invalid executable path: ${p}`);
        return false;
      }
      return true;
    });
    setTrackedGames(validated);
    return { success: true };
  });

  /**
   * Get currently active sessions
   */
  ipcMain.handle('session:getActive', async () => {
    return getActiveSessions();
  });

  /**
   * Drain sessions recovered from a previous run that crashed before finalizing.
   * The renderer records these so crashed-session playtime is not lost.
   */
  ipcMain.handle('session:getRecovered', async () => {
    return drainRecoveredSessions();
  });
}
