/**
 * HowLongToBeat IPC handlers.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { getHltbClient, type HltbQuery } from '../hltb-api.js';

/** Validate renderer input: a non-empty title of at most 200 characters, optional sane year. */
export function parseHltbQuery(raw: unknown): HltbQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const { title, year } = raw as { title?: unknown; year?: unknown };
  if (typeof title !== 'string') return null;
  const t = title.trim();
  if (!t || t.length > 200) return null;
  const y = typeof year === 'number' && Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : undefined;
  return { title: t, year: y };
}

export function register(): void {
  ipcMain.handle('hltb:getTimes', async (_event: unknown, raw: unknown) => {
    const query = parseHltbQuery(raw);
    if (!query) return null;
    try {
      const client = await getHltbClient();
      return await client.getTimes(query);
    } catch (error) {
      logger.error('[HLTB] getTimes failed:', error);
      return null;
    }
  });
}
