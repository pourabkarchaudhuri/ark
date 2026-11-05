/**
 * Settings IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { netFetch } from '../net-fetch.js';
import { secretHint } from '../secret-hint.js';
import {
  settingsStore,
  DEFAULT_OLLAMA_RERANK_MODEL,
  DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
} from '../settings-store.js';
import { resetRerankTierCache } from '../rerank-engine.js';
import { resetRerankPullAttempts } from '../ollama-setup.js';
import {
  activateOverlay,
  deactivateOverlay,
  isOverlayCycleHotkeyRegistered,
  notifyOverlayEnabledChanged,
} from '../overlay-window.js';
import { getActiveSessions, syncOverlayVisibilityLatch } from '../session-tracker.js';
import { clearIndex, syncAnnDimsFromSettings } from '../ann-index.js';
import { isImplementedChatProvider } from '../../src/lib/chat-providers.js';
import { followChatProvider, onLegacyKeysChanged } from '../ai-router/service.js';

/**
 * Cloud API keys are URL-safe tokens. Rejecting anything else is the backstop that
 * stops a masked display value ("AIza••••…") from ever replacing a real key.
 */
const API_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_API_KEY_LEN = 500;

function cleanApiKey(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const t = key.trim();
  return t.length > 0 && t.length <= MAX_API_KEY_LEN && API_KEY_PATTERN.test(t) ? t : null;
}

type SaveResult = { success: boolean; error?: string };

export async function setGeminiApiKey(key: unknown): Promise<SaveResult> {
  const clean = cleanApiKey(key);
  if (!clean) return { success: false, error: 'That does not look like an API key.' };
  try {
    settingsStore.setGoogleAIKey(clean);
    onLegacyKeysChanged();
    return { success: true };
  } catch (error) {
    logger.error('[Settings] Error setting API key:', error);
    return { success: false, error: 'Failed to save API key' };
  }
}

export async function setAzureKeyIpc(key: unknown): Promise<SaveResult> {
  const clean = cleanApiKey(key);
  if (!clean) return { success: false, error: 'That does not look like an Azure OpenAI key.' };
  try {
    settingsStore.setAzureOpenAIKey(clean);
    onLegacyKeysChanged();
    return { success: true };
  } catch (error) {
    logger.error('[Settings] Error setting Azure OpenAI key:', error);
    return { success: false, error: 'Failed to save the key' };
  }
}

export async function setAnthropicKeyIpc(key: unknown): Promise<SaveResult> {
  const clean = cleanApiKey(key);
  if (!clean) return { success: false, error: 'That does not look like an Anthropic key.' };
  try {
    settingsStore.setAnthropicKey(clean);
    onLegacyKeysChanged();
    return { success: true };
  } catch (error) {
    logger.error('[Settings] Error setting Anthropic key:', error);
    return { success: false, error: 'Failed to save the key' };
  }
}

export async function setPreferredChatProviderIpc(provider: unknown): Promise<SaveResult> {
  // Only providers with a chat backend (CHAT_IMPLEMENTED_PROVIDERS) are accepted; the chat
  // route of the AI router follows the selection (Anthropic is served by it).
  if (!isImplementedChatProvider(provider)) return { success: false, error: 'Invalid provider' };
  try {
    settingsStore.setPreferredChatProvider(provider);
    followChatProvider(settingsStore.getPreferredChatProvider());
    return { success: true };
  } catch (error) {
    logger.error('[Settings] Error setting preferred chat provider:', error);
    return { success: false, error: 'Failed to save' };
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; statusText: string; text(): Promise<string>;
}>;

/**
 * Azure OpenAI "Test connection". Runs in main so the key never has to be readable by
 * the renderer: the renderer sends endpoint/deployment/version and main adds the key.
 */
export async function testAzureConnection(
  input: unknown,
  deps: { fetch: FetchLike } = { fetch: (url, init) => netFetch(url, init, { timeoutMs: 30_000 }) },
): Promise<{ ok: boolean; message: string }> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const endpoint = str(o.endpoint, 500).replace(/\/+$/, '');
  const deployment = str(o.deployment, 200);
  const apiVersion = str(o.apiVersion, 50) || '2024-12-01-preview';
  const key = settingsStore.getAzureOpenAIKey();
  if (!endpoint || !deployment || !key) {
    return { ok: false, message: 'Endpoint, API key, and deployment name are required.' };
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad scheme');
  } catch {
    return { ok: false, message: 'The endpoint must be an http(s) address.' };
  }
  try {
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_completion_tokens: 20 }),
    });
    if (res.ok) {
      void res.text().catch(() => ''); // release the connection
      return { ok: true, message: 'Connection successful. Azure OpenAI is reachable.' };
    }
    const body = await res.text().catch(() => '');
    return { ok: false, message: body.slice(0, 1000) || `HTTP ${res.status} ${res.statusText}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Network or request failed.' };
  }
}

export function register(): void {
  // The decrypted Gemini key never goes to the renderer (v1.0.97): only whether
  // one is stored plus a first4…last4 hint for the settings field.
  ipcMain.handle('settings:getApiKeyHint', async () => {
    try {
      return secretHint(settingsStore.getGoogleAIKey());
    } catch (error) {
      logger.error('[Settings] Error reading API key hint:', error);
      return { has: false, hint: '' };
    }
  });

  // There is deliberately no settings:getApiKey: the Gemini key stays in main (1.0.97).
  ipcMain.handle('settings:setApiKey', (_event: any, key: unknown) => setGeminiApiKey(key));

  ipcMain.handle('settings:removeApiKey', async () => {
    try {
      settingsStore.removeGoogleAIKey();
      onLegacyKeysChanged();
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

  ipcMain.handle('settings:hasAzureKey', async () => {
    try {
      return settingsStore.hasAzureOpenAIKey();
    } catch {
      return false;
    }
  });

  ipcMain.handle('settings:setAzureKey', (_event: any, key: unknown) => setAzureKeyIpc(key));

  ipcMain.handle('settings:clearAzureKey', async () => {
    try {
      settingsStore.clearAzureOpenAIKey();
      onLegacyKeysChanged();
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error removing Azure OpenAI key:', error);
      return { success: false };
    }
  });

  ipcMain.handle('settings:testAzureConnection', (_event: any, input: unknown) => testAzureConnection(input));

  ipcMain.handle('settings:hasAnthropicKey', async () => {
    try {
      return settingsStore.hasAnthropicKey();
    } catch {
      return false;
    }
  });

  ipcMain.handle('settings:setAnthropicKey', (_event: any, key: unknown) => setAnthropicKeyIpc(key));

  ipcMain.handle('settings:clearAnthropicKey', async () => {
    try {
      settingsStore.clearAnthropicKey();
      onLegacyKeysChanged();
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error removing Anthropic key:', error);
      return { success: false };
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
        oracleRerankBlend: 0.6,
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
    embeddingChunkingEnabled?: boolean;
    chunkAnnMaxSimEnabled?: boolean;
    embeddingMrl256Enabled?: boolean;
    embeddingBatchSize?: number;
    chatNumCtx?: number;
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
      const prevMrl = settingsStore.getOllamaSettings().embeddingMrl256Enabled;
      settingsStore.setOllamaSettings(settings);
      // Session-cached reranker tier and pull cooldown were both resolved
      // against the old URL / model tags, so they no longer describe reality.
      resetRerankTierCache();
      resetRerankPullAttempts();
      // MRL-256 toggles ANN dimensionality — clear on-disk index so rebuild uses new dims.
      if (
        settings.embeddingMrl256Enabled !== undefined
        && settings.embeddingMrl256Enabled !== prevMrl
      ) {
        clearIndex();
        syncAnnDimsFromSettings();
        logger.log(
          `[Settings] MRL-256 ${settings.embeddingMrl256Enabled ? 'enabled' : 'disabled'} — ANN index cleared`,
        );
      }
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

  ipcMain.handle('settings:setPreferredChatProvider', (_event: any, provider: unknown) => setPreferredChatProviderIpc(provider));

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
      // Register/unregister the global hotkeys (main.ts installs the hook).
      notifyOverlayEnabledChanged(enabled);
      // Apply live: enable + active sessions → create/show; otherwise destroy HWND.
      if (enabled && getActiveSessions().length > 0) {
        activateOverlay();
        syncOverlayVisibilityLatch(true);
      } else {
        deactivateOverlay();
        syncOverlayVisibilityLatch(false);
      }
      return { success: true };
    } catch (error) {
      logger.error('[Settings] Error setting overlay enabled:', error);
      return { success: false, error: 'Failed to save' };
    }
  });

  ipcMain.handle('settings:getOverlayCycleHotkeyRegistered', async () => {
    try {
      return isOverlayCycleHotkeyRegistered();
    } catch (error) {
      logger.error('[Settings] Error reading overlay cycle hotkey status:', error);
      return false;
    }
  });
}
