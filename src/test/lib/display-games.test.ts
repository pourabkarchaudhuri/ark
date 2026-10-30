/**
 * Dashboard grid list selection (1.0.97 B21 ui-browse-details#1): an empty result computed for
 * the current view is shown as empty (empty state), not replaced by the whole list.
 */

import { describe, it, expect } from 'vitest';
import type { Game } from '@/types/game';
import { selectLibraryDisplayGames, selectBrowseDisplayGames, pickGridEmptyState } from '@/lib/display-games';

function g(id: string, over: Partial<Game> = {}): Game {
  return {
    id, title: id, developer: '', publisher: '', genre: [], platform: [], metacriticScore: null,
    releaseDate: '', status: 'Want to Play', priority: 'Medium', publicReviews: '', recommendationSource: '',
    createdAt: new Date(0), updatedAt: new Date(0), ...over,
  } as Game;
}

const lib = [g('lib-b', { title: 'Beta', status: 'Playing' }), g('lib-a', { title: 'alpha', status: 'Playing' }), g('lib-c', { title: 'Gamma', status: 'Completed' })];
const steam = [g('steam-1', { title: 'One' }), g('steam-2', { title: 'Two' })];
const libFor = { viewMode: 'library', fingerprint: 'f' };
const browseFor = { viewMode: 'browse', fingerprint: 'f' };

describe('selectLibraryDisplayGames', () => {
  const args = { mergedLibraryGames: lib, status: 'All', sortBy: 'rating', sortDirection: 'desc' as const };

  it('library search with no matches stays empty (no-results, not the whole library)', () => {
    expect(selectLibraryDisplayGames({ ...args, sortedGames: [], computedFor: libFor })).toEqual([]);
    expect(pickGridEmptyState({ viewMode: 'library', isSearching: true, searchInFlight: false, hasActiveFilters: false })).toBe('no-results');
  });

  it('Store=Epic with no Epic games stays empty (no-filter-results)', () => {
    expect(selectLibraryDisplayGames({ ...args, sortedGames: [], computedFor: libFor })).toEqual([]);
    expect(pickGridEmptyState({ viewMode: 'library', isSearching: false, searchInFlight: false, hasActiveFilters: true })).toBe('no-filter-results');
  });

  it('falls back to the status-sorted library list before anything is computed for library', () => {
    const out = selectLibraryDisplayGames({ ...args, sortedGames: steam, computedFor: browseFor });
    expect(out.map(x => x.id)).toEqual(['lib-a', 'lib-b', 'lib-c']);
    const none = selectLibraryDisplayGames({ ...args, sortedGames: [], computedFor: null });
    expect(none).toHaveLength(3);
  });

  it('fallback applies the status filter', () => {
    const out = selectLibraryDisplayGames({ ...args, status: 'Completed', sortedGames: [], computedFor: null });
    expect(out.map(x => x.id)).toEqual(['lib-c']);
  });
});

describe('selectBrowseDisplayGames', () => {
  const args = { steamGames: steam, committedQuery: '', browseSearchPending: false, sortBy: 'rating', sortDirection: 'desc' as const };

  it('a Browse filter that matches nothing shows the empty state, not the full list', () => {
    expect(selectBrowseDisplayGames({ ...args, sortedGames: [], computedFor: browseFor })).toEqual([]);
    expect(pickGridEmptyState({ viewMode: 'browse', isSearching: false, searchInFlight: false, hasActiveFilters: true })).toBe('no-filter-results');
  });

  it('passes a browse result through unchanged', () => {
    const sorted = [steam[1]!];
    expect(selectBrowseDisplayGames({ ...args, sortedGames: sorted, computedFor: browseFor })).toBe(sorted);
  });

  it('first frame after a large view switch (output still for library) shows the browse fallback', () => {
    const out = selectBrowseDisplayGames({ ...args, sortedGames: lib, computedFor: libFor });
    expect(out.map(x => x.id).sort()).toEqual(['steam-1', 'steam-2']);
  });

  it('never substitutes category order while a committed search is not computed yet', () => {
    expect(selectBrowseDisplayGames({ ...args, committedQuery: 'zelda', sortedGames: lib, computedFor: libFor })).toEqual([]);
  });

  it('while typing is pending, keeps the previous result, then falls back', () => {
    const sorted = [steam[0]!];
    expect(selectBrowseDisplayGames({ ...args, browseSearchPending: true, sortedGames: sorted, computedFor: browseFor })).toBe(sorted);
    expect(selectBrowseDisplayGames({ ...args, browseSearchPending: true, sortedGames: [], computedFor: browseFor })).toHaveLength(2);
  });

  it('no empty state while a browse search is in flight', () => {
    expect(pickGridEmptyState({ viewMode: 'browse', isSearching: true, searchInFlight: true, hasActiveFilters: false })).toBe('none');
    expect(pickGridEmptyState({ viewMode: 'browse', isSearching: false, searchInFlight: false, hasActiveFilters: false })).toBe('no-games');
  });
});
