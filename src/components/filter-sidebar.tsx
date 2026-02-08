import { useMemo } from 'react';
import { GameStatus, GamePriority } from '@/types/game';
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
import { motion, AnimatePresence } from 'framer-motion';
import {
  Filter,
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

export type GameCategory = 'all' | 'most-played' | 'trending' | 'recent' | 'award-winning';

const categoryOptions: { value: GameCategory; label: string }[] = [
  { value: 'all', label: 'All Games' },
  { value: 'most-played', label: 'Most Played' },
  { value: 'trending', label: 'Top Sellers' },
  { value: 'recent', label: 'New Releases' },
  { value: 'award-winning', label: 'Coming Soon' },
];

type SortOption = 'releaseDate' | 'title' | 'rating';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'browse' | 'library' | 'journey' | 'buzz';

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'rating', label: 'Rating' },
  { value: 'releaseDate', label: 'Release Date' },
  { value: 'title', label: 'Title' },
];

interface FilterState {
  search: string;
  status: GameStatus | 'All';
  priority: GamePriority | 'All';
  genre: string;
  platform: string;
  category: GameCategory;
  releaseYear: string;
}

interface FilterSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FilterState;
  updateFilter: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  resetFilters: () => void;
  genres: string[];
  platforms: string[];
  sortBy: SortOption;
  setSortBy: (value: SortOption) => void;
  sortDirection: SortDirection;
  toggleSortDirection: () => void;
  viewMode: ViewMode;
}

export function FilterSidebar({
  open,
  onOpenChange,
  filters,
  updateFilter,
  resetFilters,
  genres,
  platforms,
  sortBy,
  setSortBy,
  sortDirection,
  toggleSortDirection,
  viewMode,
}: FilterSidebarProps) {
  const hasActiveFilters = 
    filters.status !== 'All' || 
    filters.priority !== 'All' ||
    filters.genre !== 'All' || 
    filters.platform !== 'All' ||
    filters.category !== 'all' ||
    filters.releaseYear !== 'All';

  const activeFilterCount = [
    filters.status !== 'All' && viewMode === 'library',
    filters.priority !== 'All' && viewMode === 'library',
    filters.genre !== 'All',
    filters.platform !== 'All',
    filters.category !== 'all' && viewMode === 'browse',
    filters.releaseYear !== 'All',
  ].filter(Boolean).length;

  // Convert arrays to combobox options
  const genreOptions = useMemo(() => [
    { value: 'All', label: 'All Genres' },
    ...genres.map(g => ({ value: g, label: g }))
  ], [genres]);

  const platformOptions = useMemo(() => [
    { value: 'All', label: 'All Platforms' },
    ...platforms.map(p => ({ value: p, label: p }))
  ], [platforms]);

  // Generate release year options (current year down to 2015)
  const releaseYearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years: { value: string; label: string }[] = [
      { value: 'All', label: 'All Years' },
    ];
    for (let year = currentYear + 1; year >= 2015; year--) {
      years.push({ value: String(year), label: String(year) });
    }
    return years;
  }, []);

  return (
    <>
      <Button 
        variant="outline" 
        size="icon"
        className="h-9 w-9 relative"
        onClick={() => onOpenChange(!open)}
        aria-label="Open filters"
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

      <AnimatePresence>
        {open && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 400, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="fixed top-0 right-0 h-full bg-zinc-950 border-l border-zinc-800 z-50 overflow-hidden shadow-2xl"
          >
            <div className="w-[400px] h-full overflow-y-auto p-6">
              <div className="pb-6 mb-6 border-b border-zinc-800">
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Filter className="h-5 w-5 text-fuchsia-400 flex-shrink-0" />
                    <h2 className="text-lg font-semibold text-white truncate">Filters & Sort</h2>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onOpenChange(false)}
                    className="h-7 w-7 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 flex-shrink-0"
                    aria-label="Close filters"
                  >
                    <X className="h-4 w-4 pointer-events-none" />
                  </Button>
                </div>
                <p className="text-sm text-white/60">
                  Refine your game collection
                </p>
              </div>

        <div className="space-y-6">
          {/* Sort */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Sort By</Label>
            <div className="flex gap-2">
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
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
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </Button>
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* Category Filter - Only in Browse mode */}
          {viewMode === 'browse' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Category</Label>
              <Select
                value={filters.category}
                onValueChange={(value) => updateFilter('category', value as GameCategory)}
              >
                <SelectTrigger className="w-full bg-background/50" aria-label="Filter by category">
                  <SelectValue placeholder="All Games" />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

          <div className="h-px bg-border" />

          {/* Active Filters Summary */}
          {hasActiveFilters && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">Active Filters</Label>
              <div className="flex flex-wrap gap-2">
                {filters.category !== 'all' && viewMode === 'browse' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
                    {categoryOptions.find(c => c.value === filters.category)?.label}
                    <button 
                      onClick={() => updateFilter('category', 'all')} 
                      className="ml-1 hover:text-red-400"
                      aria-label="Remove category filter"
                    >
                      <X className="h-3 w-3 pointer-events-none" />
                    </button>
                  </Badge>
                )}
                {filters.status !== 'All' && viewMode === 'library' && (
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
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
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
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
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
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
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
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
                  <Badge variant="secondary" className="gap-1 bg-fuchsia-500/20 text-white border-fuchsia-500/30">
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
    </>
  );
}
