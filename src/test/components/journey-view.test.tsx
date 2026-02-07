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
});
