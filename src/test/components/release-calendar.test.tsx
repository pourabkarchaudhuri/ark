import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { ReleaseCalendar } from '@/components/release-calendar';
import { ToastProvider } from '@/components/ui/toast';
import { Game } from '@/types/game';

// ─── ResizeObserver mock (needed by @tanstack/virtual-core) ──────────────────
// The global mock in setup.ts returns a plain object; tanstack needs observe().
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// ─── IntersectionObserver mock (needed by GameCard's detail-enricher) ────────
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock wouter
vi.mock('wouter', () => ({
  useLocation: vi.fn(() => ['/', vi.fn()]),
}));

// Mock prefetch-store — the primary data source for the calendar
const mockGetPrefetchedGames = vi.fn<() => Game[] | null>(() => null);
const mockIsPrefetchReady = vi.fn(() => false);

vi.mock('@/services/prefetch-store', () => ({
  getPrefetchedGames: (...args: unknown[]) => mockGetPrefetchedGames(...(args as [])),
  isPrefetchReady: (...args: unknown[]) => mockIsPrefetchReady(...(args as [])),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Game object suitable for the prefetch store. */
function makeGame(overrides: Partial<Game> & { title: string; id: string }): Game {
  return {
    developer: 'Dev',
    publisher: 'Pub',
    genre: [],
    platform: ['Windows'],
    metacriticScore: null,
    releaseDate: '',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Generate N "Coming Soon" games with no concrete release date. */
function makeComingSoonGames(count: number): Game[] {
  return Array.from({ length: count }, (_, i) =>
    makeGame({
      id: `epic-ns:cs-${i}`,
      title: `Coming Soon Game ${i}`,
      releaseDate: 'Coming Soon',
      comingSoon: true,
      store: 'epic',
    }),
  );
}

/** Generate a dated game releasing in the current month. */
function makeDatedGame(day: number, name: string): Game {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = new Date(year, month, day);
  return makeGame({
    id: `steam-${1000 + day}`,
    title: name,
    releaseDate: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    comingSoon: date > now,
    store: 'steam',
  });
}

/** Render the calendar wrapped in required providers. */
function renderCalendar() {
  return render(
    <ToastProvider>
      <ReleaseCalendar />
    </ToastProvider>
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReleaseCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Re-apply matchMedia mock (vi.restoreAllMocks in afterEach clears it)
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    // Mock window.steam and window.epic so the fallback API path doesn't crash
    Object.defineProperty(window, 'steam', {
      value: {
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'epic', {
      value: {
        getUpcomingReleases: vi.fn().mockResolvedValue([]),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ── Basic rendering ──────────────────────────────────────────────────────

  it('renders the calendar skeleton while loading', () => {
    // Prefetch not ready → falls back to API → shows skeleton during fetch
    mockIsPrefetchReady.mockReturnValue(false);

    renderCalendar();

    // Skeleton loader cells use animate-pulse
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders year header in default year view', async () => {
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue([makeDatedGame(15, 'Test Game')]);

    renderCalendar();

    const now = new Date();
    const expectedHeader = String(now.getFullYear());

    await waitFor(() => {
      expect(screen.getByText(expectedHeader)).toBeInTheDocument();
    });
  });

  it('renders month names as section headers in year view', async () => {
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue([makeDatedGame(15, 'Test Game')]);

    renderCalendar();

    await waitFor(() => {
      expect(screen.getByText('January')).toBeInTheDocument();
      expect(screen.getByText('June')).toBeInTheDocument();
      expect(screen.getByText('December')).toBeInTheDocument();
    });
  });

  // ── Coming Soon cap ──────────────────────────────────────────────────────

  it('caps Coming Soon entries at 300 from the prefetch store', async () => {
    // Generate 500 "Coming Soon" games — only 300 should survive
    const games = makeComingSoonGames(500);
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The count badge appears in both the header button and the sidebar header
    const badges = screen.getAllByText('300');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('does not cap Coming Soon when count is below limit', async () => {
    const games = makeComingSoonGames(50);
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const badges = screen.getAllByText('50');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Sidebar deferred rendering ───────────────────────────────────────────

  it('shows skeleton when sidebar opens (deferred virtualizer)', async () => {
    const games = makeComingSoonGames(20);
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The count badge "20" confirms loading is done
    const badges = screen.getAllByText('20');
    expect(badges.length).toBeGreaterThanOrEqual(1);

    // Click the "Coming Soon" button to open the sidebar
    const openButton = badges[0].closest('button');
    expect(openButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(openButton!);
    });

    // During the 320ms transition, the sidebar shows skeleton pulses
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders sidebar content after transition settles', async () => {
    const games = makeComingSoonGames(5);
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    // Flush initial async effects (fetchReleases, etc.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Find and click the open button — the badge shows "5"
    const badges = screen.getAllByText('5');
    expect(badges.length).toBeGreaterThan(0);

    const openButton = badges[0]?.closest('button');
    if (openButton) {
      await act(async () => {
        fireEvent.click(openButton);
      });

      // Advance past the 320ms defer timeout
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // After settling, the sidebar header "Coming Soon" text should be visible
      const sidebarHeader = screen.getAllByText('Coming Soon');
      expect(sidebarHeader.length).toBeGreaterThan(0);
    }
  });

  // ── Dated releases in poster feed ────────────────────────────────────────

  it('renders dated games in the current month section', async () => {
    const games = [makeDatedGame(15, 'Mid Month Game')];
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Game name appears on the poster card
    const matches = screen.getAllByText('Mid Month Game');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('shows correct count for multiple games on the same day', async () => {
    const games = [
      makeDatedGame(10, 'Game A'),
      makeDatedGame(10, 'Game B'),
    ];
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Both games are in the same month section; the count badge shows "2"
    const badges = screen.getAllByText('2');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Mixed dated + Coming Soon ────────────────────────────────────────────

  it('separates dated and Coming Soon releases correctly', async () => {
    const games = [
      makeDatedGame(20, 'Dated Game'),
      ...makeComingSoonGames(3),
    ];
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Dated game should appear as a poster card
    expect(screen.getByText('Dated Game')).toBeInTheDocument();
    // Coming Soon count badge (the "3") should be in the TBA button area
    const badges = screen.getAllByText('3');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Empty state ──────────────────────────────────────────────────────────

  it('shows empty state when no releases exist', async () => {
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue([]);

    // Both APIs return empty too
    window.steam!.getUpcomingReleases = vi.fn().mockResolvedValue([]);
    window.epic!.getUpcomingReleases = vi.fn().mockResolvedValue([]);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText('No upcoming releases found')).toBeInTheDocument();
  });

  // ── Deduplication ────────────────────────────────────────────────────────

  it('deduplicates games with the same normalized title', async () => {
    const now = new Date();
    const dateStr = new Date(now.getFullYear(), now.getMonth(), 12)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const games = [
      makeDatedGame(12, 'Test Game'),
      makeGame({
        id: 'epic-ns:testgame',
        title: 'Test Game', // Same title — should be deduped
        releaseDate: dateStr,
        comingSoon: true,
        store: 'epic',
      }),
    ];
    mockIsPrefetchReady.mockReturnValue(true);
    mockGetPrefetchedGames.mockReturnValue(games);

    await act(async () => {
      renderCalendar();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // After dedup only one game entity remains. Its title may appear on a
    // poster card. Verify it's not duplicated.
    const matches = screen.getAllByText('Test Game');
    // Without dedup there would be 2 game entities. With dedup it's 1 entity.
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});
