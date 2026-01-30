/**
 * AI Chat Type Definitions
 * Types for chat messages, history, and game context
 */

// Chat message roles
export type ChatRole = 'user' | 'assistant' | 'system';

// Individual chat message
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: Date;
  gameContext?: GameContext;
  toolCalls?: ToolCall[];
  chainOfThought?: ThoughtStep[];
  isLoading?: boolean;
  isStreaming?: boolean; // Currently receiving streaming content
  error?: string;
  model?: string; // Which model was used for this message
}

// Game context for the chat
export interface GameContext {
  appId: number;
  name: string;
  headerImage?: string;
}

// Tool call information for transparency
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  timestamp?: Date;
}

// Chain of thought step
export interface ThoughtStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'validation';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  timestamp: Date;
}

// Chat conversation
export interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  gameContext?: GameContext;
  createdAt: Date;
  updatedAt: Date;
}

// Request to send a message
export interface SendMessageRequest {
  message: string;
  gameContext?: GameContext;
  mentionedGames?: GameContext[];
}

// Response from the AI
export interface ChatResponse {
  message: ChatMessage;
  toolsUsed?: string[];
}

// Chat history stored on disk
export interface PersistedChatHistory {
  version: number;
  conversations: ChatConversation[];
  lastActiveConversationId?: string;
}

// Library action returned by the AI for library modifications
export interface LibraryAction {
  type: 'add' | 'remove';
  appId: number;
  status?: string;
  gameName?: string;
}

// Response from the AI with actions
export interface AIResponse {
  content: string;
  toolsUsed: string[];
  actions: LibraryAction[];
  chainOfThought: ThoughtStep[];
  model?: string; // Which model was used (e.g., "Gemini 2.5 Flash", "Ollama gemma3:12b")
}

// Request object for sending messages
export interface SendMessagePayload {
  message: string;
  gameContext?: GameContext;
  libraryData?: Array<{
    gameId: number;
    name?: string;
    status: string;
    priority: string;
    addedAt?: string;
  }>;
}

// Streaming chunk data
export interface StreamChunkData {
  chunk: string;
  fullContent: string;
}

// Window interface for AI chat API
declare global {
  interface Window {
    aiChat?: {
      sendMessage: (request: SendMessagePayload) => Promise<AIResponse>;
      onStreamChunk: (callback: (data: StreamChunkData) => void) => () => void;
      getHistory: () => Promise<ChatConversation[]>;
      clearHistory: () => Promise<void>;
      getActiveConversation: () => Promise<ChatConversation | null>;
      createNewConversation: () => Promise<ChatConversation>;
      searchGamesForContext: (query: string) => Promise<GameContext[]>;
    };
  }
}

export {};

