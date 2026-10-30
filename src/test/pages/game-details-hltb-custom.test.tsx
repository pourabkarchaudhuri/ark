/**
 * Custom games on the details page: their release_date holds the date the game was ADDED, so it
 * must not be sent to HowLongToBeat as a release year (an older title added years later would
 * fall below the acceptance score and never get a badge). The lookup goes out title-only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { GameDetailsPage } from '@/pages/game-details';
import { ToastProvider } from '@/components/ui/toast';
import { customGameStore } from '@/services/custom-game-store';

vi.mock('wouter', async () => {
  const actual = await vi.importActual('wouter');
  return {
    ...actual,
    useRoute: vi.fn(() => [true, { id: 'custom-hltb-test' }]),
    useLocation: vi.fn(() => ['/', vi.fn()]),
  };
});

vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn(() => null),
  searchPrefetchedGames: vi.fn(() => []),
  getPrefetchedGames: vi.fn(() => null),
  isPrefetchReady: vi.fn(() => false),
}));

vi.mock('@/services/similar-games', () => ({
  getSimilarGamesForDetails: vi.fn().mockResolvedValue({ status: 'ann_unavailable', items: [] }),
}));

vi.mock('@/services/steam-service', () => ({
  steamService: {
    getNewsForApp: vi.fn().mockResolvedValue([]),
    getMultiplePlayerCounts: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/services/epic-service', () => ({
  epicService: {
    getGameDetails: vi.fn().mockResolvedValue(null),
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { hltb?: unknown }).hltb;
});

describe('GameDetailsPage HowLongToBeat lookup for custom games', () => {
  it('a custom game added in 2025 for an older title asks HLTB with no year', async () => {
    const addedAt = new Date('2025-03-14T12:00:00Z');
    vi.spyOn(customGameStore, 'getGame').mockImplementation((id: string) => (id === 'custom-hltb-test'
      ? ({
        id: 'custom-hltb-test',
        title: 'Half-Life 2',
        platform: ['Windows'],
        status: 'Playing',
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
        addedAt,
        updatedAt: addedAt,
      } as unknown as ReturnType<typeof customGameStore.getGame>)
      : undefined));
    const getTimes = vi.fn().mockResolvedValue(null);
    (window as unknown as { hltb: unknown }).hltb = { getTimes };

    render(
      <ToastProvider>
        <Router>
          <GameDetailsPage />
        </Router>
      </ToastProvider>,
    );

    // The page shows the added date where a release date would be…
    await waitFor(() => expect(screen.getAllByText('Half-Life 2').length).toBeGreaterThan(0));
    await waitFor(() => expect(getTimes).toHaveBeenCalled());
    // …but HowLongToBeat gets the title alone.
    for (const [query] of getTimes.mock.calls) {
      expect(query).toEqual({ title: 'Half-Life 2', year: undefined });
    }
  });
});
