/**
 * useAIChat (1.0.97 B12): chat library actions remove the exact gameId the main
 * process queued (Epic/custom entries included), and every send carries the
 * gg.deals region from Settings → Prices.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { GG_REGION_LS_KEY } from '@/services/ggdeals-service';

const lib = vi.hoisted(() => ({ addToLibrary: vi.fn(), removeFromLibrary: vi.fn() }));

vi.mock('@/hooks/useGameStore', () => ({
  useLibrary: () => ({
    getAllEntries: () => [],
    addToLibrary: lib.addToLibrary,
    removeFromLibrary: lib.removeFromLibrary,
  }),
}));

import { useAIChat } from '@/hooks/useAIChat';

const aiChat = {
  sendMessage: vi.fn(),
  getHistory: vi.fn(),
  getActiveConversation: vi.fn(),
  createNewConversation: vi.fn(),
  clearHistory: vi.fn(),
  searchGamesForContext: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  aiChat.getHistory.mockResolvedValue([]);
  aiChat.getActiveConversation.mockResolvedValue(null);
  (window as unknown as { aiChat: typeof aiChat }).aiChat = aiChat;
});
afterEach(() => {
  localStorage.removeItem(GG_REGION_LS_KEY);
});

describe('useAIChat actions and region', () => {
  it('removes by gameId when present and sends the gg.deals region', async () => {
    localStorage.setItem(GG_REGION_LS_KEY, 'gb');
    aiChat.sendMessage.mockResolvedValue({
      success: true,
      content: '## Done',
      actions: [
        { type: 'remove', appId: 0, gameId: 'epic-ns:offer', gameName: 'Epic Game' },
        { type: 'remove', appId: 123, gameName: 'Steam Game' },
      ],
    });
    const { result } = renderHook(() => useAIChat({ autoLoad: false }));
    await act(async () => { await result.current.sendMessage('remove them'); });

    expect(aiChat.sendMessage.mock.calls[0][0].ggRegion).toBe('gb');
    expect(lib.removeFromLibrary).toHaveBeenNthCalledWith(1, 'epic-ns:offer');
    expect(lib.removeFromLibrary).toHaveBeenNthCalledWith(2, 'steam-123');
  });
});
