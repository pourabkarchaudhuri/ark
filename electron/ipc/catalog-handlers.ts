/**
 * Catalog IPC Handlers
 * Includes full-catalog adult filter test (Steam 150K+ and Epic ~6K).
 */
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { steamAPI } from '../steam-api.js';
import { epicAPI } from '../epic-api.js';
import { egdataAPI } from '../egdata-api.js';

const STEAM_BATCH_SIZE = 20;
const STEAM_BATCH_DELAY_MS = 400;

const EPIC_SEXUAL_CONTENT_TAG_NAMES = new Set([
  'sexual content',
  'strong sexual content',
  'adult only',
  'nudity',
  'nsfw',
  'sexual themes',
  'explicit sexual content',
  'adults only',
  'strong sexual themes',
  'interactive sexual content',
]);

function isSteamExcluded(details: { ratings?: { esrb?: { rating?: string } } | null }): boolean {
  const rating = details?.ratings?.esrb?.rating;
  if (rating == null) return false;
  return String(rating).toLowerCase() === 'ao';
}

function isEpicExcluded(item: { tags?: Array<{ name?: string }> }): boolean {
  const tags = item?.tags ?? [];
  for (const t of tags) {
    const name = (t?.name ?? '').trim().toLowerCase();
    if (EPIC_SEXUAL_CONTENT_TAG_NAMES.has(name)) return true;
  }
  return false;
}

function getDocsDir(): string {
  const cwd = process.cwd();
  const docs = path.join(cwd, 'docs');
  return docs;
}

export type FullCatalogAdultFilterResult = {
  steam: { total: number; excluded: number; excludedList: Array<{ appid: number; name: string }>; error?: string };
  epic: { total: number; excluded: number; excludedList: Array<{ title: string; id: string; namespace: string; matchingTags: string[] }>; error?: string };
  runAt: string;
  /** When set, Epic list came from egdata top-sellers (not full GraphQL catalog). */
  epicSource?: 'egdata top-sellers' | 'graphql';
};

/**
 * Run adult filter against full Steam catalog (~150K) and Epic catalog (~6K).
 * Writes excluded lists to docs/ for review. Requires STEAM_API_KEY for Steam app list.
 */
export async function runFullCatalogAdultFilterTest(): Promise<FullCatalogAdultFilterResult> {
    const docsDir = getDocsDir();
    mkdirSync(docsDir, { recursive: true });
    const result: FullCatalogAdultFilterResult = {
      steam: { total: 0, excluded: 0, excludedList: [] },
      epic: { total: 0, excluded: 0, excludedList: [] },
      runAt: new Date().toISOString(),
    };

    const writeOutputs = () => {
      try {
        const steamPath = path.join(docsDir, 'excluded-steam-adult-filter.json');
        const epicPath = path.join(docsDir, 'excluded-epic-adult-filter.json');
        const summaryPath = path.join(docsDir, 'adult-filter-full-catalog-summary.json');
        writeFileSync(steamPath, JSON.stringify(result.steam.excludedList, null, 2), 'utf8');
        writeFileSync(epicPath, JSON.stringify(result.epic.excludedList, null, 2), 'utf8');
        writeFileSync(summaryPath, JSON.stringify(result, null, 2), 'utf8');
        logger.log(`[Catalog] Wrote ${steamPath}, ${epicPath}, ${summaryPath}`);
      } catch (e) {
        logger.error('[Catalog] Failed to write output files:', e);
      }
    };

    // Write initial empty outputs so files exist even if process is killed during Steam/Epic
    writeOutputs();

    try {
    // ─── Steam: get app list then batch fetch details ─────────────────────
    const skipSteam = process.argv.includes('--steam-skip');
    if (skipSteam) {
      logger.log('[Catalog] Steam phase skipped (--steam-skip)');
    }
    try {
      if (!skipSteam) {
        logger.log('[Catalog] Fetching Steam app list...');
        let appList = await steamAPI.getAppList();
        let limit = 0;
        const limitArg = process.argv.find((a) => a.startsWith('--steam-limit='));
        if (limitArg) limit = parseInt(limitArg.split('=')[1], 10) || 0;
        if (limit <= 0 && process.env.STEAM_ADULT_FILTER_LIMIT) limit = parseInt(process.env.STEAM_ADULT_FILTER_LIMIT, 10) || 0;
        if (limit > 0 && appList.length > limit) {
          appList = appList.slice(0, limit);
          logger.log(`[Catalog] Steam limited to first ${limit} apps`);
        }
        result.steam.total = appList.length;
        logger.log(`[Catalog] Steam app list: ${appList.length} apps`);

        const excludedSteam: Array<{ appid: number; name: string }> = [];
        const progressInterval = STEAM_BATCH_SIZE * 50; // log every 50 batches (1000 apps)
        logger.log(`[Catalog] Steam batch loop starting (batch size ${STEAM_BATCH_SIZE}, delay ${STEAM_BATCH_DELAY_MS}ms)...`);
        for (let i = 0; i < appList.length; i += STEAM_BATCH_SIZE) {
          const batch = appList.slice(i, i + STEAM_BATCH_SIZE).map((a) => a.appid);
          const details = await steamAPI.fetchAppDetailsBatch(batch);
          if (i === 0) logger.log(`[Catalog] First Steam batch done (${details.length} details)`);
          for (const d of details) {
            if (isSteamExcluded(d)) excludedSteam.push({ appid: d.appid, name: d.name });
          }
          if ((i + STEAM_BATCH_SIZE) % progressInterval < STEAM_BATCH_SIZE || i + STEAM_BATCH_SIZE >= appList.length) {
            logger.log(`[Catalog] Steam progress: ${Math.min(i + STEAM_BATCH_SIZE, appList.length)}/${appList.length}`);
          }
          await new Promise((r) => setTimeout(r, STEAM_BATCH_DELAY_MS));
        }
        result.steam.excluded = excludedSteam.length;
        result.steam.excludedList = excludedSteam;
        logger.log(`[Catalog] Steam excluded (ESRB AO): ${excludedSteam.length}`);
      }
    } catch (err) {
      result.steam.error = (err as Error).message;
      logger.error('[Catalog] Steam full-catalog test failed:', err);
    }

    // ─── Epic: use egdata top-sellers so test completes (Epic GraphQL can hang in CLI) ─
    try {
      const useEgdata = process.argv.includes('--epic-egdata') || process.argv.includes('--steam-skip');
      if (useEgdata) {
        logger.log('[Catalog] Fetching Epic items via egdata top-sellers (single page)...');
        const res = await egdataAPI.getTopSellers(10, 0);
        const elements = res?.elements ?? [];
        result.epic.total = elements.length;
        logger.log(`[Catalog] Epic (egdata top-sellers): ${elements.length} items`);
        const excludedEpic: Array<{ title: string; id: string; namespace: string; matchingTags: string[] }> = [];
        for (const el of elements) {
          if (isEpicExcluded(el)) {
            const matchTags = (el?.tags ?? [])
              .filter((t) => EPIC_SEXUAL_CONTENT_TAG_NAMES.has((t?.name ?? '').toLowerCase()))
              .map((t) => t?.name ?? '');
            excludedEpic.push({
              title: el?.title ?? '',
              id: el?.id ?? '',
              namespace: el?.namespace ?? '',
              matchingTags: matchTags,
            });
          }
        }
        result.epic.excluded = excludedEpic.length;
        result.epic.excludedList = excludedEpic;
        result.epicSource = 'egdata top-sellers';
        logger.log(`[Catalog] Epic excluded (sexual-content tag): ${excludedEpic.length}`);
      } else {
        logger.log('[Catalog] Fetching Epic catalog (GraphQL)...');
        const EPIC_CATALOG_TIMEOUT_MS = 120000;
        const epicItems = await Promise.race([
          epicAPI.browseCatalog(0),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`Epic catalog fetch timed out after ${EPIC_CATALOG_TIMEOUT_MS / 1000}s`)), EPIC_CATALOG_TIMEOUT_MS)
          ),
        ]);
        result.epic.total = epicItems.length;
        logger.log(`[Catalog] Epic catalog: ${epicItems.length} items`);

      const excludedEpic: Array<{ title: string; id: string; namespace: string; matchingTags: string[] }> = [];
      for (const el of epicItems) {
        if (isEpicExcluded(el)) {
          const matchTags = (el?.tags ?? [])
            .filter((t) => EPIC_SEXUAL_CONTENT_TAG_NAMES.has((t?.name ?? '').toLowerCase()))
            .map((t) => t?.name ?? '');
          excludedEpic.push({
            title: el?.title ?? '',
            id: el?.id ?? '',
            namespace: el?.namespace ?? '',
            matchingTags: matchTags,
          });
        }
      }
      result.epic.excluded = excludedEpic.length;
      result.epic.excludedList = excludedEpic;
      result.epicSource = 'graphql';
      logger.log(`[Catalog] Epic excluded (sexual-content tag): ${excludedEpic.length}`);
      }
    } catch (err) {
      result.epic.error = (err as Error).message;
      logger.error('[Catalog] Epic full-catalog test failed:', err);
    }

    // ─── Write excluded lists to docs/ (always, even on partial/error) ─────
    writeOutputs();
    return result;
    } finally {
      writeOutputs();
    }
}

export function register(): void {
  ipcMain.handle('catalog:runFullCatalogAdultFilterTest', async () => runFullCatalogAdultFilterTest());
}
