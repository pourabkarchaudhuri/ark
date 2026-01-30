/**
 * useAIChat Hook
 * Manages AI chat state and interactions
 */

import { useState, useCallback, useEffect } from 'react';
import type { 
  ChatMessage, 
  ChatConversation, 
  GameContext, 
  LibraryAction,
  SendMessagePayload,
  AIResponse 
} from '@/types/chat';
import { useLibrary } from './useGameStore';

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
  
  // Execute library actions
  const executeActions = useCallback((actions: LibraryAction[]) => {
    for (const action of actions) {
      if (action.type === 'add') {
        addToLibrary({
          gameId: action.appId,
          steamAppId: action.appId,
          status: (action.status as 'Want to Play' | 'Playing' | 'Completed' | 'On Hold' | 'Dropped') || 'Want to Play',
          priority: 'Medium',
        });
      } else if (action.type === 'remove') {
        removeFromLibrary(action.appId);
      }
    }
  }, [addToLibrary, removeFromLibrary]);
  
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
      }));
      
      const payload: SendMessagePayload = {
        message: content,
        gameContext,
        libraryData,
      };
      
      const response: AIResponse = await window.aiChat.sendMessage(payload);
      
      // Execute any library actions
      if (response.actions && response.actions.length > 0) {
        executeActions(response.actions);
      }
      
      // Replace loading message with response
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
        toolCalls: response.toolsUsed?.map(name => ({ name, args: {} })),
        chainOfThought: response.chainOfThought,
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
  }, [gameContext, isLoading, getAllEntries, executeActions]);
  
  // Clear history
  const clearHistory = useCallback(async () => {
    if (!window.aiChat) return;
    
    try {
      await window.aiChat.clearHistory();
      setMessages([]);
      setConversations([]);
      setGameContext(undefined);
    } catch (err) {
      console.error('Failed to clear history:', err);
      setError('Failed to clear chat history');
    }
  }, []);
  
  // Create new conversation
  const createNewConversation = useCallback(async () => {
    if (!window.aiChat) return;
    
    try {
      await window.aiChat.createNewConversation();
      setMessages([]);
      setGameContext(undefined);
      await loadConversations();
    } catch (err) {
      console.error('Failed to create new conversation:', err);
      setError('Failed to create new conversation');
    }
  }, [loadConversations]);
  
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
    isAvailable,
  };
}

