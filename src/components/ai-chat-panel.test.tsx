/**
 * AI Chat Panel Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AIChatPanel } from './ai-chat-panel';
import type { ChatConversation, AIResponse, GameContext } from '@/types/chat';

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

// Mock the useLibrary hook
vi.mock('@/hooks/useGameStore', () => ({
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
  mockAiChat.searchGamesForContext.mockResolvedValue([]);
});

describe('AIChatPanel', () => {
  it('renders when open', () => {
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    // Model indicator is shown per-message, not in header
  });

  it('does not render when closed', () => {
    render(<AIChatPanel isOpen={false} onClose={() => {}} />);
    
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument();
  });

  it('shows empty state with quick prompts when no messages', () => {
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
    expect(screen.getByText("What's in my library?")).toBeInTheDocument();
    expect(screen.getByText('Recommend games for me')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<AIChatPanel isOpen={true} onClose={onClose} />);
    
    // The close button is the third button in the header
    const buttons = screen.getAllByRole('button');
    const closeBtn = buttons[2]; // After "New" and "Clear" buttons
    fireEvent.click(closeBtn);
    
    expect(onClose).toHaveBeenCalled();
  });

  it('sends a message when enter is pressed', async () => {
    const mockResponse: AIResponse = {
      content: 'Hello! How can I help you with games today?',
      toolsUsed: [],
      actions: [],
      chainOfThought: [],
    };
    mockAiChat.sendMessage.mockResolvedValue(mockResponse);
    
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    const input = screen.getByPlaceholderText('Ask anything...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    
    await waitFor(() => {
      expect(mockAiChat.sendMessage).toHaveBeenCalled();
    });
  });

  it('displays game context when provided', () => {
    const gameContext: GameContext = {
      appId: 1245620,
      name: 'Elden Ring',
      headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg',
    };
    
    render(
      <AIChatPanel 
        isOpen={true} 
        onClose={() => {}} 
        initialGameContext={gameContext}
      />
    );
    
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
  });

  it('shows loading indicator while message is being processed', async () => {
    // Make sendMessage take some time
    mockAiChat.sendMessage.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({
        content: 'Response',
        toolsUsed: [],
        actions: [],
        chainOfThought: [],
      }), 100);
    }));
    
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    const input = screen.getByPlaceholderText('Ask anything...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    
    await waitFor(() => {
      expect(screen.getByText('Thinking...')).toBeInTheDocument();
    });
  });

  it('clears history when clear button is clicked', async () => {
    mockAiChat.clearHistory.mockResolvedValue(undefined);
    
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    // Find the clear history button (Trash icon button)
    const clearBtn = screen.getByTitle('Clear history');
    fireEvent.click(clearBtn);
    
    await waitFor(() => {
      expect(mockAiChat.clearHistory).toHaveBeenCalled();
    });
  });

  it('creates new conversation when new button is clicked', async () => {
    const newConversation: ChatConversation = {
      id: 'new-123',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockAiChat.createNewConversation.mockResolvedValue(newConversation);
    
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    // Find the new conversation button (Plus icon button)
    const newBtn = screen.getByTitle('New conversation');
    fireEvent.click(newBtn);
    
    await waitFor(() => {
      expect(mockAiChat.createNewConversation).toHaveBeenCalled();
    });
  });

  it('shows quick prompts that can be clicked', async () => {
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    
    const quickPrompt = screen.getByText("What's in my library?");
    fireEvent.click(quickPrompt);
    
    const input = screen.getByPlaceholderText('Ask anything...') as HTMLInputElement;
    expect(input.value).toBe("What's in my library?");
  });
});
