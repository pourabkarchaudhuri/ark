/**
 * IPC Handler Registry
 * Imports and registers all domain-specific IPC handlers.
 */
import type { BrowserWindow as BrowserWindowType } from 'electron';

import { register as registerWindowHandlers } from './window-handlers.js';
import { register as registerSteamHandlers } from './steam-handlers.js';
import { register as registerEpicHandlers } from './epic-handlers.js';
import { register as registerRssHandlers } from './rss-handlers.js';
import { register as registerMetacriticHandlers } from './metacritic-handlers.js';
import { register as registerProxyHandlers } from './proxy-handlers.js';
import { register as registerAiHandlers } from './ai-handlers.js';
import { register as registerSettingsHandlers } from './settings-handlers.js';
import { register as registerDialogHandlers } from './dialog-handlers.js';
import { register as registerSessionHandlers } from './session-handlers.js';
import { register as registerWebviewHandlers } from './webview-handlers.js';
import { register as registerOllamaHandlers } from './ollama-handlers.js';
import { register as registerAnnHandlers } from './ann-handlers.js';
import { register as registerAnalyticsHandlers } from './analytics-handlers.js';
import { register as registerMlHandlers } from './ml-handlers.js';
import { register as registerDevlogHandlers } from './devlog-handlers.js';
import { register as registerEventScraperHandlers } from './event-scraper-handlers.js';
import { register as registerEgdataHandlers } from './egdata-handlers.js';
import { register as registerCatalogHandlers } from './catalog-handlers.js';

export function registerAllHandlers(getMainWindow: () => BrowserWindowType | null): void {
  registerWindowHandlers(getMainWindow);
  registerSteamHandlers();
  registerEpicHandlers();
  registerEgdataHandlers();
  registerCatalogHandlers();
  registerRssHandlers();
  registerMetacriticHandlers();
  registerProxyHandlers();
  registerAiHandlers();
  registerSettingsHandlers();
  registerDialogHandlers(getMainWindow);
  registerSessionHandlers();
  registerWebviewHandlers(getMainWindow);
  registerOllamaHandlers();
  registerAnnHandlers();
  registerAnalyticsHandlers();
  registerMlHandlers();
  registerDevlogHandlers();
  registerEventScraperHandlers();
}

// Re-export webview handler's destroy function for window cleanup
export { register as webviewHandlers } from './webview-handlers.js';
