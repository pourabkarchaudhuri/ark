/**
 * Chat History In-Memory Store
 * Stores chat conversations in memory (cleared on app restart)
 */

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

class ChatStore {
  private history: ChatHistory;

  constructor() {
    // Initialize with empty in-memory storage
    this.history = {
      conversations: [],
      lastActiveConversationId: undefined,
    };
    console.log('[ChatStore] Initialized in-memory chat store');
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
    this.history.lastActiveConversationId = conversation.id;
    
    console.log(`[ChatStore] Created new conversation: ${conversation.id}`);
    return conversation;
  }

  /**
   * Set the active conversation
   */
  setActiveConversation(conversationId: string): void {
    if (this.history.conversations.some(c => c.id === conversationId)) {
      this.history.lastActiveConversationId = conversationId;
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
    console.log('[ChatStore] Cleared all chat history');
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
  }
}

// Export singleton instance
export const chatStore = new ChatStore();
