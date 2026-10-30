/**
 * Chat providers that the main process can actually run (v1.0.97).
 *
 * This is the one switch for "can chat use this provider": the Settings provider list,
 * the chat panel, useChatAvailability and main's preferred-provider validation all
 * filter on it. 'anthropic' is not in it yet: its key is already stored encrypted in
 * main, and the AI router (B35, LiteLLM) adds it here once it serves Anthropic chat.
 * Until then it is never offered, never counts towards "chat is available", and main
 * falls back from a stored 'anthropic' preference (the stored value is kept).
 * Shared by the renderer and the main process (listed in tsconfig.node.json),
 * so keep this file free of renderer-only imports.
 */

export type ImplementedChatProvider = 'ollama' | 'gemini' | 'azure-openai';

export const CHAT_IMPLEMENTED_PROVIDERS: readonly ImplementedChatProvider[] = ['ollama', 'gemini', 'azure-openai'];

export function isImplementedChatProvider(p: unknown): p is ImplementedChatProvider {
  return typeof p === 'string' && (CHAT_IMPLEMENTED_PROVIDERS as readonly string[]).includes(p);
}

export interface ChatProviderCredentials {
  ollamaUrl?: string | null;
  betaFeatures: boolean;
  hasGeminiKey: boolean;
  /** Endpoint + deployment set in the renderer and a key saved in main. */
  azureConfigured: boolean;
}

/** Configured providers in display order. Cloud providers only count with Beta features on. */
export function listConfiguredChatProviders(c: ChatProviderCredentials): ImplementedChatProvider[] {
  const list: ImplementedChatProvider[] = [];
  if (c.ollamaUrl?.trim()) list.push('ollama');
  if (c.betaFeatures) {
    if (c.hasGeminiKey) list.push('gemini');
    if (c.azureConfigured) list.push('azure-openai');
  }
  return list;
}
