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

export function registerAllHandlers(getMainWindow: () => BrowserWindowType | null): void {
  registerWindowHandlers(getMainWindow);
  registerSteamHandlers();
  registerEpicHandlers();
  registerRssHandlers();
  registerMetacriticHandlers();
  registerProxyHandlers();
  registerAiHandlers();
  registerSettingsHandlers();
  registerDialogHandlers(getMainWindow);
  registerSessionHandlers();
  registerWebviewHandlers(getMainWindow);
  registerOllamaHandlers();
}

// Re-export webview handler's destroy function for window cleanup
export { register as webviewHandlers } from './webview-handlers.js';
