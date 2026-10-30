/**
 * Settings Store
 * Handles persistent storage for application settings including API keys
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { app, safeStorage } = electron;
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from './safe-logger.js';
import { atomicWriteFileSync } from './safe-write.js';
import { applyLoginItem } from './login-item.js';
import { isImplementedChatProvider } from '../src/lib/chat-providers.js';

export type PreferredChatProvider = 'ollama' | 'gemini' | 'azure-openai' | 'anthropic';

interface Settings {
  version: number;
  apiKeys: {
    /** Gemini key: OS-encrypted ("ss:") since 1.0.97; older installs hold the local cipher until first read. */
    googleAI?: string;
    /** gg.deals API key: OS-encrypted ("ss:" + safeStorage) when available, else the local cipher. */
    ggDeals?: string;
    /** Azure OpenAI key (1.0.97): same storage as ggDeals. Never readable from the renderer. */
    azureOpenAI?: string;
    /** Anthropic key (1.0.97): same storage as ggDeals. Never readable from the renderer. */
    anthropic?: string;
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
     * for 4 weeks (v1.0.42; 30 days before v1.0.88). Default TRUE — user asked for this explicitly. The
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
    /**
     * Send anonymous usage analytics (app launch, screen views with game ids stripped) to
     * Google Analytics (v1.0.97). Default false — nothing is sent until the user turns it on
     * in Settings; turning it off also deletes the stored analytics client id.
     */
    analyticsEnabled?: boolean;
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
     * Texts per embedding request to Ollama (v1.0.74). 0 / absent = Auto (256 on GPU,
     * 100 on CPU). Clamped to [EMBED_BATCH_MIN, EMBED_BATCH_MAX].
     */
    embeddingBatchSize?: number;
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
    /**
     * When true, ANN uses Matryoshka 256-d prefixes (forces index clear + rebuild).
     * Default off until rebuild smoke is green.
     */
    embeddingMrl256Enabled?: boolean;
    /**
     * Context window (num_ctx) for AI chat on Ollama (v1.0.97). Ollama's own 2-4k
     * default cut off the system prompt or the question. Clamped by clampChatNumCtx.
     */
    chatNumCtx?: number;
  };
}

export const DEFAULT_CHAT_NUM_CTX = 8192;
const CHAT_NUM_CTX_MIN = 2048;
const CHAT_NUM_CTX_MAX = 131072;

/** Clamp an Ollama chat num_ctx value; anything unusable falls back to the 8192 default. */
export function clampChatNumCtx(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHAT_NUM_CTX;
  return Math.min(CHAT_NUM_CTX_MAX, Math.max(CHAT_NUM_CTX_MIN, Math.round(n)));
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

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Disk + OS-encryption seam so the store can be unit-tested without Electron. */
export interface SettingsStoreIo {
  settingsPath(): string;
  /** Seed for the legacy local cipher (the userData path). */
  cipherSeed(): string;
  readFile(p: string): string;
  writeFile(p: string, data: string): void;
  copyFile(src: string, dst: string): void;
  sleepSync(ms: number): void;
  now(): number;
  safeStorage: SafeStorageLike | null | undefined;
}

const defaultIo: SettingsStoreIo = {
  settingsPath: getSettingsFilePath,
  cipherSeed: () => app.getPath('userData'),
  readFile: (p) => fs.readFileSync(p, 'utf-8'),
  writeFile: (p, data) => atomicWriteFileSync(p, data),
  copyFile: (src, dst) => fs.copyFileSync(src, dst),
  sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  now: () => Date.now(),
  safeStorage,
};

/** Read errors that usually clear on their own (antivirus, backup tools, a second instance). */
const TRANSIENT_READ_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);
const READ_RETRIES = 2;

type SecretSlot = 'googleAI' | 'ggDeals' | 'azureOpenAI' | 'anthropic';

export const EMBED_BATCH_MIN = 16;
export const EMBED_BATCH_MAX = 512;

/** 0 = Auto; anything else is rounded and clamped to [EMBED_BATCH_MIN, EMBED_BATCH_MAX]. */
export function clampEmbeddingBatchSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(EMBED_BATCH_MAX, Math.max(EMBED_BATCH_MIN, Math.round(n)));
}

export class SettingsStore {
  private settings: Settings;
  /**
   * settings.json exists but could not be read (still locked after retries, or its
   * backup failed). Saving would replace the user's real file with defaults, so the
   * next save backs it up first and is skipped if that backup fails too.
   */
  private loadFailed = false;

  constructor(private readonly io: SettingsStoreIo = defaultIo) {
    this.settings = this.loadSettings();
  }

  /** Copy the current settings.json aside; returns false when the copy failed. */
  private backupSettingsFile(suffix: string): boolean {
    let dest = '';
    try {
      const file = this.io.settingsPath();
      dest = `${file}.${suffix}`;
      this.io.copyFile(file, dest);
      logger.warn(`[SettingsStore] Kept a copy of the previous settings file at ${dest}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true; // nothing left to protect
      logger.error(`[SettingsStore] Could not back up the settings file to ${dest}:`, (error as Error)?.message);
      return false;
    }
  }

  private readSettingsFile(file: string): string | null {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.io.readFile(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return null;
        if (code && TRANSIENT_READ_ERRORS.has(code) && attempt < READ_RETRIES) {
          this.io.sleepSync(50);
          continue;
        }
        throw error;
      }
    }
  }

  private loadSettings(): Settings {
    const defaults = (): Settings => ({
      version: SETTINGS_VERSION,
      apiKeys: {},
      preferences: { autoLaunch: true, preferredChatProvider: 'ollama', betaFeatures: false, autoStatusTransition: false, autoOnHoldTransition: true, overlayEnabled: false, analyticsEnabled: false },
      ollama: {
        enabled: true,
        url: 'http://localhost:11434',
        model: 'gemma3:12b',
        useGeminiInstead: false,
        rerankModel: DEFAULT_OLLAMA_RERANK_MODEL,
        rerankQwenModel: DEFAULT_OLLAMA_RERANK_QWEN_MODEL,
        neighborRerankEnabled: true,
        oracleRerankEnabled: true,
        oracleRerankBlend: 0.6,
        embeddingChunkingEnabled: true,
        chunkAnnMaxSimEnabled: true,
        embeddingMrl256Enabled: false,
      },
    });
    let data: string | null;
    try {
      data = this.readSettingsFile(this.io.settingsPath());
    } catch (error) {
      // Locked or unreadable: use defaults for now, but never let a save overwrite it unseen.
      logger.error('[SettingsStore] Failed to read settings; using defaults without overwriting the file:', error);
      this.loadFailed = true;
      return defaults();
    }
    if (data === null) return defaults();
    let parsed: Settings;
    try {
      parsed = JSON.parse(data) as Settings;
      if (!parsed || typeof parsed !== 'object') throw new Error('Settings file is not an object');
    } catch (error) {
      logger.error('[SettingsStore] Settings file is corrupt, using defaults:', error);
      if (!this.backupSettingsFile(`corrupt-${this.io.now()}`)) this.loadFailed = true;
      return defaults();
    }
    try {
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
      if (!this.backupSettingsFile(`v${String(parsed.version).replace(/[^\w.-]/g, '_')}.bak`)) this.loadFailed = true;
    } catch (error) {
      logger.error('[SettingsStore] Failed to load settings:', error);
    }
    return defaults();
  }

  private saveSettings(): void {
    if (this.loadFailed) {
      // Keep the unreadable original before the first save replaces it.
      if (!this.backupSettingsFile(`unreadable-${this.io.now()}`)) {
        logger.warn('[SettingsStore] Not saving: the existing settings file could not be read or backed up');
        return;
      }
      this.loadFailed = false;
    }
    try {
      this.io.writeFile(this.io.settingsPath(), JSON.stringify(this.settings, null, 2));
    } catch (error) {
      logger.error('[SettingsStore] Failed to save settings:', error);
      throw error;
    }
  }

  // Legacy local cipher: the key is a hash of the userData path, so it only hides values
  // from casual reading. New secrets use encryptSecret(); this stays as its fallback.
  private getEncryptionKey(): Buffer {
    return crypto.createHash('sha256').update(this.io.cipherSeed()).digest();
  }

  // Encrypt a value
  private encrypt(text: string): string {
    const key = this.getEncryptionKey();
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
    const key = this.getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // API Key Management (Gemini). Main process only: the renderer can set, check and remove it.
  getGoogleAIKey(): string | null {
    const plain = this.readSecret('googleAI', 'Google AI');
    const stored = this.settings.apiKeys.googleAI;
    // Lazy migration from the legacy path-derived cipher to OS encryption. Only persisted
    // when OS encryption is really available, so a machine without it keeps a readable key.
    if (plain !== null && stored && !stored.startsWith('ss:') && !this.loadFailed) {
      const upgraded = this.encryptSecret(plain);
      if (upgraded.startsWith('ss:')) {
        this.settings.apiKeys.googleAI = upgraded;
        try {
          this.saveSettings();
          this.secretMemo.googleAI = { stored: upgraded, plain };
          logger.log('[SettingsStore] Google AI key moved to OS encryption');
        } catch {
          this.settings.apiKeys.googleAI = stored;
        }
      }
    }
    return plain;
  }

  setGoogleAIKey(key: string): void {
    this.writeSecret('googleAI', key);
    logger.log('[SettingsStore] Google AI key saved');
  }

  removeGoogleAIKey(): void {
    this.writeSecret('googleAI', null);
    logger.log('[SettingsStore] Google AI key removed');
  }

  hasGoogleAIKey(): boolean {
    return !!this.settings.apiKeys.googleAI;
  }

  // Secrets that never leave the main process: Windows/OS encryption (safeStorage) when available,
  // else the local cipher above. The "ss:" prefix says which one was used.
  private encryptSecret(value: string): string {
    try {
      const ss = this.io.safeStorage;
      if (ss?.isEncryptionAvailable?.()) {
        return 'ss:' + ss.encryptString(value).toString('base64');
      }
    } catch {
      /* fall back */
    }
    return this.encrypt(value);
  }

  private decryptSecret(stored: string): string {
    if (stored.startsWith('ss:')) {
      if (!this.io.safeStorage) throw new Error('OS encryption is not available');
      return this.io.safeStorage.decryptString(Buffer.from(stored.slice(3), 'base64'));
    }
    return this.decrypt(stored);
  }

  /** Decrypted value per stored ciphertext (OS decryption runs once, not per request). */
  private secretMemo: Partial<Record<SecretSlot, { stored: string; plain: string | null }>> = {};

  private readSecret(slot: SecretSlot, label: string): string | null {
    const stored = this.settings.apiKeys[slot];
    if (!stored) return null;
    const memo = this.secretMemo[slot];
    if (memo?.stored === stored) return memo.plain;
    let plain: string | null = null;
    try {
      plain = this.decryptSecret(stored);
    } catch (error) {
      // e.g. settings copied from another PC: ask the user to enter the key again.
      logger.error(`[SettingsStore] Could not decrypt the ${label} key; it needs to be entered again:`, (error as Error).message);
    }
    this.secretMemo[slot] = { stored, plain };
    return plain;
  }

  private writeSecret(slot: SecretSlot, key: string | null): void {
    delete this.secretMemo[slot];
    if (key === null) delete this.settings.apiKeys[slot];
    else this.settings.apiKeys[slot] = this.encryptSecret(key);
    this.saveSettings();
  }

  /** Main process only — there is deliberately no IPC getter for this key. */
  getGgDealsKey(): string | null {
    return this.readSecret('ggDeals', 'gg.deals');
  }

  setGgDealsKey(key: string): void {
    this.writeSecret('ggDeals', key);
    logger.log('[SettingsStore] gg.deals key saved');
  }

  clearGgDealsKey(): void {
    this.writeSecret('ggDeals', null);
    logger.log('[SettingsStore] gg.deals key removed');
  }

  hasGgDealsKey(): boolean {
    return this.getGgDealsKey() !== null;
  }

  /** Main process only: the renderer keeps endpoint/deployment, never the key. */
  getAzureOpenAIKey(): string | null {
    return this.readSecret('azureOpenAI', 'Azure OpenAI');
  }

  setAzureOpenAIKey(key: string): void {
    this.writeSecret('azureOpenAI', key);
    logger.log('[SettingsStore] Azure OpenAI key saved');
  }

  clearAzureOpenAIKey(): void {
    this.writeSecret('azureOpenAI', null);
    logger.log('[SettingsStore] Azure OpenAI key removed');
  }

  hasAzureOpenAIKey(): boolean {
    return this.getAzureOpenAIKey() !== null;
  }

  /** Main process only. Kept for the AI router (B35), which serves Anthropic chat. */
  getAnthropicKey(): string | null {
    return this.readSecret('anthropic', 'Anthropic');
  }

  setAnthropicKey(key: string): void {
    this.writeSecret('anthropic', key);
    logger.log('[SettingsStore] Anthropic key saved');
  }

  clearAnthropicKey(): void {
    this.writeSecret('anthropic', null);
    logger.log('[SettingsStore] Anthropic key removed');
  }

  hasAnthropicKey(): boolean {
    return this.getAnthropicKey() !== null;
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
    embeddingMrl256Enabled: boolean;
    embeddingBatchSize: number;
    chatNumCtx: number;
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
      oracleRerankBlend: 0.6,
      embeddingChunkingEnabled: true,
      chunkAnnMaxSimEnabled: true,
      embeddingMrl256Enabled: false,
      embeddingBatchSize: 0,
      chatNumCtx: DEFAULT_CHAT_NUM_CTX,
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
      embeddingMrl256Enabled: o?.embeddingMrl256Enabled === true,
      embeddingBatchSize: clampEmbeddingBatchSize(o?.embeddingBatchSize),
      chatNumCtx: clampChatNumCtx(o?.chatNumCtx),
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
    embeddingMrl256Enabled?: boolean;
    embeddingBatchSize?: number;
    chatNumCtx?: number;
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
      next.oracleRerankBlend = Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 0.6;
    }
    if (next.embeddingBatchSize !== undefined) next.embeddingBatchSize = clampEmbeddingBatchSize(next.embeddingBatchSize);
    if (next.chatNumCtx !== undefined) next.chatNumCtx = clampChatNumCtx(next.chatNumCtx);
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
    // 'anthropic' has no chat backend: a stored value falls back to the default.
    const raw: PreferredChatProvider = isImplementedChatProvider(p) ? p : 'ollama';
    if (!this.getBetaFeatures() && raw !== 'ollama') return 'ollama';
    return raw;
  }

  setPreferredChatProvider(provider: PreferredChatProvider): void {
    if (!this.getBetaFeatures() && provider !== 'ollama') {
      logger.warn('[SettingsStore] Rejecting non-Ollama provider while beta features are off');
      provider = 'ollama';
    }
    if (!isImplementedChatProvider(provider)) {
      logger.warn(`[SettingsStore] Rejecting unsupported chat provider "${provider}"`);
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

    // Apply immediately via Electron's login item settings (packaged builds only — see login-item.ts)
    try {
      applyLoginItem(enabled);
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

  // Auto Playing → On Hold transition after 4 weeks of no play (default: true; v1.0.42, 28 days since v1.0.88).
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

  // Usage analytics (opt-in; default false). Callers go through analytics.ts setAnalyticsEnabled,
  // which also deletes the client id on opt-out.
  getAnalyticsEnabled(): boolean {
    return this.settings.preferences?.analyticsEnabled === true;
  }

  setAnalyticsEnabled(enabled: boolean): void {
    if (!this.settings.preferences) {
      this.settings.preferences = { autoLaunch: true, analyticsEnabled: enabled };
    } else {
      this.settings.preferences.analyticsEnabled = enabled;
    }
    this.saveSettings();
    logger.log(`[SettingsStore] Analytics enabled set to ${enabled}`);
  }
}

export const settingsStore = new SettingsStore();

