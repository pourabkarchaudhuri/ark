/**
 * AI Chat IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { processMessage, searchGamesForContext, chatStore, type ChatProviderOptions } from '../ai-chat.js';
import { settingsStore } from '../settings-store.js';
import { syncChatConnectorsFromPayload } from '../ai-router/service.js';

/**
 * Azure OpenAI options for one chat request. The key is read from the encrypted store
 * in main (1.0.97); a key in the renderer payload is ignored.
 */
export function buildAzureProviderOptions(
  payload: { azureEndpoint?: unknown; azureDeployment?: unknown; azureApiVersion?: unknown } | null | undefined,
  preferredProvider: string,
  storedKey: string | null,
): ChatProviderOptions | undefined {
  if (preferredProvider !== 'azure-openai' || !storedKey) return undefined;
  const endpoint = typeof payload?.azureEndpoint === 'string' ? payload.azureEndpoint.trim() : '';
  const deployment = typeof payload?.azureDeployment === 'string' ? payload.azureDeployment.trim() : '';
  const apiVersion = typeof payload?.azureApiVersion === 'string' ? payload.azureApiVersion.trim() : '';
  if (!endpoint || !deployment) return undefined;
  return {
    azure: {
      endpoint,
      apiKey: storedKey.trim(),
      deployment,
      ...(apiVersion ? { apiVersion } : {}),
    },
  };
}

export function register(): void {
  /**
   * Send a message to the AI chat
   * Supports streaming responses via 'ai:streamChunk' event
   */
  ipcMain.handle('ai:sendMessage', async (event: any, payload: any) => {
    const { message, gameContext, libraryData, imageAttachment, ggRegion } = payload || {};
    try {
      const MAX_MSG_LEN = 4000;
      if (typeof message !== 'string' || message.length > MAX_MSG_LEN) {
        throw new Error(`Message must be a string of at most ${MAX_MSG_LEN} characters`);
      }

      const MAX_LIBRARY_ITEMS = 500;
      const safeLibraryData = Array.isArray(libraryData)
        ? libraryData.slice(0, MAX_LIBRARY_ITEMS)
        : undefined;

      const preferredProvider = settingsStore.getPreferredChatProvider();
      // The AI router follows the provider the user selected (Azure endpoint, Anthropic model ride along).
      syncChatConnectorsFromPayload(preferredProvider, payload);
      const providerOptions = buildAzureProviderOptions(
        payload,
        preferredProvider,
        preferredProvider === 'azure-openai' ? settingsStore.getAzureOpenAIKey() : null,
      );

      const safeImageAttachment =
        preferredProvider === 'azure-openai' &&
        typeof imageAttachment === 'string' &&
        imageAttachment.startsWith('data:image/') &&
        imageAttachment.length < 10_000_000
          ? imageAttachment
          : undefined;
      if (typeof imageAttachment === 'string' && !safeImageAttachment) {
        if (preferredProvider !== 'azure-openai') logger.log('[AI IPC] Image attachment ignored (only Azure OpenAI supports vision).');
        else if (imageAttachment.length >= 10_000_000) logger.warn('[AI IPC] Image attachment too large (>10MB), skipped.');
      }

      logger.log(`[AI IPC] sendMessage: "${message.substring(0, 50)}..." provider=${preferredProvider}` + (safeImageAttachment ? ' +image' : ''));
      
      const onStreamChunk = (chunk: string, fullContent: string) => {
        event.sender.send('ai:streamChunk', { chunk, fullContent });
      };
      
      // ggRegion is validated (normalizeRegion) inside processMessage; unknown values become 'us'.
      const result = await processMessage(message, gameContext, safeLibraryData, onStreamChunk, undefined, providerOptions, safeImageAttachment, typeof ggRegion === 'string' ? ggRegion : undefined);
      
      // Persist to the same conversation regardless of provider so context survives model switches
      const storedContent = message + (safeImageAttachment ? ' [Image attached]' : '');
      chatStore.addMessage({ role: 'user', content: storedContent, gameContext });
      chatStore.addMessage({ role: 'assistant', content: result.content, toolCalls: result.toolsUsed.map((name: string) => ({ name, args: {} })) });
      
      return result;
    } catch (error) {
      logger.error('[AI IPC] Error sending message:', error);
      throw error;
    }
  });

  /**
   * Get chat history
   */
  ipcMain.handle('ai:getHistory', async () => {
    try {
      return chatStore.getConversations();
    } catch (error) {
      logger.error('[AI IPC] Error getting history:', error);
      return [];
    }
  });

  /**
   * Get active conversation
   */
  ipcMain.handle('ai:getActiveConversation', async () => {
    try {
      return chatStore.getActiveConversation();
    } catch (error) {
      logger.error('[AI IPC] Error getting active conversation:', error);
      return null;
    }
  });

  /**
   * Create a new conversation
   */
  ipcMain.handle('ai:createNewConversation', async () => {
    try {
      return chatStore.createConversation();
    } catch (error) {
      logger.error('[AI IPC] Error creating conversation:', error);
      throw error;
    }
  });

  /**
   * Clear chat history
   */
  ipcMain.handle('ai:clearHistory', async () => {
    try {
      chatStore.clearHistory();
      return true;
    } catch (error) {
      logger.error('[AI IPC] Error clearing history:', error);
      throw error;
    }
  });

  /**
   * Search games for context selection
   */
  ipcMain.handle('ai:searchGamesForContext', async (_event: any, query: string) => {
    try {
      if (typeof query !== 'string' || query.length > 500) return [];
      return await searchGamesForContext(query);
    } catch (error) {
      logger.error('[AI IPC] Error searching games for context:', error);
      return [];
    }
  });
}
