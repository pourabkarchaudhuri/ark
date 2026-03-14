/**
 * egdata API Client — Epic Games Store data from api.egdata.app
 *
 * Used additively: Epic top sellers, optional fallback when Epic GraphQL is blocked,
 * and optional detail enrichment (related, price). All calls from main process only.
 */

import electron from 'electron';
import { logger } from './safe-logger.js';

const EGDATA_BASE = 'https://api.egdata.app';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types (mirror egdata API response shapes)
// ---------------------------------------------------------------------------

export interface EgdataKeyImage {
  type: string;
  url: string;
}

export interface EgdataOffer {
  id: string;
  namespace: string;
  title: string;
  description?: string;
  longDescription?: string;
  keyImages?: EgdataKeyImage[];
  tags?: Array<{ id: number | string; name?: string; groupName?: string | null }>;
  effectiveDate?: string;
  releaseDate?: string;
  developerDisplayName?: string;
  publisherDisplayName?: string;
  seller?: { name: string };
  url?: string;
  urlSlug?: string;
  productSlug?: string;
  offerMappings?: Array<{ pageSlug: string; pageType: string }>;
  categories?: Array<{ path: string }>;
  customAttributes?: Array<{ key: string; value: string }>;
  price?: {
    discountPrice?: number;
    originalPrice?: number;
    currencyCode?: string;
  };
  position?: number;
}

export interface EgdataTopSellersResponse {
  elements: EgdataOffer[];
  page?: number;
  limit?: number;
  total?: number;
}

export interface EgdataHealthResponse {
  status: string;
  services?: { redis?: { status: string }; mongodb?: { status: string } };
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function egdataFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${EGDATA_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const merged: RequestInit = {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers as Record<string, string>),
      },
    };
    if (electron?.net?.fetch) {
      return await electron.net.fetch(url, merged);
    }
    return await fetch(url, merged);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const EGDATA_PAGE_SIZE = 10;
const EGDATA_MAX_PAGES = 10;

class EgdataAPIClient {
  /**
   * GET /offers/top-sellers — single page. API uses page=1,2,... and returns 10 per page.
   */
  async getTopSellers(limit: number = 99, skip: number = 0): Promise<EgdataTopSellersResponse | null> {
    try {
      const page = skip > 0 ? Math.floor(skip / EGDATA_PAGE_SIZE) + 1 : 1;
      const path = `/offers/top-sellers?limit=${Math.min(limit, 99)}&page=${page}`;
      const res = await egdataFetch(path);
      if (!res.ok) {
        logger.warn(`[egdata] getTopSellers ${res.status}`);
        return null;
      }
      const data = (await res.json()) as EgdataTopSellersResponse;
      return data?.elements ? data : null;
    } catch (err) {
      logger.warn('[egdata] getTopSellers failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * GET /offers/top-sellers — paginated to get up to 99 (API uses page=1,2,..., 10 per page).
   */
  async getTopSellersPaginated(requestedLimit: number = 99): Promise<EgdataTopSellersResponse | null> {
    const cap = Math.min(requestedLimit, 99);
    const byId = new Map<string, { el: EgdataOffer; position: number }>();
    try {
      for (let p = 1; p <= EGDATA_MAX_PAGES; p++) {
        const path = `/offers/top-sellers?limit=${EGDATA_PAGE_SIZE}&page=${p}`;
        const res = await egdataFetch(path);
        if (!res.ok) break;
        const data = (await res.json()) as EgdataTopSellersResponse;
        const elements = data?.elements ?? [];
        if (elements.length === 0) break;
        for (const el of elements) {
          const id = el?.id && el?.namespace ? `${el.namespace}:${el.id}` : '';
          if (id && !byId.has(id)) byId.set(id, { el, position: el.position ?? 999 });
        }
        if (elements.length < EGDATA_PAGE_SIZE) break;
      }
      const sorted = Array.from(byId.values())
        .sort((a, b) => a.position - b.position)
        .map((x) => x.el)
        .slice(0, cap);
      return sorted.length > 0 ? { elements: sorted } : null;
    } catch (err) {
      logger.warn('[egdata] getTopSellersPaginated failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * GET /offers/:id — single offer by id (offerId).
   */
  async getOffer(id: string): Promise<EgdataOffer | null> {
    if (!id?.trim()) return null;
    try {
      const path = `/offers/${encodeURIComponent(id.trim())}`;
      const res = await egdataFetch(path);
      if (!res.ok) {
        if (res.status === 404) return null;
        logger.warn(`[egdata] getOffer ${id} ${res.status}`);
        return null;
      }
      return (await res.json()) as EgdataOffer;
    } catch (err) {
      logger.warn(`[egdata] getOffer ${id} failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * GET /offers/:id/price?country=... — regional price (for detail enrichment).
   */
  async getPrice(id: string, country: string = 'IN'): Promise<{ discountPrice: number; originalPrice: number; currencyCode: string } | null> {
    if (!id?.trim()) return null;
    try {
      const path = `/offers/${encodeURIComponent(id.trim())}/price?country=${encodeURIComponent(country)}`;
      const res = await egdataFetch(path);
      if (!res.ok) return null;
      const data = (await res.json()) as { discountPrice?: number; originalPrice?: number; currencyCode?: string };
      if (typeof data?.discountPrice !== 'number') return null;
      return {
        discountPrice: data.discountPrice,
        originalPrice: typeof data.originalPrice === 'number' ? data.originalPrice : data.discountPrice,
        currencyCode: data.currencyCode ?? 'USD',
      };
    } catch (err) {
      logger.warn(`[egdata] getPrice ${id} failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * GET /offers/:id/related — related offers (editions, DLC) for detail page.
   */
  async getRelated(id: string): Promise<EgdataOffer[] | null> {
    if (!id?.trim()) return null;
    try {
      const path = `/offers/${encodeURIComponent(id.trim())}/related`;
      const res = await egdataFetch(path);
      if (!res.ok) return null;
      const data = await res.json();
      const arr = Array.isArray(data) ? data : (data?.elements ?? data?.items ?? []);
      return arr as EgdataOffer[];
    } catch (err) {
      logger.warn(`[egdata] getRelated ${id} failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * GET /autocomplete?query=... — search autocomplete (for Epic search fallback when blocked).
   */
  async getAutocomplete(query: string, limit: number = 20): Promise<EgdataTopSellersResponse | null> {
    if (!query?.trim()) return null;
    try {
      const path = `/autocomplete?query=${encodeURIComponent(query.trim())}&limit=${Math.min(limit, 20)}`;
      const res = await egdataFetch(path);
      if (!res.ok) {
        logger.warn(`[egdata] getAutocomplete ${res.status}`);
        return null;
      }
      const data = (await res.json()) as EgdataTopSellersResponse;
      return data?.elements ? data : null;
    } catch (err) {
      logger.warn('[egdata] getAutocomplete failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * GET /health — service health.
   */
  async health(): Promise<EgdataHealthResponse | null> {
    try {
      const res = await egdataFetch('/health');
      if (!res.ok) return null;
      return (await res.json()) as EgdataHealthResponse;
    } catch (err) {
      logger.warn('[egdata] health failed:', (err as Error).message);
      return null;
    }
  }
}

export const egdataAPI = new EgdataAPIClient();
