/**
 * egdata API IPC Handlers
 * Expose egdata client to renderer (main process only).
 */

import https from 'node:https';
import { ipcMain } from 'electron';
import { logger } from '../safe-logger.js';
import { egdataAPI } from '../egdata-api.js';

/** Safe offer id (alphanumeric, hyphen, underscore) */
const SAFE_OFFER_ID = /^[a-zA-Z0-9_\-]+$/;

const EGDATA_TOP_SELLERS_HOST = 'api.egdata.app';
const EGDATA_TOP_SELLERS_PATH = '/offers/top-sellers';

/** Page size the API actually returns (API often returns only 10 per request regardless of limit). */
const EGDATA_PAGE_SIZE = 10;
const EGDATA_MAX_PAGES = 10; // 10 * 10 = 99 cap
const EGDATA_TOP_SELLERS_CAP = 99;
/** Pages in flight at once — small, to keep each burst light on api.egdata.app. */
const EGDATA_PAGE_CONCURRENCY = 4;
/** Non-empty top-seller lists are reused this long (several renderer paths ask repeatedly). */
const TOP_SELLERS_TTL_MS = 15 * 60 * 1000;

type TopSellersResult = { elements: unknown[]; total: number };
type TopSellerElement = { id?: string; namespace?: string; position?: number };

let topSellersCache: (TopSellersResult & { at: number }) | null = null;
let topSellersInFlight: Promise<TopSellersResult> | null = null;

/** Test seam: forget the cached / in-flight top-sellers fetch. */
export function resetTopSellersCache(): void {
  topSellersCache = null;
  topSellersInFlight = null;
}

/** Fetch one page of Epic top sellers via Node https. API uses page=1,2,... (not skip). */
function fetchTopSellersViaHttps(limit: number, page: number): Promise<{ elements: unknown[]; total: number }> {
  return new Promise((resolve, reject) => {
    const path = `${EGDATA_TOP_SELLERS_PATH}?limit=${limit}&page=${page}`;
    const req = https.get(
      {
        hostname: EGDATA_TOP_SELLERS_HOST,
        path,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (res) => {
        res.on('error', reject);
        if (res.statusCode !== 200) {
          // Drain the body so the socket is released
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as { elements?: unknown[]; total?: number };
            const elements = Array.isArray(data?.elements) ? data.elements : [];
            resolve({ elements, total: data?.total ?? elements.length });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/** Fetch one page via global fetch (fallback transport). */
async function fetchTopSellersViaFetch(page: number): Promise<unknown[]> {
  const url = `https://${EGDATA_TOP_SELLERS_HOST}${EGDATA_TOP_SELLERS_PATH}?limit=${EGDATA_PAGE_SIZE}&page=${page}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { elements?: unknown[] };
    return Array.isArray(data?.elements) ? data.elements : [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch pages 1..EGDATA_MAX_PAGES a few at a time and merge whatever succeeded
 * (one failed page no longer throws away the others), deduped by namespace:id and
 * sorted by position.
 */
async function fetchTopSellerPagesMerged(fetchPage: (page: number) => Promise<unknown[]>): Promise<TopSellersResult> {
  const pages = Array.from({ length: EGDATA_MAX_PAGES }, (_, i) => i + 1);
  const settled: PromiseSettledResult<unknown[]>[] = [];
  for (let i = 0; i < pages.length; i += EGDATA_PAGE_CONCURRENCY) {
    settled.push(...await Promise.allSettled(pages.slice(i, i + EGDATA_PAGE_CONCURRENCY).map(fetchPage)));
  }
  const failed = settled.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    logger.warn(`[egdata IPC] getTopSellers: ${failed}/${pages.length} pages failed:`, (first?.reason as Error)?.message);
  }
  const byId = new Map<string, { el: unknown; position: number }>();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const el of r.value as TopSellerElement[]) {
      const id = el?.id && el?.namespace ? `${el.namespace}:${el.id}` : '';
      if (id && !byId.has(id)) byId.set(id, { el, position: el.position ?? 999 });
    }
  }
  const sorted = Array.from(byId.values())
    .sort((a, b) => a.position - b.position)
    .map((x) => x.el)
    .slice(0, EGDATA_TOP_SELLERS_CAP);
  return { elements: sorted, total: sorted.length };
}

/** Try each transport in turn until one yields elements. Never throws. */
async function fetchTopSellersUncached(): Promise<TopSellersResult> {
  // 1) Node https (API returns ~10 per request; we fetch pages to get up to 99)
  try {
    const merged = await fetchTopSellerPagesMerged(async (p) => (await fetchTopSellersViaHttps(EGDATA_PAGE_SIZE, p)).elements);
    if (merged.elements.length > 0) {
      logger.log('[egdata IPC] getTopSellers: https paginated returned', merged.elements.length, 'elements');
      return merged;
    }
  } catch (httpsErr) {
    logger.warn('[egdata IPC] getTopSellers https failed:', (httpsErr as Error).message);
  }

  // 2) Global fetch (fallback) — only when https merged nothing
  try {
    const merged = await fetchTopSellerPagesMerged(fetchTopSellersViaFetch);
    if (merged.elements.length > 0) {
      logger.log('[egdata IPC] getTopSellers: fetch paginated returned', merged.elements.length, 'elements');
      return merged;
    }
  } catch (fetchErr) {
    logger.warn('[egdata IPC] getTopSellers fetch failed:', (fetchErr as Error).message);
  }

  // 3) egdata API client (paginated)
  try {
    const result = await egdataAPI.getTopSellersPaginated(EGDATA_TOP_SELLERS_CAP);
    const elements = Array.isArray(result?.elements) ? (result!.elements as unknown[]) : [];
    return { elements, total: result?.total ?? elements.length };
  } catch (err) {
    logger.error('[egdata IPC] getTopSellers:', err);
    return { elements: [], total: 0 };
  }
}

/** Cached (15 min, non-empty only) top-sellers list; concurrent callers share one fetch. */
export function getTopSellersCached(now: () => number = Date.now): Promise<TopSellersResult> {
  if (topSellersCache && now() - topSellersCache.at < TOP_SELLERS_TTL_MS) {
    return Promise.resolve({ elements: topSellersCache.elements, total: topSellersCache.total });
  }
  if (topSellersInFlight) return topSellersInFlight;
  const p = fetchTopSellersUncached()
    .then((result) => {
      if (result.elements.length > 0) topSellersCache = { ...result, at: now() };
      return result;
    })
    .finally(() => {
      if (topSellersInFlight === p) topSellersInFlight = null;
    });
  topSellersInFlight = p;
  return p;
}

export function register(): void {
  ipcMain.handle('egdata:getTopSellers', async (_event: unknown, limit?: number, skip?: number) => {
    const l = typeof limit === 'number' && limit > 0 ? Math.min(limit, EGDATA_TOP_SELLERS_CAP) : EGDATA_TOP_SELLERS_CAP;
    const s = typeof skip === 'number' && skip >= 0 ? Math.floor(skip) : 0;
    const { elements } = await getTopSellersCached();
    const page = elements.slice(s, s + l);
    return { elements: page, total: page.length };
  });

  ipcMain.handle('egdata:getAutocomplete', async (_event: unknown, query: string, limit?: number) => {
    try {
      if (typeof query !== 'string' || !query.trim()) return { elements: [], total: 0 };
      const l = typeof limit === 'number' && limit > 0 ? Math.min(limit, 20) : 20;
      const result = await egdataAPI.getAutocomplete(query, l);
      return result ?? { elements: [], total: 0 };
    } catch (err) {
      logger.error('[egdata IPC] getAutocomplete:', err);
      return { elements: [], total: 0 };
    }
  });

  ipcMain.handle('egdata:getOffer', async (_event: unknown, id: string) => {
    try {
      if (typeof id !== 'string' || id.length > 200 || !SAFE_OFFER_ID.test(id)) return null;
      return await egdataAPI.getOffer(id);
    } catch (err) {
      logger.error('[egdata IPC] getOffer:', err);
      return null;
    }
  });

  ipcMain.handle('egdata:getPrice', async (_event: unknown, id: string, country?: string) => {
    try {
      if (typeof id !== 'string' || id.length > 200 || !SAFE_OFFER_ID.test(id)) return null;
      return await egdataAPI.getPrice(id, typeof country === 'string' ? country : 'IN');
    } catch (err) {
      logger.error('[egdata IPC] getPrice:', err);
      return null;
    }
  });

  ipcMain.handle('egdata:getRelated', async (_event: unknown, id: string) => {
    try {
      if (typeof id !== 'string' || id.length > 200 || !SAFE_OFFER_ID.test(id)) return [];
      const list = await egdataAPI.getRelated(id);
      return list ?? [];
    } catch (err) {
      logger.error('[egdata IPC] getRelated:', err);
      return [];
    }
  });

  ipcMain.handle('egdata:health', async () => {
    try {
      return await egdataAPI.health();
    } catch (err) {
      logger.error('[egdata IPC] health:', err);
      return null;
    }
  });

  ipcMain.handle('egdata:isEnabled', () => {
    return process.env.EGDATA_DISABLED !== '1';
  });
}
