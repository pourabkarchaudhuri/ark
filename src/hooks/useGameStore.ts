import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { steamService, hasValidDeveloperInfo } from '@/services/steam-service';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { customGameStore } from '@/services/custom-game-store';
import { Game, GameFilters, UpdateLibraryEntry, CreateCustomGameEntry, GameStatus } from '@/types/game';

type GameCategory = 'all' | 'most-played' | 'trending' | 'recent' | 'award-winning';

const GENRE_TERMS = ['action', 'rpg', 'indie', 'adventure', 'simulation', 'strategy'];

/**
 * Custom hook to manage Steam games with library integration
 * Supports category-based fetching with pagination
 * Default view: all games sorted by release date (newest first)
 */
export function useSteamGames(category: GameCategory = 'all') {
  const [allGames, setAllGames] = useState<Game[]>([]); // All fetched games
  const [displayCount, setDisplayCount] = useState(30); // Number of games to display
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const genreSearchIndexRef = useRef(0);
  const allGamesRef = useRef<Game[]>([]);
  allGamesRef.current = allGames;

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
          // Fetch up to 500 games (Steam Charts typically provides 100-300)
          fetchedGames = await steamService.getMostPlayedGames(500);
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
        default: {
          // Merge four sources for fast initial load; more games load on demand when user scrolls to end
          const [mostPlayed, newReleases, topSellers, comingSoon] = await Promise.all([
            steamService.getMostPlayedGames(500),
            steamService.getNewReleases(),
            steamService.getTopSellers(),
            steamService.getComingSoon(),
          ]);
          const byAppId = new Map<number, Game>();
          const addGames = (list: Game[]) => {
            for (const g of list) {
              if (g.steamAppId && !byAppId.has(g.steamAppId)) byAppId.set(g.steamAppId, g);
            }
          };
          addGames(mostPlayed);
          addGames(newReleases);
          addGames(topSellers);
          addGames(comingSoon);
          fetchedGames = Array.from(byAppId.values());
          console.log(`[useSteamGames] All Games: merged ${mostPlayed.length}+${newReleases.length}+${topSellers.length}+${comingSoon.length} -> ${fetchedGames.length} unique games`);
          break;
        }
      }
      
      // Sort by release date (newest first) for categories other than most-played
      fetchedGames.sort((a, b) => {
        const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return dateB - dateA;
      });
      
      console.log(`[useSteamGames] Fetched and sorted ${fetchedGames.length} ${cat} games`);
      if (isMountedRef.current) {
        setAllGames(fetchedGames);
        // Show all initially-fetched games immediately — no artificial cap
        setDisplayCount(fetchedGames.length);
      }
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

  // Once games are loaded, fetch real-time player counts in the background.
  // Counts come from ISteamUserStats/GetNumberOfCurrentPlayers — the same API
  // used by the game-details page — so dashboard and details always agree.
  // We accumulate all counts first, then apply a single state update to avoid
  // triggering N/BATCH_SIZE separate re-renders.
  useEffect(() => {
    if (loading || allGames.length === 0) return;

    let cancelled = false;
    const BATCH_SIZE = 20;

    const fetchLiveCounts = async () => {
      const steamIds = allGames
        .map(g => g.steamAppId)
        .filter((id): id is number => id !== undefined && id !== null);

      if (steamIds.length === 0) return;

      const allCounts: Record<number, number> = {};

      for (let i = 0; i < steamIds.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = steamIds.slice(i, i + BATCH_SIZE);
        try {
          const counts = await steamService.getMultiplePlayerCounts(batch);
          if (cancelled) return;
          Object.assign(allCounts, counts);
        } catch {
          // Non-critical — skip this batch
        }
      }

      if (!cancelled && Object.keys(allCounts).length > 0) {
        setAllGames(prev =>
          prev.map(game => {
            if (game.steamAppId && allCounts[game.steamAppId] !== undefined) {
              return { ...game, playerCount: allCounts[game.steamAppId] };
            }
            return game;
          })
        );
      }
    };

    fetchLiveCounts();
    return () => { cancelled = true; };
  // Only run once per load, not on every allGames mutation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

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

  // Lazy append for "All Games" when user scrolls to end (grows pool on demand)
  const appendMoreGamesForAll = useCallback(async (): Promise<number | undefined> => {
    if (category !== 'all' || loadingMore) return undefined;
    setLoadingMore(true);
    try {
      const searchTerm = GENRE_TERMS[genreSearchIndexRef.current % GENRE_TERMS.length];
      genreSearchIndexRef.current += 1;
      const newGames = await steamService.searchGames(searchTerm, 50);
      if (!isMountedRef.current) return undefined;
      const prev = allGamesRef.current;
      // Use steamAppId if available, else fall back to game id to avoid
      // dropping custom games that lack steamAppId (the old `!` assertion silently
      // collapsed all undefined-keyed games into a single Map entry).
      const byId = new Map(prev.map(g => [g.steamAppId ?? g.id, g] as const));
      for (const g of newGames) {
        const key = g.steamAppId ?? g.id;
        if (key && !byId.has(key)) byId.set(key, g);
      }
      const merged = Array.from(byId.values());
      merged.sort((a, b) => {
        const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return dateB - dateA;
      });
      if (isMountedRef.current) setAllGames(merged);
      return merged.length;
    } catch (err) {
      console.error('[useSteamGames] appendMoreGamesForAll failed:', err);
      return undefined;
    } finally {
      if (isMountedRef.current) setLoadingMore(false);
    }
  }, [category, loadingMore]);

  // Pagination - games to display
  const games = useMemo(() => allGames.slice(0, displayCount), [allGames, displayCount]);
  const hasMore = displayCount < allGames.length;

  const loadMore = useCallback(async () => {
    if (category === 'all' && displayCount >= allGames.length - 15 && !loadingMore) {
      const newLength = await appendMoreGamesForAll();
      if (newLength !== undefined) {
        setDisplayCount(prev => Math.min(prev + 15, newLength));
        return;
      }
    }
    setDisplayCount(prev => Math.min(prev + 15, allGames.length));
  }, [allGames.length, category, displayCount, loadingMore, appendMoreGamesForAll]);

  // Refresh
  const refresh = useCallback(() => {
    steamService.clearCache();
    genreSearchIndexRef.current = 0;
    fetchGames(category);
  }, [fetchGames, category]);

  return {
    games,
    loading,
    loadingMore,
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
 * Custom hook for searching Steam games.
 * Uses a request counter to avoid stale responses overwriting newer results.
 */
export function useGameSearch(query: string, debounceMs: number = 300) {
  const [results, setResults] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonically increasing counter — only the latest request may write state
  const requestIdRef = useRef(0);

  const isSearching = query.trim().length > 0;

  useEffect(() => {
    // Cancel any pending debounce from the previous query
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    // Capture a unique id for THIS search request
    const currentId = ++requestIdRef.current;

    debounceRef.current = setTimeout(async () => {
      try {
        console.log(`[useGameSearch] Searching for "${query}" (request #${currentId})`);
        const searchResults = await steamService.searchGames(query, 20);
        // Only apply results if this is still the latest request
        if (currentId === requestIdRef.current) {
          console.log(`[useGameSearch] Got ${searchResults.length} results for "${query}"`);
          setResults(searchResults);
          setError(null);
          setLoading(false);
        } else {
          console.log(`[useGameSearch] Discarding stale results for "${query}" (request #${currentId}, latest #${requestIdRef.current})`);
        }
      } catch (err) {
        console.error('[useGameSearch] Search error:', err);
        if (currentId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : 'Search failed');
          setResults([]);
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
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
          const withDetails = results.filter((g): g is Game => g !== null);
          // Do not show cards for games without developer/publisher (e.g. FiveM)
          const validGames = withDetails.filter(hasValidDeveloperInfo);

          // Fetch real-time player counts for all library games in one batch
          const steamIds = validGames
            .map(g => g.steamAppId)
            .filter((id): id is number => id !== undefined && id !== null);

          const playerCounts = await steamService.getMultiplePlayerCounts(steamIds);

          // Attach player counts to each game
          const gamesWithCounts = validGames.map(game => {
            if (game.steamAppId && playerCounts[game.steamAppId]) {
              return { ...game, playerCount: playerCounts[game.steamAppId] };
            }
            return game;
          });

          setGames(gamesWithCounts);

          // Seed journey history with full game metadata
          for (const game of gamesWithCounts) {
            const id = game.steamAppId;
            if (!id) continue;
            const libEntry = libraryStore.getEntry(id);
            journeyStore.record({
              gameId: id,
              title: game.title,
              coverUrl: game.coverUrl,
              genre: game.genre ?? [],
              platform: game.platform ?? [],
              releaseDate: game.releaseDate,
              status: game.status,
              hoursPlayed: libEntry?.hoursPlayed ?? 0,
              rating: libEntry?.rating ?? 0,
              addedAt: libEntry?.addedAt
                ? new Date(libEntry.addedAt).toISOString()
                : game.createdAt
                  ? new Date(game.createdAt).toISOString()
                  : undefined,
            });
          }
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
 * Custom hook for reading journey history.
 * Returns all journey entries (persisted even after library removal).
 */
export function useJourneyHistory() {
  const [entries, setEntries] = useState(journeyStore.getAllEntries());

  useEffect(() => {
    // Refresh on any journey store change
    return journeyStore.subscribe(() => {
      setEntries(journeyStore.getAllEntries());
    });
  }, []);

  return entries;
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
    priority: 'All',
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
      priority: 'All',
      genre: 'All',
      platform: 'All',
      category: 'all',
      releaseYear: 'All',
    });
  }, []);

  const hasActiveFilters = useMemo(() => {
    return (
      filters.status !== 'All' ||
      filters.priority !== 'All' ||
      filters.genre !== 'All' ||
      filters.platform !== 'All' ||
      filters.releaseYear !== 'All' ||
      filters.category !== 'all'
    );
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'All') count++;
    if (filters.priority !== 'All') count++;
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

