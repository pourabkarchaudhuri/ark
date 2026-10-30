/**
 * Dashboard return state — what the Dashboard needs to look the same after Back from game details.
 *
 * Opening a game unmounts the Dashboard, so category, filters, sort, committed search and the
 * Catalog letter would otherwise reset to Top Sellers while the old scroll offset was applied to
 * that different list. One snapshot is kept in sessionStorage; each saved scroll offset carries a
 * fingerprint of the state it was taken in, so an offset is only restored onto the same list.
 */

import type { GameFilters } from '@/types/game';

export const DASHBOARD_RETURN_STATE_KEY = 'ark-dashboard-return-state';

export type DashboardSortBy = 'rating' | 'releaseDate' | 'title';
export type DashboardSortDirection = 'asc' | 'desc';

export interface DashboardReturnState {
  viewMode: string;
  filters: GameFilters;
  sortBy: DashboardSortBy;
  sortDirection: DashboardSortDirection;
  committedQuery: string;
  catalogLetter: string | null;
}

const SORT_OPTIONS: readonly DashboardSortBy[] = ['rating', 'releaseDate', 'title'];
const SORT_DIRECTIONS: readonly DashboardSortDirection[] = ['asc', 'desc'];

export function saveDashboardReturnState(state: DashboardReturnState): void {
  try {
    sessionStorage.setItem(DASHBOARD_RETURN_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — Back just opens the defaults */
  }
}

/** The saved snapshot, or null when missing, unreadable or malformed. */
export function loadDashboardReturnState(validViewModes: readonly string[]): DashboardReturnState | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(DASHBOARD_RETURN_STATE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DashboardReturnState> | null;
    if (!v || typeof v !== 'object') return null;
    if (typeof v.viewMode !== 'string' || !validViewModes.includes(v.viewMode)) return null;
    const f = v.filters as Partial<GameFilters> | undefined;
    if (!f || typeof f !== 'object' || typeof f.category !== 'string' || !Array.isArray(f.store)) return null;
    return {
      viewMode: v.viewMode,
      filters: f as GameFilters,
      sortBy: SORT_OPTIONS.includes(v.sortBy as DashboardSortBy) ? (v.sortBy as DashboardSortBy) : 'rating',
      sortDirection: SORT_DIRECTIONS.includes(v.sortDirection as DashboardSortDirection)
        ? (v.sortDirection as DashboardSortDirection)
        : 'desc',
      committedQuery: typeof v.committedQuery === 'string' ? v.committedQuery : '',
      catalogLetter: typeof v.catalogLetter === 'string' && v.catalogLetter ? v.catalogLetter : null,
    };
  } catch {
    return null;
  }
}

/**
 * Stable string for "which list is on screen": two states with the same fingerprint show the same
 * list in the same order, so a scroll offset taken in one is valid in the other.
 */
export function dashboardStateFingerprint(state: DashboardReturnState): string {
  const f = state.filters;
  return JSON.stringify([
    state.viewMode,
    f.category,
    f.status,
    f.priority,
    f.genre,
    f.platform,
    f.releaseYear,
    [...(f.store ?? [])].sort(),
    f.search ?? '',
    state.sortBy,
    state.sortDirection,
    state.committedQuery.trim(),
    state.catalogLetter ?? '',
  ]);
}

/** sessionStorage key holding the fingerprint saved next to a scroll offset key. */
export function scrollFingerprintKey(scrollKey: string): string {
  return `${scrollKey}:fp`;
}

/** A saved offset is restored only when it was taken in the state now on screen. */
export function shouldRestoreScroll(savedFingerprint: string | null, currentFingerprint: string): boolean {
  return savedFingerprint !== null && savedFingerprint === currentFingerprint;
}
