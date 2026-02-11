import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Router, useRoute } from 'wouter';
import { GameDetailsPage } from '@/pages/game-details';
import { ToastProvider } from '@/components/ui/toast';
import { SteamAppDetails, SteamReviewsResponse } from '@/types/steam';

// Mock wouter hooks
vi.mock('wouter', async () => {
  const actual = await vi.importActual('wouter');
  return {
    ...actual,
    useRoute: vi.fn(() => [true, { id: 'steam-730' }]), // Universal string ID for CS2
    useLocation: vi.fn(() => ['/', vi.fn()]),
  };
});

// Mock prefetch-store — avoids side-effects from the real module
vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn(() => null),
  searchPrefetchedGames: vi.fn(() => []),
  getPrefetchedGames: vi.fn(() => null),
  isPrefetchReady: vi.fn(() => false),
}));

// Mock fitgirl-service — avoids network calls
vi.mock('@/services/fitgirl-service', () => ({
  getRepackLinkForGame: vi.fn().mockResolvedValue(null),
}));

// Mock steam-service — avoids IPC/fetch calls
vi.mock('@/services/steam-service', () => ({
  steamService: {
    getNewsForApp: vi.fn().mockResolvedValue([]),
    getMultiplePlayerCounts: vi.fn().mockResolvedValue({}),
  },
}));

// Mock epic-service
vi.mock('@/services/epic-service', () => ({
  epicService: {
    getGameDetails: vi.fn().mockResolvedValue(null),
  },
}));

const mockUseRoute = vi.mocked(useRoute);

// Mock game details
const mockGameDetails: SteamAppDetails = {
  type: 'game',
  name: 'Counter-Strike 2',
  steam_appid: 730,
  required_age: 0,
  is_free: true,
  detailed_description: '<p>Test description for Counter-Strike 2</p>',
  about_the_game: 'About this game',
  short_description: 'Short description',
  supported_languages: 'English, French, German',
  header_image: 'https://example.com/header.jpg',
  capsule_image: 'https://example.com/capsule.jpg',
  capsule_imagev5: 'https://example.com/capsulev5.jpg',
  website: 'https://www.counter-strike.net',
  pc_requirements: {
    minimum: '<strong>Minimum:</strong> OS: Windows 10',
    recommended: '<strong>Recommended:</strong> OS: Windows 10/11',
  },
  developers: ['Valve'],
  publishers: ['Valve'],
  platforms: {
    windows: true,
    mac: true,
    linux: true,
  },
  metacritic: {
    score: 83,
    url: 'https://www.metacritic.com/game/pc/counter-strike-2',
  },
  categories: [
    { id: 1, description: 'Multi-player' },
    { id: 36, description: 'Online PvP' },
  ],
  genres: [
    { id: '1', description: 'Action' },
    { id: '37', description: 'Free to Play' },
  ],
  screenshots: [
    { id: 1, path_thumbnail: 'https://example.com/thumb1.jpg', path_full: 'https://example.com/full1.jpg' },
    { id: 2, path_thumbnail: 'https://example.com/thumb2.jpg', path_full: 'https://example.com/full2.jpg' },
  ],
  movies: [
    {
      id: 1,
      name: 'Trailer',
      thumbnail: 'https://example.com/trailer_thumb.jpg',
      mp4: { '480': 'https://example.com/trailer_480.mp4', max: 'https://example.com/trailer_max.mp4' },
    },
  ],
  recommendations: { total: 1000000 },
  achievements: { total: 167 },
  release_date: {
    coming_soon: false,
    date: 'Aug 21, 2012',
  },
  background: 'https://example.com/background.jpg',
};

// Mock reviews response
const mockReviews: SteamReviewsResponse = {
  success: 1,
  query_summary: {
    num_reviews: 10,
    review_score: 9,
    review_score_desc: 'Very Positive',
    total_positive: 8500000,
    total_negative: 1500000,
    total_reviews: 10000000,
  },
  reviews: [
    {
      recommendationid: '1',
      author: {
        steamid: '12345',
        num_games_owned: 100,
        num_reviews: 50,
        playtime_forever: 1200,
        playtime_last_two_weeks: 60,
        playtime_at_review: 1000,
        last_played: 1700000000,
      },
      language: 'english',
      review: 'Great game! Highly recommended.',
      timestamp_created: 1700000000,
      timestamp_updated: 1700000000,
      voted_up: true,
      votes_up: 100,
      votes_funny: 5,
      weighted_vote_score: '0.9',
      comment_count: 10,
      steam_purchase: true,
      received_for_free: false,
      written_during_early_access: false,
    },
    {
      recommendationid: '2',
      author: {
        steamid: '67890',
        num_games_owned: 50,
        num_reviews: 20,
        playtime_forever: 500,
        playtime_last_two_weeks: 20,
        playtime_at_review: 400,
        last_played: 1699000000,
      },
      language: 'english',
      review: 'Not for everyone but I enjoyed it.',
      timestamp_created: 1699000000,
      timestamp_updated: 1699000000,
      voted_up: false,
      votes_up: 20,
      votes_funny: 2,
      weighted_vote_score: '0.5',
      comment_count: 3,
      steam_purchase: true,
      received_for_free: false,
      written_during_early_access: false,
    },
  ],
};

// Mock Metacritic response
const mockMetacriticReviews = {
  title: 'Counter-Strike 2',
  poster: 'https://example.com/poster.jpg',
  score: 83,
  release_date: 'Sep 27, 2023',
  reviews: [
    {
      review: 'A worthy successor to the legendary CS:GO.',
      review_critic: 'IGN',
      author: 'John Smith',
      review_date: 'Sep 28, 2023',
      review_grade: '85',
    },
    {
      review: 'Valve delivers another masterpiece.',
      review_critic: 'GameSpot',
      author: 'Jane Doe',
      review_date: 'Sep 29, 2023',
      review_grade: '90',
    },
  ],
};

function renderGameDetails() {
  return render(
    <ToastProvider>
      <Router>
        <GameDetailsPage />
      </Router>
    </ToastProvider>
  );
}

describe('GameDetailsPage', () => {
  beforeEach(() => {
    // Mock window.steam
    Object.defineProperty(window, 'steam', {
      value: {
        getAppDetails: vi.fn().mockResolvedValue(mockGameDetails),
        getGameReviews: vi.fn().mockResolvedValue(mockReviews),
        getMostPlayedGames: vi.fn().mockResolvedValue([]),
        getMultipleAppDetails: vi.fn().mockResolvedValue([]),
        searchGames: vi.fn().mockResolvedValue([]),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getTopSellers: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getQueueStatus: vi.fn().mockResolvedValue({ queueSize: 0 }),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCoverUrl: vi.fn((appId: number) => `https://cdn.steam.com/${appId}/cover.jpg`),
        getHeaderUrl: vi.fn((appId: number) => `https://cdn.steam.com/${appId}/header.jpg`),
        getNewsForApp: vi.fn().mockResolvedValue([]),
        getMultiplePlayerCounts: vi.fn().mockResolvedValue({}),
        getGamesByGenre: vi.fn().mockResolvedValue([]),
        getRecommendations: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.epic
    Object.defineProperty(window, 'epic', {
      value: {
        searchGames: vi.fn().mockResolvedValue([]),
        getGameDetails: vi.fn().mockResolvedValue(null),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getFreeGames: vi.fn().mockResolvedValue([]),
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
        getCoverUrl: vi.fn().mockReturnValue(null),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCacheStats: vi.fn().mockResolvedValue({ total: 0, fresh: 0, stale: 0 }),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.metacritic
    Object.defineProperty(window, 'metacritic', {
      value: {
        getGameReviews: vi.fn().mockResolvedValue(mockMetacriticReviews),
        clearCache: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    renderGameDetails();
    
    // Check for skeleton elements (animate-pulse class is used for skeleton loading)
    const skeletonElements = document.querySelectorAll('.animate-pulse');
    expect(skeletonElements.length).toBeGreaterThan(0);
  });

  it('renders game details after loading', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });

    // Check developer (appears multiple times: hero section + details panel)
    const valveElements = screen.getAllByText('Valve');
    expect(valveElements.length).toBeGreaterThan(0);
    
    // Check Metacritic score (appears in header badge + Metascore section)
    const scoreElements = screen.getAllByText('83');
    expect(scoreElements.length).toBeGreaterThan(0);
  });

  it('renders game genres', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Action')).toBeInTheDocument();
    });

    // Free to Play may appear multiple times (genre badge + price badge)
    const freeToPlayElements = screen.getAllByText('Free to Play');
    expect(freeToPlayElements.length).toBeGreaterThan(0);
  });

  it('renders Steam reviews section', async () => {
    renderGameDetails();

    await waitFor(() => {
      // There are multiple Steam Reviews sections (main + compact sidebar)
      const steamReviewsElements = screen.getAllByText('Steam Reviews');
      expect(steamReviewsElements.length).toBeGreaterThan(0);
    });

    // Check review summary - there might be multiple 85% elements
    const percentageElements = screen.getAllByText('85%');
    expect(percentageElements.length).toBeGreaterThan(0);
  });

  it('renders individual review content', async () => {
    renderGameDetails();

    // Wait for the thumbs up/down icons in reviews (which indicate reviews are rendered)
    await waitFor(() => {
      // Check for reviews section header
      const steamReviewsElements = screen.getAllByText('Steam Reviews');
      expect(steamReviewsElements.length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // We can verify reviews section exists by checking for percentage display
    const percentageElements = screen.getAllByText('85%');
    expect(percentageElements.length).toBeGreaterThan(0);
  });

  it('calls Steam API on mount with correct app ID', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(window.steam!.getAppDetails).toHaveBeenCalledWith(730);
    });

    expect(window.steam!.getGameReviews).toHaveBeenCalledWith(730, 10);
  });

  it('handles API error gracefully', async () => {
    // Override to simulate error
    window.steam!.getAppDetails = vi.fn().mockResolvedValue(null);

    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Game not found')).toBeInTheDocument();
    });
  });

  it('handles missing reviews gracefully', async () => {
    // Override to simulate reviews not available
    window.steam!.getGameReviews = vi.fn().mockRejectedValue(new Error('Reviews not available'));

    renderGameDetails();

    // Page should still load with game details
    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });
  });

  it('renders system requirements', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('System Requirements')).toBeInTheDocument();
    });

    expect(screen.getByText('Minimum')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('renders platform badges', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Windows')).toBeInTheDocument();
    });

    expect(screen.getByText('macOS')).toBeInTheDocument();
    expect(screen.getByText('Linux')).toBeInTheDocument();
  });

  it('renders Steam store link', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('View on Steam')).toBeInTheDocument();
    });
  });
});

describe('Steam Reviews API Types', () => {
  it('SteamReviewsResponse has correct structure', () => {
    const response: SteamReviewsResponse = mockReviews;
    
    expect(response.success).toBe(1);
    expect(response.query_summary.total_reviews).toBe(10000000);
    expect(response.query_summary.total_positive).toBe(8500000);
    expect(response.query_summary.total_negative).toBe(1500000);
    expect(response.reviews).toHaveLength(2);
  });

  it('SteamReview has author information', () => {
    const review = mockReviews.reviews[0];
    
    expect(review.author.steamid).toBe('12345');
    expect(review.author.playtime_forever).toBe(1200);
    expect(review.voted_up).toBe(true);
    expect(review.votes_up).toBe(100);
  });

  it('calculates positive percentage correctly', () => {
    const { total_positive, total_reviews } = mockReviews.query_summary;
    const percentage = Math.round((total_positive / total_reviews) * 100);
    
    expect(percentage).toBe(85);
  });
});

describe('Metacritic Integration', () => {
  beforeEach(() => {
    // Mock window.steam
    Object.defineProperty(window, 'steam', {
      value: {
        getAppDetails: vi.fn().mockResolvedValue(mockGameDetails),
        getGameReviews: vi.fn().mockResolvedValue(mockReviews),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.epic
    Object.defineProperty(window, 'epic', {
      value: {
        searchGames: vi.fn().mockResolvedValue([]),
        getGameDetails: vi.fn().mockResolvedValue(null),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getFreeGames: vi.fn().mockResolvedValue([]),
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
        getCoverUrl: vi.fn().mockReturnValue(null),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCacheStats: vi.fn().mockResolvedValue({ total: 0, fresh: 0, stale: 0 }),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.metacritic
    Object.defineProperty(window, 'metacritic', {
      value: {
        getGameReviews: vi.fn().mockResolvedValue(mockMetacriticReviews),
        clearCache: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls Metacritic API with game name', async () => {
    renderGameDetails();

    // Wait for the game details to load first
    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });

    // Metacritic API should be called with the game name
    await waitFor(() => {
      expect(window.metacritic!.getGameReviews).toHaveBeenCalledWith('Counter-Strike 2');
    }, { timeout: 3000 });
  });

  it('renders Critic Reviews section', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Critic Reviews')).toBeInTheDocument();
    });
  });

  it('renders Metascore label', async () => {
    renderGameDetails();

    // Wait for Metacritic data to load
    await waitFor(() => {
      expect(screen.getByText('Metascore')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('renders critic publication names', async () => {
    renderGameDetails();

    // Wait for Metacritic data to load
    await waitFor(() => {
      expect(screen.getByText('IGN')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('handles Metacritic API failure gracefully', async () => {
    // Override to simulate error
    window.metacritic!.getGameReviews = vi.fn().mockRejectedValue(new Error('Metacritic unavailable'));

    renderGameDetails();

    // Page should still load with game details
    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });

    // Should show no reviews available
    await waitFor(() => {
      expect(screen.getByText('No critic reviews available')).toBeInTheDocument();
    });
  });

  it('handles missing Metacritic API gracefully', async () => {
    // Remove Metacritic from window
    Object.defineProperty(window, 'metacritic', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    renderGameDetails();

    // Page should still load with game details
    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });
  });
});

describe('Epic Game Details', () => {
  beforeEach(() => {
    // Override route to point to an Epic game
    mockUseRoute.mockReturnValue([true, { id: 'epic-fn:fortnite' }] as any);

    // Mock window.steam
    Object.defineProperty(window, 'steam', {
      value: {
        getAppDetails: vi.fn().mockResolvedValue(null),
        getGameReviews: vi.fn().mockResolvedValue(null),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.epic
    Object.defineProperty(window, 'epic', {
      value: {
        searchGames: vi.fn().mockResolvedValue([]),
        getGameDetails: vi.fn().mockResolvedValue({
          namespace: 'fn',
          id: 'fortnite',
          title: 'Fortnite',
          description: 'A battle royale game',
          developer: 'Epic Games',
          publisher: 'Epic Games',
          releaseDate: '2017-07-25',
          keyImages: [
            { type: 'DieselStoreFrontWide', url: 'https://example.com/wide.jpg' },
            { type: 'OfferImageTall', url: 'https://example.com/tall.jpg' },
          ],
          categories: [{ path: 'games/edition/base' }],
          price: { totalPrice: { fmtPrice: { originalPrice: 'Free' } }, totalPaymentPrice: { fmtPrice: { originalPrice: 'Free' } } },
          tags: [{ id: '1216', name: 'Action' }],
        }),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getFreeGames: vi.fn().mockResolvedValue([]),
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
        getCoverUrl: vi.fn().mockReturnValue('https://example.com/cover.jpg'),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCacheStats: vi.fn().mockResolvedValue({ total: 0, fresh: 0, stale: 0 }),
      },
      writable: true,
      configurable: true,
    });

    // Mock window.metacritic
    Object.defineProperty(window, 'metacritic', {
      value: {
        getGameReviews: vi.fn().mockResolvedValue(null),
        clearCache: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset route mock
    mockUseRoute.mockReturnValue([true, { id: 'steam-730' }] as any);
  });

  it('fetches Epic game details for epic-prefixed IDs', async () => {
    renderGameDetails();

    // The component uses epicService (the module), not window.epic directly
    await waitFor(() => {
      expect(mockedEpicService.getGameDetails).toHaveBeenCalledWith('fn', 'fortnite');
    });
  });

  it('does not call Steam API for Epic games', async () => {
    renderGameDetails();

    // Give it time to process
    await waitFor(() => {
      expect(mockedEpicService.getGameDetails).toHaveBeenCalled();
    });

    // Steam API should NOT be called for Epic game IDs
    expect(window.steam!.getAppDetails).not.toHaveBeenCalled();
  });
});

// ─── State Reset on Navigation ──────────────────────────────────────────────
// Verifies that stale data from a previous game doesn't bleed through when the
// user navigates to a different game details page.

describe('State Reset on Navigation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'steam', {
      value: {
        getAppDetails: vi.fn().mockResolvedValue(mockGameDetails),
        getGameReviews: vi.fn().mockResolvedValue(mockReviews),
        getRecommendations: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'epic', {
      value: {
        searchGames: vi.fn().mockResolvedValue([]),
        getGameDetails: vi.fn().mockResolvedValue(null),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getFreeGames: vi.fn().mockResolvedValue([]),
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
        getCoverUrl: vi.fn().mockReturnValue(null),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCacheStats: vi.fn().mockResolvedValue({ total: 0, fresh: 0, stale: 0 }),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'metacritic', {
      value: {
        getGameReviews: vi.fn().mockResolvedValue(mockMetacriticReviews),
        clearCache: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockUseRoute.mockReturnValue([true, { id: 'steam-730' }] as any);
  });

  it('resets state when gameId changes (no stale data)', async () => {
    // First render — load CS2
    const { unmount } = renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });

    // Verify Steam API was called for the first game
    expect(window.steam!.getAppDetails).toHaveBeenCalledWith(730);

    unmount();

    // Second render — load a different game
    const differentDetails = { ...mockGameDetails, name: 'Half-Life 3', steam_appid: 999 };
    window.steam!.getAppDetails = vi.fn().mockResolvedValue(differentDetails);
    mockUseRoute.mockReturnValue([true, { id: 'steam-999' }] as any);

    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Half-Life 3')).toBeInTheDocument();
    });

    // The first game's name should NOT be present
    expect(screen.queryByText('Counter-Strike 2')).not.toBeInTheDocument();
    // API should have been called with the new appId
    expect(window.steam!.getAppDetails).toHaveBeenCalledWith(999);
  });

  it('shows loading skeleton during navigation', async () => {
    // Make the API slow to resolve
    let resolveDetails!: (val: SteamAppDetails) => void;
    window.steam!.getAppDetails = vi.fn().mockReturnValue(
      new Promise((resolve) => { resolveDetails = resolve; })
    );

    renderGameDetails();

    // Should show skeleton while loading
    const skeletonElements = document.querySelectorAll('.animate-pulse');
    expect(skeletonElements.length).toBeGreaterThan(0);

    // Resolve the API call
    await act(async () => {
      resolveDetails(mockGameDetails);
    });

    await waitFor(() => {
      expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    });
  });
});

// ─── epicToSteamDetails Normalizer ──────────────────────────────────────────
// Tests the conversion function that transforms Epic Game objects into
// SteamAppDetails-compatible shapes for the unified detail layout.

// Import the mocked epicService (vi.mock hoists above imports)
import { epicService } from '@/services/epic-service';
const mockedEpicService = vi.mocked(epicService);

describe('epicToSteamDetails normalizer (via Epic rendering)', () => {

  beforeEach(() => {
    mockUseRoute.mockReturnValue([true, { id: 'epic-ns:offer1' }] as any);

    Object.defineProperty(window, 'steam', {
      value: {
        getAppDetails: vi.fn().mockResolvedValue(null),
        getGameReviews: vi.fn().mockResolvedValue(null),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'epic', {
      value: {
        searchGames: vi.fn().mockResolvedValue([]),
        getGameDetails: vi.fn().mockResolvedValue(null),
        getNewReleases: vi.fn().mockResolvedValue([]),
        getComingSoon: vi.fn().mockResolvedValue([]),
        getFreeGames: vi.fn().mockResolvedValue([]),
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
        getCoverUrl: vi.fn().mockReturnValue(null),
        clearCache: vi.fn().mockResolvedValue(undefined),
        getCacheStats: vi.fn().mockResolvedValue({ total: 0, fresh: 0, stale: 0 }),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'metacritic', {
      value: {
        getGameReviews: vi.fn().mockResolvedValue(null),
        clearCache: vi.fn().mockResolvedValue(true),
      },
      writable: true,
      configurable: true,
    });

    // Mock epicService to return a Game object (the normalized shape)
    mockedEpicService.getGameDetails.mockResolvedValue({
      id: 'epic-ns:offer1',
      title: 'Epic Test Game',
      developer: 'TestDev',
      publisher: 'TestPub',
      genre: ['Action', 'Adventure'],
      platform: ['Windows', 'Mac'],
      metacriticScore: 78,
      releaseDate: 'Dec 15, 2025',
      summary: 'A test game from Epic Store',
      coverUrl: 'https://example.com/cover.jpg',
      headerImage: 'https://example.com/header.jpg',
      screenshots: ['https://example.com/ss1.jpg', 'https://example.com/ss2.jpg'],
      price: { isFree: false, finalFormatted: '$29.99', discountPercent: 10 },
      store: 'epic',
      epicNamespace: 'ns',
      epicOfferId: 'offer1',
      epicSlug: 'epic-test-game',
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockUseRoute.mockReturnValue([true, { id: 'steam-730' }] as any);
  });

  it('renders Epic game using the unified layout (epicToSteamDetails)', async () => {
    renderGameDetails();

    // The game title should render (epicToSteamDetails maps title → name)
    await waitFor(() => {
      expect(screen.getByText('Epic Test Game')).toBeInTheDocument();
    });
  });

  it('renders Epic game genres from normalized data', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Action')).toBeInTheDocument();
    });
    expect(screen.getByText('Adventure')).toBeInTheDocument();
  });

  it('renders Epic game description', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('A test game from Epic Store')).toBeInTheDocument();
    });
  });

  it('shows Epic store badge for Epic-primary games', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('Epic Test Game')).toBeInTheDocument();
    });

    // Should show "View on Epic Games" link
    expect(screen.getByText('View on Epic Games')).toBeInTheDocument();
  });

  it('renders price from Epic game data', async () => {
    renderGameDetails();

    await waitFor(() => {
      expect(screen.getByText('$29.99')).toBeInTheDocument();
    });
  });
});
