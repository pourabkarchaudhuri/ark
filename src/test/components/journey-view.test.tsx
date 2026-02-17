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
    useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
    useTransform: () => ({ get: () => 0 }),
    useMotionValue: () => ({ get: () => 0, set: () => {}, on: () => () => {} }),
    useInView: () => false,
    animate: () => ({ stop: () => {} }),
  };
});

function createMockEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
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
    addedAt: '2025-03-15T00:00:00.000Z',
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

    // Both year labels should appear (Timeline renders them as headings)
    expect(screen.getAllByText('2025').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2024').length).toBeGreaterThan(0);
  });

  it('shows game titles in cards', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', title: 'Counter-Strike 2', addedAt: '2025-01-01T00:00:00.000Z' }),
      createMockEntry({ gameId: 'steam-570', title: 'Dota 2', addedAt: '2025-02-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

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

    expect(screen.getByText('Playing')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('shows hours played when available', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', hoursPlayed: 120, addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

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

    // Header should show game count and completed count
    expect(screen.getByText(/2 games in your history/)).toBeInTheDocument();
    // "1 completed" appears in header and year summary, so use getAllByText
    const completedTexts = screen.getAllByText(/1 completed/);
    expect(completedTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to game details on card click', () => {
    const entries = [
      createMockEntry({ gameId: 'steam-730', addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    const textEl = screen.getByText('Counter-Strike 2');
    // Walk up to the nearest clickable card container (rendered as a plain div by the mock)
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

    // Should show "2 games added" in the year summary
    expect(screen.getByText(/2 games added/)).toBeInTheDocument();
  });

  it('shows "Removed" badge for removed games', async () => {
    // Game was removed, so it's no longer in the library
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

    expect(screen.getByText('In Library')).toBeInTheDocument();
    expect(screen.queryByText('Removed')).not.toBeInTheDocument();
  });

  // ── Noob / OCD / Analytics tab toggle tests ──

  it('renders Noob, OCD, and Analytics tab buttons', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    expect(screen.getByText('Noob')).toBeInTheDocument();
    expect(screen.getByText('OCD')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
  });

  it('defaults to Noob view (timeline renders)', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Noob view shows year labels via the Timeline component
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

    // In Noob view, Mock/Live should NOT be visible
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

  it('switches to Analytics view when Analytics tab is clicked', () => {
    const entries = [
      createMockEntry({
        gameId: 'steam-730',
        title: 'Counter-Strike 2',
        addedAt: '2025-01-01T00:00:00.000Z',
        hoursPlayed: 120,
        status: 'Completed',
        genre: ['Action', 'FPS'],
      }),
      createMockEntry({
        gameId: 'steam-570',
        title: 'Dota 2',
        addedAt: '2025-02-01T00:00:00.000Z',
        hoursPlayed: 50,
        status: 'Playing',
        genre: ['Strategy', 'MOBA'],
      }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Click Analytics tab
    fireEvent.click(screen.getByText('Analytics'));

    // Analytics view shows StatCard sections
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('shows Mock/Live toggle in both OCD and Analytics views', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // In Noob view, Mock/Live should NOT be visible
    expect(screen.queryByText('Mock')).not.toBeInTheDocument();

    // Switch to Analytics — Mock/Live should be visible
    fireEvent.click(screen.getByText('Analytics'));
    expect(screen.getByText('Mock')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});
