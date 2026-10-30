/**
 * v1.0.97 B34 (oracle#4) — Oracle cards for the user's own games (Unfinished Business, Backlog Advisor,
 * custom games) are not recommendations: dismissing one hides only that card (no franchise/developer
 * mute), thumbs-down is not offered, "Add to Library" is not offered, and an unscored card shows no 0% badge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const addToLibrary = vi.hoisted(() => vi.fn());
vi.mock('@/services/library-store', () => ({
  libraryStore: {
    isInLibrary: (id: string) => id === 'steam-hades',
    getEntry: () => undefined,
    getAllEntries: () => [],
    getAllGameIds: () => [],
    addToLibrary,
    subscribe: () => () => {},
    subscribeHours: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getGame: () => undefined, getAllGames: () => [], subscribe: () => () => {} },
}));
vi.mock('react-loader-spinner', () => ({ DNA: () => null }));

import { OracleCard, WhyPanelBody } from '@/components/oracle-view';
import { oracleDismissMeta, isLibraryBackedOracleGame } from '@/services/oracle-library-cards';
import { expandHardNegativeIds } from '@/services/hard-negative';
import type { RecoShelf, ScoredGame } from '@/types/reco';
import { makeScored } from '../oracle/fixtures';

const libraryGame = (over: Partial<ScoredGame> = {}): ScoredGame =>
  makeScored('steam-hades', 0, { title: 'Hades', developer: 'Supergiant Games', ...over });

function rightClick(title: string) {
  const card = screen.getByText(title).closest('.group');
  expect(card).toBeTruthy();
  fireEvent.contextMenu(card!);
}

describe('library-backed Oracle cards', () => {
  beforeEach(() => { addToLibrary.mockClear(); });

  it('recognises library shelves, library ids and custom ids', () => {
    expect(isLibraryBackedOracleGame('steam-1', 'unfinished-business')).toBe(true);
    expect(isLibraryBackedOracleGame('steam-1', 'backlog-advisor')).toBe(true);
    expect(isLibraryBackedOracleGame('steam-hades', 'hidden-gems')).toBe(true);
    expect(isLibraryBackedOracleGame('custom-3', 'hidden-gems')).toBe(true);
    expect(isLibraryBackedOracleGame('steam-1', 'hidden-gems')).toBe(false);
  });

  it('dismissing a library game stores no title/developer and mutes no same-franchise card', () => {
    const shelves = [
      { type: 'unfinished-business', title: 'Unfinished Business', games: [libraryGame()] },
      { type: 'hidden-gems', title: 'Hidden Gems', games: [makeScored('steam-h2', 0.5, { title: 'Hades II', developer: 'Supergiant Games' })] },
    ] as RecoShelf[];
    const meta = oracleDismissMeta('steam-hades', shelves);
    expect(meta).toEqual({});
    const hidden = expandHardNegativeIds(
      [{ gameId: 'steam-hades', at: Date.now(), ...meta }],
      [{ gameId: 'steam-h2', title: 'Hades II', developer: 'Supergiant Games' }],
    );
    expect(hidden).toEqual(['steam-hades']);
    // A recommendation keeps its title and developer.
    expect(oracleDismissMeta('steam-h2', shelves)).toEqual({ title: 'Hades II', developer: 'Supergiant Games' });
  });

  it('Unfinished Business cards offer no Add to Library and no 0% badge', () => {
    render(<OracleCard game={libraryGame()} index={0} shelfType="unfinished-business" />);
    expect(screen.queryByText('0%')).toBeNull();
    rightClick('Hades');
    expect(screen.queryByText('Add to Library')).toBeNull();
  });

  it('a custom-N card never writes a library entry', () => {
    render(<OracleCard game={makeScored('custom-4', 0.5, { title: 'My Mod', matchPct: 70 })} index={0} shelfType="hidden-gems" />);
    expect(screen.getByText('70%')).toBeInTheDocument();
    rightClick('My Mod');
    expect(screen.queryByText('Add to Library')).toBeNull();
    expect(addToLibrary).not.toHaveBeenCalled();
  });

  it('a real recommendation still offers Add to Library', () => {
    render(<OracleCard game={makeScored('steam-77', 0.5, { title: 'New Pick', developer: 'Pick Studio', matchPct: 80 })} index={0} shelfType="hidden-gems" />);
    rightClick('New Pick');
    fireEvent.click(screen.getByText('Add to Library'));
    expect(addToLibrary).toHaveBeenCalledTimes(1);
    expect(addToLibrary.mock.calls[0][0].gameId).toBe('steam-77');
  });

  it('thumbs-down is not rendered for library games in the Why panel', () => {
    const { unmount } = render(<WhyPanelBody game={libraryGame()} shelfType="unfinished-business" onClose={() => {}} />);
    expect(screen.queryByLabelText('Bad recommendation')).toBeNull();
    expect(screen.getByLabelText('Good recommendation')).toBeInTheDocument();
    unmount();
    render(<WhyPanelBody game={makeScored('steam-77', 0.5, { title: 'New Pick' })} shelfType="hidden-gems" onClose={() => {}} />);
    expect(screen.getByLabelText('Bad recommendation')).toBeInTheDocument();
  });
});
