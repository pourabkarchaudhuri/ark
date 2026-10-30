import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Play, Bookmark } from 'lucide-react';
import { buildLibraryRows, VirtualLibrarySections, type LibrarySection } from '@/components/virtual-library-sections';
import type { Game } from '@/types/game';

const SECTIONS: LibrarySection[] = [
  { key: 'Playing', label: 'Playing', icon: Play, color: 'text-blue-400' },
  { key: 'Want to Play', label: 'Want to Play', icon: Bookmark, color: 'text-fuchsia-400' },
  { key: 'Completed', label: 'Completed', icon: Bookmark, color: 'text-white/50' },
];

function makeGames(n: number, prefix: string): Game[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, title: `${prefix} ${i}` }) as unknown as Game);
}

describe('buildLibraryRows', () => {
  it('emits a header per non-empty section then ceil(n/cols) card rows', () => {
    const rows = buildLibraryRows(SECTIONS, { Playing: makeGames(5, 'p'), 'Want to Play': makeGames(2, 'w'), Completed: [] }, new Set(), 4);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'cards', 'cards', 'header', 'cards']);
    expect(rows[2].kind === 'cards' && rows[2].games.map((g) => g.id)).toEqual(['p-4']);
    expect(rows[0].kind === 'header' && rows[0].count).toBe(5);
  });

  it('drops card rows of collapsed sections but keeps their header', () => {
    const rows = buildLibraryRows(SECTIONS, { Playing: makeGames(5, 'p'), 'Want to Play': makeGames(2, 'w') }, new Set(['Playing']), 4);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'header', 'cards']);
    expect(rows[0].kind === 'header' && rows[0].collapsed).toBe(true);
  });

  it('gives every row a unique key', () => {
    const rows = buildLibraryRows(SECTIONS, { Playing: makeGames(9, 'p'), 'Want to Play': makeGames(9, 'w') }, new Set(), 3);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('VirtualLibrarySections', () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  beforeEach(() => {
    // jsdom has no layout (offsetHeight is 0): give every measured row a real height,
    // otherwise the virtualizer sees zero-height rows and keeps mounting more.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 276 });
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });
  afterEach(() => {
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  });

  function Harness({ games }: { games: Record<string, Game[]> }) {
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    return (
      <VirtualLibrarySections
        sections={SECTIONS}
        groups={games}
        collapsedSections={collapsed}
        onToggleSection={(key) => setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        })}
        columns={4}
        renderCard={(g) => <div data-testid="card">{g.title}</div>}
      />
    );
  }

  it('mounts a bounded number of cards for a 2,000-game library', () => {
    render(<Harness games={{ Playing: makeGames(1000, 'p'), 'Want to Play': makeGames(1000, 'w') }} />);
    const mounted = screen.getAllByTestId('card').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
  });

  it('collapsing a section removes its cards and expanding restores them', () => {
    render(<Harness games={{ Playing: makeGames(3, 'p') }} />);
    expect(screen.getAllByTestId('card')).toHaveLength(3);
    const header = screen.getByRole('button', { name: /Playing/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(header);
    expect(screen.queryAllByTestId('card')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Playing/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Playing/ }));
    expect(screen.getAllByTestId('card')).toHaveLength(3);
  });

  it('total height reflects all rows so scroll restore has room', () => {
    render(<Harness games={{ Playing: makeGames(400, 'p') }} />);
    const container = screen.getByTestId('library-sections');
    // 1 header + 100 card rows: far taller than one viewport.
    expect(parseInt(container.style.height, 10)).toBeGreaterThan(10_000);
  });
});
