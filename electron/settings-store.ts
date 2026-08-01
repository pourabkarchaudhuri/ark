/**
 * Settings Store
 * Handles persistent storage for application settings including API keys
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from './safe-logger.js';
import { atomicWriteFileSync } from './safe-write.js';

export type PreferredChatProvider = 'ollama' | 'gemini' | 'azure-openai' | 'anthropic';

interface Settings {
  version: number;
  apiKeys: {
    googleAI?: string; // Encrypted
  };
  preferences: {
    autoLaunch: boolean; // Launch app on system startup (default: true)
    preferredChatProvider?: PreferredChatProvider; // Single source of truth for chat model
    /** When false (default), AI Chat UI and cloud LLM providers are hidden; only Ollama is used. */
    betaFeatures?: boolean;
    /**
     * Auto-transition a game from "Want to Play" → "Playing" after a session ≥10 min
     * (v1.0.41). Opt-in — default false so the app never mutates status without the
     * user's explicit consent. When on, `libraryStore.updateEntry` is called with
     * `autoTransitionedAt` set to the moment the transition fired.
     */
    autoStatusTransition?: boolean;
    /**
     * Auto-transition a game from "Playing" → "On Hold" when it has had no session
     * for 30 days (v1.0.42). Default TRUE — user asked for this explicitly. The
     * renderer sweeps at app startup and every 60 minutes; when a stale entry is
     * found, `libraryStore.updateEntry` is called with `autoTransitionedAt`
     * stamped. `Completed` entries are never touched.
     */
    autoOnHoldTransition?: boolean;
    /**
     * Show the opt-in in-game overlay HUD (transparent corner badge + live
     * session timer) while a tracked game is running. Default false — the
     * overlay is entirely disabled unless the user turns it on. A global hotkey
     * (Ctrl+Shift+O) toggles visibility while enabled.
     */
    overlayEnabled?: boolean;
  };
  ollama: {
    enabled: boolean;
    url: string;
    model: string;
    useGeminiInstead: boolean; // Deprecated: use preferences.preferredChatProvider instead
    /** Ollama library name for POST /api/rerank (Embedding Space neighbor ordering). */
    rerankModel?: string;
    /**
     * Causal-LM reranker used when /api/rerank is unavailable, scored through
     * /api/generate logprobs. Separate from `rerankModel` because the two tiers
     * need different architectures — a BERT cross-encoder cannot be prompted.
     */
    rerankQwenModel?: string;
    /** Refine Embedding Space neighbor lists with /api/rerank (default true). */
    neighborRerankEnabled?: boolean;
    /** Refine Oracle shelves with /api/rerank (default true). */
    oracleRerankEnabled?: boolean;
    /** 0 = keep worker order within shelves, 1 = full rerank ordering (default 1). */
    oracleRerankBlend?: number;
    /**
     * When true (default), library/catalog embedding rewrites use facet chunks + int8
     * pooled storage. When false, fall back to whole-text float pooled writes.
     * Reads always decode both formats.
     */
    embeddingChunkingEnabled?: boolean;
    /**
     * When true (default), Embedding Space + Similar Games aggregate ANN hits
     * with max-sim over chunk ids. Oracle / graph stay pooled.
     */
    chunkAnnMaxSimEnabled?: boolean;
  };
}

/** Default rerank model — keep string in sync with `src/services/ollama-rerank.ts` `DEFAULT_OLLAMA_RERANK_MODEL`. */
export const DEFAULT_OLLAMA_RERANK_MODEL = 'dengcao/bge-reranker-v2-m3';

/** Default Qwen3 tier model — Apache 2.0, ~639 MB, works through /api/generate.
 *  Namespaced+quantized tag that actually exists in the Ollama registry. */
export const DEFAULT_OLLAMA_RERANK_QWEN_MODEL = 'dengcao/Qwen3-Reranker-0.6B:Q8_0';

/**
 * Legacy default shipped through 1.0.48. This tag never existed in the Ollama
 * registry, so pulls 404'd and the reranker silently fell back to cosine.
 * `loadSettings()` migrates any settings.json still pinned to this value onto
 * `DEFAULT_OLLAMA_RERANK_QWEN_MODEL`. Kept exported so the migration and its
 * tests share one source of truth.
 */
export const LEGACY_OLLAMA_RERANK_QWEN_MODEL = 'qwen3-reranker:0.6b';

/**
 * Rewrite the legacy Qwen3 reranker tag onto the current default, in place.
 * Returns true when a rewrite happened (caller should persist). Only the exact
 * legacy value is touched — a custom user tag is left alone. Extracted as a pure
 * function so the migration decision is unit-testable without the disk/electron
 * side effects of the SettingsStore singleton.
 */
export function migrateOllamaRerankQwenModel(ollama: { rerankQwenModel?: string }): boolean {
  if (ollama.rerankQwenModel === LEGACY_OLLAMA_RERANK_QWEN_MODEL) {
    ollama.rerankQwenModel = DEFAULT_OLLAMA_RERANK_QWEN_MODEL;
    return true;
  }
  return false;
}

const SETTINGS_VERSION = 1;

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Simple encryption key based on machine ID (stored locally, not sent anywhere)
const getEncryptionKey = (): Buffer => {
  const machineId = app.getPath('userData'); // Use userData path as a stable identifier
  return crypto.createHash('sha256').update(machineId).digest();
};

class SettingsStore {
  private settings: Settings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): Settings {
    const defaults = (): Settings => ({
      version: SETTINGS_VERSION,
      apiKeys: {},
      preferences: { autoLaunch: true, preferredChatProvider: 'ollama', betaFeatures: false, autoStatusTransition: false, autoOnHoldTransition: true, overlayEnabled: false },
      ollama: {
        enabled: true,
        url: 'http://localhost:11434',
        model: 'gemma3:12b',
        useGeminiInstead: false,
        rerankModel: DEFAULT_OLLAMA_RERANK_MODEL,
        rerankQwenModel: DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
        neighborRerankEnabled: true,
        oracleRerankEnabled: true,
        oracleRerankBlend: 1,
        embeddingChunkingEnabled: true,
        chunkAnnMaxSimEnabled: true,
      },
    });
    try {
      const settingsFile = getSettingsFilePath();
      if (fs.existsSync(settingsFile)) {
        const data = fs.readFileSync(settingsFile, 'utf-8');
        const parsed = JSON.parse(data) as Settings;
        if (parsed.version === SETTINGS_VERSION) {
          const merged: Settings = {
            ...defaults(),
            ...parsed,
            preferences: { ...defaults().preferences, ...parsed.preferences },
            ollama: { ...defaults().ollama, ...parsed.ollama },
          };
          if (!merged.preferences.preferredChatProvider) {
            merged.preferences.preferredChatProvider =
              parsed.ollama?.useGeminiInstead && parsed.apiKeys?.googleAI ? 'gemini' : 'ollama';
          }
          // Targeted migration (no SETTINGS_VERSION bump — that would reset ALL
          // user settings). Existing 1.0.48 installs have the bad Qwen3 reranker
          // tag persisted; rewrite ONLY that exact value so the pull can succeed.
          // Any custom user-chosen tag is left untouched.
          if (migrateOllamaRerankQwenModel(merged.ollama)) {
            // saveSettings() serializes this.settings, which the constructor has
            // not assigned yet during initial load — point it at merged first.
            this.settings = merged;
            this.saveSettings();
            logger.log('[SettingsStore] Migrated legacy Qwen3 reranker tag to new default');
          }
          return merged;
        }
        logger.warn('[SettingsStore] Settings version mismatch, using defaults');
      }
    } catch (error) {
      logger.error('[SettingsStore] Failed to load settings:', error);
    }
    return defaults();
  }

  private saveSettings(): void {
    try {
      atomicWriteFileSync(getSettingsFilePath(), JSON.stringify(this.settings, null, 2));
    } catch (error) {
      logger.error('[SettingsStore] Failed to save settings:', error);
      throw error;
    }
  }

  // Encrypt a value
  private encrypt(text: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  // Decrypt a value
  private decrypt(encrypted: string): string {
    if (typeof encrypted !== 'string' || !encrypted.includes(':')) {
      throw new Error('Malformed encrypted value');
    }
    const colonIdx = encrypted.indexOf(':');
    const ivHex = encrypted.slice(0, colonIdx);
    const encryptedText = encrypted.slice(colonIdx + 1);
    if (!/^[0-9a-f]{32}$/i.test(ivHex) || encryptedText.length === 0) {
      throw new Error('Malformed encrypted value: invalid IV or empty ciphertext');
    }
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // API Key Management
  getGoogleAIKey(): string | null {
    const encrypted = this.settings.apiKeys.googleAI;
    if (!encrypted) return null;
    
    try {
      return this.decrypt(encrypted);
    } catch (error) {
      logger.error('[SettingsStore] Failed to decrypt API key:', error);
      return null;
    }
  }

  setGoogleAIKey(key: string): void {
    this.settings.apiKeys.googleAI = this.encrypt(key);
    this.saveSettings();
    logger.log('[SettingsStore] Google AI key saved');
  }

  removeGoogleAIKey(): void {
    delete this.settings.apiKeys.googleAI;
    this.saveSettings();
    logger.log('[SettingsStore] Google AI key removed');
  }

  hasGoogleAIKey(): boolean {
    return !!this.settings.apiKeys.googleAI;
  }

  // Ollama settings
  getOllamaSettings(): {
    enabled: boolean;
    url: string;
    model: string;
    useGeminiInstead: boolean;
    rerankModel: string;
    rerankQwenModel: string;
    neighborRerankEnabled: boolean;
    oracleRerankEnabled: boolean;
    oracleRerankBlend: number;
    embeddingChunkingEnabled: boolean;
    chunkAnnMaxSimEnabled: boolean;
  } {
    const defaults = {
      enabled: true,
      url: 'http://localhost:11434',
      model: 'gemma3:12b',
      useGeminiInstead: false,
      rerankModel: DEFAULT_OLLAMA_RERANK_MODEL,
      rerankQwenModel: DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
      neighborRerankEnabled: true,
      oracleRerankEnabled: true,
      oracleRerankBlend: 1,
      embeddingChunkingEnabled: true,
      chunkAnnMaxSimEnabled: true,
    };
    const o = this.settings.ollama;
    let blend =
      typeof o?.oracleRerankBlend === 'number' && Number.isFinite(o.oracleRerankBlend)
        ? o.oracleRerankBlend
        : defaults.oracleRerankBlend;
    blend = Math.min(1, Math.max(0, blend));
    return {
      ...defaults,
      ...o,
      rerankModel: o?.rerankModel?.trim() || defaults.rerankModel,
      rerankQwenModel: o?.rerankQwenModel?.trim() || defaults.rerankQwenModel,
      neighborRerankEnabled: o?.neighborRerankEnabled !== false,
      oracleRerankEnabled: o?.oracleRerankEnabled !== false,
      oracleRerankBlend: blend,
      embeddingChunkingEnabled: o?.embeddingChunkingEnabled !== false,
      chunkAnnMaxSimEnabled: o?.chunkAnnMaxSimEnabled !== false,
    };
  }

  setOllamaSettings(settings: {
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
  }): void {
    const next = { ...settings };
    if (next.rerankModel !== undefined) {
      const t = String(next.rerankModel).trim();
      next.rerankModel = t.length > 200 ? t.slice(0, 200) : t;
    }
    if (next.rerankQwenModel !== undefined) {
      const t = String(next.rerankQwenModel).trim();
      next.rerankQwenModel = t.length > 200 ? t.slice(0, 200) : t;
    }
    if (next.oracleRerankBlend !== undefined) {
      const b = Number(next.oracleRerankBlend);
      next.oracleRerankBlend = Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 1;
    }
    this.settings.ollama = {
      ...this.settings.ollama,
      ...next,
    };
    this.saveSettings();
    logger.log('[SettingsStore] Ollama settings updated');
  }

  isOllamaEnabled(): boolean {
    return this.settings.ollama?.enabled ?? true;
  }

  // Check if Gemini should be used instead of Ollama (deprecated: use getPreferredChatProvider)
  shouldUseGemini(): boolean {
    return this.getPreferredChatProvider() === 'gemini';
  }

  getBetaFeatures(): boolean {
    return this.settings.preferences?.betaFeatures === true;
  }

  setBetaFeatures(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: true, preferredChatProvider: 'ollama', betaFeatures: enabled };
    } else {
      this.settings.preferences.betaFeatures = enabled;
      if (!enabled && this.settings.preferences.preferredChatProvider && this.settings.preferences.preferredChatProvider !== 'ollama') {
        this.settings.preferences.preferredChatProvider = 'ollama';
      }
    }
    this.saveSettings();
    logger.log(`[SettingsStore] Beta features set to ${enabled}`);
  }

  getPreferredChatProvider(): PreferredChatProvider {
    const p = this.settings.preferences?.preferredChatProvider;
    const valid =
      p === 'ollama' || p === 'gemini' || p === 'azure-openai' || p === 'anthropic';
    const raw: PreferredChatProvider = valid ? p! : 'ollama';
    if (!this.getBetaFeatures() && raw !== 'ollama') return 'ollama';
    return raw;
  }

  setPreferredChatProvider(provider: PreferredChatProvider): void {
    if (!this.getBetaFeatures() && provider !== 'ollama') {
      logger.warn('[SettingsStore] Rejecting non-Ollama provider while beta features are off');
      provider = 'ollama';
    }
    if (!this.settings.preferences) this.settings.preferences = { autoLaunch: true };
    this.settings.preferences.preferredChatProvider = provider;
    this.saveSettings();
    logger.log('[SettingsStore] Preferred chat provider set to', provider);
  }

  // Auto-launch settings
  getAutoLaunch(): boolean {
    return this.settings.preferences?.autoLaunch ?? true;
  }

  setAutoLaunch(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: enabled };
    } else {
      this.settings.preferences.autoLaunch = enabled;
    }
    this.saveSettings();

    // Apply immediately via Electron's login item settings
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: enabled ? ['--hidden'] : [],
      });
    } catch (err) {
      logger.error('[SettingsStore] Failed to set login item settings:', err);
    }

    logger.log(`[SettingsStore] Auto-launch set to ${enabled}`);
  }

  // Auto Want-to-Play → Playing transition (opt-in; default false).
  getAutoStatusTransition(): boolean {
    return this.settings.preferences?.autoStatusTransition === true;
  }

  setAutoStatusTransition(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: true, autoStatusTransition: enabled };
    } else {
      this.settings.preferences.autoStatusTransition = enabled;
    }
    this.saveSettings();
    logger.log(`[SettingsStore] Auto status transition set to ${enabled}`);
  }

  // Auto Playing → On Hold transition after 30 days of no play (default: true; v1.0.42).
  getAutoOnHoldTransition(): boolean {
    // Undefined counts as enabled — user explicitly asked for this default.
    return this.settings.preferences?.autoOnHoldTransition !== false;
  }

  setAutoOnHoldTransition(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: true, autoOnHoldTransition: enabled };
    } else {
      this.settings.preferences.autoOnHoldTransition = enabled;
    }
    this.saveSettings();
    logger.log(`[SettingsStore] Auto On Hold transition set to ${enabled}`);
  }

  // In-game overlay HUD (opt-in; default false).
  getOverlayEnabled(): boolean {
    return this.settings.preferences?.overlayEnabled === true;
  }

  setOverlayEnabled(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: true, overlayEnabled: enabled };
    } else {
      this.settings.preferences.overlayEnabled = enabled;
    }
    this.saveSettings();
    logger.log(`[SettingsStore] Overlay enabled set to ${enabled}`);
  }
}

export const settingsStore = new SettingsStore();

