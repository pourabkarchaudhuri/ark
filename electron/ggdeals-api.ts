/**
 * gg.deals price client (main process).
 *
 *   GET https://api.gg.deals/v1/prices/by-steam-app-id/?ids=<≤100 comma-separated>&key=<key>&region=<cc>
 *   → { success: true, data: { "<appid>": { title, url, prices: { currentRetail, currentKeyshops,
 *        historicalRetail, historicalKeyshops, currency } } | null } }
 *   bad key → 400 { success: false, data: { message: "Invalid key." } }
 *
 * The API key is the user's own (entered in Settings, stored encrypted by settings-store) and never
 * leaves the main process: it is not returned over IPC, not part of cache keys, and not included in
 * errors (safe-logger also redacts `key=` from any logged URL). Prices are cached per appid and
 * region for 6 hours; requests go one at a time; 429/5xx pause requests for 15 minutes.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
import { logger } from './safe-logger.js';

const API_BASE = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const BATCH_SIZE = 100;
const PRICE_TTL_MS = 6 * 60 * 60 * 1000;
const BREAKER_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_SPACING_MS = 300;
const CACHE_VERSION = 'v1';

export interface GgDealsPrice {
  title: string;
  /** gg.deals page for the game (attribution / "see all deals"). */
  url: string;
  currency: string;
  /** Lowest price at official stores right now. */
  currentRetail: number | null;
  /** Lowest price at key resellers right now. */
  currentKeyshops: number | null;
  /** All-time lowest official price. */
  historicalRetail: number | null;
  historicalKeyshops: number | null;
}

export type GgDealsError = 'no-key' | 'invalid-key' | 'unavailable';

export interface GgDealsResult {
  prices: Record<number, GgDealsPrice | null>;
  error?: GgDealsError;
}

export interface GgCacheLike {
  get<T>(key: string, allowStale?: boolean): T | null;
  set<T>(key: string, data: T, ttl: number): void;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface Deps {
  fetch: FetchFn;
  cache: GgCacheLike;
  getKey: () => string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const GG_REGIONS = ['us', 'gb', 'eu', 'ca', 'au', 'br', 'pl', 'de', 'fr', 'in'] as const;

const MAX_IDS = 300;
/** gg.deals keys are short alphanumeric tokens. */
export function isPlausibleGgDealsKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key.trim());
}

/** Validate a renderer request for prices: positive integer appids, capped, deduplicated. */
export function parseAppIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((v): v is number => Number.isInteger(v) && v > 0 && v < 1e9))];
  return ids.slice(0, MAX_IDS);
}

export function normalizeRegion(region: unknown): string {
  return typeof region === 'string' && (GG_REGIONS as readonly string[]).includes(region) ? region : 'us';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parsePriceEntry(raw: unknown): GgDealsPrice | null {
  const e = raw as { title?: unknown; url?: unknown; prices?: Record<string, unknown> } | null;
  if (!e || typeof e !== 'object' || !e.prices || typeof e.prices !== 'object') return null;
  const p = e.prices;
  const price: GgDealsPrice = {
    title: typeof e.title === 'string' ? e.title : '',
    url: typeof e.url === 'string' && /^https:\/\/gg\.deals\//.test(e.url) ? e.url : 'https://gg.deals/',
    currency: typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'USD',
    currentRetail: num(p.currentRetail),
    currentKeyshops: num(p.currentKeyshops),
    historicalRetail: num(p.historicalRetail),
    historicalKeyshops: num(p.historicalKeyshops),
  };
  return price.currentRetail === null && price.currentKeyshops === null ? null : price;
}

export class GgDealsClient {
  private breakerUntil = 0;
  /** The key that answered "Invalid key." — not retried until the key changes. */
  private rejectedKey: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private deps: Deps) {}

  private cacheKey(region: string, appId: number) {
    return `gg:${CACHE_VERSION}:${region}:${appId}`;
  }

  async getPrices(appIds: readonly number[], regionIn?: string): Promise<GgDealsResult> {
    const region = normalizeRegion(regionIn);
    const ids = [...new Set(appIds.filter((id) => Number.isInteger(id) && id > 0))];
    const prices: Record<number, GgDealsPrice | null> = {};
    const missing: number[] = [];
    for (const id of ids) {
      const hit = this.deps.cache.get<{ p: GgDealsPrice | null }>(this.cacheKey(region, id));
      if (hit) prices[id] = hit.p;
      else missing.push(id);
    }
    if (missing.length === 0) return { prices };

    const key = this.deps.getKey();
    if (!key) return { prices, error: 'no-key' };
    if (key === this.rejectedKey) return { prices, error: 'invalid-key' };
    if (this.deps.now() < this.breakerUntil) return { prices, error: 'unavailable' };

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const outcome = await this.fetchBatch(batch, key, region);
      if (typeof outcome === 'string') return { prices, error: outcome };
      for (const id of batch) {
        const p = outcome[id] ?? null;
        prices[id] = p;
        this.deps.cache.set(this.cacheKey(region, id), { p }, PRICE_TTL_MS);
      }
    }
    return { prices };
  }

  /** Check a key with a single lookup (Counter-Strike 2). */
  async testKey(key: string): Promise<{ ok: boolean; error?: GgDealsError }> {
    const outcome = await this.fetchBatch([730], key, 'us');
    if (typeof outcome === 'string') return { ok: false, error: outcome };
    if (this.rejectedKey === key) this.rejectedKey = null;
    return { ok: true };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + REQUEST_SPACING_MS - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastRequestAt = this.deps.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchBatch(ids: number[], key: string, region: string): Promise<Record<number, GgDealsPrice | null> | GgDealsError> {
    const url = `${API_BASE}?ids=${ids.join(',')}&key=${encodeURIComponent(key)}&region=${region}`;
    try {
      const res = await this.serial(async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
        try {
          return await this.deps.fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }
      });
      const body = (await res.json().catch(() => null)) as { success?: unknown; data?: unknown } | null;
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const message = (body?.data as { message?: unknown } | undefined)?.message;
        if (typeof message === 'string' && /key/i.test(message)) {
          this.rejectedKey = key;
          logger.warn('[gg.deals] The API key was rejected');
          return 'invalid-key';
        }
        logger.warn(`[gg.deals] Request refused (HTTP ${res.status})`);
        return 'unavailable';
      }
      if (res.status === 429 || res.status >= 500) {
        this.breakerUntil = this.deps.now() + BREAKER_MS;
        logger.warn(`[gg.deals] HTTP ${res.status}; pausing price lookups for 15 min`);
        return 'unavailable';
      }
      if (!res.ok || body?.success !== true || !body.data || typeof body.data !== 'object') {
        this.breakerUntil = this.deps.now() + BREAKER_MS;
        logger.warn('[gg.deals] Unexpected response; pausing price lookups for 15 min');
        return 'unavailable';
      }
      const data = body.data as Record<string, unknown>;
      const out: Record<number, GgDealsPrice | null> = {};
      for (const id of ids) out[id] = parsePriceEntry(data[String(id)]);
      return out;
    } catch (err) {
      // Never include the URL (it carries the key) in what we log or return.
      this.breakerUntil = this.deps.now() + BREAKER_MS;
      logger.warn(`[gg.deals] Request failed; pausing price lookups for 15 min: ${(err as Error).name}`);
      return 'unavailable';
    }
  }
}

let defaultClient: GgDealsClient | null = null;

export async function getGgDealsClient(): Promise<GgDealsClient> {
  if (defaultClient) return defaultClient;
  const { PersistentCache } = await import('./persistent-cache.js');
  const { settingsStore } = await import('./settings-store.js');
  const cache = new PersistentCache('ggdeals-cache.json');
  const netFetch = electron?.net?.fetch as FetchFn | undefined;
  defaultClient = new GgDealsClient({
    fetch: netFetch ? (u, i) => netFetch(u, i) : (u, i) => fetch(u, i),
    cache,
    getKey: () => settingsStore.getGgDealsKey(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return defaultClient;
}
