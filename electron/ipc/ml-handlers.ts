/**
 * ML Model IPC Handlers
 *
 * Exposes the Kaggle-trained recommendation model to the renderer process.
 * The ONNX runtime runs exclusively in the main process (native addon).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import {
  loadModel,
  scoreGames,
  buildUserProfile,
  getGameRecRates,
  getStatus,
  isLoaded,
  type UserProfile,
} from '../ml-model.js';

export function register(): void {
  ipcMain.handle('ml:load', async () => {
    try {
      return await loadModel();
    } catch (err) {
      logger.error('[ML IPC] load error:', err);
      return false;
    }
  });

  ipcMain.handle('ml:status', async () => {
    try {
      return getStatus();
    } catch (err) {
      logger.error('[ML IPC] status error:', err);
      return { loaded: false, modelCount: 0, gameProfileCount: 0, tagCount: 0 };
    }
  });

  ipcMain.handle(
    'ml:scoreGames',
    async (
      _event: any,
      userProfile: UserProfile,
      gameIds: string[],
    ) => {
      try {
        if (!userProfile || !Array.isArray(gameIds)) return [];
        if (!isLoaded()) {
          const ok = await loadModel();
          if (!ok) return gameIds.map((id: string) => ({ gameId: id, score: 0.5 }));
        }
        return await scoreGames(userProfile, gameIds);
      } catch (err) {
        logger.error('[ML IPC] scoreGames error:', err);
        return (Array.isArray(gameIds) ? gameIds : []).map((id: string) => ({ gameId: id, score: 0.5 }));
      }
    },
  );

  ipcMain.handle(
    'ml:buildUserProfile',
    async (
      _event: any,
      games: Array<{ gameId: string; hoursPlayed: number; rating: number; status: string }>,
    ) => {
      try {
        if (!Array.isArray(games)) return null;
        if (!isLoaded()) {
          const ok = await loadModel();
          if (!ok) return null;
        }
        return buildUserProfile(games);
      } catch (err) {
        logger.error('[ML IPC] buildUserProfile error:', err);
        return null;
      }
    },
  );

  ipcMain.handle(
    'ml:getGameRecRates',
    async (_event: any, gameIds: string[]) => {
      try {
        if (!Array.isArray(gameIds)) return {};
        if (!isLoaded()) {
          const ok = await loadModel();
          if (!ok) return {};
        }
        return getGameRecRates(gameIds);
      } catch (err) {
        logger.error('[ML IPC] getGameRecRates error:', err);
        return {};
      }
    },
  );
}
