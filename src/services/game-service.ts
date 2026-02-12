/**
 * Game Service — Unified Facade
 *
 * Combines data from Steam and Epic into a single stream.
 * Handles cross-store deduplication by normalized title matching,
 * parallel fetching, and merging "availableOn" indicators.
 */

import { Game, GameStore } from '@/types/game';
import { steamService } from './steam-service';
import { epicService } from './epic-service';

// Re-export pure dedup functions from the worker-safe module
export { normalizeTitle, deduplicateGames } from './dedup';
// Local import for use within this module
import { deduplicateGames } from './dedup';

// ---------------------------------------------------------------------------
// Unified Game Service
// ---------------------------------------------------------------------------

class GameService {
  /**
   * Search both stores in parallel, deduplicate results.
   */
  async searchGames(query: string, limit: number = 20): Promise<Game[]> {
    const [steamResults, epicResults] = await Promise.allSettled([
      steamService.searchGames(query, limit),
      epicService.searchGames(query, limit),
    ]);

    const allGames: Game[] = [
      ...(steamResults.status === 'fulfilled' ? steamResults.value : []),
      ...(epicResults.status === 'fulfilled' ? epicResults.value : []),
    ];

    return deduplicateGames(allGames);
  }

  /**
   * Get most played games (Steam-only — Epic doesn't expose this).
   */
  async getMostPlayedGames(limit?: number): Promise<Game[]> {
    return steamService.getMostPlayedGames(limit);
  }

  /**
   * Get new releases from both stores, deduplicated.
   */
  async getNewReleases(): Promise<Game[]> {
    const [steamReleases, epicReleases] = await Promise.allSettled([
      steamService.getNewReleases(),
      epicService.getNewReleases(),
    ]);

    const allGames: Game[] = [
      ...(steamReleases.status === 'fulfilled' ? steamReleases.value : []),
      ...(epicReleases.status === 'fulfilled' ? epicReleases.value : []),
    ];

    return deduplicateGames(allGames);
  }

  /**
   * Get top sellers from both stores, deduplicated.
   * Steam: top sellers ranking. Epic: full catalog (sorted by relevance).
   */
  async getTopSellers(): Promise<Game[]> {
    const [steamSellers, epicCatalog, epicFree] = await Promise.allSettled([
      steamService.getTopSellers(),
      epicService.browseCatalog(0),
      epicService.getFreeGames(),
    ]);

    const allGames: Game[] = [
      ...(steamSellers.status === 'fulfilled' ? steamSellers.value : []),
      ...(epicCatalog.status === 'fulfilled' ? epicCatalog.value : []),
      ...(epicFree.status === 'fulfilled' ? epicFree.value : []),
    ];

    return deduplicateGames(allGames);
  }

  /**
   * Get coming soon from both stores, deduplicated.
   */
  async getComingSoon(): Promise<Game[]> {
    const [steamComingSoon, epicComingSoon] = await Promise.allSettled([
      steamService.getComingSoon(),
      epicService.getComingSoon(),
    ]);

    const allGames: Game[] = [
      ...(steamComingSoon.status === 'fulfilled' ? steamComingSoon.value : []),
      ...(epicComingSoon.status === 'fulfilled' ? epicComingSoon.value : []),
    ];

    return deduplicateGames(allGames);
  }

  /**
   * Get game details by universal string ID.
   * Routes to the correct service based on prefix.
   */
  async getGameDetails(gameId: string): Promise<Game | null> {
    if (gameId.startsWith('epic-')) {
      // Parse "epic-namespace:offerId"
      const rest = gameId.slice(5); // remove "epic-"
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return null;
      const namespace = rest.slice(0, colonIdx);
      const offerId = rest.slice(colonIdx + 1);
      return epicService.getGameDetails(namespace, offerId);
    }

    if (gameId.startsWith('steam-')) {
      const appId = parseInt(gameId.slice(6), 10);
      if (isNaN(appId)) return null;
      return steamService.getGameDetails(appId);
    }

    // Custom or unknown — not routable
    return null;
  }

  /**
   * Get free games (Epic-only — Steam doesn't have a dedicated endpoint).
   */
  async getFreeGames(): Promise<Game[]> {
    return epicService.getFreeGames();
  }

  /**
   * Clear caches on both services.
   */
  async clearCache(): Promise<void> {
    await Promise.allSettled([
      steamService.clearCache(),
      epicService.clearCache(),
    ]);
  }

  /**
   * Filter games by store.
   */
  filterByStore(games: Game[], store: 'All' | GameStore): Game[] {
    if (store === 'All') return games;
    return games.filter(g => {
      if (g.store === store) return true;
      // Also include dedup-merged games that are available on the requested store
      return g.availableOn?.includes(store as 'steam' | 'epic');
    });
  }
}

// Export singleton
export const gameService = new GameService();
