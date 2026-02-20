import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JourneyView } from '@/components/journey-view';
import { JourneyEntry } from '@/types/game';

// Mock wouter
const mockNavigate = vi.fn();
vi.mock('wouter', () => ({
  useLocation: () => ['/journey', mockNavigate],
}));

// Mock library store
vi.mock('@/services/library-store', () => ({
  libraryStore: {
    isInLibrary: vi.fn().mockReturnValue(true),
    getEntry: vi.fn().mockReturnValue(null),
    getAllEntries: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock status history store
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    getAll: vi.fn().mockReturnValue([]),
    getForGame: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock session store
vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getAll: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock @tanstack/react-virtual (jsdom has no layout, virtualizer renders 0 rows)
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 48,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 48,
        size: 48,
        key: i,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

// Mock ShowcaseView (uses Three.js which doesn't work in jsdom)
vi.mock('@/components/showcase-view', () => ({
  ShowcaseView: ({ entries }: { entries: unknown[] }) => (
    <div data-testid="showcase-view">Showcase ({(entries as unknown[]).length} entries)</div>
  ),
}));

// Mock useBadgeProgress (used by MedalsView)
vi.mock('@/hooks/useBadgeProgress', () => ({
  useBadgeProgress: () => ({
    badges: [],
    tasteDna: [],
    genomePurity: 0,
    totalPoints: 0,
    rank: { name: 'Novice', threshold: 0, color: '#888' },
  }),
}));

// Mock medal sub-components
vi.mock('@/components/medals/taste-dna', () => ({
  DnaRadar: () => <div data-testid="dna-radar" />,
}));
vi.mock('@/components/medals/badge-vault', () => ({
  BadgeVault: () => <div data-testid="badge-vault" />,
}));
vi.mock('@/components/medals/overview-charts', () => ({
  computeOverviewAnalytics: () => ({ genreRadar: [], monthlyActivity: [], recSources: [], currentStreak: 0, longestStreak: 0, statusCounts: {}, totalGames: 0, totalHours: 0 }),
  GenreRadarChart: () => <div data-testid="genre-radar-chart" />,
  ActivityAreaChart: () => <div data-testid="activity-area-chart" />,
  DataSourcesRadar: () => <div data-testid="data-sources-radar" />,
}));
vi.mock('@/components/ui/evervault-card', () => ({
  Icon: () => <div data-testid="icon" />,
}));

// Mock framer-motion
vi.mock('framer-motion', () => {
  const motionHandler = {
    get(_: unknown, tag: string) {
      return ({ children, onClick, className, ...props }: Record<string, unknown>) => {
        const Tag = tag as keyof JSX.IntrinsicElements;
        const safe: Record<string, unknown> = {};
        // Filter out framer-motion-specific props for valid DOM attributes
        for (const [k, v] of Object.entries(props)) {
          if (
            !['initial', 'animate', 'exit', 'whileInView', 'viewport', 'transition',
             'variants', 'whileHover', 'whileTap', 'whileFocus', 'whileDrag',
             'layout', 'layoutId', 'onAnimationComplete'].includes(k)
          ) {
            safe[k] = v;
          }
        }
        return <Tag onClick={onClick as React.MouseEventHandler} className={className as string} {...safe}>{children as React.ReactNode}</Tag>;
      };
    },
  };
  return {
    motion: new Proxy({}, motionHandler),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
    useTransform: () => ({ get: () => 0 }),
    useMotionValue: () => ({ get: () => 0, set: () => {}, on: () => () => {} }),
    useInView: () => false,
    animate: () => ({ stop: () => {} }),
  };
});

function createMockEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  const addedAt = overrides.addedAt ?? '2025-03-15T00:00:00.000Z';
  return {
    gameId: 'steam-730',
    title: 'Counter-Strike 2',
    coverUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/730/library_600x900.jpg',
    genre: ['Action', 'FPS'],
    platform: ['Windows'],
    releaseDate: '2023-09-27',
    status: 'Playing',
    hoursPlayed: 120,
    rating: 4,
    addedAt,
    firstPlayedAt: addedAt,
    lastPlayedAt: addedAt,
    ...overrides,
  };
}

describe('JourneyView', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders loading state', () => {
    render(<JourneyView entries={[]} loading={true} />);

    // Should show skeleton loading elements
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders empty state when no entries', () => {
    render(<JourneyView entries={[]} loading={false} />);

    expect(screen.getByText('Your Voyage Awaits')).toBeInTheDocument();
    expect(screen.getByText(/Start adding games/)).toBeInTheDocument();
  });

  it('shows Browse Games button in empty state when onSwitchToBrowse provided', () => {
    const onSwitch = vi.fn();
    render(<JourneyView entries={[]} loading={false} onSwitchToBrowse={onSwitch} />);

    const browseBtn = screen.getByText('Browse Games');
    expect(browseBtn).toBeInTheDocument();

    fireEvent.click(browseBtn);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('groups entries by year', () => {
    const entries = [
      createMockEntry({
        gameId: 'steam-730',
        title: 'Counter-Strike 2',
        addedAt: '2025-03-15T00:00:00.000Z',
        status: 'Playing',
      }),
      createMockEntry({
        gameId: 'steam-570',
        title: 'Dota 2',
        addedAt: '2024-06-20T00:00:00.000Z',
        status: 'Completed',
      }),
      createMockEntry({
        gameId: 'steam-1086940',
        title: "Baldur's Gate 3",
        addedAt: '2024-08-10T00:00:00.000Z',
        status: 'Completed',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getAllByText('2025').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2024').length).toBeGreaterThan(0);
  });

  it('shows game titles in cards', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', title: 'Counter-Strike 2', addedAt: '2025-01-01T00:00:00.000Z' }),
      createMockEntry({ gameId: 'steam-570', title: 'Dota 2', addedAt: '2025-02-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    expect(screen.getByText('Dota 2')).toBeInTheDocument();
  });

  it('shows status badges on game cards', () => {
    const entries = [
      createMockEntry({ status: 'Playing', addedAt: '2025-01-01T00:00:00.000Z' }),
      createMockEntry({
        gameId: 'steam-570',
        title: 'Dota 2',
        status: 'Completed',
        addedAt: '2025-02-01T00:00:00.000Z',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('Playing')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('shows hours played when available', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', hoursPlayed: 120, addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('120 Hrs')).toBeInTheDocument();
  });

  it('shows total stats in header', () => {
    const entries = [
      createMockEntry({
        gameId: 'steam-730',
        status: 'Completed',
        hoursPlayed: 120,
        addedAt: '2025-01-01T00:00:00.000Z',
      }),
      createMockEntry({
        gameId: 'steam-570',
        title: 'Dota 2',
        status: 'Playing',
        hoursPlayed: 50,
        addedAt: '2025-02-01T00:00:00.000Z',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    expect(screen.getByText(/played/)).toBeInTheDocument();
  });

  it('navigates to game details on card click', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    const textEl = screen.getByText('Counter-Strike 2');
    const card = textEl.closest('div[class]');
    expect(card).toBeInTheDocument();
    if (card) fireEvent.click(card);

    expect(mockNavigate).toHaveBeenCalledWith('/game/steam-730');
  });

  it('shows year summary with game count', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z', status: 'Playing' }),
      createMockEntry({
        gameId: 'steam-570',
        title: 'Dota 2',
        addedAt: '2025-06-01T00:00:00.000Z',
        status: 'Completed',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText(/2 titles registered/)).toBeInTheDocument();
  });

  it('shows "Removed" badge for removed games', async () => {
    const { libraryStore } = await import('@/services/library-store');
    (libraryStore.isInLibrary as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const entries = [
      createMockEntry({
        gameId: 'steam-730',
        addedAt: '2025-01-01T00:00:00.000Z',
        removedAt: '2025-06-01T00:00:00.000Z',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.queryByText('In Library')).not.toBeInTheDocument();
  });

  it('shows "In Library" badge for games still in library', async () => {
    const { libraryStore } = await import('@/services/library-store');
    (libraryStore.isInLibrary as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const entries = [
      createMockEntry({
        gameId: 'steam-730',
        addedAt: '2025-01-01T00:00:00.000Z',
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('In Library')).toBeInTheDocument();
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  // ── Log / OCD / Medals tab toggle tests ──

  it('renders Log, OCD, and Medals tab buttons', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    expect(screen.getByText('Log')).toBeInTheDocument();
    expect(screen.getByText('OCD')).toBeInTheDocument();
    expect(screen.getByText('Medals')).toBeInTheDocument();
  });

  it('defaults to Ark view, switches to Log view with timeline', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Click Log tab to switch to Captain's Log view
    fireEvent.click(screen.getByText('Log'));

    // Log view shows year labels via the Timeline component
    expect(screen.getAllByText('2025').length).toBeGreaterThan(0);
  });

  it('switches to OCD view when OCD tab is clicked', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Click OCD tab
    fireEvent.click(screen.getByText('OCD'));

    // OCD view shows the game title (may appear in both timeline and Gantt)
    const titles = screen.getAllByText('Counter-Strike 2');
    expect(titles.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Mock/Live toggle only in OCD view', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // In Ark view, Mock/Live should NOT be visible
    expect(screen.queryByText('Mock')).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();

    // Switch to OCD
    fireEvent.click(screen.getByText('OCD'));

    // Now Mock/Live should be visible
    expect(screen.getByText('Mock')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('loads mock data when Mock is clicked in OCD view', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Switch to OCD
    fireEvent.click(screen.getByText('OCD'));
    // Switch to Mock
    fireEvent.click(screen.getByText('Mock'));

    // Mock data includes well-known game titles from the mock generator
    const eldenRings = screen.getAllByText('Elden Ring');
    expect(eldenRings.length).toBeGreaterThanOrEqual(1);
  });

  it('switches to Medals view when Medals tab is clicked', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    fireEvent.click(screen.getByText('Medals'));

    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Badge Vault')).toBeInTheDocument();
  });
});
