/**
 * Tests for MyProgressTab component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MyProgressTab } from '@/components/my-progress-tab';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';

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
    subscribeHours: vi.fn(() => () => {}),
  },
}));

// Mock customGameStore (used by MyProgressTab for custom-* game IDs)
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: {
    getGame: vi.fn(),
    updateGame: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeHours: vi.fn(() => () => {}),
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

// Store listeners captured by the subscribe mocks, so tests can simulate live store changes.
let allListeners: Array<() => void> = [];
let hoursListeners: Array<() => void> = [];
function wireSubscribeMocks() {
  allListeners = [];
  hoursListeners = [];
  const sub = (list: () => Array<() => void>) => (l: () => void) => {
    list().push(l);
    return () => {};
  };
  vi.mocked(libraryStore.subscribe).mockImplementation(sub(() => allListeners));
  vi.mocked(libraryStore.subscribeHours).mockImplementation(sub(() => hoursListeners));
  vi.mocked(customGameStore.subscribe).mockImplementation(sub(() => allListeners));
  vi.mocked(customGameStore.subscribeHours).mockImplementation(sub(() => hoursListeners));
}

describe('MyProgressTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireSubscribeMocks();
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
    
    expect(screen.getAllByText(/Added/).length).toBeGreaterThan(0);
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

  it('shows the picker error when a non-.exe is chosen and keeps the field empty', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    const error = "Pick the game's .exe (shortcuts and .bat/.cmd files cannot be tracked)";
    Object.defineProperty(window, 'fileDialog', {
      value: { selectExecutable: vi.fn(async () => ({ success: false, error })) },
      writable: true,
      configurable: true,
    });
    try {
      render(<MyProgressTab gameId="steam-730" />);
      fireEvent.click(screen.getByText('Browse'));
      expect(await screen.findByText(error)).toBeInTheDocument();
      expect(screen.getByText('No executable selected')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'fileDialog', { value: undefined, writable: true, configurable: true });
    }
  });

  // 1.0.97 B25: Save must not write back stale playtime / status captured when the tab opened.
  it('saves only the edited field after live playtime and status changes', async () => {
    const opened = { ...mockLibraryEntry, status: 'Want to Play' as const, hoursPlayed: 12 };
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(opened);
    render(<MyProgressTab gameId="steam-730" />);

    // A session raises hours (hours channel), then the auto status moves it to Playing.
    const live = { ...opened, hoursPlayed: 13.5, status: 'Playing' as const };
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(live);
    act(() => { hoursListeners.forEach(l => l()); });
    act(() => { allListeners.forEach(l => l()); });
    expect(screen.getAllByText('Playing').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByDisplayValue('Great game!'), { target: { value: 'notes only' } });
    const saveButton = await screen.findByRole('button', { name: /Save Changes/ });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    expect(libraryStore.updateEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(libraryStore.updateEntry).mock.calls[0]).toEqual(['steam-730', { publicReviews: 'notes only' }]);
  });

  it('keeps a user edit when the store changes underneath it', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    render(<MyProgressTab gameId="steam-730" />);
    fireEvent.change(screen.getByDisplayValue('Great game!'), { target: { value: 'mine' } });
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue({ ...mockLibraryEntry, publicReviews: 'other', hoursPlayed: 51 });
    act(() => { allListeners.forEach(l => l()); });
    expect(screen.getByDisplayValue('mine')).toBeInTheDocument();
    expect(screen.getByText('51 Hrs')).toBeInTheDocument();
  });

  it('sends hoursPlayed when the user moves the slider', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(mockLibraryEntry);
    render(<MyProgressTab gameId="steam-730" />);
    const thumb = screen.getByRole('slider');
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    const saveButton = screen.getByRole('button', { name: /Save Changes/ });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);
    expect(vi.mocked(libraryStore.updateEntry).mock.calls[0]).toEqual(['steam-730', { hoursPlayed: 51 }]);
  });

  it('sends an explicit executablePath clear', async () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue({ ...mockLibraryEntry, executablePath: 'C:/g.exe' });
    render(<MyProgressTab gameId="steam-730" />);
    fireEvent.click(screen.getByRole('button', { name: /clear executable/i }));
    const saveButton = screen.getByRole('button', { name: /Save Changes/ });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);
    const payload = vi.mocked(libraryStore.updateEntry).mock.calls[0][1];
    expect('executablePath' in payload).toBe(true);
    expect(payload.executablePath).toBeUndefined();
  });

  it('raises the slider max for games past 500 hours', () => {
    (libraryStore.getEntry as ReturnType<typeof vi.fn>).mockReturnValue({ ...mockLibraryEntry, hoursPlayed: 600 });
    render(<MyProgressTab gameId="steam-730" />);
    expect(Number(screen.getByRole('slider').getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(600);
  });
});
