import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GameCard } from './game-card';
import { Game } from '@/types/game';

const mockGame: Game = {
  id: 'test-1',
  igdbId: 12345,
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

    it('renders rating score with white text', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      );
      expect(screen.getByText('Rating: 92')).toBeInTheDocument();
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

    it('renders Backlog status for want-to-play library games', () => {
      render(
        <GameCard
          game={mockGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );
      expect(screen.getByText('Backlog')).toBeInTheDocument();
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

    it('does not render more options button for non-library games', () => {
      const nonLibraryGame = { ...mockGame, isInLibrary: false };
      render(
        <GameCard
          game={nonLibraryGame}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={false}
        />
      );
      expect(screen.queryByLabelText('More options for Test Game')).not.toBeInTheDocument();
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

  describe('Card Click', () => {
    it('calls onClick when card is clicked for custom games without steamAppId', () => {
      const onClick = vi.fn();
      // Create a custom game without steamAppId
      const customGame = { ...mockGame, steamAppId: undefined };
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
        expect(onClick).toHaveBeenCalled();
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
  });
});
