/**
 * Settings IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import {
  settingsStore,
  DEFAULT_OLLAMA_RERANK_MODEL,
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
} from '../settings-store.js';
import { resetRerankTierCache } from '../rerank-engine.js';
import { resetRerankPullAttempts } from '../ollama-setup.js';
import { showOverlay, hideOverlay } from '../overlay-window.js';
import { getActiveSessions } from '../session-tracker.js';

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
      return {
        enabled: true,
        url: 'http://localhost:11434',
        model: 'gemma3:12b',
        useGeminiInstead: false,
        rerankModel: DEFAULT_OLLAMA_RERANK_MODEL,
        rerankQwenModel: DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
        neighborRerankEnabled: true,
        oracleRerankEnabled: true,
        oracleRerankBlend: 1,
      };
    }
  });

  ipcMain.handle('settings:setOllamaSettings', async (_event: any, settings: {
    enabled?: boolean;
    url?: string;
    model?: string;
    useGeminiInstead?: boolean;
    rerankModel?: string;
    rerankQwenModel?: string;
    neighborRerankEnabled?: boolean;
    oracleRerankEnabled?: boolean;
    oracleRerankBlend?: number;
  }) => {
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
      // Session-cached reranker tier and pull cooldown were both resolved
      // against the old URL / model tags, so they no longer describe reality.
      resetRerankTierCache();
      resetRerankPullAttempts();
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

  ipcMain.handle('settings:getPreferredChatProvider', async () => {
    try {
      return settingsStore.getPreferredChatProvider();
    } catch (error) {
      logger.error('[Settings] Error getting preferred chat provider:', error);
      return 'ollama';
    }
  });

  ipcMain.handle('settings:setPreferredChatProvider', async (_event: any, provider: string) => {
    try {
      const valid = ['ollama', 'gemini', 'azure-openai', 'anthropic'];
      if (typeof provider !== 'string' || !valid.includes(provider)) {
        return { success: false, error: 'Invalid provider' };
      }
      settingsStore.setPreferredChatProvider(provider as 'ollama' | 'gemini' | 'azure-openai' | 'anthropic');
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting preferred chat provider:', error);
      return { success: false, error: 'Failed to save' };
    }
  });

  ipcMain.handle('settings:getBetaFeatures', async () => {
    try {
      return settingsStore.getBetaFeatures();
    } catch (error) {
      logger.error('[Settings] Error getting beta features:', error);
      return false;
    }
  });

  ipcMain.handle('settings:setBetaFeatures', async (_event: any, enabled: boolean) => {
    try {
      if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid value' };
      settingsStore.setBetaFeatures(enabled);
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting beta features:', error);
      return { success: false, error: 'Failed to save' };
    }
  });

  ipcMain.handle('settings:getOverlayEnabled', async () => {
    try {
      return settingsStore.getOverlayEnabled();
    } catch (error) {
      logger.error('[Settings] Error getting overlay enabled:', error);
      return false;
    }
  });

  ipcMain.handle('settings:setOverlayEnabled', async (_event: any, enabled: boolean) => {
    try {
      if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid value' };
      settingsStore.setOverlayEnabled(enabled);
      // Apply live: turning it on shows the HUD immediately if a game is being
      // played right now; turning it off hides it regardless of session state.
      if (enabled) {
        if (getActiveSessions().length > 0) showOverlay();
      } else {
        hideOverlay();
      }
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting overlay enabled:', error);
      return { success: false, error: 'Failed to save' };
    }
  });
}
