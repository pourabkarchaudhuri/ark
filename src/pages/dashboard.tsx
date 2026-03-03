import { useState, useCallback, useMemo, useEffect, useRef, useSyncExternalStore, lazy, Suspense, startTransition } from 'react';
import { useLocation } from 'wouter';
import { useSteamGames, useGameSearch, useLibrary, useLibraryGames, useJourneyHistory, useSteamFilters, useFilteredGames, extractCachedMeta, useDebounce } from '@/hooks/useGameStore';
import { useDeferredFilterSort } from '@/hooks/useDeferredFilterSort';
import { useDetailEnricher } from '@/hooks/useDetailEnricher';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { Game, GameStatus } from '@/types/game';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { GameDialog, GameDialogInitialEntry } from '@/components/game-dialog';
import { CustomGameDialog } from '@/components/custom-game-dialog';
// EditProgressDialog removed — edits now route through GameDialog in edit mode
import { GameCard } from '@/components/game-card';
import { SkeletonGrid } from '@/components/game-card-skeleton';
import { VirtualGameGrid, useBreakpointColumns } from '@/components/virtual-game-grid';
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
const OracleView = lazy(() => import('@/components/oracle-view').then(m => ({ default: m.OracleView })));
const AnnGraphView = lazy(() => import('@/components/ann-graph-view').then(m => ({ default: m.AnnGraphView })));
const DataFlowView = lazy(() => import('@/components/data-flow-view').then(m => ({ default: m.DataFlowView })));
const DevLogView = lazy(() => import('@/components/devlog-view').then(m => ({ default: m.DevLogView })));
import { useToast } from '@/components/ui/toast';

import { cn } from '@/lib/utils';
import { setNavigatingGame } from '@/services/prefetch-store';
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
  Compass,
  Eye,
  Network,
  HelpCircle,
  Workflow,
  ScrollText,
  ChevronDown,
  Play,
  Pause,
  CheckCircle2,
  Bookmark,
  Zap,
  Loader2,
} from 'lucide-react';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { AIChatPanel } from '@/components/ai-chat-panel';
import { SettingsScreen } from '@/components/settings-screen';
import { GuidedTour, useTourState } from '@/components/guided-tour';
import { YearWrapped, WrappedSnackbar } from '@/components/year-wrapped';
import { AnimateIcon, MagneticWrap } from '@/components/ui/animate-icon';
import { useSessionTracker } from '@/hooks/useSessionTracker';
import { NavbarStatusIndicator } from '@/components/system-status-panel';
import { useDevMode } from '@/hooks/useDevMode';
import { scheduleBackgroundPrecompute, getBuildStage, subscribeGalaxy } from '@/services/galaxy-cache';
import { embeddingService } from '@/services/embedding-service';
import { prewarmNews } from '@/services/news-service';
import { prewarmEvents } from '@/services/event-resolver-service';
import { TooltipCard } from '@/components/ui/tooltip-card';
import { MovingBorderButton } from '@/components/ui/moving-border';

type SortOption = 'releaseDate' | 'title' | 'rating';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'browse' | 'library' | 'journey' | 'buzz' | 'calendar' | 'oracle' | 'ann-graph' | 'data-flow' | 'devlog' | 'settings';


const RETURN_VIEW_KEY = 'ark-return-view';
const VALID_VIEW_MODES: ViewMode[] = ['browse', 'library', 'journey', 'buzz', 'calendar', 'oracle', 'ann-graph', 'data-flow', 'devlog', 'settings'];

function getScrollStorageKey(view: ViewMode): string {
  return `ark-dashboard-scroll-${view}`;
}

function LazyViewFallback() {
  return (
    <div className="flex items-center justify-center h-64 text-white/30">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export function Dashboard() {
  const [location, navigate] = useLocation();
  
  // Local filter state
  const { filters, updateFilter, resetFilters } = useFilteredGames();
  
  // View mode state — restore from sessionStorage when returning from game details
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'browse';
    const saved = sessionStorage.getItem(RETURN_VIEW_KEY);
    return (saved && VALID_VIEW_MODES.includes(saved as ViewMode)) ? (saved as ViewMode) : 'browse';
  });

  // Guided tour state
  const { tourRunning, tourKey, startTour, stopTour } = useTourState();

  // Persist current view so it survives navigation to game details and back
  useEffect(() => {
    if (location === '/') {
      sessionStorage.setItem(RETURN_VIEW_KEY, viewMode);
    }
  }, [location, viewMode]);

  // Pending scroll restore when returning to a view whose content loads async (e.g. Library)
  const pendingScrollRestoreRef = useRef<{ view: ViewMode; pos: number } | null>(null);

  // Seed the pending scroll restore on mount
  useEffect(() => {
    if (location !== '/') return;
    const saved = sessionStorage.getItem(getScrollStorageKey(viewMode));
    const pos = saved ? parseInt(saved, 10) : 0;
    if (!isNaN(pos) && pos > 0) {
      pendingScrollRestoreRef.current = { view: viewMode, pos };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (viewMode === 'journey' || viewMode === 'buzz' || viewMode === 'calendar' || viewMode === 'oracle' || viewMode === 'devlog' || viewMode === 'settings') {
      setIsFilterOpen(false);
    }
  }, [viewMode]);
  
  // Steam Games (games for browsing) - pass category filter
  const { games: steamGames, loading: steamLoading, hasMore: browseHasMore, loadMore: browseLoadMore, error: steamError, loadingMore, catalogLetter, jumpToLetter: rawJumpToLetter, enrichGames, allGamesRef, enrichmentMapRef, catalogTotalCount } = useSteamGames(filters.category);

  // Wire up the detail enricher — lazily fetches metadata for visible catalog cards
  useDetailEnricher(enrichGames, allGamesRef, enrichmentMapRef);

  // Scroll to top before jumping to a letter in catalog mode
  const jumpToLetter = useCallback((letter: string) => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    rawJumpToLetter(letter);
  }, [rawJumpToLetter]);
  
  // Note: Cache clearing removed - useSteamGames handles data fetching on mount
  
  // Search functionality — input is immediate, but filtering/API calls wait
  // until the user pauses typing (3s debounce).
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 3000);
  const { results: searchResults, loading: searchLoading, isSearching } = useGameSearch(debouncedSearch);
  
  // Library management
  const { addToLibrary, removeFromLibrary, updateEntry, isInLibrary, librarySize, addCustomGame, removeCustomGame, customGames } = useLibrary();
  
  // Library games with full details (fetched independently from Steam games)
  const { games: libraryGames, loading: libraryLoading } = useLibraryGames();

  // Journey history (persists even after library removal)
  const journeyEntries = useJourneyHistory();
  
  // Session tracking (live "Playing Now" status)
  const { isPlayingNow, liveGames } = useSessionTracker();
  const [devMode] = useDevMode();

  // Background precompute for Embedding Space galaxy data (runs once, 20s after mount)
  useEffect(() => { scheduleBackgroundPrecompute(); }, []);

  // Prewarm Transmissions data so news + events are cached before the user opens the tab
  useEffect(() => {
    const id = requestIdleCallback(() => { prewarmNews(); prewarmEvents(); });
    return () => cancelIdleCallback(id);
  }, []);
  const galaxyStage = useSyncExternalStore(subscribeGalaxy, getBuildStage);
  const galaxyBuilding = galaxyStage === 'scheduled' || galaxyStage === 'waiting' || galaxyStage === 'running';
  // Ollama availability — drives whether Embedding Space is accessible
  const [ollamaUnavailable, setOllamaUnavailable] = useState(false);
  useEffect(() => {
    const check = () => {
      if (embeddingService.isOllamaChecked) setOllamaUnavailable(embeddingService.isOllamaUnavailable);
    };
    check();
    return embeddingService.subscribe(check);
  }, []);

  // Custom game dialog state
  const [isCustomGameDialogOpen, setIsCustomGameDialogOpen] = useState(false);
  
  
  // AI Chat panel state
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);
  
  // Year Wrapped state
  const [showWrapped, setShowWrapped] = useState(false);
  
  // Panel handlers - ensure only one panel is open at a time; toggle if already open
  const toggleAIChat = useCallback(() => {
    setIsAIChatOpen(prev => {
      if (prev) return false;          // already open → close
      setIsFilterOpen(false);
      return true;                     // was closed → open
    });
  }, []);

  const closeAIChat = useCallback(() => setIsAIChatOpen(false), []);
  
  const switchToSettings = useCallback(() => { setViewMode('settings'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  
  const openFilters = useCallback(() => {
    setIsAIChatOpen(false);
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
  // Separate memoized library array — only rebuilds when library/custom data changes,
  // NOT on every viewMode toggle. libraryGames already have isInLibrary: true.
  const mergedLibraryGames = useMemo(() => {
    if (customGames.length === 0) return libraryGames;
    return [...customGames, ...libraryGames];
  }, [customGames, libraryGames]);

  const currentGames = viewMode === 'library' ? mergedLibraryGames : steamGames;
  
  // Ref mirror of currentGames — lets stable callbacks (handleCardEdit etc.)
  // find custom / library games without being recreated on every data change.
  const currentGamesRef = useRef<Game[]>([]);
  currentGamesRef.current = currentGames;

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
  const [editInitialEntry, setEditInitialEntry] = useState<GameDialogInitialEntry | null>(null);
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
  
  // Clear library confirmation state — two-step: step 1 = first "are you sure", step 2 = final confirmation
  const [clearLibraryStep, setClearLibraryStep] = useState<0 | 1 | 2>(0);

  // ── Deferred filter / sort / dynamic-filter computation ──────────────────
  // All the heavy per-game processing (filter 6000+ games, compute dynamic
  // genre/platform/year options, sort) is moved OFF the render phase.
  // The first render uses a fast synchronous path (initial ~120 item batch),
  // then a rAF-deferred effect computes the full result and applies it via
  // startTransition so the browser stays responsive.
  const { sortedGames, dynamicGenres, dynamicPlatforms, dynamicYears } =
    useDeferredFilterSort({
      currentGames,
      searchResults,
      isSearching,
      viewMode,
      searchQuery: debouncedSearch,
      filters,
      sortBy,
      sortDirection,
      liveGameIds: liveGames,
    });

  // Deferred scroll restore when grid content finishes loading.
  // The virtualised grid renders from `sortedGames` which is produced
  // asynchronously by `useDeferredFilterSort` (rAF + startTransition).
  // We must track BOTH `currentGames.length` (data arriving from store)
  // AND `sortedGames.length` (deferred sort output → grid height) so
  // this effect re-fires once the grid is tall enough to scroll to.
  const rawGameCount = currentGames.length;
  const renderedGameCount = sortedGames.length;
  useEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (location !== '/' || !pending || currentLoading) return;
    if (viewMode !== pending.view) return;
    if (renderedGameCount === 0) return;

    if (document.documentElement.scrollHeight < pending.pos + 200) return;

    pendingScrollRestoreRef.current = null;

    let attempts = 0;
    const maxAttempts = 30;
    const tryRestore = () => {
      window.scrollTo({ top: pending.pos, left: 0 });
      attempts++;
      if (Math.abs(window.scrollY - pending.pos) > 10 && attempts < maxAttempts) {
        requestAnimationFrame(tryRestore);
      }
    };
    requestAnimationFrame(tryRestore);
  }, [location, viewMode, currentLoading, rawGameCount, renderedGameCount]);

  // Auto-reset stale cascading filter values when the dynamic options no
  // longer include the currently selected value (e.g. user picks Genre=RPG,
  // then switches Store to Epic which has no RPGs → genre resets to 'All').
  useEffect(() => {
    if (filters.genre !== 'All' && dynamicGenres.length > 0 && !dynamicGenres.includes(filters.genre)) {
      updateFilter('genre', 'All');
    }
    if (filters.platform !== 'All' && dynamicPlatforms.length > 0 && !dynamicPlatforms.includes(filters.platform)) {
      updateFilter('platform', 'All');
    }
    if (filters.releaseYear !== 'All' && dynamicYears.length > 0 && !dynamicYears.includes(filters.releaseYear)) {
      updateFilter('releaseYear', 'All');
    }
  }, [dynamicGenres, dynamicPlatforms, dynamicYears, filters.genre, filters.platform, filters.releaseYear, updateFilter]);

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

  // Scroll-to-top visibility and persist scroll position (for Back-from-details restore)
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  useEffect(() => {
    let scrollSaveTimeout: ReturnType<typeof setTimeout>;
    function handleScroll() {
      setShowScrollTop(window.scrollY > 500);
      if (location !== '/') return;
      clearTimeout(scrollSaveTimeout);
      scrollSaveTimeout = setTimeout(() => {
        sessionStorage.setItem(getScrollStorageKey(viewModeRef.current), String(Math.round(window.scrollY)));
      }, 150);
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollSaveTimeout);
      // Flush one final save so the position isn't lost when navigating away
      sessionStorage.setItem(getScrollStorageKey(viewModeRef.current), String(Math.round(window.scrollY)));
    };
  }, [location, viewMode]);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Stable view-mode handlers — avoids creating new closures on every render.
  // Reset filters + search when leaving a mode so stale filter state from one
  // view (e.g. Browse genre=RPG) doesn't silently carry over to another (Library).
  const switchToBrowse = useCallback(() => { setSearchQuery(''); resetFilters(); startTransition(() => setViewMode('browse')); }, [resetFilters]);
  const switchToLibrary = useCallback(() => { setSearchQuery(''); resetFilters(); startTransition(() => setViewMode('library')); }, [resetFilters]);
  const switchToJourney = useCallback(() => { setViewMode('journey'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToBuzz = useCallback(() => { setViewMode('buzz'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToCalendar = useCallback(() => { setViewMode('calendar'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToOracle = useCallback(() => { setViewMode('oracle'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToAnnGraph = useCallback(() => { setViewMode('ann-graph'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToDataFlow = useCallback(() => { setViewMode('data-flow'); setSearchQuery(''); resetFilters(); }, [resetFilters]);
  const switchToDevLog = useCallback(() => { setViewMode('devlog'); setSearchQuery(''); resetFilters(); }, [resetFilters]);



  // Handle adding game to library
  const handleAddToLibrary = useCallback((game: Game) => {
    setEditingGame(game);
    setEditInitialEntry(null); // Add mode — no initial values
    setIsDialogOpen(true);
  }, []);

  // Handle quick status change from card badge
  const handleStatusChange = useCallback((game: Game, status: GameStatus) => {
    if (game.id.startsWith('custom-')) {
      // Custom games live in customGameStore, not libraryStore
      customGameStore.updateGame(game.id, { status });
    } else if (isInLibrary(game.id)) {
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

        const isCustom = gameId.startsWith('custom-');
        
        if (isCustom) {
          // Custom games live in customGameStore, not libraryStore
          customGameStore.updateGame(gameId, {
            status: gameData.status,
            priority: gameData.priority,
            publicReviews: gameData.publicReviews,
            recommendationSource: gameData.recommendationSource,
            executablePath: gameData.executablePath,
          });
          success(`"${editingGame.title}" updated successfully`);
        } else if (isInLibrary(gameId)) {
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
      setEditInitialEntry(null);
    } catch (err) {
      showError('Failed to save. Please try again.');
    }
  }, [editingGame, isInLibrary, updateEntry, addToLibrary, success, showError]);

  // Handle removing from library
  const handleDeleteClick = useCallback((game: Game) => {
    setDeleteConfirm({ open: true, game });
  }, []);

  // ------ Stable gameId-based callbacks (never re-created → GameCard memo works) ------
  // Helper: find a game across ALL sources (browse + library + custom).
  // allGamesRef has Steam/Epic browse games; currentGamesRef has the active
  // view's data (library + custom games in library mode, browse in browse mode).
  const resolveGame = useCallback((gameId: string): Game | undefined => {
    return allGamesRef.current.find(g => g.id === gameId)
      || currentGamesRef.current.find(g => g.id === gameId);
  }, [allGamesRef]);

  const handleCardEdit = useCallback((gameId: string) => {
    const game = resolveGame(gameId);
    if (!game) return;

    // Build initialEntry from library store or custom game store
    const libEntry = libraryStore.getEntry(gameId);
    const customEntry = gameId.startsWith('custom-') ? customGameStore.getGame(gameId) : null;

    const entry: GameDialogInitialEntry = {
      status: libEntry?.status ?? customEntry?.status ?? 'Want to Play',
      priority: libEntry?.priority ?? customEntry?.priority ?? 'Medium',
      publicReviews: libEntry?.publicReviews ?? customEntry?.publicReviews ?? '',
      recommendationSource: libEntry?.recommendationSource ?? customEntry?.recommendationSource ?? 'Personal Discovery',
      executablePath: libEntry?.executablePath ?? customEntry?.executablePath,
    };

    setEditingGame(game);
    setEditInitialEntry(entry);
    setIsDialogOpen(true);
  }, [resolveGame]);

  const handleCardDelete = useCallback((gameId: string) => {
    const game = resolveGame(gameId);
    if (game) handleDeleteClick(game);
  }, [handleDeleteClick, resolveGame]);

  const handleCardAddToLibrary = useCallback((gameId: string) => {
    const game = resolveGame(gameId);
    if (game) handleAddToLibrary(game);
  }, [handleAddToLibrary, resolveGame]);

  const handleCardRemoveFromLibrary = useCallback((gameId: string) => {
    const game = resolveGame(gameId);
    if (game) handleDeleteClick(game);
  }, [handleDeleteClick, resolveGame]);

  const handleCardStatusChange = useCallback((gameId: string, status: GameStatus) => {
    const game = resolveGame(gameId);
    if (game) handleStatusChange(game, status);
  }, [handleStatusChange, resolveGame]);

  // ── Library grouped sections ───────────────────────────────────────────
  const isLibraryView = viewMode === 'library';
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const libColumns = useBreakpointColumns();

  const STATUS_SECTIONS: { key: string; label: string; icon: typeof Play; color: string }[] = useMemo(() => [
    { key: 'Playing Now', label: 'Playing Now', icon: Zap, color: 'text-emerald-400' },
    { key: 'Playing', label: 'Playing', icon: Play, color: 'text-blue-400' },
    { key: 'On Hold', label: 'On Hold', icon: Pause, color: 'text-amber-400' },
    { key: 'Want to Play', label: 'Want to Play', icon: Bookmark, color: 'text-fuchsia-400' },
    { key: 'Completed', label: 'Completed', icon: CheckCircle2, color: 'text-white/50' },
  ], []);

  const libraryGroups = useMemo(() => {
    if (!isLibraryView || filters.status !== 'All') return null;
    const groups: Record<string, Game[]> = {};
    for (const s of STATUS_SECTIONS) groups[s.key] = [];

    for (const game of sortedGames) {
      const isLive = liveGames?.has(game.id) ||
        (game.steamAppId ? liveGames?.has(`steam-${game.steamAppId}`) : false);
      const effectiveStatus = (isLive || game.status === 'Playing Now') ? 'Playing Now' : (game.status || 'Want to Play');
      if (groups[effectiveStatus]) groups[effectiveStatus].push(game);
      else groups['Want to Play'].push(game);
    }
    return groups;
  }, [isLibraryView, filters.status, sortedGames, liveGames, STATUS_SECTIONS]);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Stable render callback for VirtualGameGrid
  const isPlayingNowRef = useRef(isPlayingNow);
  isPlayingNowRef.current = isPlayingNow;
  const renderGameCard = useCallback((game: Game) => {
    return (
      <GameCard
        game={game}
        onEdit={handleCardEdit}
        onDelete={handleCardDelete}
        isInLibrary={game.isInLibrary}
        isPlayingNow={isPlayingNowRef.current(game.steamAppId ?? game.id)}
        onAddToLibrary={handleCardAddToLibrary}
        onRemoveFromLibrary={handleCardRemoveFromLibrary}
        onStatusChange={handleCardStatusChange}
        hideLibraryBadge={isLibraryView}
        showTerminalPanel={false}
      />
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLibraryView, handleCardEdit, handleCardDelete, handleCardAddToLibrary, handleCardRemoveFromLibrary, handleCardStatusChange]);

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

  // Handle clearing entire library — two-step confirmation.
  // Step 1 closes itself immediately and opens step 2 after a brief delay
  // so the first dialog can animate out before the second appears.
  const handleClearLibraryStep1Confirm = useCallback(() => {
    setClearLibraryStep(0);
    setTimeout(() => setClearLibraryStep(2), 200);
  }, []);

  const handleClearLibraryFinalConfirm = useCallback(() => {
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
    setClearLibraryStep(0);
  }, [success, showError]);

  // Stable callbacks for dialog/panel open-change handlers.
  // Avoids creating new closures on every Dashboard render.
  const handleGameDialogChange = useCallback((open: boolean) => {
    setIsDialogOpen(open);
    if (!open) {
      setEditingGame(null);
      setEditInitialEntry(null);
    }
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
    filters.category !== 'trending' ||
    filters.store.length > 0),
  [searchQuery, filters.status, filters.priority, filters.genre, filters.platform, filters.category, filters.store.length]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'All' && viewMode === 'library') count++;
    if (filters.priority !== 'All' && viewMode === 'library') count++;
    if (filters.genre !== 'All') count++;
    if (filters.platform !== 'All') count++;
    if (filters.category !== 'trending' && viewMode === 'browse') count++;
    if (filters.store.length > 0) count++;
    return count;
  }, [filters.status, filters.priority, filters.genre, filters.platform, filters.category, filters.store.length, viewMode]);


  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="sticky top-0 z-40 drag-region bg-black/80 backdrop-blur-xl">
        <div className="px-3 lg:px-6 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 no-drag mt-[5px]">
              <div data-tour="app-logo" className="h-8 w-8 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
                <Gamepad2 className="h-4 w-4 text-white" />
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white tracking-wide" style={{ fontFamily: "'Sterion', sans-serif" }}>ARK</h1>
                <span className="text-xs text-white/50">v{APP_VERSION}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 no-drag">
              {devMode && (
                <TooltipCard content="The developer's build log — a day-by-day timeline of features, fixes, and decisions made while constructing the Ark.">
                  <Button
                    onClick={switchToDevLog}
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7 transition-all",
                      viewMode === 'devlog'
                        ? "text-fuchsia-400 bg-fuchsia-500/15 border border-fuchsia-500/30"
                        : "text-white/40 hover:text-fuchsia-400 hover:bg-fuchsia-500/10"
                    )}
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                  </Button>
                </TooltipCard>
              )}
              {devMode && (
                <TooltipCard content="Visualize how data flows through the Ark's internal systems — APIs, stores, caches, and service connections.">
                  <Button
                    onClick={switchToDataFlow}
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7 transition-all",
                      viewMode === 'data-flow'
                        ? "text-fuchsia-400 bg-fuchsia-500/15 border border-fuchsia-500/30"
                        : "text-white/40 hover:text-fuchsia-400 hover:bg-fuchsia-500/10"
                    )}
                  >
                    <Workflow className="h-3.5 w-3.5" />
                  </Button>
                </TooltipCard>
              )}
              {devMode && <NavbarStatusIndicator />}
              <WindowControls />
            </div>
          </div>
        </div>
      </header>

      <main className={cn(
        "px-3 lg:px-6 py-4 lg:py-6 transition-all duration-300 relative z-10",
        (isFilterOpen || (devMode && isAIChatOpen)) && "lg:pr-[424px]"
      )}>
        {/* Results Header */}
        <div className="flex items-center justify-between mb-6 gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-shrink overflow-hidden">
            {/* View Mode Toggle — collapses to icon-only below lg for split-screen */}
            <div data-tour="view-toggle" className="flex items-center bg-white/5 rounded-lg p-1 shrink-0">
              <TooltipCard content="Explore Steam's catalog of 150,000+ games. Filter by genre, platform, and popularity to discover your next favorite.">
                <button
                  data-tour="browse-button"
                  onClick={switchToBrowse}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'browse' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="swing" className="shrink-0"><Compass className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Browse</span>
                </button>
              </TooltipCard>
              <TooltipCard content={<span>Your personal collection of <strong className="text-white">{librarySize}</strong> games — track what you're playing, want to play, and have completed.</span>}>
                <button
                  data-tour="library-button"
                  onClick={switchToLibrary}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'library' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><Library className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Library ({librarySize})</span>
                </button>
              </TooltipCard>
              <TooltipCard content="AI-powered game recommendations tailored to your library. The Oracle learns what you like and suggests what to play next.">
                <button
                  data-tour="oracle-button"
                  onClick={switchToOracle}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'oracle' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><Eye className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Oracle</span>
                </button>
              </TooltipCard>
              <TooltipCard content="Upcoming game releases on a calendar view. Filter by platform, track your wishlist, and never miss a launch day.">
                <button
                  data-tour="calendar-button"
                  onClick={switchToCalendar}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'calendar' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><CalendarDays className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Releases</span>
                </button>
              </TooltipCard>
              <TooltipCard content="A visual timeline of your gaming journey — see when you added, played, and completed games across the months.">
                <button
                  data-tour="journey-button"
                  onClick={switchToJourney}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'journey' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><Clock className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Voyage</span>
                </button>
              </TooltipCard>
              <TooltipCard content="Live news signals from Steam, Reddit, and RSS feeds — decoded in the built-in reader. Events with live countdowns and stream links.">
                <button
                  data-tour="buzz-button"
                  onClick={switchToBuzz}
                  className={cn(
                    "px-2 lg:px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1",
                    viewMode === 'buzz' 
                      ? "bg-fuchsia-500 text-white" 
                      : "text-white/60 hover:text-white"
                  )}
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><Newspaper className="h-3 w-3" /></AnimateIcon>
                  <span className="hidden lg:inline">Transmissions</span>
                </button>
              </TooltipCard>
            </div>

            {/* Clear Library Button - only visible in library mode */}
            {viewMode === 'library' && librarySize > 0 && (
              <TooltipCard content={<span>Remove all <strong className="text-red-400">{librarySize}</strong> games from your library. This includes progress, notes, and custom entries. Cannot be undone.</span>}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setClearLibraryStep(1)}
                  className="h-7 text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20"
                >
                  <AnimateIcon hover="lift"><Trash2 className="h-3 w-3 lg:mr-1" /></AnimateIcon>
                  <span className="hidden lg:inline">Clear All</span>
                </Button>
              </TooltipCard>
            )}

            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && viewMode !== 'oracle' && viewMode !== 'devlog' && viewMode !== 'settings' && (
              <>
                <p className="text-sm text-white/60 items-center gap-1.5 whitespace-nowrap shrink-0 hidden lg:flex">
                  {viewMode === 'library' ? (
                    <><span className="text-white font-medium">{sortedGames.length.toLocaleString()}</span> games</>
                  ) : filters.category === 'catalog' ? (
                    /* Catalog A–Z: show the absolute full catalog count */
                    catalogTotalCount > 0 ? (
                      <><span className="text-white font-medium">{catalogTotalCount.toLocaleString()}</span> games</>
                    ) : (
                      /* Catalog count still loading — show spinner */
                      <span className="inline-flex items-center gap-1.5 text-white/50">
                        <svg className="h-3.5 w-3.5 animate-spin text-fuchsia-400 shrink-0" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span className="text-[11px] tabular-nums">Indexing catalog…</span>
                      </span>
                    )
                  ) : (
                    /* Other browse categories: "X games of {filter}" */
                    <>
                      <span className="text-white font-medium">
                        {sortedGames.length.toLocaleString()}
                      </span> games of <button onClick={openFilters} className="text-white/80 hover:text-fuchsia-400 transition-colors cursor-pointer underline decoration-white/20 hover:decoration-fuchsia-400/50 underline-offset-2">{{ trending: 'Top Sellers', 'most-played': 'Most Played', free: 'Free Games', recent: 'New Releases', 'award-winning': 'Coming Soon', catalog: 'Catalog', all: 'All' }[filters.category] ?? filters.category}</button>
                    </>
                  )}
                </p>
                {hasActiveFilters && (
                  <Badge 
                    variant="secondary" 
                    className="gap-1 px-1.5 bg-fuchsia-500/20 hover:bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30 cursor-pointer shrink-0"
                    onClick={openFilters}
                  >
                    <Filter className="h-3 w-3 pointer-events-none" />
                    {activeFilterCount}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        resetFilters();
                        setSearchQuery('');
                      }}
                      className="ml-0.5 rounded-full hover:bg-white/10 p-0.5 transition-colors"
                      aria-label="Clear all filters"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )}
              </>
            )}
          </div>
          
          <div className="flex items-center gap-3 shrink-0">
            {/* Search - hidden in journey, buzz, calendar, oracle, devlog, settings mode */}
            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && viewMode !== 'oracle' && viewMode !== 'devlog' && viewMode !== 'settings' && (
              <div data-tour="search-input" className="relative">
                <AnimateIcon hover="wiggle" className="absolute left-3 inset-y-0 z-10"><Search className="h-4 w-4 text-white/40" /></AnimateIcon>
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
                  className="w-44 lg:w-80 h-9 pl-10 pr-10 bg-white/5 border-white/10 text-white placeholder:text-white/40"
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
                        setNavigatingGame(game);
                        navigate(`/game/${encodeURIComponent(game.id)}`);
                      }
                    }}
                    onClose={() => setShowSuggestions(false)}
                    searchQuery={searchQuery}
                  />
                )}
              </div>
            )}

            {/* Enter Embedding Space Button (Live + Mock) */}
            {(() => {
              const noOllama = ollamaUnavailable && galaxyStage !== 'done';
              const liveDisabled = galaxyBuilding || noOllama;
              const galaxyReady = !liveDisabled;
              const label = noOllama
                ? 'Install Ollama to unlock'
                : galaxyBuilding
                  ? 'Processing Galaxy'
                  : 'Enter Embedding Space';
              return (
                <TooltipCard content={
                  noOllama
                    ? "Requires Ollama to generate game embeddings. Install it from Settings to unlock the Galaxy Map."
                    : galaxyBuilding
                      ? "The Galaxy Map is being computed — embedding your library games into a 3D similarity space. This runs once in the background."
                      : "Enter the Galaxy Map — a 3D visualization of game similarity powered by AI embeddings. Explore how your library games relate to each other."
                }>
                  <div className="flex items-center" data-tour="embedding-space">
                    {galaxyReady ? (
                      <MovingBorderButton
                        as="div"
                        borderRadius="0.5rem"
                        containerClassName="h-9 w-auto cursor-pointer"
                        borderClassName="from-fuchsia-500 via-purple-500/40 to-transparent"
                        className="bg-black/80 border border-fuchsia-500/20 px-3 gap-1.5"
                        duration={2500}
                        onClick={switchToAnnGraph}
                      >
                        <AnimateIcon hover="pulse"><Network className="h-4 w-4 text-fuchsia-400 pointer-events-none" /></AnimateIcon>
                        <span className="text-xs font-medium text-fuchsia-300 hidden lg:inline whitespace-nowrap">
                          {label}
                        </span>
                      </MovingBorderButton>
                    ) : (
                      <Button
                        onClick={switchToAnnGraph}
                        variant="ghost"
                        disabled
                        className="h-9 px-3 border rounded-lg transition-all gap-1.5 text-white/25 border-white/5 cursor-not-allowed"
                      >
                        <Network className={cn("h-4 w-4 opacity-40", galaxyBuilding && "animate-pulse")} />
                        <span className="text-xs font-medium hidden lg:inline">
                          {label}
                        </span>
                      </Button>
                    )}
                  </div>
                </TooltipCard>
              );
            })()}

            {/* Tour Help Button */}
            <TooltipCard content="Take a guided tour of the Ark's features. Great for first-time visitors or rediscovering hidden capabilities.">
              <MagneticWrap strength={0.25}>
                <Button
                  onClick={startTour}
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-white/70 hover:text-white hover:bg-cyan-500/20 border border-white/10 hover:border-cyan-500/50 transition-all"
                >
                  <AnimateIcon hover="wiggle"><HelpCircle className="h-4 w-4 text-cyan-400 pointer-events-none" /></AnimateIcon>
                </Button>
              </MagneticWrap>
            </TooltipCard>

            {/* AI Chat Button (dev mode only) */}
            {devMode && (
              <TooltipCard content="Chat with the AI Assistant — ask about games, get personalized recommendations, or explore your library data conversationally.">
                <MagneticWrap strength={0.25}>
                  <Button
                    data-tour="ai-chat"
                    onClick={toggleAIChat}
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-white/70 hover:text-white hover:bg-purple-500/20 border border-white/10 hover:border-purple-500/50 transition-all"
                  >
                    <AnimateIcon hover="sparkle"><Sparkles className="h-4 w-4 text-purple-400 pointer-events-none" /></AnimateIcon>
                  </Button>
                </MagneticWrap>
              </TooltipCard>
            )}

            {/* Add Custom Game Button - only show in library mode */}
            {viewMode === 'library' && (
              <TooltipCard content="Add a non-Steam game to your library — perfect for DRM-free, indie, or emulated titles. Track them alongside your Steam collection.">
                <Button
                  onClick={() => setIsCustomGameDialogOpen(true)}
                  className="h-9 bg-fuchsia-500 hover:bg-fuchsia-600 text-white gap-1.5"
                >
                  <AnimateIcon hover="pulse" className="shrink-0"><PlusCircle className="h-4 w-4 pointer-events-none" /></AnimateIcon>
                  <span className="hidden lg:inline">Add Custom Game</span>
                </Button>
              </TooltipCard>
            )}

            {/* Filter Button - hidden in journey, buzz, calendar, oracle, devlog, settings mode */}
            {viewMode !== 'journey' && viewMode !== 'buzz' && viewMode !== 'calendar' && viewMode !== 'oracle' && viewMode !== 'devlog' && viewMode !== 'settings' && (
              <FilterTrigger
                open={isFilterOpen}
                onToggle={() => handleFilterOpenChange(!isFilterOpen)}
                filters={filters}
                viewMode={viewMode}
              />
            )}

            {/* Settings Button */}
            <TooltipCard content="Adjust your Ark preferences — data sources, Ollama configuration, cache management, import/export, and appearance.">
              <Button
                data-tour="settings-button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-white/60 hover:text-amber-400 hover:bg-white/10"
                onClick={switchToSettings}
              aria-label="Settings"
              data-testid="settings-button"
            >
              <AnimateIcon hover="spin"><Settings className="h-4 w-4 pointer-events-none" /></AnimateIcon>
              </Button>
            </TooltipCard>
          </div>
        </div>

        {/* Journey View */}
        {viewMode === 'journey' ? (
          <JourneyView
            entries={journeyEntries}
            loading={libraryLoading}
            onSwitchToBrowse={switchToBrowse}
          />
        ) : viewMode === 'buzz' ? (
          <BuzzView />
        ) : viewMode === 'calendar' ? (
          <ReleaseCalendar />
        ) : viewMode === 'oracle' ? (
          <Suspense fallback={<LazyViewFallback />}>
            <OracleView onSwitchToBrowse={switchToBrowse} />
          </Suspense>
        ) : viewMode === 'devlog' ? (
          <Suspense fallback={<LazyViewFallback />}>
            <DevLogView onBack={switchToBrowse} />
          </Suspense>
        ) : viewMode === 'data-flow' ? (
          <Suspense fallback={<LazyViewFallback />}>
            <DataFlowView onBack={switchToBrowse} />
          </Suspense>
        ) : viewMode === 'settings' ? (
          <SettingsScreen onBack={switchToBrowse} />
        ) : viewMode === 'ann-graph' ? (
          <div key="ann-graph-shell" className="fixed inset-0 top-[52px] z-30 bg-black">
            <Suspense fallback={<LazyViewFallback />}>
              <AnnGraphView onBack={switchToOracle} />
            </Suspense>
          </div>
        ) : (
          <div data-tour="game-grid">
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
            ) : libraryGroups ? (
              /* ── Grouped Library (status sections) ──────────────── */
              <div className="space-y-2">
                {STATUS_SECTIONS.map(section => {
                  const games = libraryGroups[section.key];
                  if (!games || games.length === 0) return null;
                  const isCollapsed = collapsedSections.has(section.key);
                  const SectionIcon = section.icon;

                  return (
                    <div key={section.key}>
                      <button
                        type="button"
                        onClick={() => toggleSection(section.key)}
                        className="w-full flex items-center gap-2 py-2.5 px-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors cursor-pointer group"
                      >
                        <SectionIcon className={cn('w-3.5 h-3.5 flex-shrink-0', section.color)} />
                        <span className="text-sm font-semibold text-white/90 font-mono tracking-wide">// {section.label}</span>
                        <Badge variant="outline" className="text-[11px] px-2 py-0 h-5 border-white/20 text-white/50 font-mono tabular-nums">{games.length}</Badge>
                        <div className="flex-1" />
                        <ChevronDown className={cn(
                          'w-4 h-4 text-white/20 group-hover:text-white/40 transition-transform duration-200',
                          isCollapsed && '-rotate-90',
                        )} />
                      </button>

                      <AnimatePresence initial={false}>
                        {!isCollapsed && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div
                              className="pt-3 pb-1"
                              style={{
                                display: 'grid',
                                gridTemplateColumns: `repeat(${libColumns}, minmax(0, 1fr))`,
                                gap: '16px',
                              }}
                            >
                              {games.map(game => (
                                <div key={game.id} className="min-w-0">
                                  {renderGameCard(game)}
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            ) : (
              <VirtualGameGrid
                games={sortedGames}
                renderCard={renderGameCard}
                gap={16}
                footer={infiniteScrollSentinel}
              />
            )}
          </div>
        )}

      </main>

      {/* Game Dialog — Add or Edit library entry */}
      <GameDialog
        open={isDialogOpen}
        onOpenChange={handleGameDialogChange}
        game={editingGame}
        onSave={handleSave}
        genres={genres}
        platforms={platforms}
        initialEntry={editInitialEntry}
      />

      {/* Custom Game Dialog */}
      <CustomGameDialog
        open={isCustomGameDialogOpen}
        onOpenChange={setIsCustomGameDialogOpen}
        onSave={handleCustomGameSave}
      />

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

      {/* Clear Library — Step 1: Initial confirmation */}
      <ConfirmDialog
        open={clearLibraryStep === 1}
        onOpenChange={(open) => { if (!open) setClearLibraryStep(0); }}
        title="Clear Entire Library"
        description={`Are you sure you want to remove all ${librarySize} game${librarySize !== 1 ? 's' : ''} from your library? This action cannot be undone.`}
        confirmText="Yes, Continue"
        cancelText="Cancel"
        variant="warning"
        onConfirm={handleClearLibraryStep1Confirm}
      />

      {/* Clear Library — Step 2: Final confirmation */}
      <ConfirmDialog
        open={clearLibraryStep === 2}
        onOpenChange={(open) => { if (!open) setClearLibraryStep(0); }}
        title="This Cannot Be Undone"
        description={`You are about to permanently delete ${librarySize} game${librarySize !== 1 ? 's' : ''}, including all progress, ratings, and notes. Consider exporting your library from Settings first. Are you absolutely sure?`}
        confirmText="Delete Everything"
        cancelText="Go Back"
        variant="danger"
        onConfirm={handleClearLibraryFinalConfirm}
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
          <span className="text-sm">Syncing Global Catalog</span>
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
        dynamicGenres={dynamicGenres}
        dynamicPlatforms={dynamicPlatforms}
        dynamicYears={dynamicYears}
        catalogTotalCount={catalogTotalCount}
        sortBy={sortBy}
        setSortBy={setSortBy}
        sortDirection={sortDirection}
        toggleSortDirection={toggleSortDirection}
        viewMode={viewMode}
      />

      {/* AI Chat Panel (dev mode only) */}
      {devMode && (
        <AIChatPanel
          isOpen={isAIChatOpen}
          onClose={closeAIChat}
        />
      )}

      {/* Settings Screen is now a full-page view rendered via viewMode === 'settings' */}

      {/* Guided Tour */}
      <GuidedTour run={tourRunning} tourKey={tourKey} onFinish={stopTour} />

      {/* Year Wrapped */}
      <YearWrapped isOpen={showWrapped} onClose={() => setShowWrapped(false)} />
      <WrappedSnackbar onLaunch={() => setShowWrapped(true)} />

    </div>
  );
}
