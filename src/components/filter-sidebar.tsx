import { useMemo, useCallback, memo } from 'react';
import { GameStatus, GamePriority, GameStore, GameFilters, GameCategory } from '@/types/game';
import { FaSteam } from 'react-icons/fa';
import { SiEpicgames } from 'react-icons/si';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RotateCcw,
  X,
  ArrowUpDown,
  SlidersHorizontal,
} from 'lucide-react';

const statusOptions: (GameStatus | 'All')[] = [
  'All',
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
  'Playing Now',
];

const priorityOptions: (GamePriority | 'All')[] = [
  'All',
  'High',
  'Medium',
  'Low',
];

const categoryOptions: { value: GameCategory; label: string }[] = [
  { value: 'trending', label: 'Top Sellers' },
  { value: 'most-played', label: 'Most Played' },
  { value: 'free', label: 'Free Games' },
  { value: 'recent', label: 'New Releases' },
  { value: 'award-winning', label: 'Coming Soon' },
  { value: 'catalog', label: 'Catalog (A–Z)' },
];

type SortOption = 'releaseDate' | 'title' | 'rating';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'browse' | 'library' | 'journey' | 'buzz' | 'calendar';

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'rating', label: 'Rating' },
  { value: 'releaseDate', label: 'Release Date' },
  { value: 'title', label: 'Title' },
];


interface FilterSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: GameFilters;
  updateFilter: <K extends keyof GameFilters>(key: K, value: GameFilters[K]) => void;
  resetFilters: () => void;
  genres: string[];
  platforms: string[];
  /** Dynamic genre options derived from games matching filters above Genre */
  dynamicGenres?: string[];
  /** Dynamic platform options derived from games matching filters above Platform (incl. Genre) */
  dynamicPlatforms?: string[];
  /** Dynamic year options derived from games matching filters above Release Year (incl. Genre + Platform) */
  dynamicYears?: string[];
  /** Full Steam catalog count — 0 means catalog is still syncing */
  catalogTotalCount?: number;
  sortBy: SortOption;
  setSortBy: (value: SortOption) => void;
  sortDirection: SortDirection;
  toggleSortDirection: () => void;
  viewMode: ViewMode;
}

// ─── Trigger Button ──────────────────────────────────────────────────────────
// Renders the small icon button that toggles the filter panel.  This stays
// inline in the header toolbar (inside <main>).

interface FilterTriggerProps {
  open: boolean;
  onToggle: () => void;
  filters: GameFilters;
  viewMode: ViewMode;
}

export const FilterTrigger = memo(function FilterTrigger({
  open,
  onToggle,
  filters,
  viewMode,
}: FilterTriggerProps) {
  const activeFilterCount = [
    filters.status !== 'All' && viewMode === 'library',
    filters.priority !== 'All' && viewMode === 'library',
    filters.genre !== 'All',
    filters.platform !== 'All',
    filters.category !== 'trending' && viewMode === 'browse',
    filters.releaseYear !== 'All',
    filters.store.length > 0,
  ].filter(Boolean).length;

  return (
    <Button
      variant="outline"
      size="icon"
      className="h-9 w-9 relative"
      onClick={onToggle}
      aria-label={open ? 'Close filters' : 'Open filters'}
    >
      <SlidersHorizontal className="h-4 w-4 pointer-events-none" />
      {activeFilterCount > 0 && (
        <Badge
          variant="secondary"
          className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs bg-fuchsia-500 text-white"
        >
          {activeFilterCount}
        </Badge>
      )}
    </Button>
  );
});

// ─── Panel Overlay ───────────────────────────────────────────────────────────
// The fixed-position slide-in panel.  Must be rendered OUTSIDE <main> (at the
// root of the Dashboard) so it shares the root stacking context with the
// sticky header (z-40).  z-50 on the panel then correctly layers it above.

export const FilterPanel = memo(function FilterPanel({
  open,
  onOpenChange,
  filters,
  updateFilter,
  resetFilters,
  genres,
  platforms,
  dynamicGenres,
  dynamicPlatforms,
  dynamicYears,
  catalogTotalCount = 0,
  sortBy,
  setSortBy,
  sortDirection,
  toggleSortDirection,
  viewMode,
}: FilterSidebarProps) {
  const isCatalog = filters.category === 'catalog' && viewMode === 'browse';
  // Most-played data is Steam-only — Epic doesn't expose player counts
  const isMostPlayed = filters.category === 'most-played' && viewMode === 'browse';
  // Free Games data is Epic-only — Steam doesn't have a dedicated free games feed
  const isFreeGames = filters.category === 'free' && viewMode === 'browse';

  const hasActiveFilters = 
    filters.status !== 'All' || 
    filters.priority !== 'All' ||
    filters.genre !== 'All' || 
    filters.platform !== 'All' ||
    filters.category !== 'trending' ||
    filters.releaseYear !== 'All' ||
    filters.store.length > 0;

  // Convert arrays to combobox options — prefer dynamic (contextual) lists
  // when available; fall back to the full static lists for the initial load
  // or catalog mode where dynamic lists are empty.
  const effectiveGenres = dynamicGenres && dynamicGenres.length > 0 ? dynamicGenres : genres;
  const effectivePlatforms = dynamicPlatforms && dynamicPlatforms.length > 0 ? dynamicPlatforms : platforms;

  const genreOptions = useMemo(() => [
    { value: 'All', label: 'All Genres' },
    ...effectiveGenres.map(g => ({ value: g, label: g }))
  ], [effectiveGenres]);

  const platformOptions = useMemo(() => [
    { value: 'All', label: 'All Platforms' },
    ...effectivePlatforms.map(p => ({ value: p, label: p }))
  ], [effectivePlatforms]);

  // Release year options — use dynamic years when available, otherwise
  // generate a static range (current year + 1 down to 2015).
  const releaseYearOptions = useMemo(() => {
    if (dynamicYears && dynamicYears.length > 0) {
      return [
        { value: 'All', label: 'All Years' },
        ...dynamicYears.map(y => ({ value: y, label: y })),
      ];
    }
    const currentYear = new Date().getFullYear();
    const years: { value: string; label: string }[] = [
      { value: 'All', label: 'All Years' },
    ];
    for (let year = currentYear + 1; year >= 2015; year--) {
      years.push({ value: String(year), label: String(year) });
    }
    return years;
  }, [dynamicYears]);

  // Toggle a store filter — mutually exclusive (radio-style)
  // Clicking the already-active option deselects it (shows all stores).
  const isBothActive = filters.store.length === 2 && filters.store.includes('steam') && filters.store.includes('epic');

  const selectStore = useCallback((mode: 'steam' | 'epic' | 'both') => {
    if (mode === 'both') {
      // Toggle off if already active
      updateFilter('store', isBothActive ? [] : ['steam', 'epic'] as GameStore[]);
    } else {
      const alreadyActive = filters.store.length === 1 && filters.store[0] === mode;
      updateFilter('store', alreadyActive ? [] : [mode] as GameStore[]);
    }
  }, [filters.store, isBothActive, updateFilter]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 400, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className="fixed right-0 top-0 bottom-0 bg-zinc-950 border-l border-zinc-800 z-50 overflow-hidden shadow-2xl"
        >
          <div className="w-[400px] h-full flex flex-col">
            {/* Header — fixed, never scrolls */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-lg flex items-center justify-center">
                  <SlidersHorizontal className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Filters & Sort</h2>
                  <p className="text-xs text-white/40">Refine your game collection</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-9 w-9 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700 transition-none flex-shrink-0"
                aria-label="Close filters"
              >
                <X className="h-4 w-4 pointer-events-none" />
              </button>
            </div>

            {/* Content — scrollable */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">

          {/* Category Filter - Only in Browse mode (always interactive) */}
          {viewMode === 'browse' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Category</Label>
              <Select
                value={filters.category}
                onValueChange={(value) => {
                  // Prevent selecting catalog if not synced yet
                  if (value === 'catalog' && catalogTotalCount === 0) return;
                  // Changing category resets all filters below it (store, genre,
                  // platform, release year) so stale selections from the previous
                  // category don't silently produce empty results.
                  updateFilter('category', value as GameCategory);
                  updateFilter('store', []);
                  updateFilter('genre', 'All');
                  updateFilter('platform', 'All');
                  updateFilter('releaseYear', 'All');
                }}
              >
                <SelectTrigger className="w-full bg-background/50" aria-label="Filter by category">
                  <SelectValue placeholder="Top Sellers" />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((option) => {
                    const isCatalogUnavailable = option.value === 'catalog' && catalogTotalCount === 0;
                    return (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={isCatalogUnavailable}
                        className={cn(isCatalogUnavailable && 'opacity-40')}
                      >
                        <span className="flex items-center gap-2">
                          {option.label}
                          {isCatalogUnavailable && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-white/40 font-normal">
                              <span className="inline-block w-3 h-3 border-2 border-white/20 border-t-white/50 rounded-full animate-spin" />
                              Syncing
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="h-px bg-border" />

          {/* Sort — disabled in Catalog mode (A–Z order is fixed) */}
          <div className={cn('space-y-2', isCatalog && 'opacity-40 pointer-events-none')}>
            <Label className="text-sm font-medium">Sort By</Label>
            <div className="flex gap-2">
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)} disabled={isCatalog}>
                <SelectTrigger className="flex-1 bg-background/50" aria-label="Sort by">
                  <ArrowUpDown className="h-4 w-4 mr-2 pointer-events-none" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                onClick={toggleSortDirection}
                aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
                className="flex-shrink-0"
                disabled={isCatalog}
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </Button>
            </div>
          </div>

          {/* Store Filter — disabled in Catalog mode (Steam-only catalog) */}
          {(viewMode === 'browse' || viewMode === 'library') && (
            <div className={cn('space-y-2', isCatalog && 'opacity-40 pointer-events-none')}>
              <Label className="text-sm font-medium">Store</Label>
              <div className="flex gap-2">
                {/* Steam only — disabled when Free Games (Epic-only data) */}
                {(() => {
                  const selected = filters.store.length === 1 && filters.store[0] === 'steam';
                  const disabled = isCatalog || isFreeGames;
                  return (
                    <button
                      type="button"
                      onClick={() => !disabled && selectStore('steam')}
                      aria-pressed={selected}
                      disabled={disabled}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-all',
                        disabled
                          ? 'opacity-40 cursor-not-allowed'
                          : selected
                            ? 'bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-300'
                            : 'bg-background/50 border-zinc-700 text-white/60 hover:border-zinc-500 hover:text-white/80',
                      )}
                    >
                      <FaSteam className="h-3.5 w-3.5" />
                      Steam
                    </button>
                  );
                })()}
                {/* Epic only — disabled when Most Played (Steam-only data) */}
                {(() => {
                  const selected = filters.store.length === 1 && filters.store[0] === 'epic';
                  const disabled = isCatalog || isMostPlayed;
                  return (
                    <button
                      type="button"
                      onClick={() => !disabled && selectStore('epic')}
                      aria-pressed={selected}
                      disabled={disabled}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-all',
                        disabled
                          ? 'opacity-40 cursor-not-allowed'
                          : selected
                            ? 'bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-300'
                            : 'bg-background/50 border-zinc-700 text-white/60 hover:border-zinc-500 hover:text-white/80',
                      )}
                    >
                      <SiEpicgames className="h-3.5 w-3.5" />
                      Epic Games
                    </button>
                  );
                })()}
                {/* Both stores (intersection) — disabled when Most Played or Free Games (single-store data) */}
                {(() => {
                  const disabled = isCatalog || isMostPlayed || isFreeGames;
                  return (
                    <button
                      type="button"
                      onClick={() => !disabled && selectStore('both')}
                      aria-pressed={isBothActive}
                      disabled={disabled}
                      title="Show games available on both stores"
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-all',
                        disabled
                          ? 'opacity-40 cursor-not-allowed'
                          : isBothActive
                            ? 'bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-300'
                            : 'bg-background/50 border-zinc-700 text-white/60 hover:border-zinc-500 hover:text-white/80',
                      )}
                    >
                      <FaSteam className="h-3 w-3" />
                      <span className="text-white/30 font-mono text-xs">∩</span>
                      <SiEpicgames className="h-3 w-3" />
                    </button>
                  );
                })()}
              </div>
              {filters.store.length === 0 && !isCatalog && !isMostPlayed && !isFreeGames && (
                <p className="text-xs text-white/30">No filter — showing all stores</p>
              )}
              {isBothActive && (
                <p className="text-xs text-white/30">Showing games available on both stores (intersection)</p>
              )}
              {isMostPlayed && (
                <p className="text-xs text-white/30">Most Played data is Steam-only</p>
              )}
              {isFreeGames && (
                <p className="text-xs text-white/30">Free Games data is Epic-only</p>
              )}
            </div>
          )}

          {/* Status Filter - Only in Library mode */}
          {viewMode === 'library' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Status</Label>
              <Select
                value={filters.status}
                onValueChange={(value) => updateFilter('status', value as GameStatus | 'All')}
              >
                <SelectTrigger className="w-full bg-background/50" aria-label="Filter by status">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Priority Filter - Only in Library mode */}
          {viewMode === 'library' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Priority</Label>
              <Select
                value={filters.priority}
                onValueChange={(value) => updateFilter('priority', value as GamePriority | 'All')}
              >
                <SelectTrigger className="w-full bg-background/50" aria-label="Filter by priority">
                  <SelectValue placeholder="All Priorities" />
                </SelectTrigger>
                <SelectContent>
                  {priorityOptions.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {priority}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Genre / Platform / Year filters are disabled in Catalog mode */}
          {isCatalog ? (
            <div className="rounded-md bg-white/5 border border-white/10 px-3 py-2.5 text-xs text-white/50">
              Sort and filters are disabled in Catalog (A–Z) mode. Browse alphabetically or use Search to find specific games.
            </div>
          ) : (
            <>
              {/* Genre Filter - Searchable Combobox */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Genre</Label>
                <Combobox
                  options={genreOptions}
                  value={filters.genre}
                  onValueChange={(value) => updateFilter('genre', value)}
                  placeholder="All Genres"
                  searchPlaceholder="Search genres..."
                  emptyMessage="No genre found."
                />
              </div>

              {/* Platform Filter - Searchable Combobox */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Platform</Label>
                <Combobox
                  options={platformOptions}
                  value={filters.platform}
                  onValueChange={(value) => updateFilter('platform', value)}
                  placeholder="All Platforms"
                  searchPlaceholder="Search platforms..."
                  emptyMessage="No platform found."
                />
              </div>

              {/* Release Year Filter */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Release Year</Label>
                <Combobox
                  options={releaseYearOptions}
                  value={filters.releaseYear}
                  onValueChange={(value) => updateFilter('releaseYear', value)}
                  placeholder="All Years"
                  searchPlaceholder="Search year..."
                  emptyMessage="No year found."
                />
              </div>
            </>
          )}

          <div className="h-px bg-border" />

          {/* Active Filters Summary */}
          {hasActiveFilters && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">Active Filters</Label>
              <div className="flex flex-wrap gap-2">
                {filters.category !== 'trending' && viewMode === 'browse' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {categoryOptions.find(c => c.value === filters.category)?.label}
                    <button 
                      onClick={() => updateFilter('category', 'trending')} 
                      className="ml-1 hover:text-red-400"
                      aria-label="Remove category filter"
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.status !== 'All' && viewMode === 'library' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {filters.status}
                    <button 
                      onClick={() => updateFilter('status', 'All')} 
                      className="ml-1 hover:text-red-400"
                      aria-label={`Remove ${filters.status} filter`}
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.priority !== 'All' && viewMode === 'library' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {filters.priority} Priority
                    <button 
                      onClick={() => updateFilter('priority', 'All')} 
                      className="ml-1 hover:text-red-400"
                      aria-label={`Remove ${filters.priority} priority filter`}
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.genre !== 'All' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {filters.genre}
                    <button 
                      onClick={() => updateFilter('genre', 'All')} 
                      className="ml-1 hover:text-red-400"
                      aria-label={`Remove ${filters.genre} filter`}
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.platform !== 'All' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {filters.platform}
                    <button 
                      onClick={() => updateFilter('platform', 'All')} 
                      className="ml-1 hover:text-red-400"
                      aria-label={`Remove ${filters.platform} filter`}
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.releaseYear !== 'All' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {filters.releaseYear}
                    <button 
                      onClick={() => updateFilter('releaseYear', 'All')} 
                      className="ml-1 hover:text-red-400"
                      aria-label={`Remove ${filters.releaseYear} filter`}
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.store.length > 0 && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {isBothActive ? 'Steam ∩ Epic' : filters.store[0] === 'steam' ? 'Steam' : 'Epic Games'}
                    <button 
                      onClick={() => updateFilter('store', [])} 
                      className="ml-1 hover:text-red-400"
                      aria-label="Remove store filter"
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Reset Button */}
          <Button 
            variant="outline" 
            className="w-full gap-2"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            aria-label="Reset all filters"
          >
            <RotateCcw className="h-4 w-4 pointer-events-none" />
            Reset All Filters
          </Button>
            </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
  );
});

// ─── Legacy combined export (backwards-compatible) ───────────────────────────
// Kept for any tests or consumers that still import FilterSidebar.
// Simply re-exports FilterPanel under the old name.
export const FilterSidebar = FilterPanel;
