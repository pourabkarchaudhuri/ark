/**
 * Analytics IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { trackEvent, trackPageView } from '../analytics.js';

export function register(): void {
  ipcMain.handle('analytics:trackEvent', async (_event: any, name: string, params?: Record<string, string | number | boolean>) => {
    trackEvent(name, params || {});
    return true;
  });

  ipcMain.handle('analytics:trackPageView', async (_event: any, page: string) => {
    trackPageView(page);
    return true;
  });
}
