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
function steamApiKey() { return (process.env.STEAM_API_KEY || '').trim(); }
const STEAM_WEB_API_BASE = 'https://api.steampowered.com';

/**
 * Build a Steam Web API URL. The `key` param is added only when a key is set — a packaged build
 * can ship without one (the key is extractable from the installer, so it may be withheld), and
 * `key=` with an empty value is rejected by Steam where an absent key is not.
 */
export function steamWebApiUrl(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined> = {},
  key: string = steamApiKey(),
): string {
  const qs = new URLSearchParams();
  if (key) qs.set('key', key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${STEAM_WEB_API_BASE}/${endpoint.replace(/^\/+/, '')}${q ? `?${q}` : ''}`;
}

/** True when a Steam Web API key is configured (IStoreService list/tag calls need one). */
export function hasSteamApiKey(): boolean {
  return steamApiKey().length > 0;
}
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

export interface RateLimiterOptions {
  /** Minimum spacing between request starts (ms). */
  delay?: number;
  /** Requests running at once. */
  maxConcurrent?: number;
  /** Waiting requests before new ones are rejected. */
  maxQueue?: number;
}

/**
 * Concurrency + spacing limiter. A slot is taken synchronously in execute() and the start time
 * is reserved synchronously too (nextSlot), so calls made in the same tick queue up instead of
 * all passing the "is a slot free?" check together — the old limiter only counted a request as
 * active after its spacing wait, so a 200-id sweep fired ~200 requests at once.
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private activeRequests = 0;
  /** Earliest time the next request may start. */
  private nextSlot = 0;
  private readonly delay: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  /** In-flight promise cache keyed by dedup key — collapses identical requests */
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: RateLimiterOptions = {}) {
    this.delay = opts.delay ?? RATE_LIMIT_DELAY;
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_REQUESTS;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE_SIZE;
  }

  /**
   * Execute a rate-limited request.
   * @param fn - The async function to execute
   * @param dedupKey - Optional dedup key; if provided, concurrent calls with the
   *                   same key share one in-flight promise (promise coalescing).
   */
  execute<T>(fn: () => Promise<T>, dedupKey?: string): Promise<T> {
    // Promise coalescing — reuse an existing in-flight request for the same key
    if (dedupKey) {
      const existing = this.inFlight.get(dedupKey) as Promise<T> | undefined;
      if (existing) return existing;
    }

    const promise = new Promise<T>((resolve, reject) => {
      // Runs with its slot already counted in activeRequests.
      const task = async () => {
        try {
          const start = Math.max(Date.now(), this.nextSlot);
          this.nextSlot = start + this.delay;
          const wait = start - Date.now();
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
          resolve(await fn());
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests--;
          this.processQueue();
        }
      };

      if (this.activeRequests < this.maxConcurrent) {
        this.activeRequests++;
        void task();
      } else if (this.queue.length >= this.maxQueue) {
        // Reject immediately if queue is at capacity to prevent memory bloat
        reject(new Error('Rate limiter queue full'));
      } else {
        this.queue.push(task);
      }
    });

    // Register in-flight promise for dedup
    if (dedupKey) {
      this.inFlight.set(dedupKey, promise);
      const clear = () => { this.inFlight.delete(dedupKey); };
      promise.then(clear, clear);
    }

    return promise;
  }

  private processQueue() {
    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const nextTask = this.queue.shift()!;
      this.activeRequests++;
      nextTask();
    }
  }

  /** Requests currently running (for tests and diagnostics). */
  getActiveCount(): number {
    return this.activeRequests;
  }

  getQueueSize(): number {
    return this.queue.length;
  }
}

// PersistentCache — imported from shared module
import { PersistentCache } from './persistent-cache.js';
import { logger } from './safe-logger.js';
import { SteamAppListStore, type AppListEntry } from './steam-applist-store.js';
import { atomicWriteFile } from './safe-write.js';
import * as fs from 'fs';
import * as path from 'path';
import { titleCollator } from '../src/lib/title-collator.js';

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

/** Player-count limiter config: the public counts endpoint tolerates far more than appdetails. */
export const PLAYER_COUNT_LIMITER_OPTIONS: Readonly<Required<RateLimiterOptions>> = {
  delay: 25,
  maxConcurrent: 8,
  maxQueue: 1000,
};

/** Uncached appdetails fetched per recommendation run; the rest are scored once cached. */
export const RECO_MAX_UNCACHED_FETCHES = 10;

/** Outcome of an appdetails lookup that callers can tell apart (see getAppDetailsWithStatus). */
export type AppDetailsStatus = 'ok' | 'not_found' | 'rate_limited' | 'error';

type Recommendation = { appId: number; name: string; score: number; reasons: string[] };

/** The subset of PersistentCache the client uses (tests pass an in-memory one). */
export type SteamCacheLike = Pick<PersistentCache, 'get' | 'set' | 'has' | 'delete' | 'clear' | 'getStats' | 'flushSync'>;

/** Where the full app list is stored (tests pass an in-memory SteamAppListStore). */
export type AppListStoreLike = Pick<SteamAppListStore, 'load' | 'save'>;

export interface SteamAPIClientDeps {
  fetch?: (url: string, timeoutMs?: number) => Promise<Response>;
  cache?: SteamCacheLike;
  appListStore?: AppListStoreLike;
}

/** Names that are not base games, dropped from the broad candidate lists before scoring. */
const NON_GAME_NAME = /\b(dlc|soundtrack|ost|demo|season pass|artbook|expansion pack)\b/i;

/** Recommendation candidates by source, highest-signal first (see buildRecommendationCandidates). */
export interface RecommendationCandidateBuckets {
  /** Current game + library ids — never candidates. */
  exclude: number[];
  /** Store-search hits for the current game's developers / publisher. */
  creator: number[];
  /** Store-search hits for its top genres. */
  genre: number[];
  topSellers: number[];
  newReleases: number[];
  mostPlayed: number[];
}

/**
 * Ordered, deduped list of ids to score: up to ~15 developer/publisher matches, then up to ~15
 * genre matches, then top sellers / new releases / most played alternated to fill `total`.
 * The old flat `slice(0, 50)` kept only the chart games (they were added first), so the
 * game-specific search hits were never scored.
 */
export function buildRecommendationCandidates(
  b: RecommendationCandidateBuckets,
  opts: { total?: number; perSearchBucket?: number } = {},
): number[] {
  const total = opts.total ?? 50;
  const perSearch = opts.perSearchBucket ?? 15;
  const excluded = new Set(b.exclude);
  const seen = new Set<number>();
  const out: number[] = [];
  const take = (id: number) => {
    if (out.length >= total || excluded.has(id) || seen.has(id) || !Number.isFinite(id)) return false;
    seen.add(id);
    out.push(id);
    return true;
  };
  for (const list of [b.creator, b.genre]) {
    let n = 0;
    for (const id of list) {
      if (n >= perSearch) break;
      if (take(id)) n++;
    }
  }
  const broad = [b.topSellers, b.newReleases, b.mostPlayed];
  const longest = Math.max(0, ...broad.map(l => l.length));
  for (let i = 0; i < longest && out.length < total; i++) {
    for (const list of broad) if (i < list.length) take(list[i]);
  }
  return out;
}

export class SteamAPIClient {
  private rateLimiter = new RateLimiter();
  /**
   * Player counts (api.steampowered.com) get their own limiter so a Browse sweep never queues
   * appdetails / reviews / search (store.steampowered.com) behind it, and their own in-memory cache:
   * writing hundreds of short-lived counts into the persistent cache rewrote steam-cache.json (which
   * holds the full app list) on every sweep and evicted real appdetails entries.
   */
  private playerCountLimiter = new RateLimiter(PLAYER_COUNT_LIMITER_OPTIONS);
  private playerCountCache = new Map<number, { v: number | null; until: number }>();
  private cache: SteamCacheLike;
  private fetchWithTimeout: (url: string, timeoutMs?: number) => Promise<Response>;
  /** Full app list — its own file (steam-applist.json), not part of steam-cache.json. */
  private appListStore: AppListStoreLike | null;
  /** Shared refresh so concurrent getAppList callers download the ~155k list once. */
  private appListRefresh: Promise<AppListEntry[]> | null = null;

  constructor(deps: SteamAPIClientDeps = {}) {
    this.cache = deps.cache ?? new Cache('steam-cache.json');
    this.fetchWithTimeout = deps.fetch ?? fetchWithTimeout;
    this.appListStore = deps.appListStore ?? null;
  }
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
    // Works without a key; steamWebApiUrl omits the param when none is set.
    const url = steamWebApiUrl('ISteamChartsService/GetMostPlayedGames/v1/');
    
    const response = await this.rateLimiter.execute(async () => {
      logger.log('[Steam] Fetching fresh most played games...');
      const res = await this.fetchWithTimeout(url);
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
        const res = await this.fetchWithTimeout(url, 15000);
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
    return (await this.fetchAppDetailsWithStatus(appId)).data;
  }

  /** True while the appdetails 429 circuit is open. */
  isAppDetailsPaused(): boolean {
    return Date.now() < this.appDetailsPausedUntil;
  }

  /**
   * getAppDetails plus why it came back empty, so the details page can tell a delisted game
   * ('not_found': Steam answered success:false) from a temporary failure ('rate_limited' while
   * the 429 pause is active, 'error' for network/HTTP failures). Cached data (fresh or stale)
   * is 'ok'. getAppDetails keeps returning plain null for its existing callers.
   */
  async getAppDetailsWithStatus(appId: number): Promise<{ data: SteamAppDetails['data'] | null; status: AppDetailsStatus }> {
    const cacheKey = `app-details-${appId}`;
    const fresh = this.cache.get<SteamAppDetails['data']>(cacheKey);
    if (fresh) return { data: fresh, status: 'ok' };
    const stale = this.cache.get<SteamAppDetails['data']>(cacheKey, true);
    if (stale) {
      this.refreshAppDetails(appId).catch(err => logger.warn(`[Steam] Background refresh for ${appId} failed:`, err));
      return { data: stale, status: 'ok' };
    }
    return this.fetchAppDetailsWithStatus(appId);
  }

  private async fetchAppDetailsWithStatus(appId: number): Promise<{ data: SteamAppDetails['data'] | null; status: AppDetailsStatus }> {
    const cacheKey = `app-details-${appId}`;
    const url = `${STEAM_STORE_API_BASE}/appdetails?appids=${appId}&cc=in&l=english`;
    // While Steam is answering 429, don't queue more appdetails calls behind the limiter —
    // every one would wait its turn only to be rejected, starving browse/Oracle/Similar Games.
    if (this.isAppDetailsPaused()) return { data: null, status: 'rate_limited' };

    try {
      const response = await this.rateLimiter.execute(async () => {
        if (this.isAppDetailsPaused()) throw new Error('Steam appdetails paused after 429');
        const res = await this.fetchWithTimeout(url);
        if (res.status === 429) {
          const retryAfterSec = Number(res.headers.get('retry-after'));
          const pauseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 5 * 60_000) : 60_000;
          this.appDetailsPausedUntil = Date.now() + pauseMs;
          logger.warn(`[Steam] appdetails rate-limited (429) — pausing appdetails for ${Math.round(pauseMs / 1000)}s`);
        }
        if (!res.ok) throw new Error(`Steam Store API error: ${res.status}`);
        return res.json() as Promise<{ [key: string]: SteamAppDetails }>;
      }, `appdetails-${appId}`);

      const appData = response?.[appId.toString()];
      if (appData?.success && appData.data) {
        this.cache.set(cacheKey, appData.data, DETAILS_CACHE_TTL);
        return { data: appData.data, status: 'ok' };
      }
      return { data: null, status: 'not_found' };
    } catch (error) {
      logger.error(`[Steam] Error fetching app details for ${appId}:`, error);
      return { data: null, status: this.isAppDetailsPaused() ? 'rate_limited' : 'error' };
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
        const res = await this.fetchWithTimeout(url);
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
        const res = await this.fetchWithTimeout(url);
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
        const res = await this.fetchWithTimeout(url);
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
        const res = await this.fetchWithTimeout(url);
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
        const res = await this.fetchWithTimeout(url);
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
  ): Promise<Recommendation[]> {
    // The full scored list is cached (key without `limit`) and sliced on read, so a 3-result
    // answer is never reused for a 10-result request.
    const cacheKey = `recommendations-v2-${currentAppId}-${libraryAppIds.slice(0, 5).join('-')}`;
    const cached = this.cache.get<Recommendation[]>(cacheKey);
    if (cached) return cached.slice(0, limit);

    logger.log(`[Steam] Getting recommendations for appId: ${currentAppId}`);
    const runStartedAt = Date.now();

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
      const buckets = await this.getCandidateGames(tasteProfile, currentAppId, libraryAppIds);
      const toScore = buildRecommendationCandidates(buckets);
      logger.log(`[Steam] Scoring ${toScore.length} candidate games`);

      // 4. Score and rank candidates
      const { scored, fetched, failed } = await this.scoreAndRankCandidates(toScore, currentGame, tasteProfile, libraryAppIds);

      // 5. Cache the full list unless the run was degraded: nothing scored, the 429 pause was
      //    active at some point during the run, or most of the details we fetched came back empty.
      const degraded = scored.length === 0
        || this.appDetailsPausedUntil > runStartedAt
        || (fetched > 0 && failed > fetched / 2);
      if (!degraded) this.cache.set(cacheKey, scored, DETAILS_CACHE_TTL);

      const results = scored.slice(0, limit);
      logger.log(`[Steam] Returning ${results.length} recommendations${degraded ? ' (not cached: degraded run)' : ''}`);
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
  ): Promise<RecommendationCandidateBuckets> {
    const exclude = [excludeAppId, ...excludeLibrary];
    const broadIds = (items: Array<{ id: number; name?: string }>) =>
      items.filter(g => !g.name || !NON_GAME_NAME.test(g.name)).map(g => g.id);

    // 1. Broad sources (top sellers, new releases, most played) — run in parallel
    const [topSellers, newReleases, mostPlayed] = await Promise.all([
      this.getTopSellers().catch((err: any) => { logger.warn('[Steam] getCandidateGames getTopSellers Non-fatal:', err); return []; }),
      this.getNewReleases().catch((err: any) => { logger.warn('[Steam] getCandidateGames getNewReleases Non-fatal:', err); return []; }),
      this.getMostPlayedGames().catch((err: any) => { logger.warn('[Steam] getCandidateGames getMostPlayedGames Non-fatal:', err); return []; })
    ]);

    // 2. Game-specific searches: developer names (up to 2), publisher, and top 2-3 genres.
    //    Kept in separate buckets so they are scored before the generic chart games.
    const creatorTerms: string[] = [...tasteProfile.developers.slice(0, 2)];
    for (const pub of tasteProfile.publishers.slice(0, 1)) {
      if (!tasteProfile.developers.includes(pub)) creatorTerms.push(pub);
    }
    const genreTerms = tasteProfile.genres.slice(0, 3).map(g => g.description);

    const search = (term: string) =>
      this.searchGames(term, 50).catch((err: any) => { logger.warn('[Steam] getCandidateGames searchGames Non-fatal:', err); return []; });
    const [creatorResults, genreResults] = await Promise.all([
      Promise.all(creatorTerms.map(search)),
      Promise.all(genreTerms.map(search)),
    ]);

    // Interleave per-term results so one prolific developer doesn't take every creator slot.
    const interleave = (lists: Array<Array<{ id: number }>>) => {
      const out: number[] = [];
      const longest = Math.max(0, ...lists.map(l => l.length));
      for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i].id);
      return out;
    };

    const buckets: RecommendationCandidateBuckets = {
      exclude,
      creator: interleave(creatorResults),
      genre: interleave(genreResults),
      topSellers: broadIds(topSellers),
      newReleases: broadIds(newReleases),
      mostPlayed: mostPlayed.map(g => g.appid),
    };
    logger.log(`[Steam] getCandidateGames: ${buckets.creator.length} creator, ${buckets.genre.length} genre, ${buckets.topSellers.length + buckets.newReleases.length + buckets.mostPlayed.length} broad`);
    return buckets;
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
  ): Promise<{ scored: Recommendation[]; fetched: number; failed: number }> {
    const librarySet = new Set(libraryAppIds);

    // Cached candidates (fresh or stale) are scored as-is, without starting background
    // refreshes; at most RECO_MAX_UNCACHED_FETCHES uncached ones are fetched per run (in
    // candidate priority order) so one "what should I play?" no longer bursts ~60 appdetails
    // calls into a 429. Later runs fetch the next uncached ones.
    const candidateDetails: Array<SteamAppDetails['data'] | null> = [];
    const toFetch: number[] = [];
    for (const id of candidateAppIds) {
      const cached = this.cache.get<SteamAppDetails['data']>(`app-details-${id}`, true);
      if (cached) candidateDetails.push(cached);
      else if (toFetch.length < RECO_MAX_UNCACHED_FETCHES) toFetch.push(id);
    }
    const fetchedDetails = await Promise.all(
      toFetch.map(id => this.refreshAppDetails(id).catch((err: any) => { logger.warn('[Steam] scoreAndRankCandidates getAppDetails Non-fatal:', err); return null; }))
    );
    const failed = fetchedDetails.filter(d => !d).length;
    candidateDetails.push(...fetchedDetails);

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

    return { scored, fetched: toFetch.length, failed };
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
   * Stored in steam-applist.json (see steam-applist-store.ts): fresh for 24 hours, then
   * served stale while a background refresh runs.
   */
  async getAppList(): Promise<Array<{ appid: number; name: string }>> {
    const APP_LIST_TTL = 24 * 60 * 60 * 1000; // 24 hours

    const stored = await this.getAppListStore().load();
    if (stored && stored.apps.length > 0) {
      if (Date.now() - stored.savedAt <= APP_LIST_TTL) {
        logger.log(`[Steam] getAppList: returning fresh list (${stored.apps.length} apps)`);
        return stored.apps;
      }
      // Stale — return immediately, refresh in background
      logger.log(`[Steam] getAppList: returning stale list (${stored.apps.length} apps), refreshing in background`);
      this.refreshAppListOnce().catch(err =>
        logger.warn('[Steam] Background refresh of app list failed:', err)
      );
      return stored.apps;
    }

    // Nothing stored — must fetch
    return this.refreshAppListOnce();
  }

  private getAppListStore(): AppListStoreLike {
    return this.appListStore ??= new SteamAppListStore({
      filePath: path.join(electron?.app?.getPath?.('userData') || './cache', 'steam-applist.json'),
      readFile: (p) => fs.promises.readFile(p, 'utf-8'),
      writeFile: (p, d) => new Promise<void>((resolve, reject) =>
        atomicWriteFile(p, d, (err) => (err ? reject(err) : resolve()))),
      legacy: this.cache,
      now: () => Date.now(),
    });
  }

  /** Concurrent callers (and stale-hit background refreshes) share one paginated download. */
  private refreshAppListOnce(): Promise<AppListEntry[]> {
    return this.appListRefresh ??= this.refreshAppList().finally(() => { this.appListRefresh = null; });
  }

  /**
   * Paginate through IStoreService/GetAppList/v1 to build the full games list.
   * Each page returns up to 50 000 entries; typically 3-4 pages for ~155k games.
   */
  private async refreshAppList(): Promise<Array<{ appid: number; name: string }>> {
    const PAGE_SIZE = 50000;
    const allApps: Array<{ appid: number; name: string }> = [];
    let lastAppId: number | undefined;
    let page = 0;

    // IStoreService requires a key: without one, skip the request (it would only 403) and return
    // an empty list that is not cached, so a later build/launch with a key fetches normally.
    if (!hasSteamApiKey()) {
      logger.warn('[Steam] getAppList: no STEAM_API_KEY configured — full app list unavailable');
      return [];
    }

    logger.log('[Steam] Fetching full game list from IStoreService/GetAppList/v1 (paginated)...');

    while (true) {
      page++;
      const url = steamWebApiUrl('IStoreService/GetAppList/v1/', {
        max_results: PAGE_SIZE,
        include_games: true,
        include_dlc: false,
        include_software: false,
        include_videos: false,
        include_hardware: false,
        last_appid: lastAppId,
      });

      const response = await this.rateLimiter.execute(async () => {
        logger.log(`[Steam] getAppList page ${page}${lastAppId ? ` (after appid ${lastAppId})` : ''}...`);
        // 50k-entry pages: the timeout now covers the whole download, so give slow links room
        const res = await this.fetchWithTimeout(url, 120_000);
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
    // (shared collator: options-form localeCompare built a collator per compare, ~19 s for 155k)
    allApps.sort((a, b) => titleCollator.compare(a.name, b.name));

    logger.log(`[Steam] getAppList: complete — ${allApps.length} games fetched and sorted`);
    await this.getAppListStore().save(allApps);
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
        const res = await this.fetchWithTimeout(url, 15000);
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
        // No DNS / no route: a second try 2 s later fails the same way (the offline run paid it for every batch)
        if (/ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|CONNECTION_REFUSED)|ENOTFOUND|EAI_AGAIN/.test(failure)) throw new Error(failure);
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

    if (!hasSteamApiKey()) {
      logger.warn('[Steam] getTagList: no STEAM_API_KEY configured — tag list unavailable');
      return [];
    }
    const url = steamWebApiUrl('IStoreService/GetTagList/v1/', { language: 'english' });
    const res = await this.fetchWithTimeout(url);
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

