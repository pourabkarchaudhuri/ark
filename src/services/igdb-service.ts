import { Game, LibraryGameEntry, GameCategory } from '@/types/game';
import {
  IGDBGame,
  IGDBGenre,
  IGDBPlatform,
  QueueStatus,
  IGDBGameCategory,
  getIGDBImageUrl,
  getIGDBDeveloper,
  getIGDBPublisher,
  formatIGDBDate,
  getPlatformFamily,
} from '@/types/igdb';
import { cacheStore } from './cache-store';

// In-memory cache for genres and platforms (also stored in IndexedDB)
let genresCache: IGDBGenre[] | null = null;
let platformsCache: IGDBPlatform[] | null = null;

// Rate limit warning callback type
type RateLimitWarningCallback = (queueSize: number) => void;

// Check if running in Electron
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.igdb;
}

// Transform IGDB game to our Game type
export function transformIGDBGame(
  igdbGame: IGDBGame,
  libraryEntry?: LibraryGameEntry
): Game {
  const platforms = igdbGame.platforms || [];
  const uniquePlatformFamilies = new Set<string>();
  
  platforms.forEach(p => {
    const family = getPlatformFamily(p);
    if (family !== 'other') {
      uniquePlatformFamilies.add(family);
    }
  });

  // Transform websites
  const websites = igdbGame.websites?.map(w => ({
    url: w.url,
    category: w.category,
  }));

  // Transform videos (YouTube IDs)
  const videos = igdbGame.videos?.map(v => v.video_id);

  // Transform similar games
  const similarGames = igdbGame.similar_games?.map(sg => ({
    id: sg.id,
    name: sg.name,
    coverUrl: sg.cover?.image_id ? getIGDBImageUrl(sg.cover.image_id, 'cover_small') : undefined,
  }));

  const game: Game = {
    id: `igdb-${igdbGame.id}`,
    igdbId: igdbGame.id,
    title: igdbGame.name,
    developer: getIGDBDeveloper(igdbGame.involved_companies),
    publisher: getIGDBPublisher(igdbGame.involved_companies),
    genre: igdbGame.genres?.map(g => g.name) || [],
    platform: Array.from(uniquePlatformFamilies),
    // Use aggregated_rating (critic scores) or fall back to total_rating (combined user+critic)
    metacriticScore: igdbGame.aggregated_rating 
      ? Math.round(igdbGame.aggregated_rating) 
      : igdbGame.total_rating 
        ? Math.round(igdbGame.total_rating)
        : null,
    releaseDate: formatIGDBDate(igdbGame.first_release_date),
    summary: igdbGame.summary,
    storyline: igdbGame.storyline,
    coverUrl: getIGDBImageUrl(igdbGame.cover?.image_id, 'cover_big'),
    screenshots: igdbGame.screenshots?.map(s => 
      getIGDBImageUrl(s.image_id, 'screenshot_big')
    ),
    videos,
    websites,
    similarGames,
    
    // User library fields - use defaults or library entry
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

// IGDB Service class
class IGDBService {
  private listeners: Set<() => void> = new Set();
  private rateLimitListeners: Set<RateLimitWarningCallback> = new Set();
  private popularGamesCache: IGDBGame[] = [];
  private searchCache: Map<string, IGDBGame[]> = new Map();
  private gameCache: Map<number, IGDBGame> = new Map();
  private rateLimitListenerInitialized = false;

  constructor() {
    // Set up rate limit warning listener when running in Electron
    this.initRateLimitListener();
  }

  private initRateLimitListener() {
    if (this.rateLimitListenerInitialized) return;
    
    if (typeof window !== 'undefined' && window.igdb?.onRateLimitWarning) {
      window.igdb.onRateLimitWarning((queueSize: number) => {
        this.notifyRateLimitListeners(queueSize);
      });
      this.rateLimitListenerInitialized = true;
    } else {
      // Retry after a short delay (window.igdb might not be available immediately)
      setTimeout(() => this.initRateLimitListener(), 1000);
    }
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Subscribe to rate limit warnings
  subscribeToRateLimitWarnings(callback: RateLimitWarningCallback): () => void {
    this.rateLimitListeners.add(callback);
    return () => this.rateLimitListeners.delete(callback);
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener());
  }

  private notifyRateLimitListeners(queueSize: number) {
    this.rateLimitListeners.forEach(callback => callback(queueSize));
  }

  // Get current queue status
  async getQueueStatus(): Promise<QueueStatus | null> {
    if (!isElectron() || !window.igdb?.getQueueStatus) {
      return null;
    }
    
    try {
      return await window.igdb.getQueueStatus();
    } catch (error) {
      console.error('Failed to get queue status:', error);
      return null;
    }
  }

  // Clear in-memory caches (useful for testing or refresh)
  clearCache() {
    this.popularGamesCache = [];
    this.searchCache.clear();
    this.gameCache.clear();
    genresCache = null;
    platformsCache = null;
  }

  // Clear all caches including IndexedDB (full reset)
  async clearAllCaches(): Promise<void> {
    console.log('Clearing all caches (in-memory + IndexedDB)...');
    
    // Clear in-memory caches
    this.clearCache();
    
    // Clear IndexedDB cache
    try {
      await cacheStore.clearAll();
      console.log('All caches cleared successfully');
    } catch (error) {
      console.error('Failed to clear IndexedDB cache:', error);
    }
  }

  // Fetch popular games (optionally filtered by year)
  async getPopularGames(limit: number = 30, offset: number = 0, year?: number): Promise<IGDBGame[]> {
    // Check if we're offline
    if (!navigator.onLine) {
      console.log('Offline - returning cached games');
      return this.getCachedGames(limit, offset);
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return this.getMockGames(limit, offset);
    }

    try {
      const games = await window.igdb!.getPopularGames(limit, offset, year);
      
      // Cache individual games (in-memory and IndexedDB)
      games.forEach(game => {
        this.gameCache.set(game.id, game);
      });
      
      // Store in IndexedDB for offline access
      cacheStore.cacheGames(games).catch(err => 
        console.error('Failed to cache games to IndexedDB:', err)
      );
      
      // Update popular games cache
      if (offset === 0) {
        this.popularGamesCache = games;
      } else {
        this.popularGamesCache = [...this.popularGamesCache, ...games];
      }
      
      this.notifyListeners();
      return games;
    } catch (error) {
      console.error('Failed to fetch popular games:', error);
      // Try to return cached data on error
      const cachedGames = await this.getCachedGames(limit, offset);
      if (cachedGames.length > 0) {
        console.log('Returning cached games due to API error');
        return cachedGames;
      }
      throw error;
    }
  }

  // Get cached games for offline mode
  private async getCachedGames(limit: number, offset: number): Promise<IGDBGame[]> {
    try {
      const allCached = await cacheStore.getAllCachedGames();
      return allCached.slice(offset, offset + limit);
    } catch (error) {
      console.error('Failed to get cached games:', error);
      return [];
    }
  }

  // Fetch games by category
  async getGamesByCategory(category: GameCategory, limit: number = 30, offset: number = 0, year?: number): Promise<IGDBGame[]> {
    // Check if we're offline
    if (!navigator.onLine) {
      console.log('Offline - returning cached games for category');
      return this.getCachedGames(limit, offset);
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return this.getMockGames(limit, offset);
    }

    try {
      const igdbCategory = category as IGDBGameCategory;
      const games = await window.igdb!.getGamesByCategory(igdbCategory, limit, offset, year);
      
      // Cache individual games (in-memory and IndexedDB)
      games.forEach(game => {
        this.gameCache.set(game.id, game);
      });
      
      // Store in IndexedDB for offline access
      cacheStore.cacheGames(games).catch(err => 
        console.error('Failed to cache category games to IndexedDB:', err)
      );
      
      this.notifyListeners();
      return games;
    } catch (error) {
      console.error(`Failed to fetch games by category ${category}:`, error);
      // Try to return cached data on error
      const cachedGames = await this.getCachedGames(limit, offset);
      if (cachedGames.length > 0) {
        console.log('Returning cached games due to category API error');
        return cachedGames;
      }
      throw error;
    }
  }

  // Search games
  async searchGames(query: string, limit: number = 20): Promise<IGDBGame[]> {
    if (!query.trim()) {
      return [];
    }

    // Check in-memory cache first
    const cacheKey = `${query.toLowerCase()}-${limit}`;
    if (this.searchCache.has(cacheKey)) {
      return this.searchCache.get(cacheKey)!;
    }

    // Check IndexedDB cache for offline mode or as fallback
    try {
      const cachedResults = await cacheStore.getSearchResults(query);
      if (cachedResults) {
        this.searchCache.set(cacheKey, cachedResults);
        return cachedResults;
      }
    } catch (error) {
      console.error('Failed to check search cache:', error);
    }

    // Check if we're offline
    if (!navigator.onLine) {
      console.log('Offline - searching in cached games');
      const allCached = await cacheStore.getAllCachedGames();
      const queryLower = query.toLowerCase();
      return allCached.filter(game => 
        game.name.toLowerCase().includes(queryLower)
      ).slice(0, limit);
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return this.getMockSearchResults(query, limit);
    }

    try {
      const games = await window.igdb!.searchGames(query, limit);
      
      // Cache results (in-memory and IndexedDB)
      this.searchCache.set(cacheKey, games);
      games.forEach(game => {
        this.gameCache.set(game.id, game);
      });
      
      // Store in IndexedDB for offline access
      cacheStore.cacheSearchResults(query, games).catch(err =>
        console.error('Failed to cache search results:', err)
      );
      cacheStore.cacheGames(games).catch(err =>
        console.error('Failed to cache searched games:', err)
      );
      
      return games;
    } catch (error) {
      console.error('Failed to search games:', error);
      throw error;
    }
  }

  // Get single game by ID
  async getGameById(id: number): Promise<IGDBGame | null> {
    // Check cache first
    if (this.gameCache.has(id)) {
      return this.gameCache.get(id)!;
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return null;
    }

    try {
      const game = await window.igdb!.getGameById(id);
      if (game) {
        this.gameCache.set(id, game);
      }
      return game;
    } catch (error) {
      console.error('Failed to fetch game by id:', error);
      throw error;
    }
  }

  // Get multiple games by IDs
  async getGamesByIds(ids: number[]): Promise<IGDBGame[]> {
    if (!ids.length) return [];

    // Check which games we need to fetch
    const cachedGames: IGDBGame[] = [];
    const idsToFetch: number[] = [];

    ids.forEach(id => {
      if (this.gameCache.has(id)) {
        cachedGames.push(this.gameCache.get(id)!);
      } else {
        idsToFetch.push(id);
      }
    });

    if (!idsToFetch.length) {
      return cachedGames;
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return cachedGames;
    }

    try {
      const fetchedGames = await window.igdb!.getGamesByIds(idsToFetch);
      
      // Cache fetched games
      fetchedGames.forEach(game => {
        this.gameCache.set(game.id, game);
      });

      return [...cachedGames, ...fetchedGames];
    } catch (error) {
      console.error('Failed to fetch games by ids:', error);
      throw error;
    }
  }

  // Get all genres
  async getGenres(): Promise<IGDBGenre[]> {
    if (genresCache) {
      return genresCache;
    }

    // Try IndexedDB cache
    try {
      const cachedGenres = await cacheStore.getGenres();
      if (cachedGenres.length > 0) {
        genresCache = cachedGenres;
        return genresCache;
      }
    } catch (error) {
      console.error('Failed to get cached genres:', error);
    }

    // Check if we're offline
    if (!navigator.onLine) {
      console.log('Offline - no genres available');
      return this.getMockGenres();
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return this.getMockGenres();
    }

    try {
      genresCache = await window.igdb!.getGenres();
      
      // Store in IndexedDB
      cacheStore.cacheGenres(genresCache).catch(err =>
        console.error('Failed to cache genres:', err)
      );
      
      return genresCache;
    } catch (error) {
      console.error('Failed to fetch genres:', error);
      throw error;
    }
  }

  // Get all platforms
  async getPlatforms(): Promise<IGDBPlatform[]> {
    if (platformsCache) {
      return platformsCache;
    }

    // Try IndexedDB cache
    try {
      const cachedPlatforms = await cacheStore.getPlatforms();
      if (cachedPlatforms.length > 0) {
        platformsCache = cachedPlatforms;
        return platformsCache;
      }
    } catch (error) {
      console.error('Failed to get cached platforms:', error);
    }

    // Check if we're offline
    if (!navigator.onLine) {
      console.log('Offline - no platforms available');
      return this.getMockPlatforms();
    }

    if (!isElectron()) {
      console.warn('IGDB API only available in Electron');
      return this.getMockPlatforms();
    }

    try {
      platformsCache = await window.igdb!.getPlatforms();
      
      // Store in IndexedDB
      cacheStore.cachePlatforms(platformsCache).catch(err =>
        console.error('Failed to cache platforms:', err)
      );
      
      return platformsCache;
    } catch (error) {
      console.error('Failed to fetch platforms:', error);
      throw error;
    }
  }

  // Mock data for browser development
  private getMockGames(limit: number, offset: number): IGDBGame[] {
    const mockGames: IGDBGame[] = [];
    for (let i = offset; i < offset + limit && i < 60; i++) {
      mockGames.push({
        id: 1000 + i,
        name: `Sample Game ${i + 1}`,
        cover: { id: i, url: '', image_id: 'nocover' },
        genres: [{ id: 1, name: 'Action' }, { id: 2, name: 'Adventure' }],
        platforms: [{ id: 6, name: 'PC (Microsoft Windows)', abbreviation: 'PC' }],
        aggregated_rating: 70 + Math.floor(Math.random() * 25),
        first_release_date: Math.floor(Date.now() / 1000) - (i * 86400 * 30),
        summary: `This is a sample game description for Game ${i + 1}. It showcases various gameplay elements and features.`,
        involved_companies: [
          { id: 1, company: { id: 1, name: 'Sample Developer' }, developer: true, publisher: false },
          { id: 2, company: { id: 2, name: 'Sample Publisher' }, developer: false, publisher: true },
        ],
      });
    }
    return mockGames;
  }

  private getMockSearchResults(query: string, limit: number): IGDBGame[] {
    return this.getMockGames(Math.min(limit, 10), 0).filter(g => 
      g.name.toLowerCase().includes(query.toLowerCase())
    );
  }

  private getMockGenres(): IGDBGenre[] {
    return [
      { id: 1, name: 'Action' },
      { id: 2, name: 'Adventure' },
      { id: 3, name: 'RPG' },
      { id: 4, name: 'Strategy' },
      { id: 5, name: 'Shooter' },
      { id: 6, name: 'Puzzle' },
      { id: 7, name: 'Racing' },
      { id: 8, name: 'Sports' },
    ];
  }

  private getMockPlatforms(): IGDBPlatform[] {
    return [
      { id: 6, name: 'PC (Microsoft Windows)', abbreviation: 'PC', platform_family: 1 },
      { id: 48, name: 'PlayStation 4', abbreviation: 'PS4', platform_family: 1 },
      { id: 167, name: 'PlayStation 5', abbreviation: 'PS5', platform_family: 1 },
      { id: 49, name: 'Xbox One', abbreviation: 'XONE', platform_family: 2 },
      { id: 169, name: 'Xbox Series X|S', abbreviation: 'XSX', platform_family: 2 },
    ];
  }
}

// Singleton instance
export const igdbService = new IGDBService();

