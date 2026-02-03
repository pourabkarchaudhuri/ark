import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useSteamGames, useGameSearch, useLibrary, useLibraryGames, useSteamFilters, useFilteredGames, useRateLimitWarning } from '@/hooks/useGameStore';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { Game } from '@/types/game';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { GameDialog } from '@/components/game-dialog';
import { CustomGameDialog } from '@/components/custom-game-dialog';
import { GameCard } from '@/components/game-card';
import { SkeletonGrid } from '@/components/game-card-skeleton';
// GameDetailPanel removed - now using dedicated /game/:id route
import { FilterSidebar } from '@/components/filter-sidebar';
import { SearchSuggestions } from '@/components/search-suggestions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  Gamepad2,
  Search,
  X,
  Minus,
  Maximize2,
  Square,
  Library,
  Filter,
  ArrowUp,
  WifiOff,
  RefreshCw,
  PlusCircle,
  Sparkles,
  Settings,
  Trash2,
} from 'lucide-react';
import { libraryStore } from '@/services/library-store';
import { AIChatPanel } from '@/components/ai-chat-panel';
import { SettingsPanel } from '@/components/settings-panel';

// Declare window.electron type
declare global {
  interface Window {
    electron?: {
      minimize: () => Promise<void>;
      maximize: () => Promise<void>;
      close: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
    };
  }
}

type SortOption = 'releaseDate' | 'title' | 'rating';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'browse' | 'library';

// Track if cache has been cleared this session
export function Dashboard() {
  const [, navigate] = useLocation();
  
  // Local filter state
  const { filters, updateFilter, resetFilters } = useFilteredGames();
  
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  
  // Steam Games (games for browsing) - pass category filter
  const { games: steamGames, loading: steamLoading, hasMore: browseHasMore, loadMore: browseLoadMore, error: steamError } = useSteamGames(filters.category);
  
  // Note: Cache clearing removed - useSteamGames handles data fetching on mount
  
  // Search functionality
  const [searchQuery, setSearchQuery] = useState('');
  const { results: searchResults, loading: searchLoading, isSearching } = useGameSearch(searchQuery);
  
  // Library management
  const { addToLibrary, removeFromLibrary, updateEntry, isInLibrary, librarySize, addCustomGame, customGames } = useLibrary();
  
  // Library games with full details (fetched independently from Steam games)
  const { games: libraryGames, loading: libraryLoading } = useLibraryGames();
  
  // Custom game dialog state
  const [isCustomGameDialogOpen, setIsCustomGameDialogOpen] = useState(false);
  
  // AI Chat panel state
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  
  // Settings panel state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // Panel handlers - ensure only one panel is open at a time
  const openAIChat = useCallback(() => {
    setIsFilterOpen(false);
    setIsSettingsOpen(false);
    setIsAIChatOpen(true);
  }, []);
  
  const openSettings = useCallback(() => {
    setIsFilterOpen(false);
    setIsAIChatOpen(false);
    setIsSettingsOpen(true);
  }, []);
  
  const openFilters = useCallback(() => {
    setIsAIChatOpen(false);
    setIsSettingsOpen(false);
    setIsFilterOpen(true);
  }, []);
  
  // Handler for FilterSidebar's onOpenChange - close others when opening
  const handleFilterOpenChange = useCallback((open: boolean) => {
    if (open) {
      openFilters();
    } else {
      setIsFilterOpen(false);
    }
  }, [openFilters]);
  
  // Determine which games, loading, and hasMore to use based on viewMode
  const currentGames = useMemo(() => {
    if (viewMode === 'library') {
      // Use libraryGames (fetched with full details) + custom games
      // Mark all library games as isInLibrary
      const markedLibraryGames = libraryGames.map(g => ({ ...g, isInLibrary: true }));
      return [...customGames, ...markedLibraryGames];
    }
    return steamGames;
  }, [viewMode, steamGames, customGames, libraryGames]);
  
  const currentLoading = viewMode === 'library' ? libraryLoading : steamLoading;
  const currentError = steamError;
  const hasMore = viewMode === 'browse' ? browseHasMore : false;
  const loadMore = viewMode === 'browse' ? browseLoadMore : () => {};
  
  // IGDB filters (genres and platforms)
  const { genres, platforms } = useSteamFilters();
  
  const { success, error: showError, warning } = useToast();

  // Rate limit warning - throttle to avoid spam
  const lastWarningRef = useRef<number>(0);
  const handleRateLimitWarning = useCallback((queueSize: number) => {
    const now = Date.now();
    // Only show warning every 5 seconds to avoid spam
    if (now - lastWarningRef.current > 5000) {
      lastWarningRef.current = now;
      warning(
        `Slow down! ${queueSize} requests queued. IGDB limits to 4 requests/second.`,
        8000
      );
    }
  }, [warning]);
  
  useRateLimitWarning(handleRateLimitWarning);

  // Online status for offline mode
  const { isOnline, wasOffline, isSyncing, acknowledgeOffline } = useOnlineStatus();

  // Show toast when coming back online
  useEffect(() => {
    if (wasOffline && isOnline) {
      success('Back online! Syncing data...');
      acknowledgeOffline();
    }
  }, [wasOffline, isOnline, success, acknowledgeOffline]);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingGame, setEditingGame] = useState<Game | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('releaseDate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; game: Game | null }>({
    open: false,
    game: null,
  });
  
  // Clear library confirmation state
  const [clearLibraryConfirm, setClearLibraryConfirm] = useState(false);

  // Determine which games to show based on mode and search
  const displayedGames = useMemo(() => {
    let games: Game[];
    
    if (viewMode === 'library') {
      // Library mode: filter library games locally
      let libraryGames = currentGames;
      
      // Apply local search within library
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        libraryGames = libraryGames.filter(g => 
          g.title.toLowerCase().includes(query) ||
          g.developer.toLowerCase().includes(query) ||
          g.genre.some((genre: string) => genre.toLowerCase().includes(query)) ||
          g.platform.some((platform: string) => platform.toLowerCase().includes(query))
        );
      }
      games = libraryGames;
    } else if (viewMode === 'browse' && isSearching && searchResults.length > 0) {
      // Browse mode with active Steam search
      games = searchResults;
    } else {
      // Any other mode showing current games (browse)
      games = currentGames;
    }

    // Apply genre filter
    if (filters.genre !== 'All') {
      games = games.filter(game => game.genre.includes(filters.genre));
    }

    // Apply platform filter
    if (filters.platform !== 'All') {
      games = games.filter(game => 
        game.platform.some(p => p.toLowerCase().includes(filters.platform.toLowerCase()))
      );
    }

    // Apply status filter (only for library games)
    if (filters.status !== 'All' && viewMode === 'library') {
      games = games.filter(game => game.isInLibrary && game.status === filters.status);
    }

    // Apply release year filter
    if (filters.releaseYear !== 'All') {
      games = games.filter(game => {
        if (!game.releaseDate) return false;
        const gameYear = new Date(game.releaseDate).getFullYear().toString();
        return gameYear === filters.releaseYear;
      });
    }

    return games;
  }, [currentGames, searchResults, isSearching, viewMode, searchQuery, filters]);

  // Sort games
  const sortedGames = useMemo(() => {
    const sorted = [...displayedGames].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'rating':
          comparison = (a.metacriticScore ?? 0) - (b.metacriticScore ?? 0);
          break;
        case 'releaseDate':
        default:
          comparison = new Date(a.releaseDate || 0).getTime() - new Date(b.releaseDate || 0).getTime();
          break;
      }

      return sortDirection === 'desc' ? -comparison : comparison;
    });

    return sorted;
  }, [displayedGames, sortBy, sortDirection]);

  // Infinite scroll with IntersectionObserver
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only enable infinite scroll for browse view
    if (viewMode !== 'browse' || isSearching) return;

    const currentRef = loadMoreRef.current;
    if (!currentRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !currentLoading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(currentRef);

    return () => {
      observer.unobserve(currentRef);
      observer.disconnect();
    };
  }, [hasMore, currentLoading, loadMore, viewMode, isSearching]);

  // Scroll-to-top visibility
  useEffect(() => {
    function handleScroll() {
      setShowScrollTop(window.scrollY > 500);
    }

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Handle adding game to library
  const handleAddToLibrary = useCallback((game: Game) => {
    setEditingGame(game);
    setIsDialogOpen(true);
  }, []);

  // Handle editing library entry
  const handleEdit = useCallback((game: Game) => {
    setEditingGame(game);
    setIsDialogOpen(true);
  }, []);

  // Handle saving library entry
  const handleSave = useCallback((gameData: Partial<Game>) => {
    try {
      if (editingGame) {
        const gameId = editingGame.steamAppId || editingGame.igdbId;
        if (!gameId) {
          showError('Invalid game ID');
          return;
        }
        
        if (isInLibrary(gameId)) {
          // Update existing library entry
          updateEntry(gameId, {
            status: gameData.status,
            priority: gameData.priority,
            publicReviews: gameData.publicReviews,
            recommendationSource: gameData.recommendationSource,
          });
          success(`"${editingGame.title}" updated successfully`);
        } else {
          // Add to library
          addToLibrary(gameId, gameData.status || 'Want to Play');
          success(`"${editingGame.title}" added to your library`);
        }
      }
      setIsDialogOpen(false);
      setEditingGame(null);
    } catch (err) {
      showError('Failed to save. Please try again.');
    }
  }, [editingGame, isInLibrary, updateEntry, addToLibrary, success, showError]);

  // Handle removing from library
  const handleDeleteClick = useCallback((game: Game) => {
    setDeleteConfirm({ open: true, game });
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirm.game) {
      try {
        const gameId = deleteConfirm.game.steamAppId || deleteConfirm.game.igdbId;
        if (gameId) {
          removeFromLibrary(gameId);
          success(`"${deleteConfirm.game.title}" removed from your library`);
        }
      } catch (err) {
        showError('Failed to remove game. Please try again.');
      }
    }
    setDeleteConfirm({ open: false, game: null });
  }, [deleteConfirm.game, removeFromLibrary, success, showError]);

  // Handle clearing entire library
  const handleClearLibraryConfirm = useCallback(() => {
    try {
      const count = libraryStore.getSize();
      libraryStore.clear();
      success(`Cleared ${count} games from your library`);
    } catch (err) {
      showError('Failed to clear library. Please try again.');
    }
    setClearLibraryConfirm(false);
  }, [success, showError]);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }, []);

  // Window controls state and handlers
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electron) {
        const maximized = await window.electron.isMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();
    const interval = setInterval(checkMaximized, 500);
    return () => clearInterval(interval);
  }, []);

  const handleMinimize = async () => {
    if (window.electron) {
      await window.electron.minimize();
    }
  };

  const handleMaximize = async () => {
    if (window.electron) {
      await window.electron.maximize();
      const maximized = await window.electron.isMaximized();
      setIsMaximized(maximized);
    }
  };

  const handleClose = async () => {
    if (window.electron) {
      await window.electron.close();
    }
  };

  const hasActiveFilters = 
    searchQuery || 
    filters.status !== 'All' || 
    filters.genre !== 'All' || 
    filters.platform !== 'All' ||
    filters.category !== 'all';

  const activeFilterCount = [
    filters.status !== 'All' && viewMode === 'library',
    filters.genre !== 'All',
    filters.platform !== 'All',
    filters.category !== 'all' && viewMode === 'browse',
  ].filter(Boolean).length;

  // Total games count for display (unused after count fix, keeping for potential future use)
  const _totalGamesCount = viewMode === 'library' ? librarySize : steamGames.length;
  void _totalGamesCount; // Silence unused variable warning

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="bg-black/80 backdrop-blur-xl sticky top-0 z-40 drag-region">
        <div className="px-6 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 no-drag mt-[5px]">
              <div className="h-8 w-8 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
                <Gamepad2 className="h-4 w-4 text-white" />
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white">Ark</h1>
                <span className="text-xs text-white/50">v1.0.12</span>
              </div>
            </div>
            
            {/* macOS Window Controls */}
            <div className="flex items-center gap-2 no-drag">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
                onClick={handleClose}
                aria-label="Close window"
              >
                <X className="h-3 w-3 text-white pointer-events-none" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
                onClick={handleMinimize}
                aria-label="Minimize window"
              >
                <Minus className="h-3 w-3 text-white pointer-events-none" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-full bg-gray-700/80 hover:bg-gray-600 p-0 transition-colors"
                onClick={handleMaximize}
                aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
              >
                {isMaximized ? (
                  <Maximize2 className="h-2.5 w-2.5 text-white pointer-events-none" />
                ) : (
                  <Square className="h-3 w-3 text-white pointer-events-none" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className={cn(
        "px-6 py-6 transition-all duration-300",
        (isFilterOpen || isAIChatOpen || isSettingsOpen) && "pr-[424px]"
      )}>
        {/* Results Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setViewMode('browse')}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                  viewMode === 'browse' 
                    ? "bg-fuchsia-500 text-white" 
                    : "text-white/60 hover:text-white"
                )}
              >
                Browse
              </button>
              <button
                onClick={() => {
                  setViewMode('library');
                  setSearchQuery(''); // Clear search when switching to Library
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                  viewMode === 'library' 
                    ? "bg-fuchsia-500 text-white" 
                    : "text-white/60 hover:text-white"
                )}
              >
                <Library className="h-3 w-3" />
                Library ({librarySize})
              </button>
            </div>

            {/* Clear Library Button - only visible in library mode */}
            {viewMode === 'library' && librarySize > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setClearLibraryConfirm(true)}
                className="h-7 text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Clear All
              </Button>
            )}

            <p className="text-sm text-white/60">
              Showing <span className="text-white font-medium">{sortedGames.length}{viewMode === 'browse' && hasMore ? '+' : ''}</span> games
            </p>
            {hasActiveFilters && (
              <div className="flex items-center gap-2">
                <Badge 
                  variant="secondary" 
                  className="gap-1 bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30 hover:bg-fuchsia-500/30 cursor-pointer"
                  onClick={openFilters}
                >
                  <Filter className="h-3 w-3 pointer-events-none" />
                  {activeFilterCount} filter{activeFilterCount !== 1 ? 's' : ''} active
                </Badge>
                <button
                  onClick={() => {
                    resetFilters();
                    setSearchQuery('');
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs text-white/70 bg-black hover:bg-white/10 rounded border border-white/10 transition-colors"
                  aria-label="Clear all filters"
                >
                  <X className="h-3 w-3" />
                  Clear
                </button>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 z-10" />
              <Input
                ref={searchInputRef}
                placeholder={viewMode === 'library' ? "Search your library..." : "Search Steam games..."}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (viewMode === 'browse' && e.target.value.trim()) {
                    setShowSuggestions(true);
                  }
                }}
                onFocus={() => {
                  if (viewMode === 'browse' && searchQuery.trim()) {
                    setShowSuggestions(true);
                  }
                }}
                className="w-96 h-9 pl-10 pr-10 bg-white/5 border-white/10 text-white placeholder:text-white/40"
                aria-label="Search games"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setShowSuggestions(false);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/10 transition-colors z-10"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3 text-white/40" />
                </button>
              )}
              {searchLoading && viewMode !== 'library' && (
                <div className="absolute right-10 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                </div>
              )}
              
              {/* Search Suggestions Dropdown */}
              {viewMode === 'browse' && (
                <SearchSuggestions
                  results={searchResults}
                  loading={searchLoading}
                  visible={showSuggestions && searchQuery.trim().length > 0}
                  onSelect={(game) => {
                    setShowSuggestions(false);
                    // Navigate to game details page
                    if (game.steamAppId) {
                      navigate(`/game/${game.steamAppId}`);
                    }
                  }}
                  onClose={() => setShowSuggestions(false)}
                  searchQuery={searchQuery}
                />
              )}
            </div>

            {/* AI Chat Button */}
            <Button
              onClick={openAIChat}
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-white/70 hover:text-white hover:bg-purple-500/20 border border-white/10 hover:border-purple-500/50 transition-all"
              title="Open AI Assistant"
            >
              <Sparkles className="h-4 w-4 text-purple-400 pointer-events-none" />
            </Button>

            {/* Add Custom Game Button - only show in library mode */}
            {viewMode === 'library' && (
              <Button
                onClick={() => setIsCustomGameDialogOpen(true)}
                className="h-9 bg-fuchsia-500 hover:bg-fuchsia-600 text-white gap-1.5"
              >
                <PlusCircle className="h-4 w-4 pointer-events-none" />
                Add Custom Game
              </Button>
            )}

            {/* Filter Button */}
            <FilterSidebar
              open={isFilterOpen}
              onOpenChange={handleFilterOpenChange}
              filters={filters}
              updateFilter={updateFilter}
              resetFilters={resetFilters}
              genres={genres}
              platforms={platforms}
              sortBy={sortBy}
              setSortBy={setSortBy}
              sortDirection={sortDirection}
              toggleSortDirection={toggleSortDirection}
              viewMode={viewMode}
            />

            {/* Settings Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-white/60 hover:text-amber-400 hover:bg-white/10"
              onClick={openSettings}
              title="Settings"
              aria-label="Settings"
              data-testid="settings-button"
            >
              <Settings className="h-4 w-4 pointer-events-none" />
            </Button>
          </div>
        </div>

        {/* Loading State - Skeleton Grid */}
        {currentLoading && currentGames.length === 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 auto-rows-fr">
            <SkeletonGrid count={12} />
          </div>
        )}

        {/* Error State */}
        {currentError && (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-red-400 mb-4">{currentError}</p>
            <Button onClick={() => window.location.reload()} variant="outline">
              Retry
            </Button>
          </div>
        )}

        {/* Games Grid */}
        {!currentLoading && !currentError && sortedGames.length === 0 ? (
          (() => {
            // Determine which empty state to show
            if (isSearching) {
              return (
                <EmptyState 
                  type="no-results" 
                  onAction={() => setSearchQuery('')} 
                />
              );
            }
            if (hasActiveFilters) {
              return (
                <EmptyState 
                  type="no-filter-results" 
                  onAction={resetFilters} 
                />
              );
            }
            if (viewMode === 'library') {
              return (
                <EmptyState 
                  type="no-games" 
                  onAction={() => setViewMode('browse')} 
                />
              );
            }
            return (
              <EmptyState 
                type="no-games" 
                onAction={() => {}} 
              />
            );
          })()
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 auto-rows-fr">
              {sortedGames.map((game) => {
                // Only show rank for 'trending' category (top sellers) or when explicitly ranked
                // Hide ranks in 'all' view to avoid confusion since all games from Steam Charts have ranks
                const showRank = filters.category === 'trending' && game.rank !== undefined;
                const gameWithOptionalRank = showRank ? game : { ...game, rank: undefined };
                
                return (
                  <div key={game.id} className="min-w-0">
                    <GameCard
                      game={gameWithOptionalRank}
                      onEdit={() => handleEdit(game)}
                      onDelete={() => handleDeleteClick(game)}
                      isInLibrary={game.isInLibrary}
                      onAddToLibrary={() => handleAddToLibrary(game)}
                      onRemoveFromLibrary={() => handleDeleteClick(game)}
                    />
                  </div>
                );
              })}
            </div>
            {/* Infinite scroll sentinel */}
            {viewMode === 'browse' && !isSearching && hasMore && (
              <div ref={loadMoreRef} className="flex justify-center py-8">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
              </div>
            )}
          </>
        )}
      </main>

      {/* Game Dialog - Now for library entry */}
      <GameDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        game={editingGame}
        onSave={handleSave}
        genres={genres}
        platforms={platforms}
      />

      {/* Custom Game Dialog */}
      <CustomGameDialog
        open={isCustomGameDialogOpen}
        onOpenChange={setIsCustomGameDialogOpen}
        onSave={(customGame) => {
          addCustomGame(customGame);
          success(`"${customGame.title}" added to your library`);
          setIsCustomGameDialogOpen(false);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ open, game: open ? deleteConfirm.game : null })}
        title="Remove from Library"
        description={`Are you sure you want to remove "${deleteConfirm.game?.title}" from your library? This will delete your progress tracking and notes.`}
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
      />

      {/* Clear Library Confirmation Dialog */}
      <ConfirmDialog
        open={clearLibraryConfirm}
        onOpenChange={setClearLibraryConfirm}
        title="Clear Entire Library"
        description={`Are you sure you want to remove all ${librarySize} games from your library? This action cannot be undone. Consider exporting your library first from Settings.`}
        confirmText="Clear All"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleClearLibraryConfirm}
      />

      {/* Scroll to Top FAB - z-60 to stay above filter sidebar (z-50) */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 h-12 w-12 rounded-full bg-fuchsia-500 hover:bg-fuchsia-600 text-white shadow-lg shadow-fuchsia-500/30 flex items-center justify-center transition-all duration-300 z-[60]"
          aria-label="Scroll to top"
        >
          <ArrowUp className="h-5 w-5" />
        </button>
      )}

      {/* Offline Indicator */}
      {!isOnline && (
        <div className="fixed bottom-6 left-6 flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/90 text-black font-medium shadow-lg z-40">
          <WifiOff className="h-4 w-4" />
          <span className="text-sm">Offline - Using cached data</span>
        </div>
      )}

      {/* Syncing Indicator */}
      {isSyncing && isOnline && (
        <div className="fixed bottom-6 left-6 flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/90 text-black font-medium shadow-lg z-40">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm">Syncing...</span>
        </div>
      )}

      {/* AI Chat Panel */}
      <AIChatPanel
        isOpen={isAIChatOpen}
        onClose={() => setIsAIChatOpen(false)}
      />

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

    </div>
  );
}
