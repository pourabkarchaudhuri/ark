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

interface Settings {
  version: number;
  apiKeys: {
    googleAI?: string; // Encrypted
  };
  preferences: {
    // Future preferences can go here
  };
  ollama: {
    enabled: boolean;
    url: string;
    model: string;
    useGeminiInstead: boolean; // When true, use Gemini API instead of Ollama
  };
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
    try {
      const settingsFile = getSettingsFilePath();
      if (fs.existsSync(settingsFile)) {
        const data = fs.readFileSync(settingsFile, 'utf-8');
        const parsed = JSON.parse(data) as Settings;
        
        if (parsed.version === SETTINGS_VERSION) {
          return parsed;
        }
        
        console.warn('[SettingsStore] Settings version mismatch, using defaults');
      }
    } catch (error) {
      console.error('[SettingsStore] Failed to load settings:', error);
    }

    return {
      version: SETTINGS_VERSION,
      apiKeys: {},
      preferences: {},
      ollama: {
        enabled: true,
        url: 'http://localhost:11434',
        model: 'gemma3:12b',
        useGeminiInstead: false, // Default: use Ollama as main provider
      },
    };
  }

  private saveSettings(): void {
    try {
      fs.writeFileSync(getSettingsFilePath(), JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (error) {
      console.error('[SettingsStore] Failed to save settings:', error);
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
    const key = getEncryptionKey();
    const [ivHex, encryptedText] = encrypted.split(':');
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
      console.error('[SettingsStore] Failed to decrypt API key:', error);
      return null;
    }
  }

  setGoogleAIKey(key: string): void {
    this.settings.apiKeys.googleAI = this.encrypt(key);
    this.saveSettings();
    console.log('[SettingsStore] Google AI key saved');
  }

  removeGoogleAIKey(): void {
    delete this.settings.apiKeys.googleAI;
    this.saveSettings();
    console.log('[SettingsStore] Google AI key removed');
  }

  hasGoogleAIKey(): boolean {
    return !!this.settings.apiKeys.googleAI;
  }

  // Ollama settings
  getOllamaSettings(): { enabled: boolean; url: string; model: string; useGeminiInstead: boolean } {
    const defaults = {
      enabled: true,
      url: 'http://localhost:11434',
      model: 'gemma3:12b',
      useGeminiInstead: false,
    };
    return {
      ...defaults,
      ...this.settings.ollama,
    };
  }

  setOllamaSettings(settings: { enabled?: boolean; url?: string; model?: string; useGeminiInstead?: boolean }): void {
    this.settings.ollama = {
      ...this.settings.ollama,
      ...settings,
    };
    this.saveSettings();
    console.log('[SettingsStore] Ollama settings updated');
  }

  isOllamaEnabled(): boolean {
    return this.settings.ollama?.enabled ?? true;
  }

  // Check if Gemini should be used instead of Ollama
  shouldUseGemini(): boolean {
    return this.hasGoogleAIKey() && (this.settings.ollama?.useGeminiInstead ?? false);
  }
}

export const settingsStore = new SettingsStore();

