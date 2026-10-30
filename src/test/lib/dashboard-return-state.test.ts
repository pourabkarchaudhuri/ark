/**
 * Dashboard return state (1.0.97 B22, ui-browse-details#9): Back from game details restores
 * category, filters, sort, committed search and Catalog letter, and a saved scroll offset is only
 * restored onto the list it was taken on.
 *
 * The Dashboard page pulls in the 3D Ark, workers and every view, so the round trip is tested on
 * the snapshot module it uses (save on leave, load on mount, fingerprint check before scrolling).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DASHBOARD_RETURN_STATE_KEY,
  saveDashboardReturnState,
  loadDashboardReturnState,
  dashboardStateFingerprint,
  scrollFingerprintKey,
  shouldRestoreScroll,
  type DashboardReturnState,
} from '@/lib/dashboard-return-state';
import type { GameFilters } from '@/types/game';

const VIEWS = ['browse', 'library', 'journey'];

const baseFilters: GameFilters = {
  search: '',
  status: 'All',
  priority: 'All',
  genre: 'All',
  platform: 'All',
  category: 'trending',
  releaseYear: 'All',
  store: [],
};

function state(over: Partial<DashboardReturnState> = {}): DashboardReturnState {
  return {
    viewMode: 'browse',
    filters: baseFilters,
    sortBy: 'rating',
    sortDirection: 'desc',
    committedQuery: '',
    catalogLetter: null,
    ...over,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('dashboard return state', () => {
  it('round-trips a Library status filter and sort', () => {
    const s = state({
      viewMode: 'library',
      filters: { ...baseFilters, status: 'Playing' },
      sortBy: 'title',
      sortDirection: 'asc',
    });
    saveDashboardReturnState(s);
    expect(loadDashboardReturnState(VIEWS)).toEqual(s);
  });

  it('round-trips a Browse search query', () => {
    saveDashboardReturnState(state({ committedQuery: 'zelda' }));
    expect(loadDashboardReturnState(VIEWS)?.committedQuery).toBe('zelda');
  });

  it('round-trips the Catalog letter', () => {
    saveDashboardReturnState(state({ filters: { ...baseFilters, category: 'catalog' }, catalogLetter: 'S' }));
    const loaded = loadDashboardReturnState(VIEWS);
    expect(loaded?.filters.category).toBe('catalog');
    expect(loaded?.catalogLetter).toBe('S');
  });

  it('rejects malformed or unknown snapshots', () => {
    sessionStorage.setItem(DASHBOARD_RETURN_STATE_KEY, '{not json');
    expect(loadDashboardReturnState(VIEWS)).toBeNull();
    sessionStorage.setItem(DASHBOARD_RETURN_STATE_KEY, JSON.stringify({ ...state(), viewMode: 'nope' }));
    expect(loadDashboardReturnState(VIEWS)).toBeNull();
    sessionStorage.setItem(DASHBOARD_RETURN_STATE_KEY, JSON.stringify({ ...state(), filters: { category: 'trending' } }));
    expect(loadDashboardReturnState(VIEWS)).toBeNull();
  });

  it('falls back to default sort values when the stored ones are invalid', () => {
    sessionStorage.setItem(
      DASHBOARD_RETURN_STATE_KEY,
      JSON.stringify({ ...state(), sortBy: 'bogus', sortDirection: 'sideways' }),
    );
    const loaded = loadDashboardReturnState(VIEWS);
    expect(loaded?.sortBy).toBe('rating');
    expect(loaded?.sortDirection).toBe('desc');
  });

  it('returns null when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      expect(loadDashboardReturnState(VIEWS)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scroll fingerprint', () => {
  it('matches the same state (store order does not matter) and restores', () => {
    const a = state({ filters: { ...baseFilters, store: ['steam', 'epic'] }, sortBy: 'title' });
    const b = state({ filters: { ...baseFilters, store: ['epic', 'steam'] }, sortBy: 'title' });
    expect(dashboardStateFingerprint(a)).toBe(dashboardStateFingerprint(b));
    expect(shouldRestoreScroll(dashboardStateFingerprint(a), dashboardStateFingerprint(b))).toBe(true);
  });

  it('does not restore onto a different list', () => {
    const saved = dashboardStateFingerprint(state({ filters: { ...baseFilters, category: 'catalog' }, catalogLetter: 'S' }));
    expect(shouldRestoreScroll(saved, dashboardStateFingerprint(state()))).toBe(false);
    expect(shouldRestoreScroll(saved, dashboardStateFingerprint(state({ filters: { ...baseFilters, category: 'catalog' }, catalogLetter: 'A' })))).toBe(false);
    const search = dashboardStateFingerprint(state({ committedQuery: 'zelda' }));
    expect(shouldRestoreScroll(search, dashboardStateFingerprint(state()))).toBe(false);
    const sorted = dashboardStateFingerprint(state({ sortDirection: 'asc' }));
    expect(shouldRestoreScroll(sorted, dashboardStateFingerprint(state()))).toBe(false);
  });

  it('does not restore an offset saved without a fingerprint', () => {
    expect(shouldRestoreScroll(null, dashboardStateFingerprint(state()))).toBe(false);
  });

  it('keeps the fingerprint next to the scroll key', () => {
    expect(scrollFingerprintKey('ark-dashboard-scroll-journey:log')).toBe('ark-dashboard-scroll-journey:log:fp');
  });
});
