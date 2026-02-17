/**
 * Epic Games Store IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { epicAPI } from '../epic-api.js';

/** Only allow safe URL path characters in slugs/namespaces/offerIds */
const SAFE_PATH_RE = /^[a-zA-Z0-9_\-]+$/;

export function register(): void {
  /**
   * Search Epic Games Store by keyword
   */
  ipcMain.handle('epic:searchGames', async (_event: any, query: string, limit: number = 20) => {
    try {
      if (typeof query !== 'string' || query.length > 500) return [];
      if (typeof limit !== 'number' || limit < 0) limit = 20;
      if (limit > 100) limit = 100;
      logger.log(`[Epic IPC] searchGames: "${query}" (limit ${limit})`);
      return await epicAPI.searchGames(query, limit);
    } catch (error) {
      logger.error('[Epic IPC] Error searching games:', error);
      return [];
    }
  });

  /**
   * Get details for a single Epic game by namespace + offerId
   */
  ipcMain.handle('epic:getGameDetails', async (_event: any, namespace: string, offerId: string) => {
    try {
      if (typeof namespace !== 'string' || namespace.length > 200 || !SAFE_PATH_RE.test(namespace)) return null;
      if (typeof offerId !== 'string' || offerId.length > 200 || !SAFE_PATH_RE.test(offerId)) return null;
      logger.log(`[Epic IPC] getGameDetails: ${namespace} / ${offerId}`);
      return await epicAPI.getGameDetails(namespace, offerId);
    } catch (error) {
      logger.error('[Epic IPC] Error getting game details:', error);
      return null;
    }
  });

  /**
   * Get new releases from Epic Games Store
   */
  ipcMain.handle('epic:getNewReleases', async () => {
    try {
      logger.log('[Epic IPC] getNewReleases');
      return await epicAPI.getNewReleases();
    } catch (error) {
      logger.error('[Epic IPC] Error fetching new releases:', error);
      return [];
    }
  });

  /**
   * Get coming soon games from Epic Games Store
   */
  ipcMain.handle('epic:getComingSoon', async () => {
    try {
      logger.log('[Epic IPC] getComingSoon');
      return await epicAPI.getComingSoon();
    } catch (error) {
      logger.error('[Epic IPC] Error fetching coming soon:', error);
      return [];
    }
  });

  /**
   * Get current free games on Epic Games Store
   */
  ipcMain.handle('epic:getFreeGames', async () => {
    try {
      logger.log('[Epic IPC] getFreeGames');
      return await epicAPI.getFreeGames();
    } catch (error) {
      logger.error('[Epic IPC] Error fetching free games:', error);
      return [];
    }
  });

  /**
   * Get upcoming releases from Epic (combined new + coming soon, enriched)
   */
  ipcMain.handle('epic:getUpcomingReleases', async () => {
    try {
      logger.log('[Epic IPC] getUpcomingReleases');
      return await epicAPI.getUpcomingReleases();
    } catch (error) {
      logger.error('[Epic IPC] Error fetching upcoming releases:', error);
      return [];
    }
  });

  /**
   * Browse the full Epic catalog (paginated, no date filter — returns 200+ games)
   */
  ipcMain.handle('epic:browseCatalog', async (_event: any, limit: number = 0) => {
    try {
      if (typeof limit !== 'number' || limit < 0) limit = 0;
      if (limit > 1000) limit = 1000;
      logger.log(`[Epic IPC] browseCatalog (limit ${limit || 'ALL'})`);
      return await epicAPI.browseCatalog(limit);
    } catch (error) {
      logger.error('[Epic IPC] Error browsing catalog:', error);
      return [];
    }
  });

  /**
   * Get cover URL for an Epic game (returns cached image URL or null)
   */
  ipcMain.handle('epic:getCoverUrl', async (_event: any, namespace: string, offerId: string) => {
    try {
      if (typeof namespace !== 'string' || namespace.length > 200 || !SAFE_PATH_RE.test(namespace)) return null;
      if (typeof offerId !== 'string' || offerId.length > 200 || !SAFE_PATH_RE.test(offerId)) return null;
      return epicAPI.getCoverUrl(namespace, offerId);
    } catch (error) {
      logger.error('[Epic IPC] getCoverUrl error:', error);
      return null;
    }
  });

  /**
   * Clear Epic API cache
   */
  ipcMain.handle('epic:clearCache', async () => {
    try {
      epicAPI.clearCache();
      return true;
    } catch (error) {
      logger.error('[Epic IPC] clearCache error:', error);
      return false;
    }
  });

  /**
   * Get Epic cache statistics
   */
  ipcMain.handle('epic:getCacheStats', async () => {
    try {
      return epicAPI.getCacheStats();
    } catch (error) {
      logger.error('[Epic IPC] getCacheStats error:', error);
      return null;
    }
  });

  /**
   * Get rich product page content (full About description + system requirements)
   * from the Epic CMS REST endpoint.
   */
  ipcMain.handle('epic:getProductContent', async (_event: any, slug: string) => {
    try {
      if (typeof slug !== 'string' || slug.length > 300 || !SAFE_PATH_RE.test(slug)) return null;
      return await epicAPI.getProductContent(slug);
    } catch (error) {
      logger.error('[Epic IPC] getProductContent error:', error);
      return null;
    }
  });

  /**
   * Get news/blog articles related to an Epic game.
   */
  ipcMain.handle('epic:getNewsFeed', async (_event: any, keyword: string, limit: number = 15) => {
    try {
      if (typeof keyword !== 'string' || keyword.length > 500) return [];
      if (typeof limit !== 'number' || limit < 0) limit = 15;
      if (limit > 100) limit = 100;
      return await epicAPI.getNewsFeed(keyword, limit);
    } catch (error) {
      logger.error('[Epic IPC] getNewsFeed error:', error);
      return [];
    }
  });

  /**
   * Get product reviews for an Epic game.
   */
  ipcMain.handle('epic:getProductReviews', async (_event: any, slug: string) => {
    try {
      if (typeof slug !== 'string' || slug.length > 300 || !SAFE_PATH_RE.test(slug)) return null;
      return await epicAPI.getProductReviews(slug);
    } catch (error) {
      logger.error('[Epic IPC] getProductReviews error:', error);
      return null;
    }
  });

  /**
   * Get DLC/add-ons for an Epic game by namespace.
   */
  ipcMain.handle('epic:getAddons', async (_event: any, namespace: string, limit: number = 50) => {
    try {
      if (typeof namespace !== 'string' || namespace.length > 200 || !SAFE_PATH_RE.test(namespace)) return [];
      if (typeof limit !== 'number' || limit < 0) limit = 50;
      if (limit > 200) limit = 200;
      return await epicAPI.getAddons(namespace, limit);
    } catch (error) {
      logger.error('[Epic IPC] getAddons error:', error);
      return [];
    }
  });
}
