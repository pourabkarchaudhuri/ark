import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { useLocation } from 'wouter';
import { useSteamGames, useGameSearch, useLibrary, useLibraryGames, useJourneyHistory, useSteamFilters, useFilteredGames, extractCachedMeta } from '@/hooks/useGameStore';
import { useDetailEnricher } from '@/hooks/useDetailEnricher';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { Game, GameStatus } from '@/types/game';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { GameDialog } from '@/components/game-dialog';
import { CustomGameDialog } from '@/components/custom-game-dialog';
import { CustomGameProgressDialog } from '@/components/custom-game-progress-dialog';
import { GameCard } from '@/components/game-card';
import { SkeletonGrid } from '@/components/game-card-skeleton';
import { VirtualGameGrid } from '@/components/virtual-game-grid';
// GameDetailPanel removed - now using dedicated /game/:id route
import { FilterTrigger, FilterPanel } from '@/components/filter-sidebar';
import { SearchSuggestions } from '@/components/search-suggestions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { APP_VERSION } from '@/components/changelog-modal';
import { WindowControls } from '@/components/window-controls';
import { EmptyState } from '@/components/empty-state';
import { JourneyView } from '@/components/journey-view';
import { BuzzView } from '@/components/buzz-view';
import { ReleaseCalendar } from '@/components/release-calendar';
import { useToast } from '@/components/ui/toast';

const DarkVeil = lazy(() => import('@/components/ui/dark-veil'));
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Gamepad2,
  Search,
  X,
  Library,
  Filter,
  ArrowUp,
  WifiOff,
  RefreshCw,
  PlusCircle,
  Sparkles,
  Settings,
  Trash2,
  Clock,
  Newspaper,
  CalendarDays,
} from 'lucide-react';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { AIChatPanel } from '@/components/ai-chat-panel';
import { SettingsPanel } from '@/components/settings-panel';
import { useSessionTracker } from '@/hooks/useSessionTracker';

type SortOption = 'releaseDate' | 'title' | 'rating';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'browse' | 'library' | 'journey' | 'buzz' | 'calendar';

// Track if cache has been cleared this session
export function Dashboard() {
  const [, navigate] = useLocation();
  
  // Local filter state
  const { filters, updateFilter, resetFilters } = useFilteredGames();
  
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  // Tracks whether the DarkVeil bg is active (stays true during exit animation)
  const [buzzBgActive, setBuzzBgActive] = useState(false);

  useEffect(() => {
    if (viewMode === 'buzz') {
      setBuzzBgActive(true);
    }
    // Close the filter panel when switching to a view that doesn't support it
    // (journey, buzz, calendar have no filterable grid).  This prevents the
    // panel from reserving space / staying visible after a tab switch.
    if (viewMode === 'journey' || viewMode === 'buzz' || viewMode === 'calendar') {
      setIsFilterOpen(false);
    }
  }, [viewMode]);
  
  // Steam Games (games for browsing) - pass category filter
  const { games: steamGames, loading: steamLoading, hasMore: browseHasMore, loadMore: browseLoadMore, error: steamError, loadingMore, isSyncing: isBrowseSyncing, catalogLetter, jumpToLetter: rawJumpToLetter, enrichGames, allGamesRef, enrichmentMapRef, totalCount } = useSteamGames(filters.category);

  // Wire up the detail enricher — lazily fetches metadata for visible catalog cards
  useDetailEnricher(enrichGames, allGamesRef, enrichmentMapRef);

  // Scroll to top before jumping to a letter in catalog mode
  const jumpToLetter = useCallback((letter: string) => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    rawJumpToLetter(letter);
  }, [rawJumpToLetter]);
  
  // Note: Cache clearing removed - useSteamGames handles data fetching on mount
  
  // Search functionality
  const [searchQuery, setSearchQuery] = useState('');
  const { results: searchResults, loading: searchLoading, isSearching } = useGameSearch(searchQuery);
  
  // Library management
  const { addToLibrary, removeFromLibrary, updateEntry, isInLibrary, librarySize, addCustomGame, removeCustomGame, customGames } = useLibrary();
  
  // Library games with full details (fetched independently from Steam games)
  const { games: libraryGames, loading: libraryLoading } = useLibraryGames();

  // Journey history (persists even after library removal)
  const journeyEntries = useJourneyHistory();
  
  // Session tracking (live "Playing Now" status)
  const { isPlayingNow } = useSessionTracker();

  // Custom game dialog state
  const [isCustomGameDialogOpen, setIsCustomGameDialogOpen] = useState(false);
  
  // Custom game progress dialog state
  const [customProgressGameId, setCustomProgressGameId] = useState<string | null>(null);
  
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

  const closeAIChat = useCallback(() => setIsAIChatOpen(false), []);
  
  const openSettings = useCallback(() => {
    setIsFilterOpen(false);
    setIsAIChatOpen(false);
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);
  
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
  
  const currentLoading = viewMode === 'browse' ? steamLoading : libraryLoading;
  const currentError = steamError;
  // Epic store filter: Epic data is a finite curated set (new releases + coming
  // soon + free games), not backed by the 155k+ Steam catalog.  The catalog
  // infinite-scroll fallback only loads Steam titles, so when the user filters
  // to "epic", loading more would yield zero results and cause a tight
  // IntersectionObserver loop that hangs the UI.  Disable hasMore for Epic.
  // When the store filter is exclusively Epic, disable infinite scroll —
  // Epic data is a finite curated set not backed by the 155k+ Steam catalog.
  const isEpicOnly = filters.store.length === 1 && filters.store[0] === 'epic';
  const hasMore = viewMode === 'browse' && !isEpicOnly ? browseHasMore : false;
  // Stable noop — avoids creating a new () => {} every render, which would
  // invalidate the IntersectionObserver useEffect dependency array.
  const noopRef = useRef(() => {});
  const loadMore = viewMode === 'browse' ? browseLoadMore : noopRef.current;
  
  // Steam filters (genres and platforms)
  const { genres, platforms } = useSteamFilters();
  
  const { success, error: showError } = useToast();

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
    // When actively searching in browse mode, skip sidebar filters —
    // the user expects search to cover all of Steam, not just the filtered set.
    let skipBrowseFilters = false;
    
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
    } else if (viewMode === 'browse' && isSearching) {
      // Browse mode with active Steam search — show results (even if empty, handled below)
      games = searchResults;
      skipBrowseFilters = true;
    } else {
      // Any other mode showing current games (browse)
      games = currentGames;
    }

    // Apply sidebar filters in a SINGLE pass (avoids creating intermediate arrays).
    // Pre-compute filter checks outside the loop for efficiency.
    if (!skipBrowseFilters) {
      const hasGenre = filters.genre !== 'All';
      const hasPlatform = filters.platform !== 'All';
      const platformLower = hasPlatform ? filters.platform.toLowerCase() : '';
      const hasStatus = filters.status !== 'All' && viewMode === 'library';
      const hasPriority = filters.priority !== 'All' && viewMode === 'library';
      const hasYear = filters.releaseYear !== 'All';
      const hasStore = filters.store.length > 0;
      const storeSet = hasStore ? new Set(filters.store) : null;
      const hideSentinel = viewMode === 'browse';

      const anyFilter = hasGenre || hasPlatform || hasStatus || hasPriority || hasYear || hasStore || hideSentinel;

      if (anyFilter) {
        games = games.filter(game => {
          if (hasGenre && !game.genre.includes(filters.genre)) return false;
          if (hasPlatform && !game.platform.some(p => p.toLowerCase().includes(platformLower))) return false;
          if (hasStatus && !(game.isInLibrary && game.status === filters.status)) return false;
          if (hasPriority && !(game.isInLibrary && game.priority === filters.priority)) return false;
          if (hasYear) {
            if (!game.releaseDate) return false;
            // Extract year without creating a Date object (ISO dates start with YYYY-)
            const year = game.releaseDate.slice(0, 4);
            if (year !== filters.releaseYear) return false;
          }
          if (storeSet) {
            const directMatch = game.store && storeSet.has(game.store);
            const availMatch = game.availableOn?.some(s => storeSet.has(s));
            if (!directMatch && !availMatch) return false;
          }
          if (hideSentinel && game.comingSoon && game.releaseDate === 'Coming Soon') return false;
          return true;
        });
      }
    }

    return games;
  }, [currentGames, searchResults, isSearching, viewMode, searchQuery, filters]);

  // Sort games (skip sort in catalog mode — data is already A-Z from the hook).
  // Uses an index tiebreaker so that when enrichment fills in releaseDate /
  // metacriticScore, cards with previously-equal values keep their position
  // instead of shuffling the grid and jumping the user's scroll.
  const sortedGames = useMemo(() => {
    if (filters.category === 'catalog') return displayedGames;

    // Build index map for stable tiebreaker
    const indexMap = new Map<string, number>();
    displayedGames.forEach((g, i) => indexMap.set(g.id, i));

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
          // Use pre-computed numeric timestamp from dedup worker (O(1) instead of parsing 12000+ Dates)
          comparison = ((a as any)._releaseTs ?? 0) - ((b as any)._releaseTs ?? 0);
          break;
      }

      if (comparison !== 0) {
        return sortDirection === 'desc' ? -comparison : comparison;
      }
      // Stable tiebreaker: preserve insertion order
      return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
    });

    return sorted;
  }, [displayedGames, sortBy, sortDirection, filters.category]);

  // Infinite scroll with IntersectionObserver
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Infinite scroll sentinel footer for the virtual grid.
  // The sentinel div must always be present (for IntersectionObserver) but
  // the visual spinner only shows when loadingMore is actually true.
  const infiniteScrollSentinel = useMemo(() => {
    if (viewMode !== 'browse' || isSearching || (!hasMore && !loadingMore)) return null;
    return (
      <div ref={loadMoreRef} className="py-8">
        {loadingMore && (
          <div className="flex flex-col items-center justify-center gap-2">
            <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            <span className="text-sm text-white/70">Loading more…</span>
          </div>
        )}
      </div>
    );
  }, [viewMode, isSearching, hasMore, loadingMore]);

  useEffect(() => {
    // Only enable infinite scroll for browse view
    if (viewMode !== 'browse' || isSearching) return;

    const currentRef = loadMoreRef.current;
    if (!currentRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !currentLoading && !loadingMore) {
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
  }, [hasMore, currentLoading, loadingMore, loadMore, viewMode, isSearching]);

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

  // Stable view-mode handlers — avoids creating new closures on every render
  const switchToBrowse = useCallback(() => setViewMode('browse'), []);
  const switchToLibrary = useCallback(() => { setViewMode('library'); setSearchQuery(''); }, []);
  const switchToJourney = useCallback(() => { setViewMode('journey'); setSearchQuery(''); }, []);
  const switchToBuzz = useCallback(() => { setViewMode('buzz'); setSearchQuery(''); }, []);
  const switchToCalendar = useCallback(() => { setViewMode('calendar'); setSearchQuery(''); }, []);

  // Handle adding game to library
  const handleAddToLibrary = useCallback((game: Game) => {
    setEditingGame(game);
    setIsDialogOpen(true);
  }, []);

  // Handle editing library entry — custom games open their dedicated progress dialog
  const handleEdit = useCallback((game: Game) => {
    if (game.isCustom || game.id.startsWith('custom-')) {
      setCustomProgressGameId(game.id);
      return;
    }
    setEditingGame(game);
    setIsDialogOpen(true);
  }, []);

  // Handle clicking a custom game card — opens progress dialog.
  // Direct callback for components that receive (gameId) => void (e.g. JourneyView).
  const handleCustomGameClick = useCallback((gameId: string) => {
    setCustomProgressGameId(gameId);
  }, []);

  // Ref-backed map so each custom game gets a *stable* zero-arg callback reference
  // that won't break React.memo comparisons on GameCard.
  const customClickHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getCustomGameClickHandler = useCallback((gameId: string): () => void => {
    let handler = customClickHandlersRef.current.get(gameId);
    if (!handler) {
      handler = () => setCustomProgressGameId(gameId);
      customClickHandlersRef.current.set(gameId, handler);
    }
    return handler;
  }, []);

  // Handle quick status change from card badge
  const handleStatusChange = useCallback((game: Game, status: GameStatus) => {
    if (isInLibrary(game.id)) {
      updateEntry(game.id, { status });
    }
  }, [isInLibrary, updateEntry]);

  // Handle saving library entry
  const handleSave = useCallback((gameData: Partial<Game> & { executablePath?: string }) => {
    try {
      if (editingGame) {
        const gameId = editingGame.id;
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
            executablePath: gameData.executablePath,
          });
          success(`"${editingGame.title}" updated successfully`);
        } else {
          // Add to library — cache game metadata so library can always display
          // the game even when the remote API is unreachable (e.g. Epic/Cloudflare).
          const cachedMeta = extractCachedMeta(editingGame);
          addToLibrary(gameId, gameData.status || 'Want to Play', cachedMeta);
          // Update with additional fields including executablePath
          if (gameData.priority || gameData.publicReviews || gameData.recommendationSource || gameData.executablePath) {
            updateEntry(gameId, {
              priority: gameData.priority,
              publicReviews: gameData.publicReviews,
              recommendationSource: gameData.recommendationSource,
              executablePath: gameData.executablePath,
            });
          }
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

  // ------ Stable gameId-based callbacks (never re-created → GameCard memo works) ------
  const handleCardEdit = useCallback((gameId: string) => {
    const game = allGamesRef.current.find(g => g.id === gameId);
    if (game) handleEdit(game);
  }, [handleEdit, allGamesRef]);

  const handleCardDelete = useCallback((gameId: string) => {
    const game = allGamesRef.current.find(g => g.id === gameId);
    if (game) handleDeleteClick(game);
  }, [handleDeleteClick, allGamesRef]);

  const handleCardAddToLibrary = useCallback((gameId: string) => {
    const game = allGamesRef.current.find(g => g.id === gameId);
    if (game) handleAddToLibrary(game);
  }, [handleAddToLibrary, allGamesRef]);

  const handleCardRemoveFromLibrary = useCallback((gameId: string) => {
    const game = allGamesRef.current.find(g => g.id === gameId);
    if (game) handleDeleteClick(game);
  }, [handleDeleteClick, allGamesRef]);

  const handleCardStatusChange = useCallback((gameId: string, status: GameStatus) => {
    const game = allGamesRef.current.find(g => g.id === gameId);
    if (game) handleStatusChange(game, status);
  }, [handleStatusChange, allGamesRef]);

  // Stable render callback for VirtualGameGrid
  const showRankInGrid = filters.category === 'trending';
  const hideLibBadge = viewMode === 'library';
  const renderGameCard = useCallback((game: Game) => {
    return (
      <GameCard
        game={game}
        hideRank={!showRankInGrid}
        onEdit={handleCardEdit}
        onDelete={handleCardDelete}
        onClick={
          (game.isCustom || game.id.startsWith('custom-'))
            ? getCustomGameClickHandler(game.id)
            : undefined
        }
        isInLibrary={game.isInLibrary}
        isPlayingNow={game.steamAppId ? isPlayingNow(game.steamAppId) : false}
        onAddToLibrary={handleCardAddToLibrary}
        onRemoveFromLibrary={handleCardRemoveFromLibrary}
        onStatusChange={handleCardStatusChange}
        hideLibraryBadge={hideLibBadge}
      />
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRankInGrid, hideLibBadge, handleCardEdit, handleCardDelete, handleCardAddToLibrary, handleCardRemoveFromLibrary, handleCardStatusChange]);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirm.game) {
      try {
        const gameId = deleteConfirm.game.id;
        if (gameId) {
          // Custom games use "custom-" prefix — route to the correct store
          if (gameId.startsWith('custom-')) {
            removeCustomGame(gameId);
          } else {
            removeFromLibrary(gameId);
          }
          success(`"${deleteConfirm.game.title}" removed from your library`);
        }
      } catch (err) {
        showError('Failed to remove game. Please try again.');
      }
    }
    setDeleteConfirm({ open: false, game: null });
  }, [deleteConfirm.game, removeFromLibrary, removeCustomGame, success, showError]);

  // Handle clearing entire library (including custom games)
  const handleClearLibraryConfirm = useCallback(() => {
    try {
      const libraryCount = libraryStore.getSize();
      const customCount = customGameStore.getCount();
      libraryStore.clear();
      customGameStore.clear();
      const total = libraryCount + customCount;
      success(`Cleared ${total} game${total !== 1 ? 's' : ''} from your library`);
    } catch (err) {
      showError('Failed to clear library. Please try again.');
    }
    setClearLibraryConfirm(false);
  }, [success, showError]);

  // Stable callbacks for dialog/panel open-change handlers.
  // Avoids creating new closures on every Dashboard render.
  const handleProgressDialogChange = useCallback((open: boolean) => {
    if (!open) setCustomProgressGameId(null);
  }, []);

  const handleDeleteDialogChange = useCallback((open: boolean) => {
    if (!open) setDeleteConfirm({ open: false, game: null });
    // When opening (true), we keep the current game — setDeleteConfirm is only called from handleDeleteClick
  }, []);

  const handleCustomGameSave = useCallback((customGame: Parameters<typeof addCustomGame>[0]) => {
    addCustomGame(customGame);
    success(`"${customGame.title}" added to your library`);
    setIsCustomGameDialogOpen(false);
  }, [addCustomGame, success]);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }, []);

  const hasActiveFilters = useMemo(() =>
    !!(searchQuery || 
    filters.status !== 'All' || 
    filters.priority !== 'All' ||
    filters.genre !== 'All' || 
    filters.platform !== 'All' ||
    filters.category !== 'all' ||
    filters.store.length > 0),
  [searchQuery, filters.status, filters.priority, filters.genre, filters.platform, filters.category, filters.store.length]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'All' && viewMode === 'library') count++;
    if (filters.priority !== 'All' && viewMode === 'library') count++;
    if (filters.genre !== 'All') count++;
    if (filters.platform !== 'All') count++;
    if (filters.category !== 'all' && viewMode === 'browse') count++;
    if (filters.store.length > 0) count++;
    return count;
  }, [filters.status, filters.priority, filters.genre, filters.platform, filters.category, filters.store.length, viewMode]);

  // Total games count — for browse mode use the hook's totalCount (includes full catalog);
  // for library mode use the local librarySize.
  const browseTotalCount = viewMode === 'library' ? librarySize : totalCount;

  return (
    <div className={cn("min-h-screen", buzzBgActive ? 'bg-transparent' : 'bg-black')}>
      {/* DarkVeil background — only in buzz mode, fades in/out */}
      <AnimatePresence onExitComplete={() => setBuzzBgActive(false)}>
        {viewMode === 'buzz' && (
          <motion.div
            key="darkveil-bg"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.6, ease: 'easeInOut' } }}
            exit={{ opacity: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
            className="fixed inset-0 z-0 pointer-events-none"
          >
            <Suspense fallback={null}>
              <DarkVeil
                hueShift={0}
                noiseIntensity={0}
                scanlineIntensity={0}
                speed={0.5}
                scanlineFrequency={0}
                warpAmount={3.4}
                resolutionScale={1}
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className={cn(
        "sticky top-0 z-40 drag-region",
        buzzBgActive ? 'bg-transparent' : 'bg-black/80 backdrop-blur-xl'
      )}>
        <div className="px-6 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 no-drag mt-[5px]">
              <div className="h-8 w-8 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
                <Gamepad2 className="h-4 w-4 text-white" />
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white">Ark</h1>
                <span className="text-xs text-white/50">v{APP_VERSION}</span>
              </div>
            </div>
            
            {/* Window Controls */}
            <WindowControls />
          </div>
        </div>
      </header>

      <main className={cn(
        "px-6 py-6 transition-all duration-300 relative z-10",
        (isFilterOpen || isAIChatOpen || isSettingsOpen) && "pr-[424px]"
      )}>
        {/* Results Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-white/5 rounded-lg p-1">
              <button
                onClick={switchToBrowse}
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
                onClick={switchToLibrary}
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
              <button
                onClick={switchToJourney}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                  viewMode === 'journey' 
                    ? "bg-fuchsia-500 text-white" 
                    : "text-white/60 hover:text-white"
                )}
              >
                <Clock className="h-3 w-3" />
                Journey
              </button>
              <button
                onClick={switchToBuzz}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                  viewMode === 'buzz' 
                    ? "bg-fuchsia-500 text-white" 
                    : "text-white/60 hover:text-white"
                )}
              >
                <Newspaper className="h-3 w-3" />
                Buzz
              </button>
              <button
                onClick={switchToCalendar}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                  viewMode === 'calendar' 
                    ? "bg-fuchsia-500 text-white" 
                    : "text-white/60 hover:text-white"
                )}
              >
                <CalendarDays className="h-3 w-3" />
                Releases
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

            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && (
              <>
                <p className="text-sm text-white/60 flex items-center gap-1.5">
                  {isBrowseSyncing ? (
                    <>
                      <svg className="h-3 w-3 animate-spin text-fuchsia-400 shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span className="text-fuchsia-400 font-medium">Syncing</span>{' '}
                      <span className="text-white font-medium">{sortedGames.length.toLocaleString()}</span>
                      {browseTotalCount > 0 && browseTotalCount !== sortedGames.length && (
                        <> / <span className="text-white font-medium">{browseTotalCount.toLocaleString()}</span>{' '}
                        <span className="text-white/40">({Math.round((sortedGames.length / browseTotalCount) * 100)}%)</span></>
                      )}
                      {' '}games
                    </>
                  ) : (
                    <><span className="text-white font-medium">{sortedGames.length.toLocaleString()}</span> games</>
                  )}
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
              </>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {/* Search - hidden in journey, buzz, and calendar mode */}
            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 z-10" />
                <Input
                  ref={searchInputRef}
                  placeholder={viewMode === 'library' ? "Search your library..." : "Search games..."}
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
                      // Navigate to game details page using universal game ID
                      if (game.id) {
                        navigate(`/game/${encodeURIComponent(game.id)}`);
                      }
                    }}
                    onClose={() => setShowSuggestions(false)}
                    searchQuery={searchQuery}
                  />
                )}
              </div>
            )}

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

            {/* Filter Button - hidden in journey, buzz, and calendar mode */}
            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && (
              <FilterTrigger
                open={isFilterOpen}
                onToggle={() => handleFilterOpenChange(!isFilterOpen)}
                filters={filters}
                viewMode={viewMode}
              />
            )}

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

        {/* Journey View */}
        {viewMode === 'journey' ? (
          <JourneyView
            entries={journeyEntries}
            loading={libraryLoading}
            onSwitchToBrowse={() => setViewMode('browse')}
            onCustomGameClick={handleCustomGameClick}
          />
        ) : viewMode === 'buzz' ? (
          <BuzzView />
        ) : viewMode === 'calendar' ? (
          <ReleaseCalendar />
        ) : (
          <>
            {/* Loading State - Skeleton Grid */}
            {(currentLoading && currentGames.length === 0) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 auto-rows-fr">
                <SkeletonGrid count={12} />
              </div>
            )}

            {/* Search Loading State */}
            {searchLoading && isSearching && viewMode === 'browse' && sortedGames.length === 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 auto-rows-fr">
                <SkeletonGrid count={6} />
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

            {/* Catalog A–Z Letter Bar */}
            {viewMode === 'browse' && filters.category === 'catalog' && !currentLoading && (
              <div className="flex flex-wrap items-center gap-1 mb-4">
                <span className="text-xs text-white/50 mr-1 font-medium">Jump to:</span>
                {'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => (
                  <button
                    key={letter}
                    onClick={() => jumpToLetter(letter === '#' ? '0' : letter)}
                    className={cn(
                      "w-7 h-7 text-xs font-medium rounded transition-colors flex items-center justify-center",
                      catalogLetter?.toUpperCase() === (letter === '#' ? '0' : letter)
                        ? "bg-fuchsia-500 text-white"
                        : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    {letter}
                  </button>
                ))}
              </div>
            )}

            {/* Games Grid */}
            {!currentLoading && !searchLoading && !currentError && sortedGames.length === 0 ? (
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
              <VirtualGameGrid
                games={sortedGames}
                renderCard={renderGameCard}
                gap={16}
                footer={infiniteScrollSentinel}
              />
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
        currentExecutablePath={editingGame ? libraryStore.getEntry(editingGame.id)?.executablePath : undefined}
      />

      {/* Custom Game Dialog */}
      <CustomGameDialog
        open={isCustomGameDialogOpen}
        onOpenChange={setIsCustomGameDialogOpen}
        onSave={handleCustomGameSave}
      />

      {/* Custom Game Progress Dialog */}
      {customProgressGameId !== null && (
        <CustomGameProgressDialog
          open={customProgressGameId !== null}
          onOpenChange={handleProgressDialogChange}
          gameId={customProgressGameId}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={handleDeleteDialogChange}
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

      {/* Filter & Sort Panel — rendered at root level (outside <main>) so
          its z-50 sits above the sticky z-40 header in the same stacking context */}
      <FilterPanel
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

      {/* AI Chat Panel */}
      <AIChatPanel
        isOpen={isAIChatOpen}
        onClose={closeAIChat}
      />

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={closeSettings}
      />

    </div>
  );
}
