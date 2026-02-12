/**
 * Epic Games Store API Client
 *
 * Uses the public Epic Games GraphQL API (no authentication required).
 * Implements rate limiting and persistent caching with stale-while-revalidate,
 * mirroring the patterns established in steam-api.ts.
 *
 * Key endpoints:
 *  - GraphQL: https://store.epicgames.com/graphql (catalog queries)
 *    Fallback: https://www.epicgames.com/graphql
 *  - REST: https://store-site-backend-static.ak.epicgames.com (promotions / free games)
 */

import electron from 'electron';
import { PersistentCache } from './persistent-cache.js';

// ---------------------------------------------------------------------------
// Rate Limiter (conservative for Epic/Cloudflare)
// ---------------------------------------------------------------------------

const RATE_LIMIT_DELAY = 300; // ms between requests
const MAX_CONCURRENT = 2;

class RateLimiter {
  private queue: Array<() => void> = [];
  private active = 0;
  private lastRequestTime = 0;

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  release(): void {
    this.active--;
    this.processQueue();
  }

  private processQueue(): void {
    if (this.queue.length === 0 || this.active >= MAX_CONCURRENT) return;

    const now = Date.now();
    const waitTime = Math.max(0, RATE_LIMIT_DELAY - (now - this.lastRequestTime));

    setTimeout(() => {
      if (this.queue.length === 0) return;
      this.active++;
      this.lastRequestTime = Date.now();
      const resolve = this.queue.shift()!;
      resolve();
    }, waitTime);
  }
}

// ---------------------------------------------------------------------------
// Genre tag mapping (Epic uses numeric tag IDs)
// ---------------------------------------------------------------------------

export const EPIC_GENRE_MAP: Record<number, string> = {
  1216: 'Action',
  1117: 'Adventure',
  1367: 'RPG',
  1115: 'Strategy',
  1128: 'Simulation',
  1210: 'Sports',
  1159: 'Racing',
  1298: 'Puzzle',
  1307: 'Indie',
  1264: 'Casual',
  21122: 'Shooter',
  21725: 'Horror',
  1336: 'Fighting',
  21894: 'Platformer',
  1182: 'Open World',
  21141: 'Survival',
  1252: 'Stealth',
  9547: 'Turn-Based',
  21668: 'Roguelike',
  17187: 'Card Game',
  1183: 'Music',
  1185: 'Party',
  21140: 'City Builder',
  1178: 'Tower Defense',
  1100: 'MMO',
  21118: 'Hack and Slash',
  21137: 'Sandbox',
  21139: 'Dungeon Crawler',
  21138: 'Metroidvania',
  21135: 'Narrative',
  21127: 'Visual Novel',
  21136: 'Battle Royale',
  21134: 'Souls-like',
  21142: 'RTS',
};

// ---------------------------------------------------------------------------
// Image URL resolution (from Epic's keyImages array)
// ---------------------------------------------------------------------------

const IMAGE_TYPE_PRIORITY = [
  'DieselStoreFrontWide',
  'OfferImageWide',
  'Thumbnail',
  'DieselStoreFrontTall',
  'OfferImageTall',
  'DieselGameBoxTall',
  'DieselGameBox',
  'CodeRedemption_340x440',
];

export interface EpicKeyImage {
  type: string;
  url: string;
  md5?: string;
  width?: number;
  height?: number;
}

export function resolveEpicImage(keyImages: EpicKeyImage[] | undefined, preferTall: boolean = false): string | undefined {
  if (!keyImages || keyImages.length === 0) return undefined;

  // If preferTall, reorder priority to favor tall images
  const priority = preferTall
    ? ['DieselStoreFrontTall', 'OfferImageTall', 'DieselGameBoxTall', 'DieselGameBox', ...IMAGE_TYPE_PRIORITY]
    : IMAGE_TYPE_PRIORITY;

  for (const type of priority) {
    const img = keyImages.find(i => i.type === type);
    if (img?.url) return img.url;
  }

  // Fallback: return first available image
  return keyImages[0]?.url;
}

// ---------------------------------------------------------------------------
// Epic Catalog Item interface (raw API response shape)
// ---------------------------------------------------------------------------

export interface EpicCatalogItem {
  namespace: string;
  id: string; // offerId
  title: string;
  description?: string;
  longDescription?: string;
  keyImages?: EpicKeyImage[];
  categories?: Array<{ path: string }>;
  tags?: Array<{ id: number; name?: string }>;
  effectiveDate?: string;
  developer?: string;
  publisher?: string;
  seller?: { name: string };
  urlSlug?: string;
  url?: string;
  productSlug?: string;
  offerMappings?: Array<{ pageSlug: string; pageType: string }>;
  catalogNs?: { mappings?: Array<{ pageSlug: string; pageType: string }> };
  price?: {
    totalPrice: {
      discountPrice: number;
      originalPrice: number;
      fmtPrice: {
        originalPrice: string;
        discountPrice: string;
        intermediatePrice: string;
      };
    };
  };
  promotions?: {
    promotionalOffers: Array<{
      promotionalOffers: Array<{
        startDate: string;
        endDate: string;
        discountSetting: { discountType: string; discountPercentage: number };
      }>;
    }>;
    upcomingPromotionalOffers: Array<{
      promotionalOffers: Array<{
        startDate: string;
        endDate: string;
        discountSetting: { discountType: string; discountPercentage: number };
      }>;
    }>;
  };
  customAttributes?: Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const SEARCH_STORE_QUERY = `
query searchStoreQuery($keyword: String!, $count: Int, $locale: String, $country: String!) {
  Catalog {
    searchStore(
      keywords: $keyword
      count: $count
      locale: $locale
      country: $country
      category: "games/edition/base|bundles/games|editors|software/edition/base"
      sortBy: "relevancy"
      sortDir: "DESC"
    ) {
      elements {
        namespace
        id
        title
        description
        keyImages {
          type
          url
        }
        categories {
          path
        }
        tags {
          id
          name
        }
        effectiveDate
        developer
        url
        urlSlug
        productSlug
        offerMappings {
          pageSlug
          pageType
        }
        catalogNs {
          mappings(pageType: "productHome") {
            pageSlug
            pageType
          }
        }
        seller {
          name
        }
        price(country: $country) {
          totalPrice {
            discountPrice
            originalPrice
            fmtPrice {
              originalPrice
              discountPrice
              intermediatePrice
            }
          }
        }
        promotions {
          promotionalOffers {
            promotionalOffers {
              startDate
              endDate
              discountSetting {
                discountType
                discountPercentage
              }
            }
          }
          upcomingPromotionalOffers {
            promotionalOffers {
              startDate
              endDate
              discountSetting {
                discountType
                discountPercentage
              }
            }
          }
        }
      }
    }
  }
}`;

const CATALOG_QUERY = `
query catalogQuery($namespace: String!, $id: String!, $locale: String, $country: String!) {
  Catalog {
    catalogOffer(namespace: $namespace, id: $id, locale: $locale) {
      namespace
      id
      title
      description
      longDescription
      keyImages {
        type
        url
      }
      categories {
        path
      }
      tags {
        id
        name
      }
      effectiveDate
      developer
      url
      urlSlug
      productSlug
      offerMappings {
        pageSlug
        pageType
      }
      catalogNs {
        mappings(pageType: "productHome") {
          pageSlug
          pageType
        }
      }
      seller {
        name
      }
      customAttributes {
        key
        value
      }
      price(country: $country) {
        totalPrice {
          discountPrice
          originalPrice
          fmtPrice {
            originalPrice
            discountPrice
            intermediatePrice
          }
        }
      }
    }
  }
}`;

const BROWSE_STORE_QUERY = `
query browseStoreQuery($count: Int, $start: Int, $locale: String, $country: String!, $sortBy: String, $sortDir: String, $releaseDate: String) {
  Catalog {
    searchStore(
      count: $count
      start: $start
      locale: $locale
      country: $country
      category: "games/edition/base"
      sortBy: $sortBy
      sortDir: $sortDir
      releaseDate: $releaseDate
    ) {
      elements {
        namespace
        id
        title
        description
        keyImages {
          type
          url
        }
        categories {
          path
        }
        tags {
          id
          name
        }
        effectiveDate
        developer
        url
        urlSlug
        productSlug
        offerMappings {
          pageSlug
          pageType
        }
        catalogNs {
          mappings(pageType: "productHome") {
            pageSlug
            pageType
          }
        }
        seller {
          name
        }
        price(country: $country) {
          totalPrice {
            discountPrice
            originalPrice
            fmtPrice {
              originalPrice
              discountPrice
              intermediatePrice
            }
          }
        }
      }
      paging {
        count
        total
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Cache TTLs
// ---------------------------------------------------------------------------

const CACHE_TTL = 5 * 60 * 1000;           // 5 min for fresh data
const SEARCH_CACHE_TTL = 10 * 60 * 1000;   // 10 min for search results
const RELEASES_CACHE_TTL = 30 * 60 * 1000; // 30 min for release lists
const FREE_GAMES_CACHE_TTL = 60 * 60 * 1000; // 1 hour for free games

// ---------------------------------------------------------------------------
// Epic API Client
// ---------------------------------------------------------------------------

class EpicAPIClient {
  private rateLimiter = new RateLimiter();
  private cache = new PersistentCache('epic-cache.json');

  // Primary and fallback GraphQL endpoints (community-verified, per epicstore_api)
  private readonly GQL_ENDPOINTS = [
    'https://store.epicgames.com/graphql',
    'https://www.epicgames.com/graphql',
  ];
  private readonly FREE_GAMES_ENDPOINT = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

  // Track which endpoint last succeeded so we try it first next time
  private lastWorkingEndpointIndex = 0;

  // Circuit breaker: skip GQL entirely when Cloudflare keeps blocking us.
  // Resets automatically when Cloudflare clearance is obtained.
  private gqlCircuitOpen = false;
  private gqlCircuitOpenedAt = 0;
  private readonly GQL_CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30 min

  // Cloudflare clearance state
  private cfInitialized = false;
  private cfInitPromise: Promise<boolean> | null = null;

  // -----------------------------------------------------------------------
  // Cloudflare challenge solver
  //
  // Epic's GraphQL endpoints sit behind Cloudflare JS challenge.  Neither
  // Node.js `fetch()` nor Electron's `net.fetch()` can solve the challenge
  // because it requires full JavaScript execution.
  //
  // Solution: spin up a hidden BrowserWindow (full Chromium), navigate to
  // the Epic store page.  Chromium renders the CF challenge page, executes
  // the verification JS, and the session receives a `cf_clearance` cookie.
  // Subsequent `net.fetch()` calls with `credentials: 'include'` send that
  // cookie and pass Cloudflare.
  // -----------------------------------------------------------------------

  async initCloudflare(): Promise<boolean> {
    if (this.cfInitialized) return true;
    if (this.cfInitPromise) return this.cfInitPromise;

    this.cfInitPromise = this._solveCloudflare();
    return this.cfInitPromise;
  }

  private async _solveCloudflare(): Promise<boolean> {
    try {
      const { BrowserWindow, session: electronSession } = electron;
      if (!BrowserWindow || !electronSession) return false;

      console.log('[EpicAPI] Solving Cloudflare challenge (hidden browser)...');

      const win = new BrowserWindow({
        show: false,
        width: 400,
        height: 300,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      try {
        // Navigate to Epic store — Chromium will handle the CF JS challenge
        win.loadURL('https://store.epicgames.com/en-US/').catch(() => {});

        // Poll for cf_clearance cookie (set by CF after challenge solved)
        const deadline = Date.now() + 25_000; // 25s max
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1500));

          try {
            const cookies = await electronSession.defaultSession.cookies.get({});
            const hasCf = cookies.some(
              c =>
                (c.name === 'cf_clearance' || c.name === '__cf_bm') &&
                (c.domain || '').includes('epicgames.com'),
            );

            if (hasCf) {
              this.cfInitialized = true;
              this.gqlCircuitOpen = false;
              // Invalidate REST-fallback cache so fresh GQL data is fetched
              this.cache.clear();
              console.log('[EpicAPI] Cloudflare clearance obtained — cache cleared, GraphQL should work now');
              return true;
            }
          } catch {
            // Cookie access failed — continue polling
          }
        }

        console.warn('[EpicAPI] Cloudflare clearance timed out after 25s — REST fallback remains active');
        return false;
      } finally {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch { /* already gone */ }
        this.cfInitPromise = null;
      }
    } catch (err) {
      console.error('[EpicAPI] Cloudflare init error:', (err as Error).message);
      this.cfInitPromise = null;
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Fetch helper — uses Electron net.fetch with CF cookies
  // -----------------------------------------------------------------------

  private async doFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      if (electron?.net?.fetch) {
        // net.fetch uses Chromium's networking stack + session cookies.
        // credentials: 'include' sends cf_clearance and other session cookies.
        return await electron.net.fetch(url, {
          ...(init as any),
          credentials: 'include',
        });
      }
    } catch {
      // net not available (e.g. app not yet ready) — fall through to global fetch
    }
    return fetch(url, init);
  }

  // -----------------------------------------------------------------------
  // GraphQL fetch helper (with retry + fallback endpoint)
  // -----------------------------------------------------------------------

  private async gqlFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Circuit breaker: skip GQL if Cloudflare is blocking us
    if (this.gqlCircuitOpen) {
      // If CF clearance has been obtained, close the circuit and retry
      if (this.cfInitialized) {
        this.gqlCircuitOpen = false;
        console.log('[EpicAPI] Circuit closed — Cloudflare clearance ready, retrying GQL');
      } else if (Date.now() - this.gqlCircuitOpenedAt > this.GQL_CIRCUIT_RESET_MS) {
        this.gqlCircuitOpen = false;
        console.log('[EpicAPI] GQL circuit breaker reset — retrying GraphQL');
      } else {
        // Circuit still open, CF not ready — kick off solver if not running
        if (!this.cfInitPromise) {
          this.initCloudflare().catch(() => {});
        }
        throw new Error('GQL circuit open (Cloudflare blocked — solver running)');
      }
    }

    await this.rateLimiter.acquire();
    try {
      // Try the last-known-good endpoint first, then fall back to the other(s)
      const endpoints = [
        this.GQL_ENDPOINTS[this.lastWorkingEndpointIndex],
        ...this.GQL_ENDPOINTS.filter((_, i) => i !== this.lastWorkingEndpointIndex),
      ];

      let lastError: Error | null = null;

      for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        try {
          const response = await this.doFetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/plain, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Origin': 'https://store.epicgames.com',
              'Referer': 'https://store.epicgames.com/',
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ query, variables }),
          });

          if (!response.ok) {
            // Cloudflare 403 — open the circuit breaker so subsequent calls
            // skip straight to the REST fallback without multi-second delays.
            if (response.status === 403) {
              this.gqlCircuitOpen = true;
              this.gqlCircuitOpenedAt = Date.now();
              console.warn('[EpicAPI] Cloudflare 403 — opening circuit breaker (REST fallback will be used)');
            }
            // Log response body for debugging non-403 errors
            if (response.status !== 403) {
              try {
                const errBody = await response.text();
                console.debug(`[EpicAPI] ${response.status} response body (first 500 chars):`, errBody.slice(0, 500));
              } catch { /* ignore */ }
            }
            throw new Error(`Epic GQL request failed: ${response.status} ${response.statusText}`);
          }

          const json = await response.json();
          if (json.errors && json.errors.length > 0) {
            throw new Error(`Epic GQL error: ${json.errors[0].message}`);
          }

          // Success! Close the circuit breaker and remember the endpoint
          this.gqlCircuitOpen = false;
          const idx = this.GQL_ENDPOINTS.indexOf(endpoint);
          if (idx >= 0) this.lastWorkingEndpointIndex = idx;
          if (i > 0) {
            console.log(`[EpicAPI] Fallback endpoint succeeded: ${endpoint}`);
          }

          return json.data as T;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Only log non-circuit-breaker errors (avoid spamming)
          if (!this.gqlCircuitOpen) {
            console.debug(`[EpicAPI] Endpoint ${endpoint} failed: ${lastError.message}`);
          }
          // If there's another endpoint to try, add a small delay before retrying
          if (i < endpoints.length - 1 && !this.gqlCircuitOpen) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      throw lastError || new Error('All Epic GQL endpoints failed');
    } finally {
      this.rateLimiter.release();
    }
  }

  // -----------------------------------------------------------------------
  // Shared REST fallback — guaranteed data source
  //
  // The freeGamesPromotions REST endpoint is NOT behind Cloudflare and
  // reliably returns ~12 games with full metadata (images, prices, promos,
  // release dates).  We use it as a fallback when GraphQL is unavailable.
  // -----------------------------------------------------------------------

  private async getPromotionalCatalog(): Promise<EpicCatalogItem[]> {
    const cacheKey = 'epic:promotional-catalog';
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    const url = `${this.FREE_GAMES_ENDPOINT}?locale=en-US&country=US&allowCountries=US`;
    const response = await this.doFetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`Promotional catalog request failed: ${response.status}`);

    const json = await response.json();

    // The REST endpoint wraps everything in the same GraphQL-like envelope
    const elements: EpicCatalogItem[] = json?.data?.Catalog?.searchStore?.elements || [];
    // Map seller info into developer/publisher for compatibility
    for (const el of elements) {
      if (!el.developer && el.seller?.name) {
        el.developer = el.seller.name;
      }
    }

    this.cache.set(cacheKey, elements, FREE_GAMES_CACHE_TTL);
    console.log(`[EpicAPI] Promotional catalog loaded: ${elements.length} items`);
    return elements;
  }

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Search games by keyword.
   */
  async searchGames(keyword: string, limit: number = 20): Promise<EpicCatalogItem[]> {
    const cacheKey = `epic:search:${keyword.toLowerCase()}:${limit}`;
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    // 1. Try GraphQL (may fail if Cloudflare blocks)
    try {
      const data = await this.gqlFetch<{
        Catalog: { searchStore: { elements: EpicCatalogItem[] } };
      }>(SEARCH_STORE_QUERY, {
        keyword,
        count: limit,
        locale: 'en-US',
        country: 'US',
      });

      const results = data.Catalog.searchStore.elements || [];
      this.cache.set(cacheKey, results, SEARCH_CACHE_TTL);

      if (cached) return cached;
      return results;
    } catch (error) {
      console.debug('[EpicAPI] GQL search unavailable, using REST fallback');
    }

    // 2. Fallback: filter promotional catalog by keyword
    try {
      const catalog = await this.getPromotionalCatalog();
      const kw = keyword.toLowerCase();
      const filtered = catalog.filter(g =>
        g.title?.toLowerCase().includes(kw) ||
        g.description?.toLowerCase().includes(kw) ||
        g.developer?.toLowerCase().includes(kw)
      ).slice(0, limit);
      if (filtered.length > 0) {
        console.log(`[EpicAPI] REST fallback found ${filtered.length} results for "${keyword}"`);
        this.cache.set(cacheKey, filtered, SEARCH_CACHE_TTL);
        return filtered;
      }
    } catch (restErr) {
      console.error('[EpicAPI] REST search fallback also failed:', (restErr as Error).message);
    }

    if (cached) return cached; // Return stale on error
    return [];
  }

  /**
   * Get details for a single game by namespace + offerId.
   * Falls back to the promotional catalog + search when GraphQL is blocked
   * by Cloudflare, so library games are never silently lost.
   */
  async getGameDetails(namespace: string, offerId: string): Promise<EpicCatalogItem | null> {
    const cacheKey = `epic:details:${namespace}:${offerId}`;
    const cached = this.cache.get<EpicCatalogItem>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    // 1. Try GraphQL (preferred — returns full metadata)
    try {
      const data = await this.gqlFetch<{
        Catalog: { catalogOffer: EpicCatalogItem | null };
      }>(CATALOG_QUERY, {
        namespace,
        id: offerId,
        locale: 'en-US',
        country: 'US',
      });

      const item = data.Catalog.catalogOffer;
      if (item) {
        this.cache.set(cacheKey, item, CACHE_TTL);
        return item;
      }
    } catch (error) {
      console.debug(`[EpicAPI] GQL getGameDetails(${namespace}:${offerId}) failed, trying REST fallback`);
    }

    // 2. REST fallback: search the promotional catalog by namespace/offerId
    try {
      const catalog = await this.getPromotionalCatalog();
      const match = catalog.find(
        g => g.namespace === namespace && g.id === offerId,
      );
      if (match) {
        console.log(`[EpicAPI] REST fallback: found ${match.title} in promotional catalog`);
        this.cache.set(cacheKey, match, CACHE_TTL);
        return match;
      }
    } catch (restErr) {
      console.debug('[EpicAPI] Promotional catalog fallback also failed:', (restErr as Error).message);
    }

    // 3. Return stale cache if available
    if (cached) {
      console.log(`[EpicAPI] Returning stale cache for ${namespace}:${offerId}`);
      return cached;
    }
    return null;
  }

  /**
   * Get new releases (sorted by release date descending).
   */
  async getNewReleases(limit: number = 100): Promise<EpicCatalogItem[]> {
    const cacheKey = `epic:new-releases:${limit}`;
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    // 1. Try GraphQL
    try {
      const data = await this.gqlFetch<{
        Catalog: { searchStore: { elements: EpicCatalogItem[] } };
      }>(BROWSE_STORE_QUERY, {
        count: limit,
        start: 0,
        locale: 'en-US',
        country: 'US',
        sortBy: 'releaseDate',
        sortDir: 'DESC',
        releaseDate: `[,${new Date().toISOString()}]`,
      });

      const results = data.Catalog.searchStore.elements || [];
      this.cache.set(cacheKey, results, RELEASES_CACHE_TTL);
      return results;
    } catch (error) {
      console.debug('[EpicAPI] GQL new-releases unavailable, using REST fallback');
    }

    // 2. Fallback: promotional catalog, filter for released games, sort newest first
    try {
      const catalog = await this.getPromotionalCatalog();
      const now = new Date();
      const released = catalog
        .filter(g => g.effectiveDate && new Date(g.effectiveDate) <= now)
        .sort((a, b) => new Date(b.effectiveDate!).getTime() - new Date(a.effectiveDate!).getTime())
        .slice(0, limit);
      if (released.length > 0) {
        console.log(`[EpicAPI] REST fallback: ${released.length} new releases from promotional catalog`);
        this.cache.set(cacheKey, released, RELEASES_CACHE_TTL);
        return released;
      }
    } catch (restErr) {
      console.error('[EpicAPI] REST new-releases fallback also failed:', (restErr as Error).message);
    }

    if (cached) return cached;
    return [];
  }

  /**
   * Get coming soon (games with future release dates).
   */
  async getComingSoon(limit: number = 100): Promise<EpicCatalogItem[]> {
    const cacheKey = `epic:coming-soon:${limit}`;
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    // 1. Try GraphQL
    try {
      const data = await this.gqlFetch<{
        Catalog: { searchStore: { elements: EpicCatalogItem[] } };
      }>(BROWSE_STORE_QUERY, {
        count: limit,
        start: 0,
        locale: 'en-US',
        country: 'US',
        sortBy: 'releaseDate',
        sortDir: 'ASC',
        releaseDate: `[${new Date().toISOString()},]`,
      });

      const results = data.Catalog.searchStore.elements || [];
      this.cache.set(cacheKey, results, RELEASES_CACHE_TTL);
      return results;
    } catch (error) {
      console.debug('[EpicAPI] GQL coming-soon unavailable, using REST fallback');
    }

    // 2. Fallback: promotional catalog items with upcoming promotions or future dates
    try {
      const catalog = await this.getPromotionalCatalog();
      const now = new Date();
      const upcoming = catalog
        .filter(g => {
          const hasUpcoming = (g.promotions?.upcomingPromotionalOffers || []).length > 0;
          const hasFutureDate = g.effectiveDate && new Date(g.effectiveDate) > now;
          return hasUpcoming || hasFutureDate;
        })
        .sort((a, b) =>
          new Date(a.effectiveDate || '9999-12-31').getTime() -
          new Date(b.effectiveDate || '9999-12-31').getTime()
        )
        .slice(0, limit);
      if (upcoming.length > 0) {
        console.log(`[EpicAPI] REST fallback: ${upcoming.length} coming-soon items from promotional catalog`);
        this.cache.set(cacheKey, upcoming, RELEASES_CACHE_TTL);
        return upcoming;
      }
    } catch (restErr) {
      console.error('[EpicAPI] REST coming-soon fallback also failed:', (restErr as Error).message);
    }

    if (cached) return cached;
    return [];
  }

  /**
   * Get currently free games from Epic.
   */
  async getFreeGames(): Promise<EpicCatalogItem[]> {
    const cacheKey = 'epic:free-games';
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    try {
      // Use getPromotionalCatalog (which already fetches from the REST endpoint)
      const elements = await this.getPromotionalCatalog();

      // Filter to only currently free games (discount = 0 price, active promo)
      const now = new Date();
      const freeGames = elements.filter(item => {
        const promos = item.promotions?.promotionalOffers;
        if (!promos || promos.length === 0) return false;
        return promos.some(offer =>
          offer.promotionalOffers.some(p =>
            p.discountSetting.discountPercentage === 0 &&
            new Date(p.startDate) <= now &&
            new Date(p.endDate) >= now
          )
        );
      });

      console.log(`[EpicAPI] Free games: ${freeGames.length} currently free out of ${elements.length} promotional`);
      this.cache.set(cacheKey, freeGames, FREE_GAMES_CACHE_TTL);
      return freeGames;
    } catch (error) {
      console.error('[EpicAPI] GetFreeGames failed:', error);
      if (cached) return cached;
      return [];
    }
  }

  /**
   * Get rich product page content (full description, system requirements, etc.)
   * from the Epic CMS REST endpoint.  This is NOT behind Cloudflare.
   *
   * The endpoint returns the same data that powers the Epic Store product page:
   *  - about.description  (full HTML "About the Game")
   *  - about.shortDescription
   *  - requirements.systems[]  (per-platform min/recommended specs)
   *
   * Returns null if the slug is unknown or the endpoint fails.
   */
  async getProductContent(slug: string): Promise<{
    about?: string;
    requirements?: Array<{
      systemType: string;
      details: Array<{
        title: string;
        minimum: Record<string, string>;
        recommended: Record<string, string>;
      }>;
    }>;
    gallery?: Array<{ type: 'image' | 'video'; url: string; thumbnail?: string }>;
  } | null> {
    if (!slug) return null;

    const cacheKey = `epic:product-content:${slug}`;
    const cached = this.cache.get<any>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    try {
      await this.rateLimiter.acquire();
      try {
        const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;
        const response = await this.doFetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });

        if (!response.ok) {
          console.debug(`[EpicAPI] Product content ${response.status} for slug "${slug}"`);
          return null;
        }

        const json = await response.json();
        const pages = json?.pages || [];

        let about: string | undefined;
        let requirements: any[] | undefined;
        const gallery: Array<{ type: 'image' | 'video'; url: string; thumbnail?: string }> = [];

        for (const page of pages) {
          const data = page?.data;
          if (!data) continue;

          // About / description
          if (data.about?.description && !about) {
            about = data.about.description;
          }
          if (!about && data.description) {
            about = data.description;
          }

          // System requirements
          if (data.requirements?.systems && !requirements) {
            requirements = data.requirements.systems;
          }

          // Gallery — screenshots and videos from CMS carousel/gallery data
          // Epic CMS stores gallery items in various locations depending on page type
          const galleryItems = data.gallery?.galleryImages
            || data.gallery
            || data.carousel?.items
            || data.carousel
            || [];
          if (Array.isArray(galleryItems)) {
            for (const item of galleryItems) {
              // Image items: { image: { src, ... } } or { src, ... } or string URL
              const imgSrc = item?.image?.src || item?.src || (typeof item === 'string' ? item : null);
              if (imgSrc && typeof imgSrc === 'string') {
                gallery.push({ type: 'image', url: imgSrc });
                continue;
              }
              // Video items: { video: { ... }, thumbnail: ... }
              const videoSrc = item?.video?.src || item?.video?.url || item?.videoUrl;
              if (videoSrc) {
                gallery.push({
                  type: 'video',
                  url: videoSrc,
                  thumbnail: item?.thumbnail?.src || item?.thumbnail || undefined,
                });
              }
            }
          }

          // Also check hero/banner images for fallback media
          if (gallery.length === 0) {
            const heroImg = data.hero?.heroBackgroundImage?.src
              || data.hero?.backgroundImageUrl
              || data.hero?.image?.src;
            if (heroImg) {
              gallery.push({ type: 'image', url: heroImg });
            }
          }
        }

        const result = {
          about,
          requirements,
          gallery: gallery.length > 0 ? gallery : undefined,
        };
        this.cache.set(cacheKey, result, CACHE_TTL);
        console.log(`[EpicAPI] Product content loaded for "${slug}" (about: ${!!about}, reqs: ${!!requirements}, gallery: ${gallery.length})`);
        return result;
      } finally {
        this.rateLimiter.release();
      }
    } catch (error) {
      console.error(`[EpicAPI] GetProductContent("${slug}") failed:`, (error as Error).message);
      if (cached) return cached;
      return null;
    }
  }

  /**
   * Get upcoming releases (combined new + coming soon) for the release calendar.
   * Returns a flat array with title, date, image, and store info.
   */
  async getUpcomingReleases(): Promise<Array<{
    title: string;
    date: string;
    capsule: string;
    discount: boolean;
    free: boolean;
    namespace: string;
    offerId: string;
  }>> {
    const cacheKey = 'epic:upcoming-releases';
    const cached = this.cache.get<any[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    try {
      // getNewReleases and getComingSoon already have REST fallbacks internally
      const [newReleases, comingSoon] = await Promise.all([
        this.getNewReleases(30),
        this.getComingSoon(30),
      ]);

      let all = [...newReleases, ...comingSoon];

      // If both returned empty (complete failure), do a last-resort direct REST pull
      if (all.length === 0) {
        console.log('[EpicAPI] Both new/coming-soon empty — direct REST fallback for upcoming');
        try {
          all = await this.getPromotionalCatalog();
        } catch {
          // give up
        }
      }

      const seen = new Set<string>();
      const releases = [];

      // Epic uses far-future sentinel dates (e.g. 2099-01-01) for games
      // without a confirmed release date.  Treat anything more than 5 years
      // out as TBA so it doesn't pollute the calendar with fake dates.
      const maxReasonableDate = Date.now() + 5 * 365.25 * 24 * 60 * 60 * 1000;

      for (const item of all) {
        const key = `${item.namespace}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const isFree = item.price?.totalPrice.discountPrice === 0;
        const hasDiscount = (item.price?.totalPrice.discountPrice ?? 0) < (item.price?.totalPrice.originalPrice ?? 0);

        // Sanitize sentinel dates
        let date = item.effectiveDate || '';
        if (date) {
          const ts = new Date(date).getTime();
          if (isNaN(ts) || ts > maxReasonableDate) {
            date = ''; // Will be treated as "Coming Soon" by the calendar
          }
        }

        releases.push({
          title: item.title,
          date,
          capsule: resolveEpicImage(item.keyImages) || '',
          discount: hasDiscount,
          free: isFree,
          namespace: item.namespace,
          offerId: item.id,
        });
      }

      this.cache.set(cacheKey, releases, RELEASES_CACHE_TTL);
      return releases;
    } catch (error) {
      console.error('[EpicAPI] GetUpcomingReleases failed:', error);
      if (cached) return cached;
      return [];
    }
  }

  /**
   * Browse the full Epic catalog — fetches multiple pages in parallel.
   * Returns a large set of games for the general browse view (not limited
   * to new releases or coming soon).
   */
  async browseCatalog(totalLimit: number = 0): Promise<EpicCatalogItem[]> {
    // totalLimit=0 means "fetch everything"
    const cacheKey = `epic:catalog-browse-full`;
    const cached = this.cache.get<EpicCatalogItem[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    const PAGE_SIZE = 40; // Epic GQL max per request
    const BATCH_SIZE = 8; // Parallel requests per batch to avoid rate limits
    const MAX_PAGES = 200; // Safety cap: 200 × 40 = 8000 games max

    try {
      const allElements: EpicCatalogItem[] = [];
      let totalAvailable = Infinity;
      let currentPage = 0;

      // First request to discover total count
      const firstResult = await this.gqlFetch<{
        Catalog: { searchStore: { elements: EpicCatalogItem[]; paging: { count: number; total: number } } };
      }>(BROWSE_STORE_QUERY, {
        count: PAGE_SIZE,
        start: 0,
        locale: 'en-US',
        country: 'US',
        sortBy: 'releaseDate',
        sortDir: 'DESC',
      }).catch(() => null);

      if (firstResult?.Catalog?.searchStore) {
        const { elements, paging } = firstResult.Catalog.searchStore;
        allElements.push(...elements);
        totalAvailable = paging.total;
        currentPage = 1;
        console.log(`[EpicAPI] Catalog total available: ${totalAvailable} games`);
      }

      // Calculate remaining pages needed
      const effectiveLimit = totalLimit > 0 ? Math.min(totalLimit, totalAvailable) : totalAvailable;
      const totalPages = Math.min(Math.ceil(effectiveLimit / PAGE_SIZE), MAX_PAGES);
      const remainingPages = totalPages - currentPage;

      if (remainingPages > 0) {
        // Fetch remaining pages in parallel batches
        for (let batchStart = 0; batchStart < remainingPages; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, remainingPages);
          const batchPromises = [];

          for (let i = batchStart; i < batchEnd; i++) {
            const pageIdx = currentPage + i;
            batchPromises.push(
              this.gqlFetch<{
                Catalog: { searchStore: { elements: EpicCatalogItem[]; paging: { count: number; total: number } } };
              }>(BROWSE_STORE_QUERY, {
                count: PAGE_SIZE,
                start: pageIdx * PAGE_SIZE,
                locale: 'en-US',
                country: 'US',
                sortBy: 'releaseDate',
                sortDir: 'DESC',
              }).catch(() => null),
            );
          }

          const batchResults = await Promise.all(batchPromises);
          let batchEmpty = true;
          for (const data of batchResults) {
            if (data?.Catalog?.searchStore?.elements?.length) {
              allElements.push(...data.Catalog.searchStore.elements);
              batchEmpty = false;
            }
          }

          // Stop if a whole batch returned nothing (we've hit the end)
          if (batchEmpty) break;

          console.log(`[EpicAPI] Catalog progress: ${allElements.length}/${effectiveLimit} games`);
        }
      }

      // Map seller → developer for compatibility
      for (const el of allElements) {
        if (!el.developer && el.seller?.name) {
          el.developer = el.seller.name;
        }
      }

      // Deduplicate by namespace:id
      const uniqueMap = new Map<string, EpicCatalogItem>();
      for (const el of allElements) {
        const key = `${el.namespace}:${el.id}`;
        if (!uniqueMap.has(key)) uniqueMap.set(key, el);
      }
      const uniqueItems = Array.from(uniqueMap.values());

      if (uniqueItems.length > 0) {
        this.cache.set(cacheKey, uniqueItems, RELEASES_CACHE_TTL);
        console.log(`[EpicAPI] Catalog browse complete: ${uniqueItems.length} unique games from ${totalAvailable} total`);
        return uniqueItems;
      }
    } catch (error) {
      console.error('[EpicAPI] browseCatalog failed:', error);
    }

    // Fall back to promotional catalog if GQL fails
    if (cached) return cached;
    try {
      return await this.getPromotionalCatalog();
    } catch {
      return [];
    }
  }

  /**
   * Resolve cover URL for a game (by namespace + offerId, using cached data or fetching).
   */
  getCoverUrl(namespace: string, offerId: string): string | null {
    const cacheKey = `epic:details:${namespace}:${offerId}`;
    const cached = this.cache.get<EpicCatalogItem>(cacheKey, true);
    if (cached) {
      return resolveEpicImage(cached.keyImages, true) || null;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // News / Feed
  //
  // Epic's CMS blog endpoint is NOT behind Cloudflare and returns global
  // store news articles.  We filter by keyword (game title) to find
  // game-specific articles.
  // -----------------------------------------------------------------------

  async getNewsFeed(keyword: string, limit: number = 15): Promise<Array<{
    title: string;
    url: string;
    date: string;
    image?: string;
    body?: string;
    source?: string;
  }>> {
    if (!keyword) return [];

    const cacheKey = `epic:news:${keyword.toLowerCase()}:${limit}`;
    const cached = this.cache.get<any[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    const results: Array<{
      title: string;
      url: string;
      date: string;
      image?: string;
      body?: string;
      source?: string;
    }> = [];

    try {
      await this.rateLimiter.acquire();
      try {
        // Fetch the latest blog posts from Epic CMS (not behind Cloudflare)
        const url = `https://store-content.ak.epicgames.com/api/en-US/content/blog?offset=0&limit=50`;
        const response = await this.doFetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });

        if (response.ok) {
          const json = await response.json();
          const posts = Array.isArray(json) ? json : (json?.blogList || json?.elements || []);
          const kw = keyword.toLowerCase();

          for (const post of posts) {
            // Filter by keyword match on title, body, or content
            const title = post?.title || post?.name || '';
            const body = post?.body || post?.content || post?.short || '';
            const slug = post?.slug || post?._slug || '';

            if (
              title.toLowerCase().includes(kw) ||
              body.toLowerCase().includes(kw) ||
              slug.toLowerCase().includes(kw.replace(/\s+/g, '-'))
            ) {
              results.push({
                title,
                url: post?.url || post?.externalLink || (slug ? `https://store.epicgames.com/en-US/news/${slug}` : ''),
                date: post?.date || post?.lastModified || post?._activeDate || '',
                image: post?.image?.src || post?.image || post?.featuredImage?.src || undefined,
                body: body.slice(0, 500),
                source: 'Epic Games Store',
              });
            }

            if (results.length >= limit) break;
          }
        }
      } finally {
        this.rateLimiter.release();
      }
    } catch (error) {
      console.debug(`[EpicAPI] News feed fetch failed:`, (error as Error).message);
    }

    // Also try the product-specific CMS endpoint for news
    // (some games have dedicated news pages)
    if (results.length === 0) {
      try {
        // Attempt a slug-based product news fetch
        const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await this.rateLimiter.acquire();
        try {
          const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;
          const response = await this.doFetch(url, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });

          if (response.ok) {
            const json = await response.json();
            const pages = json?.pages || [];
            for (const page of pages) {
              const news = page?.data?.news?.articles || page?.data?.news?.items || [];
              for (const article of (Array.isArray(news) ? news : [])) {
                results.push({
                  title: article?.title || article?.name || 'News Update',
                  url: article?.url || article?.link || `https://store.epicgames.com/en-US/p/${slug}`,
                  date: article?.date || article?.publishDate || '',
                  image: article?.image?.src || article?.image || undefined,
                  body: (article?.body || article?.content || '').slice(0, 500),
                  source: 'Epic Games Store',
                });
                if (results.length >= limit) break;
              }
            }
          }
        } finally {
          this.rateLimiter.release();
        }
      } catch {
        // Silently ignore — news is a nice-to-have
      }
    }

    if (results.length > 0) {
      this.cache.set(cacheKey, results, RELEASES_CACHE_TTL);
      console.log(`[EpicAPI] News feed: ${results.length} articles for "${keyword}"`);
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Product Reviews
  //
  // Epic's product reviews endpoint returns user ratings for a game.
  // The SKU is typically the product slug (or EPIC_{slug}).
  // -----------------------------------------------------------------------

  async getProductReviews(slug: string): Promise<{
    overallScore: string;
    totalReviews: number;
    averageRating: number;
    recentReviews?: Array<{
      rating: number;
      body: string;
      date: string;
      userName?: string;
    }>;
  } | null> {
    if (!slug) return null;

    const cacheKey = `epic:reviews:${slug}`;
    const cached = this.cache.get<any>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    // Try multiple SKU formats that Epic uses
    const skuVariants = [slug, `EPIC_${slug}`, slug.replace(/-/g, '')];

    for (const sku of skuVariants) {
      try {
        await this.rateLimiter.acquire();
        try {
          const url = `https://store-content.ak.epicgames.com/api/en-US/content/productReviews/${sku}`;
          const response = await this.doFetch(url, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });

          if (response.ok) {
            const json = await response.json();
            // Parse response — format varies but typically contains an array of reviews
            const reviews = json?.reviews || json?.data?.reviews || json?.elements || [];
            const overallRating = json?.averageRating || json?.data?.averageRating || 0;
            const totalCount = json?.totalCount || json?.data?.totalCount || reviews.length;

            if (totalCount > 0 || reviews.length > 0) {
              // Compute a verbal score similar to Steam's
              let overallScore = 'Mixed';
              const avgRating = overallRating || (reviews.length > 0
                ? reviews.reduce((sum: number, r: any) => sum + (r.rating || 0), 0) / reviews.length
                : 0);

              if (avgRating >= 4.5) overallScore = 'Overwhelmingly Positive';
              else if (avgRating >= 4.0) overallScore = 'Very Positive';
              else if (avgRating >= 3.5) overallScore = 'Mostly Positive';
              else if (avgRating >= 3.0) overallScore = 'Mixed';
              else if (avgRating >= 2.0) overallScore = 'Mostly Negative';
              else overallScore = 'Negative';

              const result = {
                overallScore,
                totalReviews: totalCount,
                averageRating: Math.round(avgRating * 10) / 10,
                recentReviews: reviews.slice(0, 10).map((r: any) => ({
                  rating: r.rating || 0,
                  body: r.body || r.text || r.content || '',
                  date: r.date || r.createdAt || '',
                  userName: r.userName || r.user?.displayName || undefined,
                })),
              };

              this.cache.set(cacheKey, result, CACHE_TTL);
              console.log(`[EpicAPI] Product reviews for "${slug}": ${totalCount} reviews, avg ${avgRating}`);
              return result;
            }
          }
        } finally {
          this.rateLimiter.release();
        }
      } catch (error) {
        console.debug(`[EpicAPI] Reviews fetch failed for SKU "${sku}":`, (error as Error).message);
      }
    }

    // Also try the GraphQL polling endpoint (newer Epic review system)
    try {
      const data = await this.gqlFetch<{
        OpenCritic?: { productReviews?: { openCriticScore?: number; topCriticScore?: number; percentRecommended?: number } };
      }>(`
        query getProductReviews($sandboxId: String!) {
          OpenCritic {
            productReviews(sandboxId: $sandboxId) {
              openCriticScore
              topCriticScore
              percentRecommended
            }
          }
        }
      `, { sandboxId: slug }).catch(() => null);

      if (data?.OpenCritic?.productReviews) {
        const oc = data.OpenCritic.productReviews;
        const pctRec = oc.percentRecommended ?? 0;
        let overallScore = 'Mixed';
        if (pctRec >= 85) overallScore = 'Very Positive';
        else if (pctRec >= 70) overallScore = 'Mostly Positive';
        else if (pctRec >= 50) overallScore = 'Mixed';
        else overallScore = 'Mostly Negative';

        const result = {
          overallScore,
          totalReviews: 0,
          averageRating: oc.openCriticScore ?? oc.topCriticScore ?? 0,
          recentReviews: [],
        };
        this.cache.set(cacheKey, result, CACHE_TTL);
        console.log(`[EpicAPI] OpenCritic reviews for "${slug}": score ${result.averageRating}, ${pctRec}% recommended`);
        return result;
      }
    } catch {
      // Silently ignore
    }

    if (cached) return cached;
    return null;
  }

  // -----------------------------------------------------------------------
  // DLC / Add-ons
  //
  // Queries the catalog for addons belonging to a given namespace.
  // -----------------------------------------------------------------------

  private readonly ADDONS_QUERY = `
    query addonsQuery($namespace: String!, $count: Int, $locale: String, $country: String!) {
      Catalog {
        searchStore(
          namespace: $namespace
          count: $count
          locale: $locale
          country: $country
          category: "addons|digitalextras"
          sortBy: "releaseDate"
          sortDir: "DESC"
        ) {
          elements {
            namespace
            id
            title
            description
            keyImages {
              type
              url
            }
            effectiveDate
            price(country: $country) {
              totalPrice {
                discountPrice
                originalPrice
                fmtPrice {
                  originalPrice
                  discountPrice
                  intermediatePrice
                }
              }
            }
          }
          paging {
            count
            total
          }
        }
      }
    }`;

  async getAddons(namespace: string, limit: number = 50): Promise<Array<{
    id: string;
    title: string;
    description: string;
    image?: string;
    price?: string;
    isFree: boolean;
    releaseDate?: string;
  }>> {
    if (!namespace) return [];

    const cacheKey = `epic:addons:${namespace}:${limit}`;
    const cached = this.cache.get<any[]>(cacheKey, true);
    if (cached && !this.cache.isStale(cacheKey)) return cached;

    try {
      const data = await this.gqlFetch<{
        Catalog: {
          searchStore: {
            elements: EpicCatalogItem[];
            paging: { count: number; total: number };
          };
        };
      }>(this.ADDONS_QUERY, {
        namespace,
        count: limit,
        locale: 'en-US',
        country: 'US',
      });

      const elements = data.Catalog.searchStore.elements || [];
      const addons = elements.map(el => ({
        id: el.id,
        title: el.title,
        description: el.description || '',
        image: resolveEpicImage(el.keyImages),
        price: el.price?.totalPrice.fmtPrice?.discountPrice,
        isFree: el.price?.totalPrice.discountPrice === 0,
        releaseDate: el.effectiveDate,
      }));

      if (addons.length > 0) {
        this.cache.set(cacheKey, addons, RELEASES_CACHE_TTL);
        console.log(`[EpicAPI] Addons for namespace "${namespace}": ${addons.length} found (total available: ${data.Catalog.searchStore.paging.total})`);
      }
      return addons;
    } catch (error) {
      console.debug(`[EpicAPI] Addons query failed for "${namespace}":`, (error as Error).message);
    }

    if (cached) return cached;
    return [];
  }

  /**
   * Clear all cached Epic data.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { total: number; fresh: number; stale: number } {
    return this.cache.getStats();
  }
}

// ---------------------------------------------------------------------------
// Export singleton
// ---------------------------------------------------------------------------

export const epicAPI = new EpicAPIClient();
