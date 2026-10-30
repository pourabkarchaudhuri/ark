import type { GameFilters } from '@/types/game';

/**
 * Number of filters the user has set, as shown on the filter badges.
 *
 * Shared by the toolbar FilterTrigger and the dashboard header badge so the
 * two counts can never disagree. Status/priority only count in Library (Browse
 * ignores them) and the category only counts in Browse.
 */
export function countActiveFilters(
  filters: Pick<GameFilters, 'status' | 'priority' | 'genre' | 'platform' | 'category' | 'releaseYear' | 'store'>,
  viewMode: string,
): number {
  return [
    filters.status !== 'All' && viewMode === 'library',
    filters.priority !== 'All' && viewMode === 'library',
    filters.genre !== 'All',
    filters.platform !== 'All',
    filters.category !== 'trending' && viewMode === 'browse',
    filters.releaseYear !== 'All',
    filters.store.length > 0,
  ].filter(Boolean).length;
}
