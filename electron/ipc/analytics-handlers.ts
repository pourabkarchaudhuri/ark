/**
 * Analytics IPC Handlers
 *
 * Events are opt-in (analytics.ts checks the setting before sending). The
 * renderer may only send allow-listed event names with primitive params.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import {
  trackEvent,
  trackPageView,
  sanitizeRendererEvent,
  isAnalyticsEnabled,
  setAnalyticsEnabled,
} from '../analytics.js';

/** Handler body for `analytics:trackEvent`; false when the event is rejected. */
export function handleRendererTrackEvent(name: unknown, params: unknown): boolean {
  const clean = sanitizeRendererEvent(name, params);
  if (!clean) return false;
  trackEvent(name as string, clean);
  return true;
}

export function register(): void {
  ipcMain.handle('analytics:trackEvent', async (_event: any, name: unknown, params?: unknown) =>
    handleRendererTrackEvent(name, params));

  ipcMain.handle('analytics:trackPageView', async (_event: any, page: unknown) => {
    if (typeof page !== 'string') return false;
    trackPageView(page);
    return true;
  });

  ipcMain.handle('analytics:getEnabled', async () => isAnalyticsEnabled());

  ipcMain.handle('analytics:setEnabled', async (_event: any, enabled: unknown) => {
    try {
      if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid value' };
      setAnalyticsEnabled(enabled);
      return { success: true };
    } catch (error) {
      logger.error('[Analytics] Error saving analytics setting:', error);
      return { success: false, error: 'Failed to save' };
    }
  });
}
