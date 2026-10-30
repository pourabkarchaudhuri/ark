/**
 * useAIChat — 1.0.97 B14: removals need confirmation, add status is normalized, and
 * clear/new conversation are no-ops while a reply is pending.
 * 1.0.97 B12: removals use the exact gameId the main process queued (Epic/custom entries
 * included), and every send carries the gg.deals region from Settings → Prices.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AIResponse } from '@/types/chat';
import { GG_REGION_LS_KEY } from '@/services/ggdeals-service';

const lib = vi.hoisted(() => ({
  addToLibrary: vi.fn(),
  removeFromLibrary: vi.fn(),
  getAllEntries: vi.fn(() => [] as unknown[]),
}));

vi.mock('@/hooks/useGameStore', () => ({
  useLibrary: () => lib,
  extractCachedMeta: (g: { title?: string }) => ({ title: g.title ?? 'x', store: 'steam' }),
}));
vi.mock('@/services/game-service', () => ({
  gameService: { getGameDetails: vi.fn().mockResolvedValue(null) },
}));

import { useAIChat } from '@/hooks/useAIChat';

const mockAiChat = {
  sendMessage: vi.fn(),
  getHistory: vi.fn(),
  getActiveConversation: vi.fn(),
  createNewConversation: vi.fn(),
  clearHistory: vi.fn(),
};

const base: AIResponse = { content: 'ok', toolsUsed: [], actions: [], chainOfThought: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { aiChat: typeof mockAiChat }).aiChat = mockAiChat;
  mockAiChat.getActiveConversation.mockResolvedValue(null);
  mockAiChat.getHistory.mockResolvedValue([]);
  lib.getAllEntries.mockReturnValue([]);
});

const removeResponse: AIResponse = {
  ...base,
  actions: [
    { type: 'remove', appId: 1, gameId: 'steam-1', gameName: 'Hollow Knight' },
    { type: 'remove', appId: 2, gameId: 'steam-2', gameName: 'Celeste' },
  ],
};

describe('useAIChat library actions', () => {
  it('attaches removals as pending and removes only on confirm', async () => {
    mockAiChat.sendMessage.mockResolvedValue(removeResponse);
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    await act(async () => { await result.current.sendMessage('remove them'); });

    const msg = result.current.messages[1];
    expect(msg.removalState).toBe('pending');
    expect(msg.pendingRemovals?.map(r => r.gameName)).toEqual(['Hollow Knight', 'Celeste']);
    expect(lib.removeFromLibrary).not.toHaveBeenCalled();

    act(() => result.current.confirmPendingRemovals(msg.id));
    expect(lib.removeFromLibrary).toHaveBeenCalledTimes(2);
    expect(result.current.messages[1].removalState).toBe('removed');

    // A second confirm is a no-op.
    act(() => result.current.confirmPendingRemovals(msg.id));
    expect(lib.removeFromLibrary).toHaveBeenCalledTimes(2);
  });

  it('cancel leaves the library intact', async () => {
    mockAiChat.sendMessage.mockResolvedValue(removeResponse);
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    await act(async () => { await result.current.sendMessage('remove them'); });

    const id = result.current.messages[1].id;
    act(() => result.current.cancelPendingRemovals(id));
    expect(result.current.messages[1].removalState).toBe('cancelled');
    act(() => result.current.confirmPendingRemovals(id));
    expect(lib.removeFromLibrary).not.toHaveBeenCalled();
  });

  it('add with status "backlog" stores Want to Play', async () => {
    mockAiChat.sendMessage.mockResolvedValue({
      ...base,
      actions: [{ type: 'add', appId: 620, gameId: 'steam-620', status: 'backlog', gameName: 'Portal 2' }],
    });
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    await act(async () => { await result.current.sendMessage('add portal'); });

    expect(lib.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      gameId: 'steam-620',
      steamAppId: 620,
      status: 'Want to Play',
      priority: 'Medium',
    }));
    expect(result.current.messages[1].pendingRemovals).toBeUndefined();
  });
});

describe('useAIChat while a reply is pending', () => {
  it('clearHistory and createNewConversation are no-ops until the reply finishes', async () => {
    let resolveReply!: (r: AIResponse) => void;
    mockAiChat.sendMessage.mockReturnValue(new Promise<AIResponse>(r => { resolveReply = r; }));
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));

    let pending!: Promise<void>;
    act(() => { pending = result.current.sendMessage('hello'); });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    await act(async () => {
      await result.current.clearHistory();
      await result.current.createNewConversation();
    });
    expect(mockAiChat.clearHistory).not.toHaveBeenCalled();
    expect(mockAiChat.createNewConversation).not.toHaveBeenCalled();

    await act(async () => { resolveReply(base); await pending; });
    expect(result.current.isLoading).toBe(false);
    await act(async () => { await result.current.clearHistory(); });
    expect(mockAiChat.clearHistory).toHaveBeenCalled();
  });
});

describe('useAIChat gameId removals and region (B12)', () => {
  afterEach(() => {
    localStorage.removeItem(GG_REGION_LS_KEY);
  });

  it('removes by gameId when present (after confirm) and sends the gg.deals region', async () => {
    localStorage.setItem(GG_REGION_LS_KEY, 'gb');
    mockAiChat.sendMessage.mockResolvedValue({
      ...base,
      content: '## Done',
      actions: [
        { type: 'remove', appId: 0, gameId: 'epic-ns:offer', gameName: 'Epic Game' },
        { type: 'remove', appId: 123, gameName: 'Steam Game' },
      ],
    });
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    await act(async () => { await result.current.sendMessage('remove them'); });

    expect(mockAiChat.sendMessage.mock.calls[0][0].ggRegion).toBe('gb');
    expect(lib.removeFromLibrary).not.toHaveBeenCalled();
    act(() => result.current.confirmPendingRemovals(result.current.messages[1].id));
    expect(lib.removeFromLibrary).toHaveBeenNthCalledWith(1, 'epic-ns:offer');
    expect(lib.removeFromLibrary).toHaveBeenNthCalledWith(2, 'steam-123');
  });
});
