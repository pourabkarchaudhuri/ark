/**
 * gg.deals IPC handlers. The API key can be set, tested and removed from the renderer, never read.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { settingsStore } from '../settings-store.js';
import { getGgDealsClient, isPlausibleGgDealsKey, normalizeRegion, parseAppIds } from '../ggdeals-api.js';

const TEST_COOLDOWN_MS = 10_000;
let lastTestAt = 0;

export function register(): void {
  ipcMain.handle('ggdeals:hasKey', () => {
    try {
      return settingsStore.hasGgDealsKey();
    } catch {
      return false;
    }
  });

  ipcMain.handle('ggdeals:setKey', async (_event: unknown, key: unknown) => {
    if (!isPlausibleGgDealsKey(key)) return { success: false, error: 'That does not look like a gg.deals API key.' };
    try {
      settingsStore.setGgDealsKey(key.trim());
      return { success: true };
    } catch (error) {
      logger.error('[gg.deals] Could not save the API key:', error);
      return { success: false, error: 'Could not save the key.' };
    }
  });

  ipcMain.handle('ggdeals:clearKey', () => {
    try {
      settingsStore.clearGgDealsKey();
      return { success: true };
    } catch (error) {
      logger.error('[gg.deals] Could not remove the API key:', error);
      return { success: false };
    }
  });

  ipcMain.handle('ggdeals:testKey', async () => {
    const now = Date.now();
    if (now - lastTestAt < TEST_COOLDOWN_MS) return { ok: false, error: 'wait' };
    lastTestAt = now;
    const key = settingsStore.getGgDealsKey();
    if (!key) return { ok: false, error: 'no-key' };
    try {
      return await (await getGgDealsClient()).testKey(key);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  });

  ipcMain.handle('ggdeals:getPrices', async (_event: unknown, rawIds: unknown, region: unknown) => {
    const ids = parseAppIds(rawIds);
    if (!ids) return { prices: {} };
    try {
      return await (await getGgDealsClient()).getPrices(ids, normalizeRegion(region));
    } catch (error) {
      logger.error('[gg.deals] getPrices failed:', error);
      return { prices: {}, error: 'unavailable' };
    }
  });
}
