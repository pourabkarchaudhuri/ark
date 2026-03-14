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
        if (res.statusCode !== 200) {
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

/** Fetch up to 99 Epic top sellers by paginating (API uses page=1,2,..., returns 10 per page). */
async function fetchTopSellersPaginated(requestedLimit: number): Promise<{ elements: unknown[]; total: number }> {
  const cap = Math.min(requestedLimit, 99);
  const byId = new Map<string, { el: unknown; position: number }>();
  for (let p = 1; p <= EGDATA_MAX_PAGES; p++) {
    const { elements } = await fetchTopSellersViaHttps(EGDATA_PAGE_SIZE, p);
    if (elements.length === 0) break;
    for (const el of elements as Array<{ id?: string; namespace?: string; position?: number }>) {
      const id = el?.id && el?.namespace ? `${el.namespace}:${el.id}` : '';
      if (id && !byId.has(id)) byId.set(id, { el, position: el.position ?? 999 });
    }
    if (elements.length < EGDATA_PAGE_SIZE) break;
  }
  const sorted = Array.from(byId.values())
    .sort((a, b) => a.position - b.position)
    .map((x) => x.el)
    .slice(0, cap);
  return { elements: sorted, total: sorted.length };
}

export function register(): void {
  ipcMain.handle('egdata:getTopSellers', async (_event: unknown, limit?: number, skip?: number) => {
    const l = typeof limit === 'number' && limit > 0 ? Math.min(limit, 99) : 99;
    const s = typeof skip === 'number' && skip >= 0 ? skip : 0;

    // 1) Node https with pagination (API returns ~10 per request; we fetch pages to get up to 99)
    try {
      const { elements, total } = await fetchTopSellersPaginated(l);
      if (elements.length > 0) {
        logger.log('[egdata IPC] getTopSellers: https paginated returned', elements.length, 'elements');
        return { elements, total };
      }
    } catch (httpsErr) {
      logger.warn('[egdata IPC] getTopSellers https failed:', (httpsErr as Error).message);
    }

    // 2) Global fetch with pagination (fallback) — API uses page=1,2,...
    try {
      const byId = new Map<string, { el: unknown; position: number }>();
      for (let p = 1; p <= EGDATA_MAX_PAGES; p++) {
        const url = `https://${EGDATA_TOP_SELLERS_HOST}${EGDATA_TOP_SELLERS_PATH}?limit=${EGDATA_PAGE_SIZE}&page=${p}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) break;
        const data = (await res.json()) as { elements?: Array<{ id?: string; namespace?: string; position?: number }> };
        const elements = Array.isArray(data?.elements) ? data.elements : [];
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
        .slice(0, Math.min(l, 99));
      if (sorted.length > 0) {
        logger.log('[egdata IPC] getTopSellers: fetch paginated returned', sorted.length, 'elements');
        return { elements: sorted, total: sorted.length };
      }
    } catch (fetchErr) {
      logger.warn('[egdata IPC] getTopSellers fetch failed:', (fetchErr as Error).message);
    }

    // 3) egdata API client (paginated)
    try {
      const result = await egdataAPI.getTopSellersPaginated(l);
      return result ?? { elements: [], total: 0 };
    } catch (err) {
      logger.error('[egdata IPC] getTopSellers:', err);
      return { elements: [], total: 0 };
    }
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
