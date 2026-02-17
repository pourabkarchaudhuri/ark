/**
 * AI Chat IPC Handlers
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const { ipcMain } = electron;
import { logger } from '../safe-logger.js';
import { processMessage, searchGamesForContext, chatStore } from '../ai-chat.js';

export function register(): void {
  /**
   * Send a message to the AI chat
   * Supports streaming responses via 'ai:streamChunk' event
   */
  ipcMain.handle('ai:sendMessage', async (event: any, { message, gameContext, libraryData }: any) => {
    try {
      // Security: limit message length to prevent memory abuse / prompt stuffing
      const MAX_MSG_LEN = 4000;
      if (typeof message !== 'string' || message.length > MAX_MSG_LEN) {
        throw new Error(`Message must be a string of at most ${MAX_MSG_LEN} characters`);
      }

      logger.log(`[AI IPC] sendMessage: "${message.substring(0, 50)}..."`);
      
      // Streaming callback to send chunks to renderer
      const onStreamChunk = (chunk: string, fullContent: string) => {
        event.sender.send('ai:streamChunk', { chunk, fullContent });
      };
      
      const result = await processMessage(message, gameContext, libraryData, onStreamChunk);
      
      // Store the message in chat history
      chatStore.addMessage({ role: 'user', content: message, gameContext });
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
