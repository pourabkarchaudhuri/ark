/**
 * Chat History Store — persisted to disk
 * Conversations survive app restarts via a JSON file in userData.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;
import { logger } from './safe-logger.js';
import { atomicWriteFileSync } from './safe-write.js';

// Types (duplicated here for Electron main process)
interface GameContext {
  appId: number;
  name: string;
  headerImage?: string;
}

interface ThoughtStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'validation' | 'error';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  timestamp: Date;
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  gameContext?: GameContext;
  toolCalls?: ToolCall[];
  chainOfThought?: ThoughtStep[];
  error?: string;
}

interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  gameContext?: GameContext;
  createdAt: Date;
  updatedAt: Date;
}

interface ChatHistory {
  conversations: ChatConversation[];
  lastActiveConversationId?: string;
}

// ---------------------------------------------------------------------------
// Date-aware JSON reviver — converts ISO-8601 strings back to Date objects
// ---------------------------------------------------------------------------
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return value;
}

/** Maximum number of conversations to persist (keep most recent) */
const MAX_PERSISTED_CONVERSATIONS = 50;

class ChatStore {
  private history: ChatHistory;
  private filePath: string;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'chat-history.json');
    this.history = this.loadFromDisk();
    logger.log(
      `[ChatStore] Initialized — ${this.history.conversations.length} conversation(s) loaded from disk`,
    );
  }

  // ---- Persistence helpers ------------------------------------------------

  private loadFromDisk(): ChatHistory {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw, dateReviver) as ChatHistory;
        if (parsed && Array.isArray(parsed.conversations)) {
          return parsed;
        }
      }
    } catch (err) {
      logger.warn('[ChatStore] Failed to load chat history from disk:', err);
    }
    return { conversations: [], lastActiveConversationId: undefined };
  }

  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.writeToDisk();
    }, 5000);
  }

  private writeToDisk(): void {
    try {
      // Keep only the most recent conversations to avoid unbounded growth
      const trimmed: ChatHistory = {
        ...this.history,
        conversations: this.history.conversations.slice(-MAX_PERSISTED_CONVERSATIONS),
      };
      atomicWriteFileSync(this.filePath, JSON.stringify(trimmed));
    } catch (err) {
      logger.error('[ChatStore] Failed to save chat history:', err);
    }
  }

  /** Synchronously flush pending writes to disk (call in before-quit). */
  flushSync(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.writeToDisk();
  }

  // ---- Public API (unchanged signatures) ----------------------------------

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get all conversations
   */
  getConversations(): ChatConversation[] {
    return this.history.conversations;
  }

  /**
   * Get the active conversation
   */
  getActiveConversation(): ChatConversation | null {
    if (!this.history.lastActiveConversationId) {
      return null;
    }
    return this.history.conversations.find(
      c => c.id === this.history.lastActiveConversationId
    ) || null;
  }

  /**
   * Create a new conversation
   */
  createConversation(gameContext?: GameContext): ChatConversation {
    const now = new Date();
    const conversation: ChatConversation = {
      id: this.generateId(),
      messages: [],
      gameContext,
      createdAt: now,
      updatedAt: now,
    };
    
    this.history.conversations.push(conversation);
    // Cap in-memory conversations to prevent unbounded growth
    if (this.history.conversations.length > MAX_PERSISTED_CONVERSATIONS) {
      this.history.conversations = this.history.conversations.slice(-MAX_PERSISTED_CONVERSATIONS);
    }
    this.history.lastActiveConversationId = conversation.id;
    
    logger.log(`[ChatStore] Created new conversation: ${conversation.id}`);
    this.scheduleSave();
    return conversation;
  }

  /**
   * Set the active conversation
   */
  setActiveConversation(conversationId: string): void {
    if (this.history.conversations.some(c => c.id === conversationId)) {
      this.history.lastActiveConversationId = conversationId;
      this.scheduleSave();
    }
  }

  /**
   * Add a message to the active conversation
   */
  addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
    let conversation = this.getActiveConversation();
    
    if (!conversation) {
      conversation = this.createConversation();
    }
    
    const fullMessage: ChatMessage = {
      ...message,
      id: this.generateId(),
      timestamp: new Date(),
    };
    
    conversation.messages.push(fullMessage);
    conversation.updatedAt = new Date();
    
    this.scheduleSave();
    return fullMessage;
  }

  /**
   * Update game context for the active conversation
   */
  setGameContext(gameContext: GameContext | undefined): void {
    const conversation = this.getActiveConversation();
    if (conversation) {
      conversation.gameContext = gameContext;
      conversation.updatedAt = new Date();
      this.scheduleSave();
    }
  }

  /**
   * Clear all chat history
   */
  clearHistory(): void {
    this.history = {
      conversations: [],
      lastActiveConversationId: undefined,
    };
    logger.log('[ChatStore] Cleared all chat history');
    this.scheduleSave();
  }

  /**
   * Delete a specific conversation
   */
  deleteConversation(conversationId: string): void {
    this.history.conversations = this.history.conversations.filter(
      c => c.id !== conversationId
    );
    
    if (this.history.lastActiveConversationId === conversationId) {
      this.history.lastActiveConversationId = this.history.conversations[0]?.id;
    }
    this.scheduleSave();
  }
}

// Export singleton instance
export const chatStore = new ChatStore();
