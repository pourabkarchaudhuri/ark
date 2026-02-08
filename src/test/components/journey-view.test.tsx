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
  },
}));

// Mock status history store
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    getAll: vi.fn().mockReturnValue([]),
    getForGame: vi.fn().mockReturnValue([]),
  },
}));

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, onClick, className, ...props }: Record<string, unknown>) => (
      <div onClick={onClick as React.MouseEventHandler} className={className as string} data-testid="motion-div" {...props}>
        {children as React.ReactNode}
      </div>
    ),
  },
  useScroll: () => ({ scrollYProgress: { get: () => 0 } }),
  useTransform: () => ({ get: () => 0 }),
}));

function createMockEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    gameId: 730,
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

    expect(screen.getByText('Your Journey Awaits')).toBeInTheDocument();
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
        gameId: 730,
        title: 'Counter-Strike 2',
        addedAt: '2025-03-15T00:00:00.000Z',
        status: 'Playing',
      }),
      createMockEntry({
        gameId: 570,
        title: 'Dota 2',
        addedAt: '2024-06-20T00:00:00.000Z',
        status: 'Completed',
      }),
      createMockEntry({
        gameId: 1086940,
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
      createMockEntry({ gameId: 730, title: 'Counter-Strike 2', addedAt: '2025-01-01T00:00:00.000Z' }),
      createMockEntry({ gameId: 570, title: 'Dota 2', addedAt: '2025-02-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    expect(screen.getByText('Dota 2')).toBeInTheDocument();
  });

  it('shows status badges on game cards', () => {
    const entries = [
      createMockEntry({ status: 'Playing', addedAt: '2025-01-01T00:00:00.000Z' }),
      createMockEntry({
        gameId: 570,
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
      createMockEntry({ gameId: 730, hoursPlayed: 120, addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    expect(screen.getByText('120h')).toBeInTheDocument();
  });

  it('shows total stats in header', () => {
    const entries = [
      createMockEntry({
        gameId: 730,
        status: 'Completed',
        hoursPlayed: 120,
        addedAt: '2025-01-01T00:00:00.000Z',
      }),
      createMockEntry({
        gameId: 570,
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
      createMockEntry({ gameId: 730, addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    const card = screen.getByText('Counter-Strike 2').closest('[data-testid="motion-div"]');
    expect(card).toBeInTheDocument();
    if (card) fireEvent.click(card);

    expect(mockNavigate).toHaveBeenCalledWith('/game/730');
  });

  it('shows year summary with game count', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z', status: 'Playing' }),
      createMockEntry({
        gameId: 570,
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
        gameId: 730,
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
        gameId: 730,
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

    // OCD view shows the game title in the Gantt chart label column
    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    // The "games tracked" summary footer should be visible
    expect(screen.getByText(/tracked/)).toBeInTheDocument();
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

    // Mock data includes Elden Ring and Dota 2 from the mock generator
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Dota 2')).toBeInTheDocument();
  });

  it('switches to Analytics view when Analytics tab is clicked', () => {
    const entries = [
      createMockEntry({
        gameId: 730,
        title: 'Counter-Strike 2',
        addedAt: '2025-01-01T00:00:00.000Z',
        hoursPlayed: 120,
        status: 'Completed',
        genre: ['Action', 'FPS'],
      }),
      createMockEntry({
        gameId: 570,
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

    // Analytics view shows stat cards
    expect(screen.getByText('Total Games')).toBeInTheDocument();
    expect(screen.getByText('Total Hours')).toBeInTheDocument();
    expect(screen.getByText('Completion Rate')).toBeInTheDocument();
  });

  it('shows Mock/Live toggle only in OCD view, not in Analytics', () => {
    const entries = [
      createMockEntry({ addedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    render(<JourneyView entries={entries} loading={false} />);

    // Switch to Analytics
    fireEvent.click(screen.getByText('Analytics'));

    // Mock/Live should NOT be visible
    expect(screen.queryByText('Mock')).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });
});
