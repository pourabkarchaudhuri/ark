/**
 * Types of the Ollama settings bridge (`window.settings`), shared by the Settings pages (1.0.97 B37).
 */
export type PreferredChatProvider = 'ollama' | 'gemini' | 'azure-openai' | 'anthropic';

/** Fields of settings:setOllamaSettings; any omitted key keeps its stored value. */
export interface OllamaSettingsPatch {
  enabled?: boolean;
  url?: string;
  model?: string;
  useGeminiInstead?: boolean;
  rerankModel?: string;
  neighborRerankEnabled?: boolean;
  oracleRerankEnabled?: boolean;
  oracleRerankBlend?: number;
  embeddingChunkingEnabled?: boolean;
  chunkAnnMaxSimEnabled?: boolean;
  embeddingMrl256Enabled?: boolean;
  embeddingBatchSize?: number;
}

declare global {
  interface Window {
    settings?: {
      getApiKeyHint?: () => Promise<{ has: boolean; hint: string }>;
      // No getters for cloud keys (1.0.97): they are encrypted in main and only set/checked/cleared here.
      setApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
      removeApiKey: () => Promise<void>;
      hasApiKey: () => Promise<boolean>;
      hasAzureKey?: () => Promise<boolean>;
      setAzureKey?: (key: string) => Promise<{ success: boolean; error?: string }>;
      clearAzureKey?: () => Promise<{ success: boolean }>;
      testAzureConnection?: (input: { endpoint: string; deployment: string; apiVersion?: string }) => Promise<{ ok: boolean; message: string }>;
      hasAnthropicKey?: () => Promise<boolean>;
      setAnthropicKey?: (key: string) => Promise<{ success: boolean; error?: string }>;
      clearAnthropicKey?: () => Promise<{ success: boolean }>;
      getOllamaSettings: () => Promise<{
        enabled: boolean;
        url: string;
        model: string;
        useGeminiInstead: boolean;
        rerankModel: string;
        neighborRerankEnabled: boolean;
        oracleRerankEnabled: boolean;
        oracleRerankBlend: number;
        embeddingChunkingEnabled: boolean;
        chunkAnnMaxSimEnabled: boolean;
        embeddingMrl256Enabled: boolean;
        /** 0 = Auto; otherwise clamped to 16–512 by main. */
        embeddingBatchSize: number;
      }>;
      setOllamaSettings: (settings: OllamaSettingsPatch) => Promise<void>;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<{ success: boolean; error?: string } | undefined>;
      getPreferredChatProvider: () => Promise<PreferredChatProvider>;
      setPreferredChatProvider: (provider: PreferredChatProvider) => Promise<{ success: boolean; error?: string }>;
      getBetaFeatures: () => Promise<boolean>;
      setBetaFeatures: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      getOverlayEnabled?: () => Promise<boolean>;
      setOverlayEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      getOverlayCycleHotkeyRegistered?: () => Promise<boolean>;
    };
  }
}
