/**
 * useAIChat Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAIChat } from './useAIChat';
import type { ChatConversation, AIResponse } from '@/types/chat';

// Mock useLibrary hook
vi.mock('./useGameStore', () => ({
  useLibrary: () => ({
    getAllEntries: vi.fn().mockReturnValue([]),
    getAllGameIds: vi.fn().mockReturnValue([]),
    addToLibrary: vi.fn(),
    removeFromLibrary: vi.fn(),
    isInLibrary: vi.fn().mockReturnValue(false),
    librarySize: 0,
  }),
}));

// Mock window.aiChat
const mockAiChat = {
  sendMessage: vi.fn(),
  getHistory: vi.fn(),
  getActiveConversation: vi.fn(),
  createNewConversation: vi.fn(),
  clearHistory: vi.fn(),
  searchGamesForContext: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as typeof window & { aiChat: typeof mockAiChat }).aiChat = mockAiChat;
  
  // Default mock implementations
  mockAiChat.getActiveConversation.mockResolvedValue(null);
  mockAiChat.getHistory.mockResolvedValue([]);
});

describe('useAIChat', () => {
  it('initializes with empty messages', () => {
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    expect(result.current.messages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('reports availability correctly', () => {
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    expect(result.current.isAvailable).toBe(true);
  });

  it('loads conversations on mount when autoLoad is true', async () => {
    const mockConversation: ChatConversation = {
      id: 'test-123',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    mockAiChat.getActiveConversation.mockResolvedValue(mockConversation);
    mockAiChat.getHistory.mockResolvedValue([mockConversation]);
    
    const { result } = renderHook(() => useAIChat({ autoLoad: true }));
    
    await waitFor(() => {
      expect(result.current.messages.length).toBe(1);
    });
  });

  it('sends a message successfully', async () => {
    const mockResponse: AIResponse = {
      content: 'Hello! How can I help you?',
      toolsUsed: [],
      actions: [],
    };
    mockAiChat.sendMessage.mockResolvedValue(mockResponse);
    
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    await act(async () => {
      await result.current.sendMessage('Hello');
    });
    
    await waitFor(() => {
      expect(result.current.messages.length).toBe(2); // User + Assistant
      expect(result.current.messages[1].content).toBe('Hello! How can I help you?');
    });
  });

  it('handles send message error', async () => {
    mockAiChat.sendMessage.mockRejectedValue(new Error('API Error'));
    
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    await act(async () => {
      await result.current.sendMessage('Hello');
    });
    
    await waitFor(() => {
      expect(result.current.messages.length).toBe(2);
      expect(result.current.messages[1].error).toBeDefined();
    });
  });

  it('sets game context correctly', () => {
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    const gameContext = {
      appId: 1245620,
      name: 'Elden Ring',
    };
    
    act(() => {
      result.current.setGameContext(gameContext);
    });
    
    expect(result.current.gameContext).toEqual(gameContext);
  });

  it('clears history', async () => {
    mockAiChat.clearHistory.mockResolvedValue(undefined);
    
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    // Add some messages first
    const mockResponse: AIResponse = {
      content: 'Response',
      toolsUsed: [],
      actions: [],
    };
    mockAiChat.sendMessage.mockResolvedValue(mockResponse);
    
    await act(async () => {
      await result.current.sendMessage('Hello');
    });
    
    await waitFor(() => {
      expect(result.current.messages.length).toBe(2);
    });
    
    await act(async () => {
      await result.current.clearHistory();
    });
    
    expect(result.current.messages).toEqual([]);
    expect(mockAiChat.clearHistory).toHaveBeenCalled();
  });

  it('creates new conversation', async () => {
    const newConversation: ChatConversation = {
      id: 'new-123',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockAiChat.createNewConversation.mockResolvedValue(newConversation);
    mockAiChat.getHistory.mockResolvedValue([newConversation]);
    
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    
    await act(async () => {
      await result.current.createNewConversation();
    });
    
    expect(mockAiChat.createNewConversation).toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  it('uses initial game context', () => {
    const initialContext = {
      appId: 1245620,
      name: 'Elden Ring',
    };
    
    const { result } = renderHook(() => useAIChat({ 
      autoLoad: false,
      initialGameContext: initialContext,
    }));
    
    expect(result.current.gameContext).toEqual(initialContext);
  });
});

