import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { JourneyEntry } from '@/types/game';

// jsdom has no WebGL: the Canvas mock records its frameloop and renders the scene tree as plain
// (unknown) DOM elements, so Scene's render path still runs; useFrame callbacks never fire.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, frameloop }: { children: React.ReactNode; frameloop?: string }) => (
    <div data-testid="ark-canvas" data-frameloop={frameloop}>{children}</div>
  ),
  useFrame: () => {},
  extend: () => {},
}));
vi.mock('@react-three/drei', () => ({
  Stars: () => null,
  Html: () => null,
}));

vi.mock('framer-motion', () => {
  const motionHandler = {
    get(_: unknown, tag: string) {
      return ({ children, className }: Record<string, unknown>) => {
        const Tag = tag as keyof JSX.IntrinsicElements;
        return <Tag className={className as string}>{children as React.ReactNode}</Tag>;
      };
    },
  };
  return {
    motion: new Proxy({}, motionHandler),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    isInLibrary: vi.fn().mockReturnValue(true),
    getEntry: vi.fn().mockReturnValue(undefined),
    getAllEntries: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));
vi.mock('@/services/journey-store', () => ({
  journeyStore: { getEntry: vi.fn().mockReturnValue(undefined) },
  isPlaceholderJourneyTitle: (t?: string) => !t || /^unknown/i.test(t.trim()),
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getGame: vi.fn().mockReturnValue(undefined), getAllGames: vi.fn().mockReturnValue([]) },
}));

import { ShowcaseView, buildGenreGroups, computeCoverRanks, COVER_WINDOW_RADIUS, ARK_SHARED_GPU_RESOURCES } from '@/components/showcase-view';

function entry(gameId: string, overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    gameId,
    title: `Game ${gameId}`,
    coverUrl: `https://example.invalid/${gameId}.jpg`,
    genre: ['Action'],
    platform: ['Windows'],
    status: 'Playing',
    hoursPlayed: 1,
    rating: 0,
    addedAt: '2025-01-01T00:00:00.000Z',
    firstPlayedAt: '2025-01-01T00:00:00.000Z',
    lastPlayedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The title shown in the active-card metadata bar. */
function activeTitle(): string | null {
  const el = document.querySelector('span.text-white.text-sm.font-semibold');
  return el?.textContent ?? null;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // three.js intrinsic elements render as unknown DOM tags under the Canvas mock.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  errSpy.mockRestore();
});

describe('buildGenreGroups', () => {
  it('orders genres and cards the same way whatever the input order', () => {
    const list = [
      entry('steam-1', { genre: ['RPG'], hoursPlayed: 5 }),
      entry('steam-2', { genre: ['Action'], hoursPlayed: 5 }),
      entry('steam-3', { genre: ['RPG'], hoursPlayed: 5 }),
      entry('steam-4', { genre: ['Action'], hoursPlayed: 5 }),
    ];
    const shape = (es: JourneyEntry[]) =>
      buildGenreGroups(es).map((g) => [g.genre, g.entries.map((e) => e.gameId)]);
    const a = shape(list);
    // A status change re-sorts the journey list (Playing first); the wheel must not reshuffle.
    const b = shape([list[3], list[0], { ...list[2], status: 'Completed' }, list[1]]);
    expect(b).toEqual(a);
    expect(a).toEqual([
      ['Action', ['steam-2', 'steam-4']],
      ['RPG', ['steam-1', 'steam-3']],
    ]);
  });
});

describe('ShowcaseView', () => {
  const three = [
    entry('steam-1', { hoursPlayed: 50 }),
    entry('steam-2', { hoursPlayed: 20 }),
    entry('steam-3', { hoursPlayed: 10 }),
  ];

  it('starts on the most-played card and ArrowRight from the page advances', () => {
    render(<ShowcaseView entries={three} />);
    expect(activeTitle()).toBe('Game steam-1');
    const notPrevented = fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(notPrevented).toBe(false);
    expect(activeTitle()).toBe('Game steam-2');
  });

  it('leaves arrow keys typed into a text field alone', () => {
    render(
      <>
        <input data-testid="chat-input" />
        <ShowcaseView entries={three} />
      </>,
    );
    const input = screen.getByTestId('chat-input');
    input.focus();
    const notPrevented = fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(notPrevented).toBe(true);
    expect(activeTitle()).toBe('Game steam-1');
  });

  it('ignores modified arrow keys', () => {
    render(<ShowcaseView entries={three} />);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowRight', ctrlKey: true })).toBe(true);
    expect(activeTitle()).toBe('Game steam-1');
  });

  it('keeps the selected game when another game changes and the list re-sorts', () => {
    const { rerender } = render(<ShowcaseView entries={three} />);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(activeTitle()).toBe('Game steam-2');
    rerender(<ShowcaseView entries={[{ ...three[2], status: 'Completed' }, three[1], three[0]]} />);
    expect(activeTitle()).toBe('Game steam-2');
  });

  it('does not throw when the selected last card disappears', () => {
    const { rerender } = render(<ShowcaseView entries={three} />);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(activeTitle()).toBe('Game steam-3');
    expect(() => rerender(<ShowcaseView entries={three.slice(0, 1)} />)).not.toThrow();
    expect(activeTitle()).toBe('Game steam-1');
  });

  it('stops the render loop while paused', () => {
    const { rerender } = render(<ShowcaseView entries={three} />);
    expect(screen.getByTestId('ark-canvas').dataset.frameloop).toBe('always');
    rerender(<ShowcaseView entries={three} paused />);
    expect(screen.getByTestId('ark-canvas').dataset.frameloop).toBe('never');
  });

  it('disposes the shared geometries and materials when the scene unmounts', () => {
    const disposed = new Set<unknown>();
    const listeners = ARK_SHARED_GPU_RESOURCES.map((res) => {
      const fn = () => { disposed.add(res); };
      res.addEventListener('dispose', fn);
      return [res, fn] as const;
    });
    const { unmount } = render(<ShowcaseView entries={three} />);
    expect(disposed.size).toBe(0);
    unmount();
    expect(disposed.size).toBe(ARK_SHARED_GPU_RESOURCES.length);
    for (const [res, fn] of listeners) res.removeEventListener('dispose', fn);
  });
});

describe('computeCoverRanks (lazy covers)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`);

  it('gives every card a cover when the ring is smaller than the window', () => {
    const ranks = computeCoverRanks(ids(6), 2);
    expect(ranks.size).toBe(6);
    expect(ranks.get('g2')).toBe(0);
  });

  it('only covers the cards within the radius of the selected one, nearest first', () => {
    const ranks = computeCoverRanks(ids(108), 50);
    expect(ranks.size).toBe(2 * COVER_WINDOW_RADIUS + 1);
    expect(ranks.get('g50')).toBe(0);
    expect(ranks.get('g51')).toBe(1);
    expect(ranks.get('g49')).toBe(1);
    expect(ranks.has(`g${50 + COVER_WINDOW_RADIUS + 1}`)).toBe(false);
  });

  it('wraps around the ring', () => {
    const ranks = computeCoverRanks(ids(108), 0);
    expect(ranks.size).toBe(2 * COVER_WINDOW_RADIUS + 1);
    expect(ranks.get('g107')).toBe(1);
    expect(ranks.get(`g${108 - COVER_WINDOW_RADIUS}`)).toBe(COVER_WINDOW_RADIUS);
  });

  it('handles an empty ring', () => {
    expect(computeCoverRanks([], 0).size).toBe(0);
  });
});
