/**
 * Metacritic API IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { fetchMetacriticReviews, clearMetacriticCache } from '../metacritic-api.js';

export function register(): void {
  /**
   * Get game reviews from Metacritic
   */
  ipcMain.handle('metacritic:getGameReviews', async (_event: any, gameName: string) => {
    try {
      if (typeof gameName !== 'string' || gameName.length > 500) return null;
      logger.log(`[Metacritic] Handler: getGameReviews for "${gameName}"`);
      const reviews = await fetchMetacriticReviews(gameName);
      return reviews;
    } catch (error) {
      logger.error('Error fetching Metacritic reviews:', error);
      return null;
    }
  });

  /**
   * Clear Metacritic cache
   */
  ipcMain.handle('metacritic:clearCache', async () => {
    clearMetacriticCache();
    return true;
  });
}
