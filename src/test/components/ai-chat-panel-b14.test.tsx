/**
 * AI Chat Panel — 1.0.97 B14: removal confirmation, status normalization, render/stream
 * performance, header guards while a reply is pending, lazy emoji picker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { AIResponse, ChatConversation, GameContext } from '@/types/chat';

const lib = vi.hoisted(() => ({
  addToLibrary: vi.fn(),
  removeFromLibrary: vi.fn(),
  getAllEntries: vi.fn(() => [] as unknown[]),
}));

// Every ReactMarkdown render is recorded (children = message content).
const markdownRenders = vi.hoisted(() => [] as string[]);

vi.mock('@/hooks/useGameStore', () => ({
  useLibrary: () => lib,
  extractCachedMeta: (g: { title?: string }) => ({ title: g.title ?? 'x', store: 'steam' }),
}));
vi.mock('@/services/game-service', () => ({
  gameService: { getGameDetails: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/services/journey-store', () => ({
  journeyStore: { getEntry: vi.fn(() => undefined) },
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders.push(children);
    return <div data-testid="md">{children}</div>;
  },
}));
vi.mock('@emoji-mart/data', () => ({ default: { mocked: true } }));
vi.mock('@emoji-mart/react', () => ({
  default: ({ data }: { data: () => Promise<unknown> }) => {
    void data().then((d) => { (window as unknown as { __emojiData?: unknown }).__emojiData = d; });
    return <div data-testid="emoji-picker" />;
  },
}));

import { AIChatPanel } from '@/components/ai-chat-panel';

Element.prototype.scrollIntoView = vi.fn();

// Manual animation-frame queue so tests control when coalesced stream chunks flush.
let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;
function flushFrames() {
  const cbs = [...rafQueue.values()];
  rafQueue.clear();
  act(() => { cbs.forEach(cb => cb(0)); });
}

type ChunkCb = (d: { fullContent: string }) => void;
let chunkCb: ChunkCb | null;
const unsubscribe = vi.fn();
const mockAiChat = {
  sendMessage: vi.fn(),
  getHistory: vi.fn(),
  getActiveConversation: vi.fn(),
  createNewConversation: vi.fn(),
  clearHistory: vi.fn(),
  searchGamesForContext: vi.fn(),
  onStreamChunk: vi.fn((cb: ChunkCb) => { chunkCb = cb; return unsubscribe; }),
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const baseResponse: AIResponse = { content: 'Done.', toolsUsed: [], actions: [], chainOfThought: [] };

function conversation(messages: ChatConversation['messages']): ChatConversation {
  return { id: 'c1', messages, createdAt: new Date(), updatedAt: new Date() };
}

async function send(text: string) {
  const input = screen.getByPlaceholderText('Ask anything...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  await waitFor(() => expect(mockAiChat.sendMessage).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  markdownRenders.length = 0;
  chunkCb = null;
  rafQueue = new Map();
  rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafId += 1; rafQueue.set(rafId, cb); return rafId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue.delete(id); });
  (window as unknown as { aiChat: typeof mockAiChat }).aiChat = mockAiChat;
  mockAiChat.getActiveConversation.mockResolvedValue(null);
  mockAiChat.getHistory.mockResolvedValue([]);
  lib.getAllEntries.mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AIChatPanel library actions', () => {
  it('shows a confirm card for removals and removes only on click', async () => {
    mockAiChat.sendMessage.mockResolvedValue({
      ...baseResponse,
      actions: [
        { type: 'remove', appId: 1, gameId: 'steam-1', gameName: 'Hollow Knight' },
        { type: 'remove', appId: 2, gameId: 'steam-2', gameName: 'Celeste' },
      ],
    });
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('remove them');

    expect(await screen.findByTestId('ai-chat-removal-confirm')).toBeInTheDocument();
    expect(screen.getByText('Hollow Knight')).toBeInTheDocument();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
    expect(lib.removeFromLibrary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 games' }));
    expect(lib.removeFromLibrary).toHaveBeenCalledTimes(2);
    expect(lib.removeFromLibrary).toHaveBeenCalledWith('steam-1');
    expect(lib.removeFromLibrary).toHaveBeenCalledWith('steam-2');
    expect(await screen.findByTestId('ai-chat-removal-done')).toHaveTextContent('Removed 2 games');
  });

  it('Cancel leaves the library intact', async () => {
    mockAiChat.sendMessage.mockResolvedValue({
      ...baseResponse,
      actions: [{ type: 'remove', appId: 1, gameId: 'steam-1', gameName: 'Hollow Knight' }],
    });
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('remove it');

    await screen.findByRole('button', { name: 'Remove 1 game' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('ai-chat-removal-cancelled')).toBeInTheDocument();
    expect(lib.removeFromLibrary).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove 1 game' })).not.toBeInTheDocument();
  });

  it('applies add actions immediately with a normalized status', async () => {
    mockAiChat.sendMessage.mockResolvedValue({
      ...baseResponse,
      actions: [{ type: 'add', appId: 620, gameId: 'steam-620', status: 'backlog', gameName: 'Portal 2' }],
    });
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('add portal 2');

    await waitFor(() => expect(lib.addToLibrary).toHaveBeenCalled());
    expect(lib.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'steam-620',
      steamAppId: 620,
      status: 'Want to Play',
    }));
    expect(screen.queryByTestId('ai-chat-removal-confirm')).not.toBeInTheDocument();
  });
});

describe('AIChatPanel header guards while a reply is pending', () => {
  it('disables New conversation and Clear history until the reply finishes', async () => {
    const reply = deferred<AIResponse>();
    mockAiChat.sendMessage.mockReturnValue(reply.promise);
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('hello');

    const newBtn = screen.getByLabelText('New conversation');
    const clearBtn = screen.getByLabelText('Clear history');
    expect(newBtn).toBeDisabled();
    expect(clearBtn).toBeDisabled();
    expect(newBtn).toHaveAttribute('title', expect.stringMatching(/wait for the reply/i));
    fireEvent.click(newBtn);
    fireEvent.click(clearBtn);
    expect(mockAiChat.createNewConversation).not.toHaveBeenCalled();
    expect(mockAiChat.clearHistory).not.toHaveBeenCalled();

    await act(async () => { reply.resolve(baseResponse); });
    await waitFor(() => expect(screen.getByLabelText('New conversation')).not.toBeDisabled());
    expect(screen.getByLabelText('Clear history')).not.toBeDisabled();
    fireEvent.click(screen.getByLabelText('New conversation'));
    await waitFor(() => expect(mockAiChat.createNewConversation).toHaveBeenCalled());
  });
});

describe('AIChatPanel render performance', () => {
  it('typing does not re-render existing message bubbles', async () => {
    mockAiChat.getActiveConversation.mockResolvedValue(conversation([
      { id: 'a1', role: 'assistant', content: 'First answer', timestamp: new Date(), suggestedFollowUps: ['More?'] },
      { id: 'a2', role: 'assistant', content: 'Second answer', timestamp: new Date() },
    ]));
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await screen.findByText('Second answer');
    const before = markdownRenders.length;

    const input = screen.getByPlaceholderText('Ask anything...');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    expect(markdownRenders.length).toBe(before);
  });

  it('coalesces 100 stream chunks into one update per frame', async () => {
    const reply = deferred<AIResponse>();
    mockAiChat.sendMessage.mockReturnValue(reply.promise);
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('stream please');
    await waitFor(() => expect(chunkCb).not.toBeNull());

    act(() => {
      for (let i = 0; i < 100; i++) chunkCb!({ fullContent: `chunk ${i}` });
    });
    expect(rafQueue.size).toBe(1);
    flushFrames();

    expect(screen.getByText('chunk 99')).toBeInTheDocument();
    expect(markdownRenders.filter(c => c.startsWith('chunk'))).toEqual(['chunk 99']);

    await act(async () => { reply.resolve({ ...baseResponse, content: 'Final answer' }); });
    expect(await screen.findByText('Final answer')).toBeInTheDocument();
  });

  it('a frame pending when the reply ends does not resurrect the streaming message', async () => {
    const reply = deferred<AIResponse>();
    mockAiChat.sendMessage.mockReturnValue(reply.promise);
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    await send('stream please');
    await waitFor(() => expect(chunkCb).not.toBeNull());

    act(() => { chunkCb!({ fullContent: 'late chunk' }); });
    expect(rafQueue.size).toBe(1);
    await act(async () => { reply.resolve({ ...baseResponse, content: 'Final answer' }); });
    await screen.findByText('Final answer');
    expect(unsubscribe).toHaveBeenCalled();

    flushFrames();
    act(() => { chunkCb!({ fullContent: 'after end' }); });
    flushFrames();
    expect(screen.queryByText('late chunk')).not.toBeInTheDocument();
    expect(screen.queryByText('after end')).not.toBeInTheDocument();
    expect(screen.queryByText('Streaming response...')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
  });

  it('follow-up chip sends with the latest game context', async () => {
    mockAiChat.sendMessage.mockResolvedValue(baseResponse);
    mockAiChat.getActiveConversation.mockResolvedValue(conversation([
      { id: 'a1', role: 'assistant', content: 'Answer', timestamp: new Date(), suggestedFollowUps: ['Tell me more'] },
    ]));
    const ctxA: GameContext = { appId: 1, name: 'Game A' };
    const ctxB: GameContext = { appId: 2, name: 'Game B' };
    const { rerender } = render(<AIChatPanel isOpen={true} onClose={() => {}} initialGameContext={ctxA} />);
    await screen.findByText('Tell me more');
    rerender(<AIChatPanel isOpen={true} onClose={() => {}} initialGameContext={ctxB} />);
    await screen.findByText('Game B');

    fireEvent.click(screen.getByText('Tell me more'));
    await waitFor(() => expect(mockAiChat.sendMessage).toHaveBeenCalled());
    expect(mockAiChat.sendMessage.mock.calls[0][0]).toEqual(expect.objectContaining({
      message: 'Tell me more',
      gameContext: ctxB,
    }));
  });
});

describe('AIChatPanel stick-to-bottom scrolling', () => {
  function fakeScrollMetrics(el: HTMLElement) {
    const m = { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 };
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => m.scrollTop, set: (v: number) => { m.scrollTop = v; } });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight });
    return m;
  }

  it('follows the stream at the bottom, but not after the user scrolls up', async () => {
    const reply = deferred<AIResponse>();
    mockAiChat.sendMessage.mockReturnValue(reply.promise);
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    const container = screen.getByTestId('ai-chat-messages');
    const m = fakeScrollMetrics(container);
    await send('stream please');
    await waitFor(() => expect(chunkCb).not.toBeNull());

    // At the bottom: each flushed frame pins scrollTop to scrollHeight.
    m.scrollTop = 1500;
    fireEvent.scroll(container);
    m.scrollHeight = 2200;
    act(() => { chunkCb!({ fullContent: 'one' }); });
    flushFrames();
    expect(m.scrollTop).toBe(2200);

    // User scrolls up to read: streaming no longer pulls them down.
    m.scrollTop = 100;
    fireEvent.scroll(container);
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    m.scrollHeight = 2600;
    act(() => { chunkCb!({ fullContent: 'one two' }); });
    flushFrames();
    expect(m.scrollTop).toBe(100);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    await act(async () => { reply.resolve(baseResponse); });
    await screen.findByText('Done.');
    expect(m.scrollTop).toBe(100);
  });
});

describe('AIChatPanel emoji picker', () => {
  it('loads the picker and its data only when opened', async () => {
    render(<AIChatPanel isOpen={true} onClose={() => {}} />);
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Add emoji'));
    expect(await screen.findByTestId('emoji-picker')).toBeInTheDocument();
    await waitFor(() => expect((window as unknown as { __emojiData?: unknown }).__emojiData).toEqual({ mocked: true }));
  });
});
