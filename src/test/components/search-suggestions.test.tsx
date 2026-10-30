import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchSuggestions } from '@/components/search-suggestions';
import { Game } from '@/types/game';

const baseGame: Game = {
  id: 'custom-search-1',
  store: 'custom',
  title: 'Search Game',
  developer: 'Dev',
  genre: [],
  metacriticScore: null,
  platform: ['windows'],
  status: 'Want to Play',
  priority: 'Medium',
  publisher: '',
  publicReviews: '',
  recommendationSource: '',
  releaseDate: '2024-01-15',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isCustom: true,
  coverUrl: 'https://img.test/broken.jpg',
};

function Harness({ results, onClose }: { results: Game[]; onClose: () => void }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={anchorRef} data-testid="anchor">
        <input aria-label="Search games" />
        <SearchSuggestions
          results={results}
          loading={false}
          visible={true}
          onSelect={() => {}}
          onClose={onClose}
          searchQuery="search"
          anchorRef={anchorRef}
        />
      </div>
      <button>elsewhere</button>
    </div>
  );
}

function thumb(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('li img');
}

describe('SearchSuggestions', () => {
  it('keeps the dropdown open on mousedown inside the search input', () => {
    const onClose = vi.fn();
    render(<Harness results={[baseGame]} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByLabelText('Search games'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on mousedown elsewhere', () => {
    const onClose = vi.fn();
    render(<Harness results={[baseGame]} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes on outside mousedown without an anchorRef', () => {
    const onClose = vi.fn();
    render(
      <div>
        <input aria-label="Search games" />
        <SearchSuggestions results={[baseGame]} loading={false} visible={true} onSelect={() => {}} onClose={onClose} searchQuery="search" />
      </div>
    );
    fireEvent.mouseDown(screen.getByLabelText('Search games'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('thumbnail fallback reset (1.0.97)', () => {
    it('shows a new image when the same game gets a new URL after every old URL failed', () => {
      const { container, rerender } = render(<Harness results={[baseGame]} onClose={() => {}} />);
      const img = thumb(container) as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('https://img.test/broken.jpg');
      fireEvent.error(img);
      expect(thumb(container)).toBeNull();

      rerender(<Harness results={[{ ...baseGame, coverUrl: 'https://img.test/enriched.jpg' }]} onClose={() => {}} />);
      const next = thumb(container) as HTMLImageElement;
      expect(next).not.toBeNull();
      expect(next.getAttribute('src')).toBe('https://img.test/enriched.jpg');
    });

    it('keeps the working image when the new list still contains it', () => {
      const game: Game = { ...baseGame, coverUrl: 'https://img.test/a.jpg', headerImage: 'https://img.test/b.jpg' };
      const { container, rerender } = render(<Harness results={[game]} onClose={() => {}} />);
      fireEvent.error(thumb(container) as HTMLImageElement);
      const working = thumb(container) as HTMLImageElement;
      expect(working.getAttribute('src')).toBe('https://img.test/b.jpg');
      Object.defineProperty(working, 'naturalWidth', { configurable: true, value: 300 });
      Object.defineProperty(working, 'naturalHeight', { configurable: true, value: 400 });
      fireEvent.load(working);
      expect(working.className).toContain('opacity-100');

      // A new cover arrives first in the list; the URL on screen is still in it.
      rerender(<Harness results={[{ ...game, coverUrl: 'https://img.test/c.jpg' }]} onClose={() => {}} />);
      const after = thumb(container) as HTMLImageElement;
      expect(after.getAttribute('src')).toBe('https://img.test/b.jpg');
      expect(after.className).toContain('opacity-100');
    });

    it('does not lazy-load the 32px thumbnails, so the 4 s timeout matches a started request', () => {
      const { container } = render(<Harness results={[baseGame]} onClose={() => {}} />);
      expect(thumb(container)?.getAttribute('loading')).toBeNull();
    });
  });
});
