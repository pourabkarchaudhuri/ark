/**
 * useAIChat Hook
 * Manages AI chat state and interactions
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { 
  ChatMessage, 
  ChatConversation, 
  GameContext, 
  SendMessagePayload,
  AIResponse 
} from '@/types/chat';
import { useLibrary, extractCachedMeta } from './useGameStore';
import { gameService } from '@/services/game-service';
import { applyAIChatActions, confirmAIChatRemovals } from '@/services/ai-chat-actions';
import { getGgRegion } from '@/services/ggdeals-service';

interface UseAIChatOptions {
  initialGameContext?: GameContext;
  autoLoad?: boolean;
}

interface UseAIChatReturn {
  // State
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  gameContext: GameContext | undefined;
  conversations: ChatConversation[];
  
  // Actions
  sendMessage: (content: string) => Promise<void>;
  setGameContext: (context: GameContext | undefined) => void;
  clearHistory: () => Promise<void>;
  createNewConversation: () => Promise<void>;
  loadConversations: () => Promise<void>;
  /** Apply the library removals the model queued on this assistant message (user clicked Remove). */
  confirmPendingRemovals: (messageId: string) => void;
  /** Dismiss the queued removals on this assistant message without touching the library. */
  cancelPendingRemovals: (messageId: string) => void;
  
  // Status
  isAvailable: boolean;
}

export function useAIChat(options: UseAIChatOptions = {}): UseAIChatReturn {
  const { initialGameContext, autoLoad = true } = options;
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameContext, setGameContext] = useState<GameContext | undefined>(initialGameContext);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [isAvailable] = useState(() => !!window.aiChat);
  
  const { getAllEntries, addToLibrary, removeFromLibrary } = useLibrary();
  
  // Load conversations on mount
  const loadConversations = useCallback(async () => {
    if (!window.aiChat) return;
    
    try {
      const convos = await window.aiChat.getHistory();
      setConversations(convos);
      
      // Load active conversation messages
      const active = await window.aiChat.getActiveConversation();
      if (active && active.messages) {
        setMessages(active.messages.map(m => ({
          ...m,
          timestamp: new Date(m.timestamp),
        })));
        if (active.gameContext) {
          setGameContext(active.gameContext);
        }
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
      setError('Failed to load chat history');
    }
  }, []);
  
  useEffect(() => {
    if (autoLoad && isAvailable) {
      loadConversations();
    }
  }, [autoLoad, isAvailable, loadConversations]);
  
  // Update game context when initial context changes
  useEffect(() => {
    if (initialGameContext) {
      setGameContext(initialGameContext);
    }
  }, [initialGameContext]);
  
  // Latest messages for the confirm/cancel handlers (they must read the pending list at click time).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const confirmPendingRemovals = useCallback((messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.removalState !== 'pending') return;
    confirmAIChatRemovals(msg.pendingRemovals, removeFromLibrary);
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, removalState: 'removed' } : m)));
  }, [removeFromLibrary]);

  const cancelPendingRemovals = useCallback((messageId: string) => {
    setMessages(prev => prev.map(m => (m.id === messageId && m.removalState === 'pending' ? { ...m, removalState: 'cancelled' } : m)));
  }, []);
  
  // Send a message
  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading || !window.aiChat) {
      return;
    }
    
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: content.trim(),
      timestamp: new Date(),
      gameContext,
    };
    
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setError(null);
    
    // Add loading message
    const loadingId = `loading-${Date.now()}`;
    const loadingMessage: ChatMessage = {
      id: loadingId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isLoading: true,
    };
    setMessages(prev => [...prev, loadingMessage]);
    
    try {
      // Get library data
      const libraryEntries = getAllEntries();
      const libraryData = libraryEntries.map(entry => ({
        gameId: entry.gameId,
        name: `Game ${entry.gameId}`, // Name will be fetched by AI agent
        status: entry.status,
        priority: entry.priority,
        addedAt: entry.addedAt?.toISOString(),
        hoursPlayed: entry.hoursPlayed,
        rating: entry.rating,
      }));
      
      const payload: SendMessagePayload = {
        message: content,
        gameContext,
        libraryData,
        ggRegion: getGgRegion(),
      };
      try {
        let preferredProvider: string = 'ollama';
        try {
          if (window.settings) preferredProvider = await window.settings.getPreferredChatProvider() ?? 'ollama';
          else preferredProvider = localStorage.getItem('ark-preferred-chat-provider') ?? 'ollama';
        } catch {
          preferredProvider = localStorage.getItem('ark-preferred-chat-provider') ?? 'ollama';
        }
        if (preferredProvider === 'anthropic') {
          try {
            const model = localStorage.getItem('ark-anthropic-model')?.trim();
            if (model) payload.anthropicModel = model;
          } catch {
            // ignore
          }
        }
        if (preferredProvider === 'azure-openai') {
          // The key is added by main from its encrypted store; only endpoint/deployment go from here.
          const endpoint = localStorage.getItem('ark-azure-endpoint')?.trim();
          const deployment = localStorage.getItem('ark-azure-deployment')?.trim();
          const apiVersion = localStorage.getItem('ark-azure-api-version')?.trim();
          if (endpoint && deployment) {
            payload.azureEndpoint = endpoint;
            payload.azureDeployment = deployment;
            if (apiVersion) payload.azureApiVersion = apiVersion;
          }
        }
      } catch {
        // ignore
      }

      const response: AIResponse = await window.aiChat.sendMessage(payload);
      
      // Adds apply now; removals wait for the user's confirmation on the message card
      const { pendingRemovals } = await applyAIChatActions(response.actions, {
        addToLibrary,
        priority: 'Medium',
        resolveCachedMeta: async (id) => {
          const game = await gameService.getGameDetails(id);
          return game ? extractCachedMeta(game) : null;
        },
        lookupName: (id) => getAllEntries().find(e => e.gameId === id)?.cachedMeta?.title,
      });
      
      // Replace loading message with response
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
        toolCalls: response.toolsUsed?.map(name => ({ name, args: {} })),
        chainOfThought: response.chainOfThought,
        ...(pendingRemovals.length > 0 ? { pendingRemovals, removalState: 'pending' as const } : {}),
      };
      
      setMessages(prev => 
        prev.filter(m => m.id !== loadingId).concat(assistantMessage)
      );
    } catch (err) {
      console.error('Failed to send message:', err);
      setError('Failed to get a response');
      
      // Replace loading message with error
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        error: 'Failed to get a response. Please try again.',
      };
      
      setMessages(prev => 
        prev.filter(m => m.id !== loadingId).concat(errorMessage)
      );
    } finally {
      setIsLoading(false);
    }
  }, [gameContext, isLoading, getAllEntries, addToLibrary]);
  
  // Clear history
  // Blocked while a reply is pending: main saves the reply into whichever conversation is active
  // when it finishes, so clearing/starting a new one mid-reply would put the old exchange back.
  const clearHistory = useCallback(async () => {
    if (!window.aiChat || isLoading) return;
    
    try {
      await window.aiChat.clearHistory();
      setMessages([]);
      setConversations([]);
      setGameContext(undefined);
    } catch (err) {
      console.error('Failed to clear history:', err);
      setError('Failed to clear chat history');
    }
  }, [isLoading]);
  
  // Create new conversation
  const createNewConversation = useCallback(async () => {
    if (!window.aiChat || isLoading) return;
    
    try {
      await window.aiChat.createNewConversation();
      setMessages([]);
      setGameContext(undefined);
      await loadConversations();
    } catch (err) {
      console.error('Failed to create new conversation:', err);
      setError('Failed to create new conversation');
    }
  }, [loadConversations, isLoading]);
  
  return {
    messages,
    isLoading,
    error,
    gameContext,
    conversations,
    sendMessage,
    setGameContext,
    clearHistory,
    createNewConversation,
    loadConversations,
    confirmPendingRemovals,
    cancelPendingRemovals,
    isAvailable,
  };
}

