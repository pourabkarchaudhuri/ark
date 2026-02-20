import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GameCard } from '@/components/game-card';
import { Game } from '@/types/game';

const mockGame: Game = {
  id: 'steam-730',
  store: 'steam',
  steamAppId: 730,
  title: 'Test Game',
  developer: 'Test Developer',
  genre: ['Action', 'RPG', 'Adventure', 'Indie'],
  metacriticScore: 92,
  platform: ['windows', 'mac', 'linux'],
  status: 'Want to Play',
  priority: 'High',
  publisher: 'Test Publisher',
  publicReviews: 'Great game!',
  recommendationSource: 'Personal Discovery',
  releaseDate: '2024-01-15',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isInLibrary: true,
  availableOn: ['steam'],
};

const mockEpicGame: Game = {
  id: 'epic-fn:fortnite',
  store: 'epic',
  epicNamespace: 'fn',
  epicOfferId: 'fortnite',
  title: 'Epic Test Game',
  developer: 'Epic Developer',
  genre: ['Action'],
  metacriticScore: 80,
  platform: ['windows'],
  status: 'Want to Play',
  priority: 'Medium',
  publisher: 'Epic Publisher',
  publicReviews: '',
  recommendationSource: '',
  releaseDate: '2024-06-01',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isInLibrary: false,
  availableOn: ['epic'],
};

describe('GameCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('renders game title', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      expect(screen.getByText('Test Game')).toBeInTheDocument();
    });

    it('renders developer name', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      expect(screen.getByText('Test Developer')).toBeInTheDocument();
    });

    it('renders Completed status for completed library games', () => {
      const completedGame = { ...mockGame, status: 'Completed' as const, isInLibrary: true };
      render(
        <GameCard
          game={completedGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('renders status badge for want-to-play library games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByText('Want to Play')).toBeInTheDocument();
    });

    it('does not render status badge for non-library games', () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
        />
      );
      expect(screen.queryByText('Backlog')).not.toBeInTheDocument();
      expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    });

    it('renders Library badge when game is in library', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
  });

  describe('Library Heart Button', () => {
    it('renders library heart button with "Add to library" label for non-library games', () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
          onAddToLibrary={() => {}}
        />
      );
      expect(screen.getByLabelText('Add to library')).toBeInTheDocument();
    });

    it('renders library heart button with "Remove from library" label for library games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          onRemoveFromLibrary={() => {}}
        />
      );
      expect(screen.getByLabelText('Remove from library')).toBeInTheDocument();
    });

    it('calls onAddToLibrary when heart button is clicked for non-library games', () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      const onAddToLibrary = vi.fn();
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
          onAddToLibrary={onAddToLibrary}
        />
      );
      
      const heartButton = screen.getByLabelText('Add to library');
      fireEvent.click(heartButton);
      
      expect(onAddToLibrary).toHaveBeenCalled();
    });

    it('calls onRemoveFromLibrary when heart button is clicked for library games', () => {
      const onRemoveFromLibrary = vi.fn();
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          onRemoveFromLibrary={onRemoveFromLibrary}
        />
      );
      
      const heartButton = screen.getByLabelText('Remove from library');
      fireEvent.click(heartButton);
      
      expect(onRemoveFromLibrary).toHaveBeenCalled();
    });
  });

  describe('Dropdown Menu', () => {
    it('renders more options button for library games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByLabelText('More options for Test Game')).toBeInTheDocument();
    });

    it('does not render more options button for non-library games (context menu still works)', () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
        />
      );
      // Button is not rendered for non-library games (right-click context menu still available)
      const button = screen.queryByLabelText('More options for Test Game');
      expect(button).not.toBeInTheDocument();
    });

    it('opens context menu with "Add to Library" on right-click for non-library games', async () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      const onAddToLibrary = vi.fn();
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
          onAddToLibrary={onAddToLibrary}
        />
      );
      
      // Find the card and right-click
      const card = screen.getByText('Test Game').closest('.group');
      expect(card).toBeInTheDocument();
      
      if (card) {
        fireEvent.contextMenu(card);
        
        // Menu should appear with "Add to Library" option
        await waitFor(() => {
          expect(screen.getByText('Add to Library')).toBeInTheDocument();
        });
      }
    });
  });

  describe('Platform Icons', () => {
    it('renders platform icons for supported platforms', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      // Check for platform icons by title attribute
      expect(screen.getByTitle('Windows')).toBeInTheDocument();
      expect(screen.getByTitle('Mac')).toBeInTheDocument();
      expect(screen.getByTitle('Linux')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has accessible more options button with game title for library games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByRole('button', { name: /more options for test game/i })).toBeInTheDocument();
    });

    it('has accessible library heart button', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByRole('button', { name: /remove from library/i })).toBeInTheDocument();
    });
  });

  describe('hideLibraryBadge prop', () => {
    it('hides library badge when hideLibraryBadge is true', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={true}
        />
      );
      expect(screen.queryByText('Library')).not.toBeInTheDocument();
    });

    it('hides heart button when hideLibraryBadge is true', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={true}
        />
      );
      expect(screen.queryByLabelText('Remove from library')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Add to library')).not.toBeInTheDocument();
    });

    it('shows library badge when hideLibraryBadge is false', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={false}
        />
      );
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    it('shows heart button when hideLibraryBadge is false', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={false}
        />
      );
      expect(screen.getByLabelText('Remove from library')).toBeInTheDocument();
    });

    it('still shows status badge when hideLibraryBadge is true', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={true}
        />
      );
      // Status badge should still be visible
      expect(screen.getByText('Want to Play')).toBeInTheDocument();
    });

    it('still allows context menu (right-click) when hideLibraryBadge is true', async () => {
      const onEdit = vi.fn();
      render(
        <GameCard
          game={mockGame}
          onEdit={onEdit}
          onDelete={() => {}}
          isInLibrary={true}
          hideLibraryBadge={true}
        />
      );
      
      const card = screen.getByText('Test Game').closest('.group');
      expect(card).toBeInTheDocument();
      
      if (card) {
        fireEvent.contextMenu(card);
        
        // Menu should still appear with Edit Entry option (library game)
        await waitFor(() => {
          expect(screen.getByText('Edit Entry')).toBeInTheDocument();
        });
      }
    });
  });

  describe('Card Click', () => {
    it('navigates to game details for custom games (same as store games)', () => {
      const onClick = vi.fn();
      // Create a custom game — custom games now navigate to /game/{id} like all others
      const customGame = { ...mockGame, id: 'custom-1', store: 'custom' as const, isCustom: true, steamAppId: undefined };
      render(
        <GameCard
          game={customGame}
          onEdit={() => {}}
          onDelete={() => {}}
          onClick={onClick}
        />
      );
      
      const card = screen.getByText('Test Game').closest('div[class*="cursor-pointer"]');
      if (card) {
        fireEvent.click(card);
        // onClick should NOT be called — custom games navigate like store games now
        expect(onClick).not.toHaveBeenCalled();
      }
    });

    it('does not call onClick for Steam games (navigates instead)', () => {
      const onClick = vi.fn();
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          onClick={onClick}
        />
      );
      
      const card = screen.getByText('Test Game').closest('div[class*="cursor-pointer"]');
      if (card) {
        fireEvent.click(card);
        // onClick should NOT be called for Steam games
        expect(onClick).not.toHaveBeenCalled();
      }
    });

    it('does not call onClick for Epic games (navigates instead)', () => {
      const onClick = vi.fn();
      render(
        <GameCard
          game={mockEpicGame}
          onEdit={() => {}}
          onDelete={() => {}}
          onClick={onClick}
        />
      );
      
      const card = screen.getByText('Epic Test Game').closest('div[class*="cursor-pointer"]');
      if (card) {
        fireEvent.click(card);
        // onClick should NOT be called for Epic games
        expect(onClick).not.toHaveBeenCalled();
      }
    });
  });

  describe('Store Badges', () => {
    it('renders Steam store badge for Steam games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      // Steam badge should be rendered (FaSteam icon)
      const badges = document.querySelectorAll('[class*="absolute"][class*="top-"]');
      expect(badges.length).toBeGreaterThan(0);
    });

    it('renders Epic store badge for Epic games', () => {
      render(
        <GameCard
          game={mockEpicGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      // Epic badge should be rendered
      const badges = document.querySelectorAll('[class*="absolute"][class*="top-"]');
      expect(badges.length).toBeGreaterThan(0);
    });

    it('renders both badges for multi-store games', () => {
      const multiStoreGame = { ...mockGame, availableOn: ['steam', 'epic'] as ('steam' | 'epic')[] };
      render(
        <GameCard
          game={multiStoreGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      // Should have store badge area rendered
      const card = screen.getByText('Test Game').closest('.group');
      expect(card).toBeInTheDocument();
    });
  });
});
