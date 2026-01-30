/**
 * Steam Service
 * Handles Steam API interactions and data transformation
 */

import { Game, LibraryGameEntry } from '@/types/game';
import { SteamMostPlayedGame, SteamAppDetails, SteamSearchItem, getSteamCoverUrl } from '@/types/steam';
import { libraryStore } from './library-store';

// Check if running in Electron
function isElectron(): boolean {
  const result = typeof window !== 'undefined' && !!window.steam;
  console.log(`[Steam Service] isElectron check: ${result}, window.steam exists: ${!!window?.steam}`);
  return result;
}

// In-memory cache for game details
const gameDetailsCache = new Map<number, SteamAppDetails>();
const mostPlayedCache: { games: SteamMostPlayedGame[]; timestamp: number } = { games: [], timestamp: 0 };

/**
 * Transform Steam app details to our Game type
 */
export function transformSteamGame(
  details: SteamAppDetails,
  libraryEntry?: LibraryGameEntry,
  rank?: number,
  playerCount?: number
): Game {
  // Extract platforms
  const platforms: string[] = [];
  if (details.platforms?.windows) platforms.push('Windows');
  if (details.platforms?.mac) platforms.push('Mac');
  if (details.platforms?.linux) platforms.push('Linux');

  // Extract genres
  const genres = details.genres?.map(g => g.description) || [];

  // Extract screenshots
  const screenshots = details.screenshots?.map(s => s.path_full) || [];

  // Extract movies/videos
  const videos = details.movies?.map(m => m.mp4?.max || m.webm?.max || '').filter(Boolean) || [];

  // Parse release date
  let releaseDate = '';
  if (details.release_date?.date) {
    // Steam date format is usually "Jan 15, 2025" or similar
    try {
      const parsed = new Date(details.release_date.date);
      if (!isNaN(parsed.getTime())) {
        releaseDate = parsed.toISOString();
      } else {
        releaseDate = details.release_date.date;
      }
    } catch {
      releaseDate = details.release_date.date;
    }
  }

  // Use proper cover URL: prefer library_600x900.jpg (vertical), fallback to header_image
  // The library_600x900.jpg is Steam's vertical cover art used in the Steam library
  const coverUrl = getSteamCoverUrl(details.steam_appid);
  
  // Keep header_image as fallback in screenshots for detail view
  const allScreenshots = details.header_image 
    ? [details.header_image, ...screenshots] 
    : screenshots;

  const game: Game = {
    id: `steam-${details.steam_appid}`,
    steamAppId: details.steam_appid,
    title: details.name,
    developer: details.developers?.[0] || 'Unknown Developer',
    publisher: details.publishers?.[0] || 'Unknown Publisher',
    genre: genres,
    platform: platforms.length > 0 ? platforms : ['PC'],
    metacriticScore: details.metacritic?.score || null,
    releaseDate,
    summary: details.short_description || details.about_the_game || '',
    coverUrl, // Use vertical cover instead of header_image
    screenshots: allScreenshots,
    videos,
    
    // Steam-specific fields
    playerCount,
    rank,
    price: {
      isFree: details.is_free || false,
      finalFormatted: details.price_overview?.final_formatted,
      discountPercent: details.price_overview?.discount_percent,
    },
    achievements: details.achievements?.total,
    recommendations: details.recommendations?.total,
    comingSoon: details.release_date?.coming_soon,
    
    // Library fields
    status: libraryEntry?.status || 'Want to Play',
    priority: libraryEntry?.priority || 'Medium',
    publicReviews: libraryEntry?.publicReviews || '',
    recommendationSource: libraryEntry?.recommendationSource || '',
    
    // Metadata
    createdAt: libraryEntry?.addedAt || new Date(),
    updatedAt: libraryEntry?.updatedAt || new Date(),
    isInLibrary: !!libraryEntry,
  };

  return game;
}

/**
 * Transform search result to partial Game (minimal data for suggestions)
 */
export function transformSearchResult(item: SteamSearchItem): Partial<Game> {
  return {
    id: `steam-${item.id}`,
    steamAppId: item.id,
    title: item.name,
    coverUrl: item.tiny_image,
    metacriticScore: item.metascore ? parseInt(item.metascore, 10) : null,
    platform: ['PC'],
    genre: [],
    developer: '',
    publisher: '',
    releaseDate: '',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Steam Service Class
 */
class SteamService {
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener: () => void) => listener());
  }

  private onGamesLoaded(): void {
    this.notifyListeners();
  }

  /**
   * Get most played games with full details
   */
  async getMostPlayedGames(limit: number = 30): Promise<Game[]> {
    console.log(`[Steam Service] getMostPlayedGames called, limit: ${limit}`);
    
    if (!isElectron()) {
      console.warn('[Steam Service] Not in Electron, returning mock data');
      return this.getMockGames(limit);
    }

    try {
      // Get most played games
      console.log('[Steam Service] Calling window.steam.getMostPlayedGames()...');
      const mostPlayed = await window.steam!.getMostPlayedGames();
      console.log(`[Steam Service] Got ${mostPlayed.length} most played games from Steam Charts`);
      
      if (mostPlayed.length === 0) {
        console.warn('[Steam Service] No games returned from Steam Charts API');
        return [];
      }

      // Take only the requested limit
      const gamesToFetch = mostPlayed.slice(0, limit);
      const appIds = gamesToFetch.map(g => g.appid);
      console.log(`[Steam Service] Fetching details for ${appIds.length} games: [${appIds.slice(0, 5).join(', ')}...]`);

      // Get details for each game
      const detailsArray = await window.steam!.getMultipleAppDetails(appIds);
      console.log(`[Steam Service] Got details for ${detailsArray.length} games`);
      
      // Create a map for quick lookup
      const detailsMap = new Map<number, SteamAppDetails>();
      detailsArray.forEach(({ appId, details }) => {
        if (details) {
          detailsMap.set(appId, details);
          gameDetailsCache.set(appId, details);
        }
      });

      // Transform to Game objects
      const games: Game[] = [];
      for (const mp of gamesToFetch) {
        const details = detailsMap.get(mp.appid);
        if (details) {
          const libraryEntry = libraryStore.getEntry(mp.appid);
          const game = transformSteamGame(details, libraryEntry, mp.rank, mp.peak_in_game);
          games.push(game);
        } else {
          console.warn(`[Steam Service] No details for appId ${mp.appid}`);
        }
      }

      console.log(`[Steam Service] Successfully transformed ${games.length} games`);
      if (games.length > 0) {
        console.log(`[Steam Service] First game: ${games[0].title}, developer: ${games[0].developer}, coverUrl: ${games[0].coverUrl}`);
      }
      
      this.onGamesLoaded();
      return games;
    } catch (error) {
      console.error('[Steam Service] Error getting most played games:', error);
      throw error;
    }
  }

  /**
   * Get new releases
   */
  async getNewReleases(): Promise<Game[]> {
    if (!isElectron()) {
      return this.getMockGames(20);
    }

    try {
      const releases = await window.steam!.getNewReleases();
      const appIds = releases.map(r => r.id);
      
      const detailsArray = await window.steam!.getMultipleAppDetails(appIds);
      
      const games: Game[] = [];
      for (const { appId, details } of detailsArray) {
        if (details) {
          const libraryEntry = libraryStore.getEntry(appId);
          games.push(transformSteamGame(details, libraryEntry));
        }
      }
      
      return games;
    } catch (error) {
      console.error('[Steam Service] Error getting new releases:', error);
      throw error;
    }
  }

  /**
   * Get top sellers
   */
  async getTopSellers(): Promise<Game[]> {
    if (!isElectron()) {
      return this.getMockGames(20);
    }

    try {
      const sellers = await window.steam!.getTopSellers();
      const appIds = sellers.map(s => s.id);
      
      const detailsArray = await window.steam!.getMultipleAppDetails(appIds);
      
      const games: Game[] = [];
      for (const { appId, details } of detailsArray) {
        if (details) {
          const libraryEntry = libraryStore.getEntry(appId);
          games.push(transformSteamGame(details, libraryEntry));
        }
      }
      
      return games;
    } catch (error) {
      console.error('[Steam Service] Error getting top sellers:', error);
      throw error;
    }
  }

  /**
   * Get coming soon games
   */
  async getComingSoon(): Promise<Game[]> {
    if (!isElectron()) {
      return this.getMockGames(20);
    }

    try {
      const comingSoon = await window.steam!.getComingSoon();
      const appIds = comingSoon.map(c => c.id);
      
      const detailsArray = await window.steam!.getMultipleAppDetails(appIds);
      
      const games: Game[] = [];
      for (const { appId, details } of detailsArray) {
        if (details) {
          const libraryEntry = libraryStore.getEntry(appId);
          games.push(transformSteamGame(details, libraryEntry));
        }
      }
      
      return games;
    } catch (error) {
      console.error('[Steam Service] Error getting coming soon games:', error);
      throw error;
    }
  }

  /**
   * Search games
   */
  async searchGames(query: string, limit: number = 20): Promise<Game[]> {
    console.log(`[Steam Service] searchGames called, query: "${query}", limit: ${limit}`);
    
    if (!query.trim()) {
      console.log('[Steam Service] Empty query, returning empty results');
      return [];
    }
    
    if (!isElectron()) {
      console.warn('[Steam Service] Not in Electron, returning filtered mock data');
      return this.getMockGames(limit).filter(g => 
        g.title.toLowerCase().includes(query.toLowerCase())
      );
    }

    try {
      console.log(`[Steam Service] Calling window.steam.searchGames("${query}")...`);
      const results = await window.steam!.searchGames(query, limit);
      console.log(`[Steam Service] Search returned ${results.length} results`);
      
      if (results.length === 0) {
        console.log('[Steam Service] No search results found');
        return [];
      }
      
      // Get full details for search results
      const appIds = results.map(r => r.id);
      console.log(`[Steam Service] Fetching details for search results: [${appIds.slice(0, 5).join(', ')}...]`);
      
      const detailsArray = await window.steam!.getMultipleAppDetails(appIds);
      console.log(`[Steam Service] Got ${detailsArray.length} details for search results`);
      
      const games: Game[] = [];
      for (const { appId, details } of detailsArray) {
        if (details) {
          const libraryEntry = libraryStore.getEntry(appId);
          games.push(transformSteamGame(details, libraryEntry));
        }
      }
      
      console.log(`[Steam Service] Transformed ${games.length} search result games`);
      return games;
    } catch (error) {
      console.error('[Steam Service] Search error:', error);
      throw error;
    }
  }

  /**
   * Get game details by Steam App ID
   */
  async getGameDetails(appId: number): Promise<Game | null> {
    // Check cache first
    if (gameDetailsCache.has(appId)) {
      const cached = gameDetailsCache.get(appId)!;
      const libraryEntry = libraryStore.getEntry(appId);
      return transformSteamGame(cached, libraryEntry);
    }

    if (!isElectron()) {
      return null;
    }

    try {
      const details = await window.steam!.getAppDetails(appId);
      if (!details) return null;
      
      gameDetailsCache.set(appId, details);
      const libraryEntry = libraryStore.getEntry(appId);
      return transformSteamGame(details, libraryEntry);
    } catch (error) {
      console.error(`[Steam Service] Error getting details for ${appId}:`, error);
      return null;
    }
  }

  /**
   * Get genres (extracted from most played games)
   */
  async getGenres(): Promise<string[]> {
    // Steam doesn't have a dedicated genres endpoint
    // We'll return common gaming genres
    return [
      'Action',
      'Adventure',
      'RPG',
      'Strategy',
      'Simulation',
      'Sports',
      'Racing',
      'Puzzle',
      'Indie',
      'Casual',
      'Free to Play',
      'Multiplayer',
      'Singleplayer',
      'Co-op',
      'MMO',
    ];
  }

  /**
   * Get platforms (Steam is PC only)
   */
  async getPlatforms(): Promise<string[]> {
    return ['Windows', 'Mac', 'Linux'];
  }

  /**
   * Clear cache
   */
  async clearCache(): Promise<void> {
    gameDetailsCache.clear();
    mostPlayedCache.games = [];
    mostPlayedCache.timestamp = 0;
    
    if (isElectron()) {
      await window.steam!.clearCache();
    }
    
    console.log('[Steam Service] Cache cleared');
  }

  /**
   * Mock games for browser development
   * Uses real Steam App IDs so images work
   */
  private getMockGames(limit: number): Game[] {
    const mockGamesData = [
      { appId: 730, title: 'Counter-Strike 2', developer: 'Valve', publisher: 'Valve' },
      { appId: 570, title: 'Dota 2', developer: 'Valve', publisher: 'Valve' },
      { appId: 578080, title: 'PUBG: BATTLEGROUNDS', developer: 'KRAFTON, Inc.', publisher: 'KRAFTON, Inc.' },
      { appId: 1172470, title: 'Apex Legends', developer: 'Respawn Entertainment', publisher: 'Electronic Arts' },
      { appId: 271590, title: 'Grand Theft Auto V', developer: 'Rockstar North', publisher: 'Rockstar Games' },
      { appId: 1245620, title: 'Elden Ring', developer: 'FromSoftware Inc.', publisher: 'Bandai Namco Entertainment' },
      { appId: 1086940, title: 'Baldur\'s Gate 3', developer: 'Larian Studios', publisher: 'Larian Studios' },
      { appId: 1091500, title: 'Cyberpunk 2077', developer: 'CD PROJEKT RED', publisher: 'CD PROJEKT RED' },
      { appId: 292030, title: 'The Witcher 3: Wild Hunt', developer: 'CD PROJEKT RED', publisher: 'CD PROJEKT RED' },
      { appId: 1174180, title: 'Red Dead Redemption 2', developer: 'Rockstar Games', publisher: 'Rockstar Games' },
    ];

    const mockGames: Game[] = [];

    for (let i = 0; i < Math.min(limit, mockGamesData.length); i++) {
      const data = mockGamesData[i];
      mockGames.push({
        id: `steam-${data.appId}`,
        steamAppId: data.appId,
        title: data.title,
        developer: data.developer,
        publisher: data.publisher,
        genre: ['Action', 'Adventure'],
        platform: ['Windows'],
        metacriticScore: 85 + Math.floor(Math.random() * 15),
        releaseDate: new Date(2024, Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1).toISOString(),
        summary: `This is a mock game description for ${data.title}.`,
        coverUrl: getSteamCoverUrl(data.appId), // Use real Steam cover URL
        playerCount: Math.floor(Math.random() * 500000),
        rank: i + 1,
        status: 'Want to Play',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return mockGames;
  }
}

// Export singleton
export const steamService = new SteamService();

