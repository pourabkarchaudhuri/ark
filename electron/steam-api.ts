/**
 * Steam Web API Client
 * Handles all Steam API requests with rate limiting and caching.
 * Uses Electron's net.fetch when available so corporate proxies and
 * self-signed certificates are handled by Chromium's network stack.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');

// Steam API Configuration — key loaded from .env via dotenv in main.ts
// Read lazily: ESM imports hoist above dotenv's loadEnv() call, so
// process.env isn't populated yet at module-scope evaluation time.
function steamApiKey() { return process.env.STEAM_API_KEY || ''; }
const STEAM_WEB_API_BASE = 'https://api.steampowered.com';
const STEAM_STORE_API_BASE = 'https://store.steampowered.com/api';
const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

// Rate limiting configuration - balanced for speed vs Steam's 429 limits
// Steam appdetails endpoint rate-limits at ~200 requests per 5 minutes
const RATE_LIMIT_DELAY = 200; // 200ms between requests (5 requests/second)
const MAX_CONCURRENT_REQUESTS = 3; // Conservative to avoid 429 bursts
/** Catalog GetItems batches in flight at once (the sync used to fire 8 unthrottled). */
const CATALOG_MAX_INFLIGHT = 4;

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

// Rate Limiter with promise coalescing — identical concurrent requests
// (same dedup key) share a single in-flight promise instead of hitting
// the API multiple times.
const MAX_QUEUE_SIZE = 500; // Prevent unbounded queue growth

class RateLimiter {
  private queue: Array<() => Promise<void>> = [];
  private activeRequests = 0;
  private lastRequestTime = 0;
  /** In-flight promise cache keyed by dedup key — collapses identical requests */
  private inFlight = new Map<string, Promise<unknown>>();

  /**
   * Execute a rate-limited request.
   * @param fn - The async function to execute
   * @param dedupKey - Optional dedup key; if provided, concurrent calls with the
   *                   same key share one in-flight promise (promise coalescing).
   */
  async execute<T>(fn: () => Promise<T>, dedupKey?: string): Promise<T> {
    // Promise coalescing — reuse an existing in-flight request for the same key
    if (dedupKey) {
      const existing = this.inFlight.get(dedupKey) as Promise<T> | undefined;
      if (existing) return existing;
    }

    const promise = new Promise<T>((resolve, reject) => {
      // Reject immediately if queue is at capacity to prevent memory bloat
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        reject(new Error('Rate limiter queue full'));
        return;
      }

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

    // Register in-flight promise for dedup
    if (dedupKey) {
      this.inFlight.set(dedupKey, promise);
      promise.finally(() => this.inFlight.delete(dedupKey!));
    }

    return promise;
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

// PersistentCache — imported from shared module
import { PersistentCache } from './persistent-cache.js';
import { logger } from './safe-logger.js';

// Alias for backwards compatibility
const Cache = PersistentCache;

/**
 * Fetch with a timeout (default 30s). Uses Electron net.fetch when available for correct TLS/certificate handling.
 * The timer stays armed after the headers arrive so it also bounds the body read (`res.json()`) — a body
 * that stalls mid-transfer used to hang its caller (and any sync awaiting it) forever. Aborting a request
 * whose body was already consumed is a no-op.
 */
function fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchFn: typeof globalThis.fetch = electron?.net?.fetch ?? globalThis.fetch;
  return fetchFn(url, { signal: controller.signal }).catch((err) => { clearTimeout(timer); throw err; });
}

// Steam API Client

/**
 * Store pages whose players Steam counts under another appid. Recent Call of Duty titles launch
 * through Call of Duty HQ (1938090): GetNumberOfCurrentPlayers for the store page itself returns 0-5
 * while HQ reports six figures (measured 2026-10-29: 2519060 → 0, 2933620 → 0, 1962663 → 4,
 * 1938090 → 147,422).
 */
export const PLAYER_COUNT_ALIASES: Readonly<Record<number, number>> = {
  2519060: 1938090, // Call of Duty: Modern Warfare III
  2933620: 1938090, // Call of Duty: Black Ops 6
  1962663: 1938090, // Call of Duty: Warzone
};

class SteamAPIClient {
  private rateLimiter = new RateLimiter();
  /**
   * Player counts (api.steampowered.com) get their own limiter so a Browse sweep never queues
   * appdetails / reviews / search (store.steampowered.com) behind it, and their own in-memory cache:
   * writing hundreds of short-lived counts into the persistent cache rewrote steam-cache.json (which
   * holds the full app list) on every sweep and evicted real appdetails entries.
   */
  private playerCountLimiter = new RateLimiter();
  private playerCountCache = new Map<number, { v: number | null; until: number }>();
  private cache = new Cache('steam-cache.json');
  /** appdetails circuit: set from a 429 (Retry-After, capped at 5 min; default 60s). */
  private appDetailsPausedUntil = 0;
  /** Catalog-batch throttle state (see catalogSlot). */
  private catalogInFlight = 0;
  private catalogWaiters: Array<() => void> = [];
  private catalogPausedUntil = 0;
  private catalog429Streak = 0;

  /**
   * Get most played games from Steam Charts
   * Uses stale-while-revalidate: returns cached data immediately, refreshes in background
   */
  async getMostPlayedGames(): Promise<SteamMostPlayedGame[]> {
    const cacheKey = 'most-played-games';
    
    // Check for fresh cache
    const freshCached = this.cache.get<SteamMostPlayedGame[]>(cacheKey);
    if (freshCached) {
      logger.log('[Steam] getMostPlayedGames: returning fresh cache');
      return freshCached;
    }
    
    // Check for stale cache - return it but also refresh in background
    const staleCached = this.cache.get<SteamMostPlayedGame[]>(cacheKey, true);
    if (staleCached) {
      logger.log('[Steam] getMostPlayedGames: returning stale cache, refreshing in background');
      // Fire and forget background refresh
      this.refreshMostPlayedGames().catch(err => 
        logger.warn('[Steam] Background refresh failed:', err)
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
    const url = `${STEAM_WEB_API_BASE}/ISteamChartsService/GetMostPlayedGames/v1/?key=${steamApiKey()}`;
    
    const response = await this.rateLimiter.execute(async () => {
      logger.log('[Steam] Fetching fresh most played games...');
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`Steam API error: ${res.status}`);
      return res.json() as Promise<SteamMostPlayedResponse>;
    });

    const games = response.response?.ranks || [];
    logger.log(`[Steam] Fetched ${games.length} most played games`);
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
      logger.log(`[Steam] getAppDetails(${appId}): returning stale cache, refreshing in background`);
      // Fire and forget background refresh
      this.refreshAppDetails(appId).catch(err => 
        logger.warn(`[Steam] Background refresh for ${appId} failed:`, err)
      );
      return staleCached;
    }

    // No cache at all - must fetch
    return this.refreshAppDetails(appId);
  }

  /**
   * Fetch app details for multiple app IDs in one store request (no cache).
   * Used by full-catalog adult-filter test. Max 20 ids per request to avoid URL length limits.
   */
  async fetchAppDetailsBatch(appIds: number[]): Promise<Array<{ appid: number; name: string; ratings?: { esrb?: { rating?: string } } | null }>> {
    if (appIds.length === 0) return [];
    const ids = appIds.slice(0, 20).join(',');
    const url = `${STEAM_STORE_API_BASE}/appdetails?appids=${ids}&cc=us&l=english`;
    try {
      const response = await this.rateLimiter.execute(async () => {
        const res = await fetchWithTimeout(url, 15000);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<Record<string, { success?: boolean; data?: SteamAppDetails['data'] }>>;
      }, `appdetails-batch-${appIds[0]}`);
      const out: Array<{ appid: number; name: string; ratings?: { esrb?: { rating?: string } } | null }> = [];
      for (const appId of appIds.slice(0, 20)) {
        const app = response[String(appId)];
        if (app?.success && app.data) {
          out.push({
            appid: app.data.steam_appid,
            name: app.data.name ?? '',
            ratings: (app.data as any).ratings ?? null,
          });
        }
      }
      return out;
    } catch (error) {
      logger.warn('[Steam] fetchAppDetailsBatch failed:', (error as Error).message);
      return [];
    }
  }

  /**
   * Force refresh app details (called by stale-while-revalidate)
   */
  private async refreshAppDetails(appId: number): Promise<SteamAppDetails['data'] | null> {
    const cacheKey = `app-details-${appId}`;
    const url = `${STEAM_STORE_API_BASE}/appdetails?appids=${appId}&cc=in&l=english`;
    // While Steam is answering 429, don't queue more appdetails calls behind the limiter —
    // every one would wait its turn only to be rejected, starving browse/Oracle/Similar Games.
    if (Date.now() < this.appDetailsPausedUntil) return null;

    try {
      const response = await this.rateLimiter.execute(async () => {
        if (Date.now() < this.appDetailsPausedUntil) throw new Error('Steam appdetails paused after 429');
        const res = await fetchWithTimeout(url);
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get('retry-after'));
          const pauseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 5 * 60_000) : 60_000;
          this.appDetailsPausedUntil = Date.now() + pauseMs;
          logger.warn(`[Steam] appdetails rate-limited (429) — pausing appdetails for ${Math.round(pauseMs / 1000)}s`);
        }
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<{ [key: string]: SteamAppDetails }>;
      }, `appdetails-${appId}`);

      const appData = response[appId.toString()];
      if (appData?.success && appData.data) {
        this.cache.set(cacheKey, appData.data, DETAILS_CACHE_TTL);
        return appData.data;
      }
      return null;
    } catch (error) {
      logger.error(`[Steam] Error fetching app details for ${appId}:`, error);
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

    logger.log(`[Steam] getMultipleAppDetails: ${results.size} cached, ${uncachedIds.length} to fetch`);

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
   * Filters out DLCs, Season Passes, and other non-base-game items
   */
  async searchGames(query: string, limit: number = 20): Promise<SteamSearchResult['items']> {
    const cacheKey = `search-${query}-${limit}`;
    const cached = this.cache.get<SteamSearchResult['items']>(cacheKey);
    if (cached) return cached;

    const url = `${STEAM_STORE_API_BASE}/storesearch?term=${encodeURIComponent(query)}&cc=in&l=english`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        logger.log(`[Steam] Searching for: ${query}`);
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<SteamSearchResult>;
      });

      // Filter out non-game items (DLCs, Season Passes, etc.)
      const allItems = response.items || [];
      const filteredItems = allItems.filter(item => {
        // Filter by type - include 'game' and 'app' (Steam now returns 'app' for games)
        // Steam types: 'app' (games), 'game' (legacy), 'dlc', 'demo', 'advertising', 'mod', 'video'
        const type = typeof item.type === 'string' ? item.type.toLowerCase() : String(item.type || '').toLowerCase();
        if (type && type !== 'game' && type !== 'app') {
          return false;
        }
        
        // Additional name-based filtering for items that might slip through
        const nameLower = item.name.toLowerCase();
        const excludePatterns = [
          ' dlc',
          ' - dlc',
          'season pass',
          'year pass',
          'yearly pass',
          'annual pass',
          'battle pass',
          'expansion pack',
          'expansion pass',
          'starter pack',
          'booster pack',
          'content pack',
          'character pack',
          'skin pack',
          'costume pack',
          'weapon pack',
          'map pack',
          'soundtrack',
          ' ost',
          'artbook',
          'art book',
          'digital deluxe upgrade',
          'upgrade pack',
          'vip pack',
          'premium pack',
          'gold upgrade',
          'ultimate upgrade',
          'deluxe upgrade',
          'supporter pack',
          'bonus content',
          'pre-order bonus',
          'preorder bonus',
        ];
        
        // Check if name contains any exclude patterns
        for (const pattern of excludePatterns) {
          if (nameLower.includes(pattern)) {
            return false;
          }
        }
        
        return true;
      });
      
      const items = filteredItems.slice(0, limit);
      logger.log(`[Steam] Found ${allItems.length} results, filtered to ${items.length} games for: ${query}`);
      this.cache.set(cacheKey, items);
      return items;
    } catch (error) {
      logger.error(`[Steam] Search error:`, error);
      throw error;
    }
  }

  /**
   * Get featured categories (includes new releases, top sellers, coming soon)
   */
  async getFeaturedCategories(): Promise<SteamFeaturedCategories> {
    const cacheKey = 'featured-categories';
    const cached = this.cache.get<SteamFeaturedCategories>(cacheKey);
    if (cached) return cached;

    const url = `${STEAM_STORE_API_BASE}/featuredcategories?cc=in&l=english`;
    
    try {
      const response = await this.rateLimiter.execute(async () => {
        logger.log('[Steam] Fetching featured categories...');
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<SteamFeaturedCategories>;
      }, 'featured-categories');

      this.cache.set(cacheKey, response);
      return response;
    } catch (error) {
      logger.error('[Steam] Featured categories error:', error);
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
        logger.log(`[Steam] Fetching reviews for appId: ${appId}`);
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Steam Reviews API error: ${res.status}`);
        return res.json() as Promise<SteamReviewsResponse>;
      });

      logger.log(`[Steam] Got ${response.reviews?.length || 0} reviews for appId: ${appId}`);
      this.cache.set(cacheKey, response, DETAILS_CACHE_TTL);
      return response;
    } catch (error) {
      logger.error(`[Steam] Error fetching reviews for ${appId}:`, error);
      return { success: 0, query_summary: { total_reviews: 0, total_positive: 0, total_negative: 0, review_score: 0, review_score_desc: '' }, reviews: [] };
    }
  }

  /**
   * Get news for a specific game from Steam (public API, no key required)
   */
  async getNewsForApp(appId: number, count: number = 15): Promise<Array<{ gid: string; title: string; url: string; author: string; feedlabel: string; date: number; contents: string }>> {
    const cacheKey = `news-${appId}-${count}`;
    const cached = this.cache.get<Array<{ gid: string; title: string; url: string; author: string; feedlabel: string; date: number; contents: string }>>(cacheKey);
    if (cached) return cached;

    const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=${count}&format=json`;

    try {
      const response = await this.rateLimiter.execute(async () => {
        logger.log(`[Steam] Fetching news for appId: ${appId}`);
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Steam News API error: ${res.status}`);
        return res.json();
      });

      const items = response?.appnews?.newsitems;
      if (!Array.isArray(items)) return [];

      // Blocklist: non-English / irrelevant news feeds
      const BLOCKED_FEEDS = ['gamemag.ru', 'gamemag'];

      const news = items
        .map((item: Record<string, unknown>) => ({
          gid: String(item.gid ?? ''),
          title: String(item.title ?? ''),
          url: String(item.url ?? ''),
          author: String(item.author ?? ''),
          feedlabel: String(item.feedlabel ?? ''),
          date: Number(item.date ?? 0),
          contents: String(item.contents ?? ''),
        }))
        .filter(n => {
          const label = n.feedlabel.toLowerCase();
          const url = n.url.toLowerCase();
          return !BLOCKED_FEEDS.some(b => label.includes(b) || url.includes(b));
        });

      this.cache.set(cacheKey, news, DETAILS_CACHE_TTL);
      logger.log(`[Steam] Got ${news.length} news items for appId: ${appId}`);
      return news;
    } catch (error) {
      logger.error(`[Steam] Error fetching news for ${appId}:`, error);
      return [];
    }
  }

  /**
   * Get current player count for a single game (public API, no key required).
   * Uses ISteamUserStats/GetNumberOfCurrentPlayers/v1.
   *
   * Returns null when the count is unknown: HTTP errors (404 for unknown apps), timeouts and
   * responses without `result: 1`. 0 is only returned when Steam really reports nobody playing.
   * Store pages that play through a shared launcher are counted under that launcher's appid
   * (PLAYER_COUNT_ALIASES); Steam reports a handful of players for the store page itself.
   */
  async getPlayerCount(appId: number): Promise<number | null> {
    const sourceId = PLAYER_COUNT_ALIASES[appId] ?? appId;
    const PLAYER_COUNT_TTL = 5 * 60 * 1000; // 5 minutes
    const UNKNOWN_TTL = 2 * 60 * 1000;

    const cached = this.playerCountCache.get(sourceId);
    if (cached && cached.until > Date.now()) return cached.v;
    const remember = (v: number | null) => {
      if (this.playerCountCache.size > 5000) this.playerCountCache.clear(); // bound memory in long sessions
      this.playerCountCache.set(sourceId, { v, until: Date.now() + (v === null ? UNKNOWN_TTL : PLAYER_COUNT_TTL) });
    };

    try {
      const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${sourceId}&format=json`;
      const result = await this.playerCountLimiter.execute(async () => {
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Player count API error: ${res.status}`);
        return res.json();
      }, `player-count-${sourceId}`);

      const raw = result?.response?.player_count;
      const count = result?.response?.result === 1 && typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      remember(count);
      return count;
    } catch (error) {
      // Unknown/unreleased apps answer 404; network errors are not "0 players".
      void error;
      remember(null);
      return null;
    }
  }

  /**
   * Get current player counts for multiple games in parallel.
   * Returns appId -> playerCount (null = unknown).
   */
  async getMultiplePlayerCounts(appIds: number[]): Promise<Record<number, number | null>> {
    const results = await Promise.all(
      appIds.map(async (id) => {
        const count = await this.getPlayerCount(id);
        return [id, count] as const;
      })
    );
    const map: Record<number, number | null> = {};
    for (const [id, count] of results) {
      map[id] = count;
    }
    return map;
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
    logger.log('[Steam] Cache cleared');
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
    
    logger.log(`[Steam] Got ${Object.keys(result).length}/${appIds.length} cached game names`);
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
      logger.log('[Steam] Prefetch: All games already cached');
      return;
    }

    logger.log(`[Steam] Prefetch: Loading ${uncachedIds.length} games in background...`);
    
    // Low priority fetch - don't await, just fire and forget
    // Process in small batches to not overwhelm the rate limiter
    const batchSize = 5;
    for (let i = 0; i < uncachedIds.length; i += batchSize) {
      const batch = uncachedIds.slice(i, i + batchSize);
      Promise.all(batch.map(appId => this.getAppDetails(appId).catch((err: any) => { logger.warn('[Steam] prefetchGameDetails Non-fatal:', err); return null; })));
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

    logger.log(`[Steam] Getting recommendations for appId: ${currentAppId}`);

    try {
      // 1. Get current game details
      const currentGame = await this.getAppDetails(currentAppId);
      if (!currentGame) {
        logger.log('[Steam] Could not get current game details');
        return [];
      }

      // 2. Build taste profile from current game and library
      const tasteProfile = await this.buildTasteProfile(currentGame, libraryAppIds);
      logger.log('[Steam] Taste profile:', {
        genres: tasteProfile.genres.slice(0, 5),
        categories: tasteProfile.categories.slice(0, 5),
        developers: tasteProfile.developers.slice(0, 3)
      });

      // 3. Get candidate games from various sources
      const candidates = await this.getCandidateGames(tasteProfile, currentAppId, libraryAppIds);
      logger.log(`[Steam] Found ${candidates.length} candidate games`);

      // 4. Score and rank candidates
      const scored = await this.scoreAndRankCandidates(candidates, currentGame, tasteProfile, libraryAppIds);
      
      // 5. Return top results
      const results = scored.slice(0, limit);
      this.cache.set(cacheKey, results, DETAILS_CACHE_TTL);
      
      logger.log(`[Steam] Returning ${results.length} recommendations`);
      return results;
    } catch (error) {
      logger.error('[Steam] Error getting recommendations:', error);
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

    // Add library games with low weight so the current game dominates the profile
    const libraryToFetch = libraryAppIds.slice(0, 5);
    const libraryGames = await Promise.all(
      libraryToFetch.map(id => this.getAppDetails(id).catch((err: any) => { logger.warn('[Steam] buildTasteProfile getAppDetails Non-fatal:', err); return null; }))
    );

    libraryGames.forEach(game => {
      if (game) addGameToProfile(game, 1);
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
   * Get candidate games from various Steam sources.
   * Prioritises game-specific signals: developer, publisher, and top genres.
   */
  private async getCandidateGames(
    tasteProfile: Awaited<ReturnType<typeof this.buildTasteProfile>>,
    excludeAppId: number,
    excludeLibrary: number[]
  ): Promise<number[]> {
    const excludeSet = new Set([excludeAppId, ...excludeLibrary]);
    const candidateSet = new Set<number>();

    const addCandidates = (ids: number[]) => {
      for (const id of ids) {
        if (!excludeSet.has(id)) candidateSet.add(id);
      }
    };

    // 1. Broad sources (top sellers, new releases, most played) — run in parallel
    const [topSellers, newReleases, mostPlayed] = await Promise.all([
      this.getTopSellers().catch((err: any) => { logger.warn('[Steam] getCandidateGames getTopSellers Non-fatal:', err); return []; }),
      this.getNewReleases().catch((err: any) => { logger.warn('[Steam] getCandidateGames getNewReleases Non-fatal:', err); return []; }),
      this.getMostPlayedGames().catch((err: any) => { logger.warn('[Steam] getCandidateGames getMostPlayedGames Non-fatal:', err); return []; })
    ]);

    addCandidates(topSellers.map(g => g.id));
    addCandidates(newReleases.map(g => g.id));
    addCandidates(mostPlayed.map(g => g.appid));

    // 2. Game-specific searches: developer names (up to 2), publisher, and top 2-3 genres
    const searchTerms: string[] = [];

    // Add developer names
    for (const dev of tasteProfile.developers.slice(0, 2)) {
      searchTerms.push(dev);
    }

    // Add publisher (if different from developers)
    for (const pub of tasteProfile.publishers.slice(0, 1)) {
      if (!tasteProfile.developers.includes(pub)) {
        searchTerms.push(pub);
      }
    }

    // Add top 2-3 genre descriptions
    for (const genre of tasteProfile.genres.slice(0, 3)) {
      searchTerms.push(genre.description);
    }

    // Run all game-specific searches in parallel
    const searchPromises = searchTerms.map(term =>
      this.searchGames(term, 50).catch((err: any) => { logger.warn('[Steam] getCandidateGames searchGames Non-fatal:', err); return []; })
    );
    const searchResults = await Promise.all(searchPromises);

    for (const results of searchResults) {
      addCandidates(results.map(g => g.id));
    }

    logger.log(`[Steam] getCandidateGames: ${candidateSet.size} candidates from ${searchTerms.length} searches + broad sources`);
    return Array.from(candidateSet);
  }

  /**
   * Score and rank candidate games based on similarity to the current game.
   * Games that share genres/developer with the current game are strongly favoured.
   */
  private async scoreAndRankCandidates(
    candidateAppIds: number[],
    currentGame: NonNullable<Awaited<ReturnType<typeof this.getAppDetails>>>,
    tasteProfile: Awaited<ReturnType<typeof this.buildTasteProfile>>,
    libraryAppIds: number[]
  ): Promise<Array<{ appId: number; name: string; score: number; reasons: string[] }>> {
    // Limit candidates to avoid too many API calls
    const toScore = candidateAppIds.slice(0, 50);
    const librarySet = new Set(libraryAppIds);
    
    // Fetch details for candidates (many should be cached from getCandidateGames sources)
    const candidateDetails = await Promise.all(
      toScore.map(id => this.getAppDetails(id).catch((err: any) => { logger.warn('[Steam] scoreAndRankCandidates getAppDetails Non-fatal:', err); return null; }))
    );

    const currentGenres = new Set(currentGame.genres?.map(g => g.id) || []);
    const currentCategories = new Set(currentGame.categories?.map(c => c.id) || []);
    const currentDevs = new Set(currentGame.developers || []);
    const currentPubs = new Set(currentGame.publishers || []);

    const profileGenres = new Set(tasteProfile.genres.map(g => g.id));

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

      // Genre match with taste profile (lower weight — profile is dominated by current game)
      const profileGenreOverlap = Array.from(profileGenres).filter(g => candidateGenres.has(g)).length;
      score += profileGenreOverlap * 8;

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

      // De-prioritize games already in the user's library
      if (librarySet.has(candidate.steam_appid)) {
        score = Math.floor(score * 0.5);
      }

      // Require a higher bar: at least one shared genre with the current game,
      // or a strong non-genre signal (same developer/publisher)
      const hasGenreLink = genreOverlap > 0;
      const minScore = hasGenreLink ? 20 : 25;

      if (score >= minScore) {
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

  /**
   * Get full Steam game list (appid + name) for Catalog (A–Z) browsing.
   *
   * Uses IStoreService/GetAppList/v1 (requires API key) which supports:
   *   - Pagination via `last_appid` cursor
   *   - Type filtering (games only — excludes DLCs, software, videos, hardware)
   *   - Up to 50 000 results per page
   *
   * The old ISteamApps/GetAppList/v2 endpoint is now defunct (returns 404).
   *
   * Cached on disk for 24 hours with stale-while-revalidate.
   */
  async getAppList(): Promise<Array<{ appid: number; name: string }>> {
    const cacheKey = 'full-app-list-v2'; // New key — don't read the old stale 143-entry cache
    const APP_LIST_TTL = 24 * 60 * 60 * 1000; // 24 hours

    // Check fresh cache
    const freshCached = this.cache.get<Array<{ appid: number; name: string }>>(cacheKey);
    if (freshCached) {
      logger.log(`[Steam] getAppList: returning fresh cache (${freshCached.length} apps)`);
      return freshCached;
    }

    // Check stale cache — return immediately, refresh in background
    const staleCached = this.cache.get<Array<{ appid: number; name: string }>>(cacheKey, true);
    if (staleCached) {
      logger.log(`[Steam] getAppList: returning stale cache (${staleCached.length} apps), refreshing in background`);
      this.refreshAppList(APP_LIST_TTL).catch(err =>
        logger.warn('[Steam] Background refresh of app list failed:', err)
      );
      return staleCached;
    }

    // No cache — must fetch
    return this.refreshAppList(APP_LIST_TTL);
  }

  /**
   * Paginate through IStoreService/GetAppList/v1 to build the full games list.
   * Each page returns up to 50 000 entries; typically 3-4 pages for ~155k games.
   */
  private async refreshAppList(ttl: number): Promise<Array<{ appid: number; name: string }>> {
    const cacheKey = 'full-app-list-v2';
    const PAGE_SIZE = 50000;
    const allApps: Array<{ appid: number; name: string }> = [];
    let lastAppId: number | undefined;
    let page = 0;

    logger.log('[Steam] Fetching full game list from IStoreService/GetAppList/v1 (paginated)...');

    while (true) {
      page++;
      let url = `${STEAM_WEB_API_BASE}/IStoreService/GetAppList/v1/?key=${steamApiKey()}`
        + `&max_results=${PAGE_SIZE}`
        + `&include_games=true&include_dlc=false&include_software=false&include_videos=false&include_hardware=false`;
      if (lastAppId !== undefined) {
        url += `&last_appid=${lastAppId}`;
      }

      const response = await this.rateLimiter.execute(async () => {
        logger.log(`[Steam] getAppList page ${page}${lastAppId ? ` (after appid ${lastAppId})` : ''}...`);
        // 50k-entry pages: the timeout now covers the whole download, so give slow links room
        const res = await fetchWithTimeout(url, 120_000);
        if (!res.ok) throw new Error(`Steam IStoreService API error: ${res.status}`);
        return res.json() as Promise<{
          response: {
            apps: Array<{ appid: number; name: string; last_modified: number; price_change_number: number }>;
            have_more_results?: boolean;
            last_appid?: number;
          };
        }>;
      });

      const pageApps = response.response?.apps || [];
      for (const app of pageApps) {
        if (app.name && app.name.trim().length > 0) {
          allApps.push({ appid: app.appid, name: app.name });
        }
      }

      logger.log(`[Steam] getAppList page ${page}: ${pageApps.length} entries (${allApps.length} total so far)`);

      if (!response.response?.have_more_results) break;
      lastAppId = response.response.last_appid;
      if (!lastAppId) break; // Safety: avoid infinite loop
    }

    // Sort by name (A–Z) for catalog browsing
    allApps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    logger.log(`[Steam] getAppList: complete — ${allApps.length} games fetched and sorted`);
    this.cache.set(cacheKey, allApps, ttl);
    return allApps;
  }

  /**
   * Fetch rich metadata for a batch of app IDs via IStoreBrowseService/GetItems/v1.
   * Used by the catalog sync to download game data in batches of ~200.
   * No API key required for this endpoint, but runs main-process-side to avoid CORS.
   */
  async fetchCatalogBatch(appIds: number[]): Promise<any[]> {
    const inputJson = JSON.stringify({
      ids: appIds.map(id => ({ appid: id })),
      context: { language: 'english', country_code: 'US' },
      data_request: {
        include_assets: false,
        include_release: true,
        include_platforms: true,
        include_all_purchase_options: false,
        include_screenshots: false,
        include_trailers: false,
        include_ratings: true,
        include_tag_count: 20,
        include_reviews: true,
        include_basic_info: true,
        include_supported_languages: false,
      },
    });
    const url = `${STEAM_WEB_API_BASE}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(inputJson)}`;
    // Shared throttle for all catalog batches (see catalogSlot): at most CATALOG_MAX_INFLIGHT
    // requests, and a 429 pauses EVERY batch once (Retry-After, else an escalating pause)
    // instead of each worker sleeping and then retrying in lockstep. Two attempts here; the
    // renderer's retry round / next-sync resume handle what's left.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; ; attempt++) {
      const release = await this.catalogSlot();
      let failure: string;
      try {
        const res = await fetchWithTimeout(url, 15000);
        if (res.ok) {
          const data = await res.json() as { response?: { store_items?: any[] } };
          this.catalog429Streak = 0;
          return data.response?.store_items ?? [];
        }
        failure = `IStoreBrowseService ${res.status}`;
        if (res.status === 429) {
          this.catalog429Streak++;
          const retryAfterSec = Number(res.headers.get('retry-after'));
          const pauseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 60_000)
            : Math.min(5_000 * 2 ** (this.catalog429Streak - 1), 60_000);
          this.catalogPausedUntil = Math.max(this.catalogPausedUntil, Date.now() + pauseMs);
          logger.warn(`[Steam] Catalog batch rate-limited (429, streak ${this.catalog429Streak}) — pausing catalog requests ${Math.round(pauseMs / 1000)}s`);
        } else if (res.status < 500) {
          throw new Error(failure); // other 4xx: Steam rejects the request itself — not retryable
        }
      } catch (err) {
        if (err instanceof Error && /IStoreBrowseService 4\d\d/.test(err.message)) throw err;
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        release();
      }
      if (attempt >= MAX_ATTEMPTS) throw new Error(failure);
      logger.warn(`[Steam] Catalog batch attempt ${attempt}/${MAX_ATTEMPTS} failed (${failure}) — retrying`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  /** Concurrency + shared 429 pause for catalog batches. Resolves with a release function. */
  private async catalogSlot(): Promise<() => void> {
    while (this.catalogInFlight >= CATALOG_MAX_INFLIGHT) {
      await new Promise<void>((r) => this.catalogWaiters.push(r));
    }
    this.catalogInFlight++;
    const wait = this.catalogPausedUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.catalogInFlight--;
      this.catalogWaiters.shift()?.();
    };
  }

  /**
   * Fetch the full Steam tag list (tagid → name) from IStoreService/GetTagList/v1.
   * Cached on disk for 7 days — tags rarely change.
   */
  async getTagList(): Promise<Array<{ tagid: number; name: string }>> {
    const cacheKey = 'steam-tag-list';
    const TAG_TTL = 7 * 24 * 60 * 60 * 1000;

    const cached = this.cache.get<Array<{ tagid: number; name: string }>>(cacheKey);
    if (cached) {
      logger.log(`[Steam] getTagList: returning cache (${cached.length} tags)`);
      return cached;
    }

    const url = `${STEAM_WEB_API_BASE}/IStoreService/GetTagList/v1/?key=${steamApiKey()}&language=english`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`GetTagList API error: ${res.status}`);
    const data = await res.json() as { response?: { tags?: Array<{ tagid: number; name: string }> } };
    const tags = data.response?.tags ?? [];

    logger.log(`[Steam] getTagList: fetched ${tags.length} tags`);
    if (tags.length > 0) this.cache.set(cacheKey, tags, TAG_TTL); // never cache an empty list for 7 days
    return tags;
  }

  /** Synchronously flush the disk cache (for use in before-quit). */
  flushCache(): void {
    this.cache.flushSync();
  }
}

// Export singleton instance
export const steamAPI = new SteamAPIClient();

