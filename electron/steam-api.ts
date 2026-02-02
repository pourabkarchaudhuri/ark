/**
 * Steam Web API Client
 * Handles all Steam API requests with rate limiting and caching
 * 
 * Note: Uses native fetch available in Node.js 18+ (Electron 28+)
 */

// Steam API Configuration
const STEAM_API_KEY = 'C6DCACDE5866D149A7E3A9B59646164A';
const STEAM_WEB_API_BASE = 'https://api.steampowered.com';
const STEAM_STORE_API_BASE = 'https://store.steampowered.com/api';
const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

// Rate limiting configuration - OPTIMIZED for faster loading
// Steam API is fairly tolerant, so we can be more aggressive
const RATE_LIMIT_DELAY = 100; // 100ms between requests (10 requests/second)
const MAX_CONCURRENT_REQUESTS = 5; // Increased concurrent requests

/**
 * Construct cover image URL for a Steam game
 * Prefers library_600x900.jpg (vertical cover), falls back to header.jpg
 */
export function getSteamCoverUrl(appId: number): string {
  return `${STEAM_CDN_BASE}/${appId}/library_600x900.jpg`;
}

/**
 * Construct header image URL for a Steam game
 */
export function getSteamHeaderUrl(appId: number): string {
  return `${STEAM_CDN_BASE}/${appId}/header.jpg`;
}

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DETAILS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes for game details

// Types
export interface SteamAppListItem {
  appid: number;
  name: string;
}

export interface SteamMostPlayedGame {
  rank: number;
  appid: number;
  last_week_rank: number;
  peak_in_game: number;
}

export interface SteamMostPlayedResponse {
  response: {
    rollup_date: number;
    ranks: SteamMostPlayedGame[];
  };
}

export interface SteamAppDetails {
  success: boolean;
  data?: {
    type: string;
    name: string;
    steam_appid: number;
    required_age: number;
    is_free: boolean;
    detailed_description: string;
    about_the_game: string;
    short_description: string;
    supported_languages: string;
    header_image: string;
    capsule_image: string;
    capsule_imagev5: string;
    website: string;
    pc_requirements: {
      minimum?: string;
      recommended?: string;
    };
    developers?: string[];
    publishers?: string[];
    price_overview?: {
      currency: string;
      initial: number;
      final: number;
      discount_percent: number;
      final_formatted: string;
    };
    platforms: {
      windows: boolean;
      mac: boolean;
      linux: boolean;
    };
    metacritic?: {
      score: number;
      url: string;
    };
    categories?: Array<{ id: number; description: string }>;
    genres?: Array<{ id: string; description: string }>;
    screenshots?: Array<{
      id: number;
      path_thumbnail: string;
      path_full: string;
    }>;
    movies?: Array<{
      id: number;
      name: string;
      thumbnail: string;
      webm?: { '480': string; max: string };
      mp4?: { '480': string; max: string };
    }>;
    recommendations?: { total: number };
    achievements?: { total: number };
    release_date?: {
      coming_soon: boolean;
      date: string;
    };
    background?: string;
    background_raw?: string;
  };
}

export interface SteamSearchResult {
  total: number;
  items: Array<{
    type: string;
    name: string;
    id: number;
    tiny_image: string;
    metascore?: string;
    platforms?: {
      windows: boolean;
      mac: boolean;
      linux: boolean;
    };
    streamingvideo: boolean;
  }>;
}

export interface SteamFeaturedCategories {
  [key: string]: {
    id: string;
    name: string;
    items?: Array<{
      id: number;
      type: number;
      name: string;
      discounted: boolean;
      discount_percent: number;
      original_price?: number;
      final_price: number;
      currency: string;
      large_capsule_image: string;
      small_capsule_image: string;
      windows_available: boolean;
      mac_available: boolean;
      linux_available: boolean;
      streamingvideo_available: boolean;
      header_image: string;
    }>;
  };
}

// Steam Reviews API Types
export interface SteamReviewAuthor {
  steamid: string;
  num_games_owned: number;
  num_reviews: number;
  playtime_forever: number;
  playtime_last_two_weeks: number;
  playtime_at_review: number;
  last_played: number;
}

export interface SteamReview {
  recommendationid: string;
  author: SteamReviewAuthor;
  language: string;
  review: string;
  timestamp_created: number;
  timestamp_updated: number;
  voted_up: boolean;
  votes_up: number;
  votes_funny: number;
  weighted_vote_score: string;
  comment_count: number;
  steam_purchase: boolean;
  received_for_free: boolean;
  written_during_early_access: boolean;
}

export interface SteamReviewsResponse {
  success: number;
  query_summary: {
    num_reviews?: number;
    review_score?: number;
    review_score_desc?: string;
    total_positive: number;
    total_negative: number;
    total_reviews: number;
  };
  reviews: SteamReview[];
}

// Rate Limiter
class RateLimiter {
  private queue: Array<() => Promise<void>> = [];
  private activeRequests = 0;
  private lastRequestTime = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
          await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY - timeSinceLastRequest));
        }
        
        this.lastRequestTime = Date.now();
        this.activeRequests++;
        
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests--;
          this.processQueue();
        }
      };

      if (this.activeRequests < MAX_CONCURRENT_REQUESTS) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  private processQueue() {
    if (this.queue.length > 0 && this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        nextTask();
      }
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }
}

// Persistent Cache with Stale-While-Revalidate Strategy
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// Persistent TTL - data is considered "stale" but still usable for faster loads
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours - show stale data while revalidating
const MAX_CACHE_SIZE = 500; // Maximum number of entries to persist

class PersistentCache {
  private memoryStore: Map<string, CacheEntry<unknown>> = new Map();
  private cacheFilePath: string;
  private isDirty: boolean = false;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    // Store cache in user data directory
    const userDataPath = app?.getPath('userData') || './cache';
    this.cacheFilePath = path.join(userDataPath, 'steam-cache.json');
    this.loadFromDisk();
  }

  /**
   * Load cache from disk on startup
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // Restore cache entries
        let loadedCount = 0;
        for (const [key, entry] of Object.entries(parsed)) {
          const cacheEntry = entry as CacheEntry<unknown>;
          // Only load entries that aren't completely expired (within stale TTL)
          if (Date.now() - cacheEntry.timestamp < STALE_TTL) {
            this.memoryStore.set(key, cacheEntry);
            loadedCount++;
          }
        }
        console.log(`[Cache] Loaded ${loadedCount} entries from disk cache`);
      }
    } catch (error) {
      console.warn('[Cache] Failed to load disk cache:', error);
    }
  }

  /**
   * Save cache to disk (debounced)
   */
  private saveToDisk(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      try {
        // Convert map to object, keeping only recent entries
        const entries = Array.from(this.memoryStore.entries())
          .filter(([, entry]) => Date.now() - entry.timestamp < STALE_TTL)
          .slice(-MAX_CACHE_SIZE); // Keep most recent entries
        
        const obj: Record<string, CacheEntry<unknown>> = {};
        for (const [key, value] of entries) {
          obj[key] = value;
        }
        
        fs.writeFileSync(this.cacheFilePath, JSON.stringify(obj), 'utf-8');
        console.log(`[Cache] Saved ${entries.length} entries to disk`);
        this.isDirty = false;
      } catch (error) {
        console.error('[Cache] Failed to save disk cache:', error);
      }
    }, 5000); // Debounce writes by 5 seconds
  }

  set<T>(key: string, data: T, ttl: number = CACHE_TTL): void {
    this.memoryStore.set(key, { data, timestamp: Date.now(), ttl });
    this.isDirty = true;
    this.saveToDisk();
  }

  /**
   * Get cached data
   * @param allowStale - If true, returns stale data (useful for stale-while-revalidate)
   */
  get<T>(key: string, allowStale: boolean = false): T | null {
    const entry = this.memoryStore.get(key);
    if (!entry) return null;
    
    const age = Date.now() - entry.timestamp;
    
    // If within normal TTL, return fresh data
    if (age <= entry.ttl) {
      return entry.data as T;
    }
    
    // If stale but within stale TTL and allowStale is true, return stale data
    if (allowStale && age <= STALE_TTL) {
      return entry.data as T;
    }
    
    // Completely expired
    if (age > STALE_TTL) {
      this.memoryStore.delete(key);
    }
    
    return null;
  }

  /**
   * Check if key exists and is fresh (within normal TTL)
   */
  has(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      return false;
    }
    
    return true;
  }

  /**
   * Check if key exists (even if stale)
   */
  hasStale(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    
    if (Date.now() - entry.timestamp > STALE_TTL) {
      this.memoryStore.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Check if cached data is stale (but still usable)
   */
  isStale(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return true;
    
    return Date.now() - entry.timestamp > entry.ttl;
  }

  clear(): void {
    this.memoryStore.clear();
    this.isDirty = true;
    this.saveToDisk();
  }

  /**
   * Get cache statistics
   */
  getStats(): { total: number; fresh: number; stale: number } {
    let fresh = 0;
    let stale = 0;
    
    const entries = Array.from(this.memoryStore.values());
    for (const entry of entries) {
      const age = Date.now() - entry.timestamp;
      if (age <= entry.ttl) {
        fresh++;
      } else if (age <= STALE_TTL) {
        stale++;
      }
    }
    
    return { total: this.memoryStore.size, fresh, stale };
  }
}

// Alias for backwards compatibility
const Cache = PersistentCache;

// Steam API Client
class SteamAPIClient {
  private rateLimiter = new RateLimiter();
  private cache = new Cache();

  /**
   * Get most played games from Steam Charts
   * Uses stale-while-revalidate: returns cached data immediately, refreshes in background
   */
  async getMostPlayedGames(): Promise<SteamMostPlayedGame[]> {
    const cacheKey = 'most-played-games';
    
    // Check for fresh cache
    const freshCached = this.cache.get<SteamMostPlayedGame[]>(cacheKey);
    if (freshCached) {
      console.log('[Steam] getMostPlayedGames: returning fresh cache');
      return freshCached;
    }
    
    // Check for stale cache - return it but also refresh in background
    const staleCached = this.cache.get<SteamMostPlayedGame[]>(cacheKey, true);
    if (staleCached) {
      console.log('[Steam] getMostPlayedGames: returning stale cache, refreshing in background');
      // Fire and forget background refresh
      this.refreshMostPlayedGames().catch(err => 
        console.warn('[Steam] Background refresh failed:', err)
      );
      return staleCached;
    }

    // No cache at all - must fetch
    return this.refreshMostPlayedGames();
  }

  /**
   * Force refresh most played games (called by stale-while-revalidate)
   */
  private async refreshMostPlayedGames(): Promise<SteamMostPlayedGame[]> {
    const cacheKey = 'most-played-games';
    const url = `${STEAM_WEB_API_BASE}/ISteamChartsService/GetMostPlayedGames/v1/?key=${STEAM_API_KEY}`;
    
    const response = await this.rateLimiter.execute(async () => {
      console.log('[Steam] Fetching fresh most played games...');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Steam API error: ${res.status}`);
      return res.json() as Promise<SteamMostPlayedResponse>;
    });

    const games = response.response?.ranks || [];
    console.log(`[Steam] Fetched ${games.length} most played games`);
    this.cache.set(cacheKey, games);
    return games;
  }

  /**
   * Get app details from Steam Store API
   */
  /**
   * Get app details from Steam Store API
   * Uses stale-while-revalidate: returns cached data immediately, refreshes in background
   */
  async getAppDetails(appId: number): Promise<SteamAppDetails['data'] | null> {
    const cacheKey = `app-details-${appId}`;
    
    // Check for fresh cache
    const freshCached = this.cache.get<SteamAppDetails['data']>(cacheKey);
    if (freshCached) {
      return freshCached;
    }
    
    // Check for stale cache - return it but also refresh in background
    const staleCached = this.cache.get<SteamAppDetails['data']>(cacheKey, true);
    if (staleCached) {
      console.log(`[Steam] getAppDetails(${appId}): returning stale cache, refreshing in background`);
      // Fire and forget background refresh
      this.refreshAppDetails(appId).catch(err => 
        console.warn(`[Steam] Background refresh for ${appId} failed:`, err)
      );
      return staleCached;
    }

    // No cache at all - must fetch
    return this.refreshAppDetails(appId);
  }

  /**
   * Force refresh app details (called by stale-while-revalidate)
   */
  private async refreshAppDetails(appId: number): Promise<SteamAppDetails['data'] | null> {
    const cacheKey = `app-details-${appId}`;
    const url = `${STEAM_STORE_API_BASE}/appdetails?appids=${appId}&cc=us&l=english`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<{ [key: string]: SteamAppDetails }>;
      });

      const appData = response[appId.toString()];
      if (appData?.success && appData.data) {
        this.cache.set(cacheKey, appData.data, DETAILS_CACHE_TTL);
        return appData.data;
      }
      return null;
    } catch (error) {
      console.error(`[Steam] Error fetching app details for ${appId}:`, error);
      return null;
    }
  }

  /**
   * Get details for multiple apps (batched with concurrent processing)
   * OPTIMIZED: Increased batch size and added prefetching
   */
  async getMultipleAppDetails(appIds: number[]): Promise<Map<number, SteamAppDetails['data']>> {
    const results = new Map<number, SteamAppDetails['data']>();
    
    // First, check cache and separate cached vs uncached
    const uncachedIds: number[] = [];
    for (const appId of appIds) {
      const cacheKey = `app-details-${appId}`;
      const cached = this.cache.get<SteamAppDetails['data']>(cacheKey);
      if (cached) {
        results.set(appId, cached);
      } else {
        uncachedIds.push(appId);
      }
    }

    console.log(`[Steam] getMultipleAppDetails: ${results.size} cached, ${uncachedIds.length} to fetch`);

    // OPTIMIZATION: Increased batch size from 5 to 10 for faster loading
    // Rate limiter handles the actual throttling
    const batchSize = 10;
    for (let i = 0; i < uncachedIds.length; i += batchSize) {
      const batch = uncachedIds.slice(i, i + batchSize);
      const promises = batch.map(async (appId) => {
        const details = await this.getAppDetails(appId);
        if (details) {
          results.set(appId, details);
        }
      });
      await Promise.all(promises);
    }
    
    return results;
  }

  /**
   * Search games on Steam Store
   */
  async searchGames(query: string, limit: number = 20): Promise<SteamSearchResult['items']> {
    const cacheKey = `search-${query}-${limit}`;
    const cached = this.cache.get<SteamSearchResult['items']>(cacheKey);
    if (cached) return cached;

    const url = `${STEAM_STORE_API_BASE}/storesearch?term=${encodeURIComponent(query)}&cc=us&l=english`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        console.log(`[Steam] Searching for: ${query}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<SteamSearchResult>;
      });

      const items = response.items?.slice(0, limit) || [];
      console.log(`[Steam] Found ${items.length} results for: ${query}`);
      this.cache.set(cacheKey, items);
      return items;
    } catch (error) {
      console.error(`[Steam] Search error:`, error);
      return [];
    }
  }

  /**
   * Get featured categories (includes new releases, top sellers, coming soon)
   */
  async getFeaturedCategories(): Promise<SteamFeaturedCategories> {
    const cacheKey = 'featured-categories';
    const cached = this.cache.get<SteamFeaturedCategories>(cacheKey);
    if (cached) return cached;

    const url = `${STEAM_STORE_API_BASE}/featuredcategories?cc=us&l=english`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        console.log('[Steam] Fetching featured categories...');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<SteamFeaturedCategories>;
      });

      this.cache.set(cacheKey, response);
      return response;
    } catch (error) {
      console.error('[Steam] Featured categories error:', error);
      return {};
    }
  }

  /**
   * Get new releases
   */
  async getNewReleases(): Promise<Array<{ id: number; name: string; image: string }>> {
    const categories = await this.getFeaturedCategories();
    const newReleases = categories['new_releases'];
    
    if (!newReleases?.items) return [];
    
    return newReleases.items.map(item => ({
      id: item.id,
      name: item.name,
      image: item.large_capsule_image || item.header_image
    }));
  }

  /**
   * Get top sellers
   */
  async getTopSellers(): Promise<Array<{ id: number; name: string; image: string }>> {
    const categories = await this.getFeaturedCategories();
    const topSellers = categories['top_sellers'];
    
    if (!topSellers?.items) return [];
    
    return topSellers.items.map(item => ({
      id: item.id,
      name: item.name,
      image: item.large_capsule_image || item.header_image
    }));
  }

  /**
   * Get coming soon games
   */
  async getComingSoon(): Promise<Array<{ id: number; name: string; image: string }>> {
    const categories = await this.getFeaturedCategories();
    const comingSoon = categories['coming_soon'];
    
    if (!comingSoon?.items) return [];
    
    return comingSoon.items.map(item => ({
      id: item.id,
      name: item.name,
      image: item.large_capsule_image || item.header_image
    }));
  }

  /**
   * Get game reviews from Steam
   */
  async getGameReviews(appId: number, limit: number = 10): Promise<SteamReviewsResponse> {
    const cacheKey = `reviews-${appId}-${limit}`;
    const cached = this.cache.get<SteamReviewsResponse>(cacheKey);
    if (cached) return cached;

    const url = `https://store.steampowered.com/appreviews/${appId}?json=1&language=english&num_per_page=${limit}&filter=recent&purchase_type=all`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        console.log(`[Steam] Fetching reviews for appId: ${appId}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Steam Reviews API error: ${res.status}`);
        return res.json() as Promise<SteamReviewsResponse>;
      });

      console.log(`[Steam] Got ${response.reviews?.length || 0} reviews for appId: ${appId}`);
      this.cache.set(cacheKey, response, DETAILS_CACHE_TTL);
      return response;
    } catch (error) {
      console.error(`[Steam] Error fetching reviews for ${appId}:`, error);
      return { success: 0, query_summary: { total_reviews: 0, total_positive: 0, total_negative: 0, review_score: 0, review_score_desc: '' }, reviews: [] };
    }
  }

  /**
   * Get queue status for rate limiting feedback
   */
  getQueueStatus(): { queueSize: number } {
    return { queueSize: this.rateLimiter.getQueueSize() };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.cache.clear();
    console.log('[Steam] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { total: number; fresh: number; stale: number } {
    return this.cache.getStats();
  }

  /**
   * Get cached game names for multiple app IDs
   * Returns a map of appId -> name for all games found in cache
   */
  getCachedGameNames(appIds: number[]): Record<number, string> {
    const result: Record<number, string> = {};
    
    for (const appId of appIds) {
      const cacheKey = `app-details-${appId}`;
      // Allow stale data since we just need the name
      const cached = this.cache.get<SteamAppDetails['data']>(cacheKey, true);
      if (cached && cached.name) {
        result[appId] = cached.name;
      }
    }
    
    console.log(`[Steam] Got ${Object.keys(result).length}/${appIds.length} cached game names`);
    return result;
  }

  /**
   * Prefetch game details in background (non-blocking)
   * Use this to preload data for games visible on screen
   */
  async prefetchGameDetails(appIds: number[]): Promise<void> {
    // Filter out already cached items
    const uncachedIds = appIds.filter(appId => {
      const cacheKey = `app-details-${appId}`;
      return !this.cache.has(cacheKey);
    });

    if (uncachedIds.length === 0) {
      console.log('[Steam] Prefetch: All games already cached');
      return;
    }

    console.log(`[Steam] Prefetch: Loading ${uncachedIds.length} games in background...`);
    
    // Low priority fetch - don't await, just fire and forget
    // Process in small batches to not overwhelm the rate limiter
    const batchSize = 5;
    for (let i = 0; i < uncachedIds.length; i += batchSize) {
      const batch = uncachedIds.slice(i, i + batchSize);
      Promise.all(batch.map(appId => this.getAppDetails(appId).catch(() => null)));
      // Small delay between batches to give priority to user-initiated requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  /**
   * Check if a game is cached
   */
  isCached(appId: number): boolean {
    const cacheKey = `app-details-${appId}`;
    return this.cache.has(cacheKey);
  }

  /**
   * Get game recommendations based on a game and optionally the user's library
   * Uses content-based filtering with genre, category, and developer matching
   */
  async getRecommendations(
    currentAppId: number,
    libraryAppIds: number[] = [],
    limit: number = 10
  ): Promise<Array<{ appId: number; name: string; score: number; reasons: string[] }>> {
    const cacheKey = `recommendations-${currentAppId}-${libraryAppIds.slice(0, 5).join('-')}`;
    const cached = this.cache.get<Array<{ appId: number; name: string; score: number; reasons: string[] }>>(cacheKey);
    if (cached) return cached;

    console.log(`[Steam] Getting recommendations for appId: ${currentAppId}`);

    try {
      // 1. Get current game details
      const currentGame = await this.getAppDetails(currentAppId);
      if (!currentGame) {
        console.log('[Steam] Could not get current game details');
        return [];
      }

      // 2. Build taste profile from current game and library
      const tasteProfile = await this.buildTasteProfile(currentGame, libraryAppIds);
      console.log('[Steam] Taste profile:', {
        genres: tasteProfile.genres.slice(0, 5),
        categories: tasteProfile.categories.slice(0, 5),
        developers: tasteProfile.developers.slice(0, 3)
      });

      // 3. Get candidate games from various sources
      const candidates = await this.getCandidateGames(tasteProfile, currentAppId, libraryAppIds);
      console.log(`[Steam] Found ${candidates.length} candidate games`);

      // 4. Score and rank candidates
      const scored = await this.scoreAndRankCandidates(candidates, currentGame, tasteProfile, libraryAppIds);
      
      // 5. Return top results
      const results = scored.slice(0, limit);
      this.cache.set(cacheKey, results, DETAILS_CACHE_TTL);
      
      console.log(`[Steam] Returning ${results.length} recommendations`);
      return results;
    } catch (error) {
      console.error('[Steam] Error getting recommendations:', error);
      return [];
    }
  }

  /**
   * Build a taste profile from the current game and library
   */
  private async buildTasteProfile(
    currentGame: NonNullable<Awaited<ReturnType<typeof this.getAppDetails>>>,
    libraryAppIds: number[]
  ): Promise<{
    genres: Array<{ id: string; description: string; weight: number }>;
    categories: Array<{ id: number; description: string; weight: number }>;
    developers: string[];
    publishers: string[];
  }> {
    const genreMap = new Map<string, { id: string; description: string; weight: number }>();
    const categoryMap = new Map<number, { id: number; description: string; weight: number }>();
    const developerSet = new Set<string>();
    const publisherSet = new Set<string>();

    // Add current game's attributes with high weight
    const addGameToProfile = (
      game: NonNullable<Awaited<ReturnType<typeof this.getAppDetails>>>,
      weight: number
    ) => {
      game.genres?.forEach(g => {
        const existing = genreMap.get(g.id);
        genreMap.set(g.id, {
          id: g.id,
          description: g.description,
          weight: (existing?.weight || 0) + weight
        });
      });

      game.categories?.forEach(c => {
        const existing = categoryMap.get(c.id);
        categoryMap.set(c.id, {
          id: c.id,
          description: c.description,
          weight: (existing?.weight || 0) + weight
        });
      });

      game.developers?.forEach(d => developerSet.add(d));
      game.publishers?.forEach(p => publisherSet.add(p));
    };

    // Current game gets highest weight
    addGameToProfile(currentGame, 10);

    // Add library games with lower weight (limit to avoid too many API calls)
    const libraryToFetch = libraryAppIds.slice(0, 10);
    const libraryGames = await Promise.all(
      libraryToFetch.map(id => this.getAppDetails(id).catch(() => null))
    );

    libraryGames.forEach(game => {
      if (game) addGameToProfile(game, 3);
    });

    // Sort by weight
    const genres = Array.from(genreMap.values()).sort((a, b) => b.weight - a.weight);
    const categories = Array.from(categoryMap.values()).sort((a, b) => b.weight - a.weight);

    return {
      genres,
      categories,
      developers: Array.from(developerSet),
      publishers: Array.from(publisherSet)
    };
  }

  /**
   * Get candidate games from various Steam sources
   */
  private async getCandidateGames(
    tasteProfile: Awaited<ReturnType<typeof this.buildTasteProfile>>,
    excludeAppId: number,
    excludeLibrary: number[]
  ): Promise<number[]> {
    const excludeSet = new Set([excludeAppId, ...excludeLibrary]);
    const candidateSet = new Set<number>();

    // Get games from multiple sources in parallel
    const [topSellers, newReleases, mostPlayed] = await Promise.all([
      this.getTopSellers().catch(() => []),
      this.getNewReleases().catch(() => []),
      this.getMostPlayedGames().catch(() => [])
    ]);

    // Add from all sources (different return types have different id properties)
    topSellers.forEach(g => {
      if (!excludeSet.has(g.id)) candidateSet.add(g.id);
    });
    newReleases.forEach(g => {
      if (!excludeSet.has(g.id)) candidateSet.add(g.id);
    });
    mostPlayed.forEach(g => {
      if (!excludeSet.has(g.appid)) candidateSet.add(g.appid);
    });

    // If we have a top genre, try to get more games via search
    if (tasteProfile.genres.length > 0) {
      const topGenre = tasteProfile.genres[0].description;
      try {
        const searchResults = await this.searchGames(topGenre, 50);
        searchResults.forEach(g => {
          if (!excludeSet.has(g.id)) candidateSet.add(g.id);
        });
      } catch (e) {
        console.log('[Steam] Genre search failed, continuing with other candidates');
      }
    }

    return Array.from(candidateSet);
  }

  /**
   * Score and rank candidate games based on similarity
   */
  private async scoreAndRankCandidates(
    candidateAppIds: number[],
    currentGame: NonNullable<Awaited<ReturnType<typeof this.getAppDetails>>>,
    tasteProfile: Awaited<ReturnType<typeof this.buildTasteProfile>>,
    libraryAppIds: number[]
  ): Promise<Array<{ appId: number; name: string; score: number; reasons: string[] }>> {
    // Limit candidates to avoid too many API calls
    const toScore = candidateAppIds.slice(0, 50);
    
    // Fetch details for candidates (many should be cached from getCandidateGames sources)
    const candidateDetails = await Promise.all(
      toScore.map(id => this.getAppDetails(id).catch(() => null))
    );

    const currentGenres = new Set(currentGame.genres?.map(g => g.id) || []);
    const currentCategories = new Set(currentGame.categories?.map(c => c.id) || []);
    const currentDevs = new Set(currentGame.developers || []);
    const currentPubs = new Set(currentGame.publishers || []);

    const profileGenres = new Set(tasteProfile.genres.map(g => g.id));
    const profileCategories = new Set(tasteProfile.categories.map(c => c.id));

    const scored: Array<{ appId: number; name: string; score: number; reasons: string[] }> = [];

    for (const candidate of candidateDetails) {
      if (!candidate) continue;

      let score = 0;
      const reasons: string[] = [];

      const candidateGenres = new Set(candidate.genres?.map(g => g.id) || []);
      const candidateCategories = new Set(candidate.categories?.map(c => c.id) || []);
      const candidateDevs = new Set(candidate.developers || []);
      const candidatePubs = new Set(candidate.publishers || []);

      // Genre overlap with current game (high value)
      const genreOverlap = Array.from(currentGenres).filter(g => candidateGenres.has(g)).length;
      if (genreOverlap > 0) {
        score += genreOverlap * 25;
        const sharedGenres = candidate.genres
          ?.filter(g => currentGenres.has(g.id))
          .map(g => g.description)
          .slice(0, 2);
        if (sharedGenres?.length) {
          reasons.push(`Similar genre: ${sharedGenres.join(', ')}`);
        }
      }

      // Genre match with taste profile
      const profileGenreOverlap = Array.from(profileGenres).filter(g => candidateGenres.has(g)).length;
      score += profileGenreOverlap * 10;

      // Category overlap (multiplayer, co-op, etc.)
      const catOverlap = Array.from(currentCategories).filter(c => candidateCategories.has(c)).length;
      if (catOverlap > 0) {
        score += catOverlap * 5;
      }

      // Same developer (very strong signal)
      const sameDevs = Array.from(currentDevs).filter(d => candidateDevs.has(d));
      if (sameDevs.length > 0) {
        score += 40;
        reasons.push(`From ${sameDevs[0]}`);
      }

      // Same publisher (moderate signal)
      const samePubs = Array.from(currentPubs).filter(p => candidatePubs.has(p));
      if (samePubs.length > 0 && sameDevs.length === 0) {
        score += 15;
        reasons.push(`Published by ${samePubs[0]}`);
      }

      // Metacritic score bonus
      if (candidate.metacritic?.score) {
        score += Math.floor(candidate.metacritic.score / 10);
        if (candidate.metacritic.score >= 80) {
          reasons.push(`Metacritic: ${candidate.metacritic.score}`);
        }
      }

      // Popularity bonus (has many recommendations)
      if (candidate.recommendations?.total && candidate.recommendations.total > 10000) {
        score += 10;
        if (reasons.length < 3) {
          reasons.push('Highly rated');
        }
      }

      // Only include games with meaningful similarity
      if (score >= 20) {
        scored.push({
          appId: candidate.steam_appid,
          name: candidate.name,
          score,
          reasons: reasons.slice(0, 3)
        });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }
}

// Export singleton instance
export const steamAPI = new SteamAPIClient();

