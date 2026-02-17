/**
 * Settings IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { settingsStore } from '../settings-store.js';

export function register(): void {
  ipcMain.handle('settings:getApiKey', async () => {
    try {
      return settingsStore.getGoogleAIKey();
    } catch (error) {
      logger.error('[Settings] Error getting API key:', error);
      return null;
    }
  });

  ipcMain.handle('settings:setApiKey', async (_event: any, key: string) => {
    try {
      if (typeof key !== 'string' || key.length === 0 || key.length > 500) {
        return { success: false, error: 'Invalid API key' };
      }
      settingsStore.setGoogleAIKey(key);
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting API key:', error);
      return { success: false, error: 'Failed to save API key' };
    }
  });

  ipcMain.handle('settings:removeApiKey', async () => {
    try {
      settingsStore.removeGoogleAIKey();
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error removing API key:', error);
      throw error;
    }
  });

  ipcMain.handle('settings:hasApiKey', async () => {
    try {
      return settingsStore.hasGoogleAIKey();
    } catch (error) {
      logger.error('[Settings] Error checking API key:', error);
      return false;
    }
  });

  ipcMain.handle('settings:getOllamaSettings', async () => {
    try {
      return settingsStore.getOllamaSettings();
    } catch (error) {
      logger.error('[Settings] Error getting Ollama settings:', error);
      return { enabled: true, url: 'http://localhost:11434', model: 'gemma3:12b' };
    }
  });

  ipcMain.handle('settings:setOllamaSettings', async (_event: any, settings: { enabled?: boolean; url?: string; model?: string }) => {
    try {
      // Security: validate URL scheme (allow http/https only — do NOT block localhost/private IPs
      // since Ollama runs locally by default on http://localhost:11434)
      if (settings.url) {
        try {
          const parsed = new URL(settings.url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Invalid URL scheme "${parsed.protocol}" — only http: and https: are allowed`);
          }
        } catch (urlErr: any) {
          logger.warn(`[Settings] Rejected invalid Ollama URL: ${settings.url}`, urlErr.message);
          throw new Error(`Invalid Ollama URL: ${urlErr.message}`);
        }
      }
      settingsStore.setOllamaSettings(settings);
    } catch (error) {
      logger.error('[Settings] Error setting Ollama settings:', error);
      throw error;
    }
  });

  ipcMain.handle('settings:getAutoLaunch', async () => {
    try {
      return settingsStore.getAutoLaunch();
    } catch (error) {
      logger.error('[Settings] Error getting auto-launch setting:', error);
      return true; // Default to enabled
    }
  });

  ipcMain.handle('settings:setAutoLaunch', async (_event: any, enabled: boolean) => {
    try {
      if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid value' };
      settingsStore.setAutoLaunch(enabled);
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting auto-launch:', error);
      return { success: false, error: 'Failed to save setting' };
    }
  });
}
