import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { steamService } from '@/services/steam-service';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { Game, GameFilters, UpdateLibraryEntry, CreateCustomGameEntry, GameStatus } from '@/types/game';

type GameCategory = 'all' | 'most-played' | 'trending' | 'recent' | 'award-winning';

/**
 * Custom hook to manage Steam games with library integration
 * Supports category-based fetching with pagination
 * Default view: all games sorted by release date (newest first)
 */
export function useSteamGames(category: GameCategory = 'all') {
  const [allGames, setAllGames] = useState<Game[]>([]); // All fetched games
  const [displayCount, setDisplayCount] = useState(30); // Number of games to display
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  // Fetch games based on category
  const fetchGames = useCallback(async (cat: GameCategory) => {
    setLoading(true);
    setError(null);
    setDisplayCount(30); // Reset pagination on category change

    try {
      console.log(`[useSteamGames] Fetching ${cat} games...`);
      let fetchedGames: Game[];
      
      switch (cat) {
        case 'most-played':
          // Most played games sorted by player count (rank order)
          fetchedGames = await steamService.getMostPlayedGames(100);
          // Keep original rank order - don't sort by date
          console.log(`[useSteamGames] Fetched ${fetchedGames.length} most-played games (rank order)`);
          if (isMountedRef.current) {
            setAllGames(fetchedGames);
            setLoading(false);
          }
          return; // Early return to skip date sorting
        case 'trending':
          fetchedGames = await steamService.getTopSellers();
          break;
        case 'recent':
          fetchedGames = await steamService.getNewReleases();
          break;
        case 'award-winning':
          // "award-winning" is repurposed as "Coming Soon" for Steam
          fetchedGames = await steamService.getComingSoon();
          break;
        case 'all':
        default:
          // Fetch most played games and sort by release date for "All Games"
          fetchedGames = await steamService.getMostPlayedGames(100);
          break;
      }
      
      // Sort by release date (newest first) for categories other than most-played
      fetchedGames.sort((a, b) => {
        const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return dateB - dateA;
      });
      
      console.log(`[useSteamGames] Fetched and sorted ${fetchedGames.length} ${cat} games`);
      if (isMountedRef.current) setAllGames(fetchedGames);
    } catch (err) {
      console.error('[useSteamGames] Failed to fetch games:', err);
      if (isMountedRef.current) setError(err instanceof Error ? err.message : 'Failed to fetch games');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  // Fetch when category changes
  useEffect(() => {
    isMountedRef.current = true;
    fetchGames(category);
    return () => { isMountedRef.current = false; };
  }, [category, fetchGames]);

  // Subscribe to library changes to update game data
  useEffect(() => {
    return libraryStore.subscribe(() => {
      // Update library status on games without refetching
      setAllGames(prev => prev.map(game => {
        const libraryEntry = game.steamAppId ? libraryStore.getEntry(game.steamAppId) : undefined;
        return {
          ...game,
          isInLibrary: !!libraryEntry,
          status: libraryEntry?.status || game.status,
        };
      }));
    });
  }, []);

  // Pagination - games to display
  const games = useMemo(() => allGames.slice(0, displayCount), [allGames, displayCount]);
  const hasMore = displayCount < allGames.length;
  
  const loadMore = useCallback(() => {
    setDisplayCount(prev => Math.min(prev + 15, allGames.length));
  }, [allGames.length]);

  // Refresh
  const refresh = useCallback(() => {
    steamService.clearCache();
    fetchGames(category);
  }, [fetchGames, category]);

  return {
    games,
    loading,
    error,
    hasMore,
    loadMore,
    refresh,
  };
}

/**
 * Custom hook for new releases
 */
export function useNewReleases() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetch = async () => {
      setLoading(true);
      try {
        const releases = await steamService.getNewReleases();
        if (isMounted) setGames(releases);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to fetch new releases');
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetch();
    return () => { isMounted = false; };
  }, []);

  return { games, loading, error };
}

/**
 * Custom hook for top sellers
 */
export function useTopSellers() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetch = async () => {
      setLoading(true);
      try {
        const sellers = await steamService.getTopSellers();
        if (isMounted) setGames(sellers);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to fetch top sellers');
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetch();
    return () => { isMounted = false; };
  }, []);

  return { games, loading, error };
}

/**
 * Custom hook for coming soon games
 */
export function useComingSoon() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetch = async () => {
      setLoading(true);
      try {
        const comingSoon = await steamService.getComingSoon();
        if (isMounted) setGames(comingSoon);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to fetch coming soon games');
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetch();
    return () => { isMounted = false; };
  }, []);

  return { games, loading, error };
}

/**
 * Custom hook for searching Steam games
 */
export function useGameSearch(query: string, debounceMs: number = 300) {
  const [results, setResults] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const isSearching = query.trim().length > 0;

  useEffect(() => {
    isMountedRef.current = true;

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Debounce the search
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const searchResults = await steamService.searchGames(query, 20);
        if (isMountedRef.current) {
          setResults(searchResults);
          setError(null);
        }
      } catch (err) {
        console.error('Search error:', err);
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : 'Search failed');
          setResults([]);
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, debounceMs]);

  return {
    results,
    loading,
    error,
    isSearching,
  };
}

/**
 * Custom hook for managing the user's library
 */
export function useLibrary() {
  const [updateCount, setUpdateCount] = useState(0);
  const [customGamesUpdateCount, setCustomGamesUpdateCount] = useState(0);

  // Subscribe to library changes
  useEffect(() => {
    const unsubscribe = libraryStore.subscribe(() => setUpdateCount((c) => c + 1));
    return unsubscribe;
  }, []);

  // Subscribe to custom game changes
  useEffect(() => {
    const unsubscribe = customGameStore.subscribe(() => setCustomGamesUpdateCount((c) => c + 1));
    return unsubscribe;
  }, []);

  // Get custom games as Game objects
  const customGames = useMemo(() => {
    return customGameStore.getAllAsGames();
  }, [customGamesUpdateCount]);

  const addToLibrary = useCallback((input: { gameId: number; steamAppId?: number; status?: GameStatus; priority?: 'High' | 'Medium' | 'Low' } | number, status: GameStatus = 'Want to Play') => {
    // Support both object and legacy number-based API
    if (typeof input === 'number') {
      return libraryStore.addToLibrary({
        gameId: input,
        steamAppId: input,
        status,
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
      });
    }
    return libraryStore.addToLibrary({
      gameId: input.gameId,
      steamAppId: input.steamAppId || input.gameId,
      status: input.status || 'Want to Play',
      priority: input.priority || 'Medium',
      publicReviews: '',
      recommendationSource: '',
    });
  }, []);

  const removeFromLibrary = useCallback((gameId: number) => {
    return libraryStore.removeFromLibrary(gameId);
  }, []);

  const updateEntry = useCallback((gameId: number, input: UpdateLibraryEntry) => {
    return libraryStore.updateEntry(gameId, input);
  }, []);

  const isInLibrary = useCallback((gameId: number) => {
    return libraryStore.isInLibrary(gameId);
  }, [updateCount]);

  const addCustomGame = useCallback((input: CreateCustomGameEntry) => {
    return customGameStore.addGame(input);
  }, []);

  const removeCustomGame = useCallback((id: number) => {
    return customGameStore.removeGame(id);
  }, []);

  const getAllGameIds = useCallback(() => {
    return libraryStore.getAllGameIds();
  }, []);

  const getAllEntries = useCallback(() => {
    return libraryStore.getAllEntries();
  }, [updateCount]);

  return {
    addToLibrary,
    removeFromLibrary,
    updateEntry,
    isInLibrary,
    librarySize: libraryStore.getSize() + customGameStore.getCount(),
    addCustomGame,
    removeCustomGame,
    customGames,
    getAllGameIds,
    getAllEntries,
  };
}

/**
 * Custom hook for getting library games with full details
 */
export function useLibraryGames() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateCount, setUpdateCount] = useState(0);

  // Subscribe to library changes
  useEffect(() => {
    return libraryStore.subscribe(() => setUpdateCount((c) => c + 1));
  }, []);

  // Fetch library game details
  useEffect(() => {
    let isMounted = true;

    const fetchLibraryGames = async () => {
      const gameIds = libraryStore.getAllGameIds();
      if (gameIds.length === 0) {
        if (isMounted) setGames([]);
        return;
      }

      if (isMounted) {
        setLoading(true);
        setError(null);
      }

      try {
        const gamePromises = gameIds.map(async (id) => {
          const game = await steamService.getGameDetails(id);
          return game;
        });

        const results = await Promise.all(gamePromises);
        if (isMounted) {
          const validGames = results.filter((g): g is Game => g !== null);
          setGames(validGames);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to fetch library games');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchLibraryGames();
    return () => { isMounted = false; };
  }, [updateCount]);

  return { games, loading, error };
}

/**
 * Custom hook for getting game details
 */
export function useGameDetails(steamAppId: number | null) {
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!steamAppId) {
      setGame(null);
      return;
    }

    let isMounted = true;

    const fetch = async () => {
      setLoading(true);
      setError(null);

      try {
        const details = await steamService.getGameDetails(steamAppId);
        if (isMounted) setGame(details);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to fetch game details');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetch();
    return () => { isMounted = false; };
  }, [steamAppId]);

  return { game, loading, error };
}

/**
 * Custom hook for genres and platforms (Steam-specific)
 */
export function useSteamFilters() {
  const [genres, setGenres] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const fetch = async () => {
      try {
        const [genreList, platformList] = await Promise.all([
          steamService.getGenres(),
          steamService.getPlatforms(),
        ]);
        if (isMounted) {
          setGenres(genreList);
          setPlatforms(platformList);
        }
      } catch (err) {
        console.error('Failed to fetch filters:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetch();
    return () => { isMounted = false; };
  }, []);

  return { genres, platforms, loading };
}

/**
 * Custom hook for managing game filters
 */
export function useFilteredGames(initialFilters?: Partial<GameFilters>) {
  const [filters, setFilters] = useState<GameFilters>({
    search: '',
    status: 'All',
    genre: 'All',
    platform: 'All',
    category: 'all',
    releaseYear: 'All',
    ...initialFilters,
  });

  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const debounceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (debounceTimeout.current) {
      clearTimeout(debounceTimeout.current);
    }

    debounceTimeout.current = setTimeout(() => {
      setDebouncedSearch(filters.search);
    }, 300);

    return () => {
      if (debounceTimeout.current) {
        clearTimeout(debounceTimeout.current);
      }
    };
  }, [filters.search]);

  const updateFilter = useCallback(<K extends keyof GameFilters>(key: K, value: GameFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({
      search: '',
      status: 'All',
      genre: 'All',
      platform: 'All',
      category: 'all',
      releaseYear: 'All',
    });
  }, []);

  const hasActiveFilters = useMemo(() => {
    return (
      filters.status !== 'All' ||
      filters.genre !== 'All' ||
      filters.platform !== 'All' ||
      filters.releaseYear !== 'All' ||
      filters.category !== 'all'
    );
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'All') count++;
    if (filters.genre !== 'All') count++;
    if (filters.platform !== 'All') count++;
    if (filters.releaseYear !== 'All') count++;
    if (filters.category !== 'all') count++;
    return count;
  }, [filters]);

  return {
    filters: { ...filters, search: debouncedSearch },
    rawSearch: filters.search,
    updateFilter,
    resetFilters,
    hasActiveFilters,
    activeFilterCount,
    setFilters,
  };
}

/**
 * Custom hook for debouncing a value
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Legacy exports for backwards compatibility
export const useIGDBGames = useSteamGames;
export const useIGDBFilters = useSteamFilters;

// Dummy hook for rate limit warning (Steam has less strict limits)
export function useRateLimitWarning(_callback: (queueSize: number) => void) {
  // Steam API has less strict rate limiting, so this is mostly a no-op
  useEffect(() => {
    // No action needed for Steam
  }, []);
}
