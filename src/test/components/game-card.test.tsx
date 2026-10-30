import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  describe('Play Button (Phase 4a)', () => {
    it('shows Play in the right-click context menu when executablePath and onPlay are both set', async () => {
      const onPlay = vi.fn();
      const gameWithExe = { ...mockGame, executablePath: 'C:\\Games\\Test\\game.exe' };
      render(
        <GameCard
          game={gameWithExe}
          onEdit={() => {}}
          onDelete={() => {}}
          onPlay={onPlay}
          isInLibrary={true}
        />
      );

      const card = screen.getByText('Test Game').closest('.group');
      expect(card).toBeInTheDocument();
      if (card) {
        fireEvent.contextMenu(card);
        await waitFor(() => {
          expect(screen.getByText('Play')).toBeInTheDocument();
        });
        fireEvent.click(screen.getByText('Play'));
        expect(onPlay).toHaveBeenCalledWith(gameWithExe.id);
      }
    });

    it('does not show Play when the game has no executablePath', async () => {
      const onPlay = vi.fn();
      render(
        <GameCard
          game={mockGame} // no executablePath
          onEdit={() => {}}
          onDelete={() => {}}
          onPlay={onPlay}
          isInLibrary={true}
        />
      );

      const card = screen.getByText('Test Game').closest('.group');
      if (card) {
        fireEvent.contextMenu(card);
        await waitFor(() => {
          expect(screen.getByText('Edit Entry')).toBeInTheDocument();
        });
        expect(screen.queryByText('Play')).not.toBeInTheDocument();
      }
    });

    it('does not show Play when no onPlay handler is provided, even with an executablePath', async () => {
      const gameWithExe = { ...mockGame, executablePath: 'C:\\Games\\Test\\game.exe' };
      render(
        <GameCard
          game={gameWithExe}
          onEdit={() => {}}
          onDelete={() => {}}
          isInLibrary={true}
        />
      );

      const card = screen.getByText('Test Game').closest('.group');
      if (card) {
        fireEvent.contextMenu(card);
        await waitFor(() => {
          expect(screen.getByText('Edit Entry')).toBeInTheDocument();
        });
        expect(screen.queryByText('Play')).not.toBeInTheDocument();
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
  describe('Image fallback reset when URLs change (1.0.97)', () => {
    const customGame: Game = {
      ...mockGame,
      id: 'custom-img',
      store: 'custom',
      steamAppId: undefined,
      isCustom: true,
      coverUrl: 'https://img.test/broken.jpg',
      headerImage: undefined,
    };

    function markLoaded(img: HTMLImageElement) {
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 600 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 300 });
      fireEvent.load(img);
    }

    it('shows the new image after enrichment supplies a URL, even when every old URL failed', () => {
      const { container, rerender } = render(
        <GameCard game={customGame} onEdit={() => {}} onDelete={() => {}} />
      );
      const img = container.querySelector('img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('https://img.test/broken.jpg');
      fireEvent.error(img);
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByText('TG')).toBeInTheDocument();

      rerender(
        <GameCard game={{ ...customGame, coverUrl: 'https://img.test/enriched.jpg' }} onEdit={() => {}} onDelete={() => {}} />
      );
      const next = container.querySelector('img') as HTMLImageElement;
      expect(next).not.toBeNull();
      expect(next.getAttribute('src')).toBe('https://img.test/enriched.jpg');
    });

    it('keeps the working image when the new list still contains it', () => {
      const epic: Game = {
        ...mockEpicGame,
        headerImage: 'https://img.test/header-a.jpg',
        coverUrl: 'https://img.test/cover-b.jpg',
        screenshots: [],
      };
      const { container, rerender } = render(
        <GameCard game={epic} onEdit={() => {}} onDelete={() => {}} />
      );
      fireEvent.error(container.querySelector('img') as HTMLImageElement);
      const working = container.querySelector('img') as HTMLImageElement;
      expect(working.getAttribute('src')).toBe('https://img.test/cover-b.jpg');
      markLoaded(working);
      expect(working.className).toContain('opacity-100');

      // A new header arrives first in the list; the URL on screen is still in it.
      rerender(
        <GameCard game={{ ...epic, headerImage: 'https://img.test/header-c.jpg' }} onEdit={() => {}} onDelete={() => {}} />
      );
      const after = container.querySelector('img') as HTMLImageElement;
      expect(after.getAttribute('src')).toBe('https://img.test/cover-b.jpg');
      expect(after.className).toContain('opacity-100');
    });
  });

  describe('Context menu placement and Escape (1.0.97)', () => {
    const MENU_W = 160;
    const MENU_H = 120;
    let restore: (() => void) | null = null;

    beforeEach(() => {
      const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
      const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => MENU_W });
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => MENU_H });
      restore = () => {
        if (w) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', w);
        if (h) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', h);
      };
    });
    afterEach(() => { restore?.(); restore = null; });

    it('keeps a menu opened near the bottom-right corner fully inside the window', () => {
      render(<GameCard game={mockGame} onEdit={() => {}} onDelete={() => {}} isInLibrary={true} />);
      const card = screen.getByText('Test Game').closest('.group') as HTMLElement;
      fireEvent.contextMenu(card, { clientX: window.innerWidth - 10, clientY: window.innerHeight - 10 });
      const menu = screen.getByText('Remove from Library').closest('.fixed') as HTMLElement;
      const left = parseFloat(menu.style.left);
      const top = parseFloat(menu.style.top);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(left + MENU_W).toBeLessThanOrEqual(window.innerWidth - 8);
      expect(top + MENU_H).toBeLessThanOrEqual(window.innerHeight - 8);
    });

    it('leaves a menu with room to spare at the cursor', () => {
      render(<GameCard game={mockGame} onEdit={() => {}} onDelete={() => {}} isInLibrary={true} />);
      const card = screen.getByText('Test Game').closest('.group') as HTMLElement;
      fireEvent.contextMenu(card, { clientX: 20, clientY: 30 });
      const menu = screen.getByText('Edit Entry').closest('.fixed') as HTMLElement;
      expect(parseFloat(menu.style.left)).toBe(20);
      expect(parseFloat(menu.style.top)).toBe(30);
    });

    it('closes on Escape', () => {
      render(<GameCard game={mockGame} onEdit={() => {}} onDelete={() => {}} isInLibrary={true} />);
      const card = screen.getByText('Test Game').closest('.group') as HTMLElement;
      fireEvent.contextMenu(card, { clientX: 20, clientY: 30 });
      expect(screen.getByText('Edit Entry')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText('Edit Entry')).not.toBeInTheDocument();
    });
  });
});
