/**
 * Session Tracker IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import path from 'path';
import { logger } from '../safe-logger.js';
import { setTrackedGames, getActiveSessions, getUnackedSessions, ackSessions } from '../session-tracker.js';

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
   * Every completed session not yet acknowledged by the renderer: sessions
   * recovered from a crashed run plus live-ended sessions the renderer may
   * have missed (crash/reload, hidden auto-launch). Non-destructive — the
   * renderer records them (idempotent by id) and then calls `session:ack`.
   */
  ipcMain.handle('session:getRecovered', async () => {
    return getUnackedSessions();
  });

  /**
   * Renderer confirms these session ids are persisted in its session store;
   * main drops them from the pending queue (and pending-sessions.json).
   */
  ipcMain.handle('session:ack', async (_event: any, ids: unknown) => {
    const removed = ackSessions(Array.isArray(ids) ? ids.slice(0, 5000) : []);
    return { success: true, removed };
  });
}
