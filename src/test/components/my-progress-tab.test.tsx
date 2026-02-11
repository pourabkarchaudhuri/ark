/**
 * Tests for MyProgressTab component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MyProgressTab } from '@/components/my-progress-tab';
import { libraryStore } from '@/services/library-store';

// Mock ResizeObserver
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = ResizeObserverMock;

// Mock libraryStore
vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getEntry: vi.fn(),
    updateEntry: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

// Mock customGameStore (used by MyProgressTab for custom-* game IDs)
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: {
    getGame: vi.fn(),
    updateGame: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

const mockLibraryEntry = {
  gameId: 'steam-730',
  steamAppId: 730,
  status: 'Playing' as const,
  priority: 'High' as const,
  publicReviews: 'Great game!',
  recommendationSource: 'Friend Recommendation',
  hoursPlayed: 50,
  rating: 4,
  addedAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-15'),
};

describe('MyProgressTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('renders skeleton loader when entry is not found', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    
    const { container } = render(<MyProgressTab gameId="steam-999" />);
    
    // Should show the pulsing skeleton, not the actual form
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
    // Should not render any interactive form elements
    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
  });

  it('renders progress data when entry is found', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    // Check status badge (there might be multiple "Playing" - in badge and dropdown)
    expect(screen.getAllByText('Playing').length).toBeGreaterThan(0);
    
    // Check priority badge
    expect(screen.getByText('High Priority')).toBeInTheDocument();
    
    // Check hours played display
    expect(screen.getByText('50 Hrs')).toBeInTheDocument();
    
    // Check rating display (4/5)
    expect(screen.getByText('4/5')).toBeInTheDocument();
    
    // Check notes
    expect(screen.getByDisplayValue('Great game!')).toBeInTheDocument();
  });

  it('renders hours played slider', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('Hours Played')).toBeInTheDocument();
    expect(screen.getByText('50 Hrs')).toBeInTheDocument();
  });

  it('renders star rating component', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('Your Rating')).toBeInTheDocument();
    // Check for 5 star buttons (one for each star)
    const starButtons = screen.getAllByRole('button', { name: '' });
    // There should be at least 5 star buttons
    expect(starButtons.length).toBeGreaterThanOrEqual(5);
  });

  it('renders play status selector', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('Play Status')).toBeInTheDocument();
  });

  it('renders priority selector', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('renders recommendation source selector', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('How did you discover this game?')).toBeInTheDocument();
  });

  it('renders notes textarea', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText('Your Notes')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add personal notes/)).toBeInTheDocument();
  });

  it('shows save button as disabled when no changes', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    const saveButton = screen.getByRole('button', { name: /Save Changes/ });
    expect(saveButton).toBeDisabled();
  });

  it('enables save button when notes are changed', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    const notesInput = screen.getByDisplayValue('Great game!');
    fireEvent.change(notesInput, { target: { value: 'Updated notes!' } });
    
    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: /Save Changes/ });
      expect(saveButton).not.toBeDisabled();
    });
  });

  it('calls updateEntry when save is clicked', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    const notesInput = screen.getByDisplayValue('Great game!');
    fireEvent.change(notesInput, { target: { value: 'Updated notes!' } });
    
    await waitFor(() => {
      const saveButton = screen.getByRole('button', { name: /Save Changes/ });
      expect(saveButton).not.toBeDisabled();
    });
    
    const saveButton = screen.getByRole('button', { name: /Save Changes/ });
    fireEvent.click(saveButton);
    
    await waitFor(() => {
      expect(libraryStore.updateEntry).toHaveBeenCalledWith('steam-730', expect.objectContaining({
        publicReviews: 'Updated notes!',
      }));
    });
  });

  it('renders added date', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    expect(screen.getByText(/Added/)).toBeInTheDocument();
  });

  it('handles zero hours played', () => {
    const entryWithNoHours = { ...mockLibraryEntry, hoursPlayed: 0 };
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(entryWithNoHours);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    // Find the specific hours played display (the large number next to label)
    const hoursLabel = screen.getByText('Hours Played');
    expect(hoursLabel).toBeInTheDocument();
    // The hours value should be somewhere in the document
    const hoursDisplay = screen.getAllByText('0 Mins');
    expect(hoursDisplay.length).toBeGreaterThan(0);
  });

  it('handles no rating (0 stars)', () => {
    const entryWithNoRating = { ...mockLibraryEntry, rating: 0 };
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(entryWithNoRating);
    
    render(<MyProgressTab gameId="steam-730" />);
    
    // When rating is 0, the "X/5" display should not appear
    // The Your Rating label should still be there
    expect(screen.getByText('Your Rating')).toBeInTheDocument();
    // But the specific "4/5" or similar should not be there when rating is 0
    expect(screen.queryByText(/^[1-5]\/5$/)).not.toBeInTheDocument();
  });
});
