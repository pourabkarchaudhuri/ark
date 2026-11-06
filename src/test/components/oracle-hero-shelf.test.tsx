/**
 * v1.0.100 — "Your Next Obsession" is a normal shelf (first, 5+ cards, same carousel as the others), not a banner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    isInLibrary: () => false, getEntry: () => undefined, getAllEntries: () => [], getAllGameIds: () => [],
    addToLibrary: vi.fn(), subscribe: () => () => {}, subscribeHours: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getGame: () => undefined, getAllGames: () => [], subscribe: () => () => {} },
}));
vi.mock('react-loader-spinner', () => ({ DNA: () => null }));

import { OracleView } from '@/components/oracle-view';
import { recoStore } from '@/services/reco-store';
import type { RecoShelf } from '@/types/reco';
import { makeScored } from '../oracle/fixtures';

const games = (prefix: string, n: number, top = 99) =>
  Array.from({ length: n }, (_, i) => makeScored(`steam-${prefix}${i}`, 0.5 - i * 0.01, { title: `${prefix} Game ${i}`, matchPct: top - i }));

function seed(shelves: RecoShelf[]) {
  (recoStore as unknown as { state: Record<string, unknown> }).state = {
    ...(recoStore as unknown as { state: Record<string, unknown> }).state,
    status: 'done',
    shelves,
    lastComputed: Date.now(),
    tasteProfile: null,
  };
}

describe('Oracle page: Your Next Obsession shelf', () => {
  beforeEach(() => { vi.spyOn(recoStore, 'compute').mockImplementation(() => undefined as never); });

  it('renders as the first shelf with its cards in match order and no banner', () => {
    const hero = { type: 'hero', title: 'Your Next Obsession', games: games('H', 6) } as RecoShelf;
    const others = ['hidden-gems', 'trending-now', 'critics-choice', 'free-for-you'].map(
      (t, i) => ({ type: t, title: `Shelf ${t}`, games: games(`S${i}`, 4, 90) }) as RecoShelf,
    );
    // The bandit reorders every other shelf, but Your Next Obsession always stays on top.
    seed([others[0], others[1], hero, others[2], others[3]]);
    const { container } = render(<OracleView onSwitchToBrowse={() => {}} />);

    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings[0]).toBe('Your Next Obsession');
    expect(headings.filter(h => h === 'Your Next Obsession')).toHaveLength(1);
    for (let i = 0; i < 6; i++) expect(screen.getByText(`H Game ${i}`)).toBeInTheDocument();
    // Cards read 99, 98, 97 ... left to right.
    const pcts = screen.getAllByText(/^(99|98|97|96|95|94)%$/).map(e => e.textContent);
    expect(pcts.slice(0, 6)).toEqual(['99%', '98%', '97%', '96%', '95%', '94%']);
    // The big 280px banner (and its "% Match" counter) is gone.
    expect(container.innerHTML).not.toContain('h-[280px]');
    expect(screen.queryByText(/% Match$/)).toBeNull();
  });
});
