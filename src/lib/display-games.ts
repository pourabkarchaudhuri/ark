/**
 * Which list the Dashboard grid shows for Library and Browse (1.0.97, moved out of dashboard.tsx).
 *
 * useDeferredFilterSort stamps every output with the view it was computed for. When the output
 * belongs to the current view it is passed through unchanged, including an empty list, so a
 * search or filter that matches nothing shows the empty state instead of the whole list. The
 * fallback lists below only cover "nothing computed for this view yet" (first frame after a large
 * view switch, or Browse while the typed query is still pending).
 */

import type { Game } from '@/types/game';
import { getAdjustedRatingForSort } from '@/hooks/useDeferredFilterSort';
import { titleCollator } from '@/lib/title-collator';

export interface ComputedFor {
  viewMode: string;
  fingerprint: string;
}

type SortDir = 'asc' | 'desc';

const releaseTs = (g: Game) => (g.releaseDate ? new Date(g.releaseDate).getTime() : 0);

function isLiveGame(g: Game, liveGames?: Set<string>): boolean {
  return !!(liveGames?.has(g.id) || (g.steamAppId ? liveGames?.has(`steam-${g.steamAppId}`) : false));
}

function sortFallback(list: Game[], sortBy: string, sortDirection: SortDir): Game[] {
  return [...list].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'title') cmp = a.title.localeCompare(b.title);
    else if (sortBy === 'rating') cmp = getAdjustedRatingForSort(a) - getAdjustedRatingForSort(b);
    else cmp = releaseTs(a) - releaseTs(b);
    return sortDirection === 'desc' ? -cmp : cmp;
  });
}

export interface LibraryDisplayArgs {
  sortedGames: Game[];
  computedFor: ComputedFor | null;
  mergedLibraryGames: Game[];
  liveGames?: Set<string>;
  status: string;
  sortBy: string;
  sortDirection: SortDir;
}

export function selectLibraryDisplayGames(args: LibraryDisplayArgs): Game[] {
  const { sortedGames, computedFor, mergedLibraryGames, liveGames, status, sortBy, sortDirection } = args;
  if (computedFor?.viewMode === 'library') return sortedGames;
  // Fallback: apply same status filter as hook so "Playing Now" shows only live games
  let list = mergedLibraryGames;
  if (status !== 'All') {
    if (status === 'Playing Now') list = list.filter((g) => isLiveGame(g, liveGames));
    else list = list.filter((g) => g.status === status);
  }
  const statusOrder = (g: Game) => {
    if (isLiveGame(g, liveGames) || g.status === 'Playing Now') return 0;
    if (g.status === 'Playing') return 1;
    if (g.status === 'On Hold') return 2;
    if (g.status === 'Want to Play') return 3;
    if (g.status === 'Completed') return 4;
    return 5;
  };
  if (status !== 'All') return sortFallback(list, sortBy, sortDirection);
  return [...list].sort((a, b) => {
    const diff = statusOrder(a) - statusOrder(b);
    if (diff !== 0) return diff;
    // Within each status section: alphabetical by title
    return titleCollator.compare(a.title, b.title);
  });
}

export interface BrowseDisplayArgs {
  sortedGames: Game[];
  computedFor: ComputedFor | null;
  steamGames: Game[];
  committedQuery: string;
  browseSearchPending: boolean;
  sortBy: string;
  sortDirection: SortDir;
}

export function selectBrowseDisplayGames(args: BrowseDisplayArgs): Game[] {
  const { sortedGames, computedFor, steamGames, committedQuery, browseSearchPending, sortBy, sortDirection } = args;
  const forBrowse = computedFor?.viewMode === 'browse';
  if (forBrowse && !browseSearchPending) return sortedGames;
  // While the typed query is pending the hook empties the list on purpose; keep the previous
  // result while it is still there, then fall back as before.
  if (forBrowse && sortedGames.length > 0) return sortedGames;
  if (steamGames.length === 0) return [];
  // While searching, never substitute Top Sellers order for search relevance (avoids grid/dropdown mismatch).
  if (committedQuery.trim().length > 0) return [];
  // Hook not yet populated for browse: show steamGames so user sees something
  return sortFallback(steamGames, sortBy, sortDirection);
}

export type GridEmptyState = 'none' | 'no-results' | 'no-filter-results' | 'no-games';

/** Which empty state an empty grid shows ('none' = render nothing while a search is in flight). */
export function pickGridEmptyState(args: {
  viewMode: string;
  isSearching: boolean;
  searchInFlight: boolean;
  hasActiveFilters: boolean;
}): GridEmptyState {
  if (args.isSearching) {
    // In browse, never show "no results" while the user is typing or search is in flight
    if (args.viewMode === 'browse' && args.searchInFlight) return 'none';
    return 'no-results';
  }
  if (args.hasActiveFilters) return 'no-filter-results';
  return 'no-games';
}
