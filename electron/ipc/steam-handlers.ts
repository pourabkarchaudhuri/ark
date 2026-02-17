/**
 * Steam API IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { steamAPI, getSteamCoverUrl, getSteamHeaderUrl } from '../steam-api.js';

export function register(): void {
  /**
   * Get cover URL for a Steam game
   */
  ipcMain.handle('steam:getCoverUrl', async (_event: any, appId: number) => {
    if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return null;
    return getSteamCoverUrl(appId);
  });

  /**
   * Get header URL for a Steam game
   */
  ipcMain.handle('steam:getHeaderUrl', async (_event: any, appId: number) => {
    if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return null;
    return getSteamHeaderUrl(appId);
  });

  /**
   * Get most played games from Steam Charts
   * Returns top 100 most played games with player counts
   */
  ipcMain.handle('steam:getMostPlayedGames', async () => {
    try {
      logger.log('[Steam IPC] getMostPlayedGames called');
      const games = await steamAPI.getMostPlayedGames();
      logger.log(`[Steam IPC] getMostPlayedGames returned ${games.length} games`);
      return games;
    } catch (error) {
      logger.error('[Steam IPC] Error fetching most played games:', error);
      return [];
    }
  });

  /**
   * Get app details for a specific game
   */
  ipcMain.handle('steam:getAppDetails', async (_event: any, appId: number) => {
    try {
      if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return null;
      logger.log(`[Steam IPC] getAppDetails for appId: ${appId}`);
      const details = await steamAPI.getAppDetails(appId);
      if (details) {
        logger.log(`[Steam IPC] getAppDetails success: ${details.name}`);
      } else {
        logger.log(`[Steam IPC] getAppDetails returned null for ${appId}`);
      }
      return details;
    } catch (error) {
      logger.error(`[Steam IPC] Error fetching app details for ${appId}:`, error);
      return null;
    }
  });

  /**
   * Get app details for multiple games (batched)
   */
  ipcMain.handle('steam:getMultipleAppDetails', async (_event: any, appIds: number[]) => {
    try {
      // Security: cap batch size to prevent DoS via oversized arrays
      const MAX_BATCH = 200;
      const ids = Array.isArray(appIds) ? appIds.slice(0, MAX_BATCH) : [];
      logger.log(`[Steam IPC] getMultipleAppDetails for ${ids.length} games: [${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}]`);
      const detailsMap = await steamAPI.getMultipleAppDetails(ids);
      
      // Convert Map to array for IPC serialization
      const results: Array<{ appId: number; details: any }> = [];
      detailsMap.forEach((details: any, appId: number) => {
        results.push({ appId, details });
      });
      
      logger.log(`[Steam IPC] getMultipleAppDetails returned ${results.length} results`);
      return results;
    } catch (error) {
      logger.error('[Steam IPC] Error fetching multiple app details:', error);
      return [];
    }
  });

  /**
   * Search games on Steam Store
   */
  ipcMain.handle('steam:searchGames', async (_event: any, query: string, limit: number = 20) => {
    try {
      if (typeof query !== 'string' || query.length > 500) return [];
      if (typeof limit !== 'number' || limit < 0) limit = 20;
      if (limit > 100) limit = 100;
      logger.log(`[Steam IPC] searchGames for "${query}" (limit: ${limit})`);
      const results = await steamAPI.searchGames(query, limit);
      logger.log(`[Steam IPC] searchGames returned ${results.length} results`);
      return results;
    } catch (error) {
      logger.error('[Steam IPC] Error searching games:', error);
      return [];
    }
  });

  /**
   * Get new releases
   */
  ipcMain.handle('steam:getNewReleases', async () => {
    try {
      logger.log('[Steam] Handler: getNewReleases');
      const releases = await steamAPI.getNewReleases();
      return releases;
    } catch (error) {
      logger.error('Error fetching new releases:', error);
      return [];
    }
  });

  /**
   * Get top sellers
   */
  ipcMain.handle('steam:getTopSellers', async () => {
    try {
      logger.log('[Steam] Handler: getTopSellers');
      const sellers = await steamAPI.getTopSellers();
      return sellers;
    } catch (error) {
      logger.error('Error fetching top sellers:', error);
      return [];
    }
  });

  /**
   * Get coming soon games
   */
  ipcMain.handle('steam:getComingSoon', async () => {
    try {
      logger.log('[Steam] Handler: getComingSoon');
      const comingSoon = await steamAPI.getComingSoon();
      return comingSoon;
    } catch (error) {
      logger.error('Error fetching coming soon games:', error);
      return [];
    }
  });

  /**
   * Get featured categories (includes new releases, top sellers, etc.)
   */
  ipcMain.handle('steam:getFeaturedCategories', async () => {
    try {
      logger.log('[Steam] Handler: getFeaturedCategories');
      const categories = await steamAPI.getFeaturedCategories();
      return categories;
    } catch (error) {
      logger.error('Error fetching featured categories:', error);
      return null;
    }
  });

  /**
   * Get game reviews
   */
  ipcMain.handle('steam:getGameReviews', async (_event: any, appId: number, limit: number = 10) => {
    try {
      if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return null;
      if (typeof limit !== 'number' || limit < 0) limit = 10;
      if (limit > 100) limit = 100;
      logger.log(`[Steam] Handler: getGameReviews for appId ${appId}`);
      const reviews = await steamAPI.getGameReviews(appId, limit);
      return reviews;
    } catch (error) {
      logger.error('Error fetching game reviews:', error);
      return null;
    }
  });

  /**
   * Get news for a specific game
   */
  ipcMain.handle('steam:getNewsForApp', async (_event: any, appId: number, count: number = 15) => {
    try {
      if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return [];
      if (typeof count !== 'number' || count < 0) count = 15;
      if (count > 100) count = 100;
      logger.log(`[Steam] Handler: getNewsForApp for appId ${appId}`);
      const news = await steamAPI.getNewsForApp(appId, count);
      return news;
    } catch (error) {
      logger.error(`Error fetching news for appId ${appId}:`, error);
      return [];
    }
  });

  /**
   * Get current player count for a single game
   */
  ipcMain.handle('steam:getPlayerCount', async (_event: any, appId: number) => {
    if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return null;
    return steamAPI.getPlayerCount(appId);
  });

  /**
   * Get current player counts for multiple games (batched)
   */
  ipcMain.handle('steam:getMultiplePlayerCounts', async (_event: any, appIds: number[]) => {
    // Security: cap batch size to prevent DoS via oversized arrays
    const MAX_BATCH = 200;
    const ids = Array.isArray(appIds) ? appIds.slice(0, MAX_BATCH) : [];
    return steamAPI.getMultiplePlayerCounts(ids);
  });

  /**
   * Get queue status for rate limiting feedback
   */
  ipcMain.handle('steam:getQueueStatus', async () => {
    return steamAPI.getQueueStatus();
  });

  /**
   * Clear Steam API cache
   */
  ipcMain.handle('steam:clearCache', async () => {
    steamAPI.clearCache();
    return true;
  });

  /**
   * Prefetch game details in background (for faster navigation)
   */
  ipcMain.handle('steam:prefetchGameDetails', async (_event: any, appIds: number[]) => {
    const MAX_BATCH = 200;
    const ids = Array.isArray(appIds) ? appIds.slice(0, MAX_BATCH) : [];
    logger.log(`[Steam IPC] prefetchGameDetails for ${ids.length} games`);
    steamAPI.prefetchGameDetails(ids);
    return true;
  });

  /**
   * Check if a game's details are cached
   */
  ipcMain.handle('steam:isCached', async (_event: any, appId: number) => {
    if (typeof appId !== 'number' || !Number.isFinite(appId) || appId < 0) return false;
    return steamAPI.isCached(appId);
  });

  /**
   * Get cache statistics
   */
  ipcMain.handle('steam:getCacheStats', async () => {
    return steamAPI.getCacheStats();
  });

  /**
   * Get cached game names for multiple app IDs
   */
  ipcMain.handle('steam:getCachedGameNames', async (_event: any, appIds: number[]) => {
    const MAX_BATCH = 200;
    const ids = Array.isArray(appIds) ? appIds.slice(0, MAX_BATCH) : [];
    return steamAPI.getCachedGameNames(ids);
  });

  /**
   * Get full Steam app list (for Catalog A–Z browsing)
   */
  ipcMain.handle('steam:getAppList', async () => {
    try {
      logger.log('[Steam IPC] getAppList called');
      const apps = await steamAPI.getAppList();
      logger.log(`[Steam IPC] getAppList returned ${apps.length} apps`);
      return apps;
    } catch (error) {
      logger.error('[Steam IPC] Error fetching app list:', error);
      return [];
    }
  });

  /**
   * Get game recommendations based on a game and user's library
   */
  ipcMain.handle('steam:getRecommendations', async (_event: any, currentAppId: number, libraryAppIds: number[], limit: number = 10) => {
    try {
      if (typeof currentAppId !== 'number' || !Number.isFinite(currentAppId) || currentAppId < 0) return [];
      if (!Array.isArray(libraryAppIds)) libraryAppIds = [];
      if (libraryAppIds.length > 500) libraryAppIds = libraryAppIds.slice(0, 500);
      if (typeof limit !== 'number' || limit < 0) limit = 10;
      if (limit > 100) limit = 100;
      logger.log(`[Steam IPC] getRecommendations for appId ${currentAppId} with ${libraryAppIds.length} library games`);
      const recommendations = await steamAPI.getRecommendations(currentAppId, libraryAppIds, limit);
      return recommendations;
    } catch (error) {
      logger.error('Error getting recommendations:', error);
      return [];
    }
  });

  /**
   * Get upcoming releases: combines Coming Soon + New Releases with enriched details.
   * Batch-fetches getAppDetails for each game to get release_date, genres, platforms.
   * Cached for 1 hour to avoid repeated batch fetches.
   */
  let upcomingReleasesCache: { data: any[]; timestamp: number } | null = null;
  const UPCOMING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  ipcMain.handle('steam:getUpcomingReleases', async () => {
    try {
      // Return cached data if still fresh
      if (upcomingReleasesCache && (Date.now() - upcomingReleasesCache.timestamp < UPCOMING_CACHE_TTL)) {
        logger.log('[Steam IPC] getUpcomingReleases returning cached data');
        return upcomingReleasesCache.data;
      }

      logger.log('[Steam IPC] getUpcomingReleases called');

      // Fetch coming soon and new releases in parallel
      const [comingSoon, newReleases] = await Promise.all([
        steamAPI.getComingSoon().catch((err: any) => { logger.warn('[Steam IPC] getUpcomingReleases getComingSoon Non-fatal:', err); return []; }),
        steamAPI.getNewReleases().catch((err: any) => { logger.warn('[Steam IPC] getUpcomingReleases getNewReleases Non-fatal:', err); return []; }),
      ]);

      // Merge and deduplicate by id
      const allGamesMap = new Map<number, { id: number; name: string; image: string }>();
      for (const game of [...comingSoon, ...newReleases]) {
        if (!allGamesMap.has(game.id)) {
          allGamesMap.set(game.id, game);
        }
      }

      const allGames = Array.from(allGamesMap.values());
      logger.log(`[Steam IPC] getUpcomingReleases: ${comingSoon.length} coming soon, ${newReleases.length} new releases, ${allGames.length} unique`);

      // Batch-fetch details (5 at a time to respect rate limits)
      const enriched: Array<{
        id: number;
        name: string;
        image: string;
        releaseDate: string;
        comingSoon: boolean;
        genres: string[];
        platforms: { windows: boolean; mac: boolean; linux: boolean };
      }> = [];

      const batchSize = 5;
      for (let i = 0; i < allGames.length; i += batchSize) {
        const batch = allGames.slice(i, i + batchSize);
        const detailsResults = await Promise.allSettled(
          batch.map(async (game) => {
            try {
              const details = await steamAPI.getAppDetails(game.id);
              return {
                id: game.id,
                name: details?.name || game.name,
                image: details?.header_image || game.image,
                releaseDate: details?.release_date?.date || 'Coming Soon',
                comingSoon: details?.release_date?.coming_soon ?? true,
                genres: details?.genres?.map((g: any) => g.description) || [],
                platforms: details?.platforms || { windows: true, mac: false, linux: false },
              };
            } catch {
              return {
                id: game.id,
                name: game.name,
                image: game.image,
                releaseDate: 'Coming Soon',
                comingSoon: true,
                genres: [] as string[],
                platforms: { windows: true, mac: false, linux: false },
              };
            }
          })
        );

        for (const result of detailsResults) {
          if (result.status === 'fulfilled') {
            enriched.push(result.value);
          }
        }

        // Delay between batches to avoid Steam 429 rate limits
        if (i + batchSize < allGames.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Cache the result for 1 hour
      upcomingReleasesCache = { data: enriched, timestamp: Date.now() };

      logger.log(`[Steam IPC] getUpcomingReleases returning ${enriched.length} enriched games`);
      return enriched;
    } catch (error) {
      logger.error('[Steam IPC] Error fetching upcoming releases:', error);
      return [];
    }
  });
}
