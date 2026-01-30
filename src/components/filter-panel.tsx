import { GameStatus, GamePriority } from '@/types/game';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Search,
  Filter,
  RotateCcw,
  X,
  ArrowUpDown,
  LayoutGrid,
  List,
  ChevronRight,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

const statusOptions: (GameStatus | 'All')[] = [
  'All',
  'Want to Play',
  'Playing',
  'Completed',
  'On Hold',
  'Dropped',
];

const priorityOptions: (GamePriority | 'All')[] = ['All', 'High', 'Medium', 'Low'];

type SortOption = 'releaseDate' | 'title' | 'metacritic' | 'priority';
type SortDirection = 'asc' | 'desc';

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'releaseDate', label: 'Release Date' },
  { value: 'title', label: 'Title' },
  { value: 'metacritic', label: 'Metacritic Score' },
  { value: 'priority', label: 'Priority' },
];

interface FilterState {
  search: string;
  status: GameStatus | 'All';
  priority: GamePriority | 'All';
  genre: string;
  platform: string;
}

interface FilterPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  filters: FilterState;
  updateFilter: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  resetFilters: () => void;
  genres: string[];
  platforms: string[];
  sortBy: SortOption;
  setSortBy: (value: SortOption) => void;
  sortDirection: SortDirection;
  toggleSortDirection: () => void;
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  resultCount: number;
  totalCount: number;
}

export function FilterPanel({
  isOpen,
  onToggle,
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
  setViewMode,
  resultCount,
  totalCount,
}: FilterPanelProps) {
  const hasActiveFilters = 
    filters.search || 
    filters.status !== 'All' || 
    filters.priority !== 'All' || 
    filters.genre !== 'All' || 
    filters.platform !== 'All';

  const activeFilterCount = [
    filters.status !== 'All',
    filters.priority !== 'All',
    filters.genre !== 'All',
    filters.platform !== 'All',
  ].filter(Boolean).length;

  return (
    <>
      {/* Toggle Button (when panel is closed) */}
      {!isOpen && (
        <Button 
          variant="outline" 
          size="sm" 
          className="gap-2 relative border-white/10 bg-white/5 hover:bg-white/10"
          onClick={onToggle}
          aria-label="Open filters"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <Badge 
              variant="secondary" 
              className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs bg-fuchsia-500 text-white"
            >
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      )}

      {/* Slide-out Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="fixed top-0 right-0 h-full bg-[#0a0a0a] border-l border-white/10 z-50 overflow-hidden"
          >
            <div className="w-[320px] h-full overflow-y-auto p-6">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <Filter className="h-5 w-5 text-fuchsia-400" />
                  <h2 className="text-lg font-semibold text-white">Filters & Sort</h2>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={onToggle}
                  className="h-8 w-8 text-white/60 hover:text-white hover:bg-white/10"
                  aria-label="Close filters"
                >
                  <ChevronRight className="h-4 w-4 pointer-events-none" />
                </Button>
              </div>

              <p className="text-sm text-white/50 mb-6">
                Showing {resultCount} of {totalCount} games
              </p>

              <div className="space-y-6">
                {/* Search */}
                <div className="space-y-2">
                  <Label htmlFor="panel-search" className="text-sm font-medium text-white/80">Search</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
                    <Input
                      id="panel-search"
                      placeholder="Search games, developers..."
                      value={filters.search}
                      onChange={(e) => updateFilter('search', e.target.value)}
                      className="pl-10 pr-10 bg-white/5 border-white/10 text-white placeholder:text-white/40"
                      aria-label="Search games"
                    />
                    {filters.search && (
                      <button
                        onClick={() => updateFilter('search', '')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/10 transition-colors"
                        aria-label="Clear search"
                      >
                        <X className="h-3 w-3 text-white/40" />
                      </button>
                    )}
                  </div>
                </div>

                {/* View Mode */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">View Mode</Label>
                  <div className="flex gap-2">
                    <Button
                      variant={viewMode === 'grid' ? 'secondary' : 'outline'}
                      size="sm"
                      className={cn(
                        "flex-1 gap-2",
                        viewMode === 'grid' 
                          ? "bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30" 
                          : "border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                      )}
                      onClick={() => setViewMode('grid')}
                      aria-label="Grid view"
                      aria-pressed={viewMode === 'grid'}
                    >
                      <LayoutGrid className="h-4 w-4" />
                      Grid
                    </Button>
                    <Button
                      variant={viewMode === 'list' ? 'secondary' : 'outline'}
                      size="sm"
                      className={cn(
                        "flex-1 gap-2",
                        viewMode === 'list' 
                          ? "bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30" 
                          : "border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                      )}
                      onClick={() => setViewMode('list')}
                      aria-label="List view"
                      aria-pressed={viewMode === 'list'}
                    >
                      <List className="h-4 w-4" />
                      List
                    </Button>
                  </div>
                </div>

                {/* Sort */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">Sort By</Label>
                  <div className="flex gap-2">
                    <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
                      <SelectTrigger className="flex-1 bg-white/5 border-white/10 text-white" aria-label="Sort by">
                        <ArrowUpDown className="h-4 w-4 mr-2 text-white/40" />
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
                      className="flex-shrink-0 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                    >
                      {sortDirection === 'asc' ? '↑' : '↓'}
                    </Button>
                  </div>
                </div>

                <div className="h-px bg-white/10" />

                {/* Status Filter */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">Status</Label>
                  <Select
                    value={filters.status}
                    onValueChange={(value) => updateFilter('status', value as GameStatus | 'All')}
                  >
                    <SelectTrigger className="w-full bg-white/5 border-white/10 text-white" aria-label="Filter by status">
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

                {/* Priority Filter */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">Priority</Label>
                  <Select
                    value={filters.priority}
                    onValueChange={(value) => updateFilter('priority', value as GamePriority | 'All')}
                  >
                    <SelectTrigger className="w-full bg-white/5 border-white/10 text-white" aria-label="Filter by priority">
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

                {/* Genre Filter */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">Genre</Label>
                  <Select
                    value={filters.genre}
                    onValueChange={(value) => updateFilter('genre', value)}
                  >
                    <SelectTrigger className="w-full bg-white/5 border-white/10 text-white" aria-label="Filter by genre">
                      <SelectValue placeholder="All Genres" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="All">All Genres</SelectItem>
                      {genres.map((genre) => (
                        <SelectItem key={genre} value={genre}>
                          {genre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Platform Filter */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-white/80">Platform</Label>
                  <Select
                    value={filters.platform}
                    onValueChange={(value) => updateFilter('platform', value)}
                  >
                    <SelectTrigger className="w-full bg-white/5 border-white/10 text-white" aria-label="Filter by platform">
                      <SelectValue placeholder="All Platforms" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="All">All Platforms</SelectItem>
                      {platforms.map((platform) => (
                        <SelectItem key={platform} value={platform}>
                          {platform}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="h-px bg-white/10" />

                {/* Active Filters Summary */}
                {hasActiveFilters && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-white/50">Active Filters</Label>
                    <div className="flex flex-wrap gap-2">
                      {filters.status !== 'All' && (
                        <Badge variant="secondary" className="gap-1 bg-white/10 text-white/80 border-white/20">
                          {filters.status}
                          <button 
                            onClick={() => updateFilter('status', 'All')} 
                            className="ml-1 hover:text-red-400"
                            aria-label={`Remove ${filters.status} filter`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      )}
                      {filters.priority !== 'All' && (
                        <Badge variant="secondary" className="gap-1 bg-white/10 text-white/80 border-white/20">
                          {filters.priority}
                          <button 
                            onClick={() => updateFilter('priority', 'All')} 
                            className="ml-1 hover:text-red-400"
                            aria-label={`Remove ${filters.priority} filter`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      )}
                      {filters.genre !== 'All' && (
                        <Badge variant="secondary" className="gap-1 bg-white/10 text-white/80 border-white/20">
                          {filters.genre}
                          <button 
                            onClick={() => updateFilter('genre', 'All')} 
                            className="ml-1 hover:text-red-400"
                            aria-label={`Remove ${filters.genre} filter`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      )}
                      {filters.platform !== 'All' && (
                        <Badge variant="secondary" className="gap-1 bg-white/10 text-white/80 border-white/20">
                          {filters.platform}
                          <button 
                            onClick={() => updateFilter('platform', 'All')} 
                            className="ml-1 hover:text-red-400"
                            aria-label={`Remove ${filters.platform} filter`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Reset Button */}
                <Button 
                  variant="outline" 
                  className="w-full gap-2 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                  onClick={resetFilters}
                  disabled={!hasActiveFilters}
                  aria-label="Reset all filters"
                >
                  <RotateCcw className="h-4 w-4" />
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

