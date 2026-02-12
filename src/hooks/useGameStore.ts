import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { steamService } from '@/services/steam-service';
import { epicService } from '@/services/epic-service';
import { gameService } from '@/services/game-service';
import { dedupSortInWorker } from '@/workers/use-dedup-worker';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { customGameStore } from '@/services/custom-game-store';
import {
  getPrefetchedGames,
  setPrefetchedGames,
  clearBrowseCache,
  searchPrefetchedGames,
} from '@/services/prefetch-store';
import { Game, GameFilters, GameCategory, UpdateLibraryEntry, CreateCustomGameEntry, GameStatus, CachedGameMeta } from '@/types/game';
import { SteamAppListItem } from '@/types/steam';
import { detailEnricher } from '@/services/detail-enricher';
import {
  getCachedCatalog,
  setCachedCatalog,
  isCatalogStale,
  clearCatalogCache,
  sortCatalogAZ,
} from '@/services/catalog-cache';

/** Unused — kept for reference. Individual appdetails calls removed in favor of lightweight catalog cards. */
// const CATALOG_CHUNK_SIZE = 50;

// ---------------------------------------------------------------------------
// Module-level background refresh throttle
// ---------------------------------------------------------------------------
// Persists across hook re-mounts (tab switches) and even app restarts via
// localStorage.  This ensures the full browse library is NOT re-fetched on
// every tab switch or app start — only once per BG_REFRESH_INTERVAL_MS.

const BG_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BG_REFRESH_LS_KEY = 'ark-bg-refresh-ts';

let _lastBgRefreshMs: number =
  parseInt(localStorage.getItem(BG_REFRESH_LS_KEY) || '0', 10) || 0;
let _bgRefreshRunning = false;
let _catalogPreloaded = false; // catalog app-list only needs one load per session

// ---------------------------------------------------------------------------
// Smart catalog loader — IndexedDB cache → API → persist
// ---------------------------------------------------------------------------
// In-memory copy so subsequent reads within the same session are instant.
let _catalogMemCache: SteamAppListItem[] | null = null;
// Whether the in-memory cache has been sorted A-Z.  The preload stores
// unsorted data (fast); sorting is deferred until catalog mode is opened.
let _catalogMemCacheSorted = false;

/**
 * Load the Steam app list with a tiered strategy:
 *   1. In-memory cache (instant, survives tab switches)
 *   2. IndexedDB cache (fast, survives app restarts, checked for staleness)
 *   3. API fetch (slow, re-persists to IndexedDB + memory)
 *
 * Options:
 *   - `forceRefresh`: skip caches and fetch from API.
 *   - `sorted`: sort the list A-Z by title before returning.  This uses the
 *     fast `sortCatalogAZ` (~300ms for 155K items) instead of localeCompare
 *     (~5-10s).  Only pass `true` when catalog A-Z mode actually needs it;
 *     the background preload should NOT sort.
 */
async function loadCatalogAppList(opts?: { forceRefresh?: boolean; sorted?: boolean }): Promise<SteamAppListItem[]> {
  const forceRefresh = opts?.forceRefresh ?? false;
  const needsSorted = opts?.sorted ?? false;

  // 1. In-memory (session-level)
  if (!forceRefresh && _catalogMemCache && _catalogMemCache.length > 0) {
    if (needsSorted && !_catalogMemCacheSorted) {
      sortCatalogAZ(_catalogMemCache);
      _catalogMemCacheSorted = true;
    }
    return _catalogMemCache;
  }

  // 2. IndexedDB (persistent, check staleness)
  if (!forceRefresh) {
    const stale = await isCatalogStale();
    if (!stale) {
      const cached = await getCachedCatalog();
      if (cached.length > 0) {
        if (needsSorted) {
          sortCatalogAZ(cached);
        }
        _catalogMemCache = cached;
        _catalogMemCacheSorted = needsSorted;
        console.log(`[CatalogLoader] Loaded ${cached.length} apps from IndexedDB cache`);
        return cached;
      }
    }
  }

  // 3. Fresh fetch from Steam API
  console.log('[CatalogLoader] Fetching fresh catalog from Steam API...');
  const appList = await steamService.getAppList();
  if (needsSorted) {
    sortCatalogAZ(appList);
  }
  _catalogMemCache = appList;
  _catalogMemCacheSorted = needsSorted;

  // Persist in background (don't block the caller)
  setCachedCatalog(appList).catch(err =>
    console.warn('[CatalogLoader] Background persist failed:', err)
  );

  return appList;
}

function shouldBackgroundRefresh(): boolean {
  if (_bgRefreshRunning) return false;
  return Date.now() - _lastBgRefreshMs > BG_REFRESH_INTERVAL_MS;
}

function markBackgroundRefreshDone(): void {
  _lastBgRefreshMs = Date.now();
  _bgRefreshRunning = false;
  try {
    localStorage.setItem(BG_REFRESH_LS_KEY, String(_lastBgRefreshMs));
  } catch {
    /* localStorage quota — non-critical */
  }
}

/** Extract essential display metadata from a Game for offline caching in the library. */
export function extractCachedMeta(game: Game): CachedGameMeta {
  return {
    title: game.title,
    store: game.store,
    coverUrl: game.coverUrl,
    headerImage: game.headerImage,
    developer: game.developer,
    publisher: game.publisher,
    genre: game.genre,
    platform: game.platform,
    releaseDate: game.releaseDate,
    metacriticScore: game.metacriticScore,
    summary: game.summary,
    epicSlug: game.epicSlug,
    epicNamespace: game.epicNamespace,
    epicOfferId: game.epicOfferId,
    steamAppId: game.steamAppId,
  };
}

/**
 * Custom hook to manage Steam games with library integration
 * Supports category-based fetching with pagination
 * Default view: all games sorted by release date (newest first)
 * 'catalog' category: continuous A–Z browsing via GetAppList + chunked details
 */
export function useSteamGames(category: GameCategory = 'trending') {
  // If prefetched data is available (loaded during splash), initialize instantly
  // to eliminate the 1-2s blank/skeleton flash on dashboard mount.
  const [allGames, setAllGames] = useState<Game[]>(() => {
    if (category === 'trending' || category === 'all') {
      const prefetched = getPrefetchedGames();
      if (prefetched && prefetched.length > 0) return prefetched;
    }
    return [];
  });
  // Start with a small batch to keep the first render fast (<50ms), then
  // expand to the full dataset after the first paint via useEffect below.
  // Processing 6000+ games in useMemo (enrichment, filtering, dynamic filters,
  // sorting) on the very first render frame freezes the UI for several seconds.
  const INITIAL_DISPLAY_BATCH = 120;
  const [displayCount, setDisplayCount] = useState(() => {
    if (category === 'trending' || category === 'all') {
      const prefetched = getPrefetchedGames();
      if (prefetched && prefetched.length > 0) return Math.min(prefetched.length, INITIAL_DISPLAY_BATCH);
    }
    return 30;
  });
  const [loading, setLoading] = useState(() => {
    // Skip loading state if we already have data
    if (category === 'trending' || category === 'all') {
      const prefetched = getPrefetchedGames();
      if (prefetched && prefetched.length > 0) return false;
    }
    return false;
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const initialFetchDoneRef = useRef(false);
  const genreSearchIndexRef = useRef(0);
  const bgRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const allGamesRef = useRef<Game[]>([]);
  allGamesRef.current = allGames;

  // --- Catalog-specific state ---
  // Full sorted app list (kept in ref, not state, to avoid huge re-renders)
  const catalogAppListRef = useRef<SteamAppListItem[]>([]);
  // How far we've consumed into the catalog list (next index to fetch details for)
  const catalogOffsetRef = useRef(0);
  // Whether we've finished loading the full app list
  const catalogListReadyRef = useRef(false);
  // Current catalog letter (for jump-to-letter)
  const [catalogLetter, setCatalogLetter] = useState<string | null>(null);
  // Mirror in a ref so closures always see the latest value
  const catalogLetterRef = useRef<string | null>(null);
  useEffect(() => { catalogLetterRef.current = catalogLetter; }, [catalogLetter]);
  // Whether there are more catalog entries to fetch (state-based to trigger re-renders)
  const [catalogHasMore, setCatalogHasMore] = useState(false);

  // --- Detail enrichment (ref-based to avoid re-sorting the grid) ---
  // Enrichment data lives in a ref so writing to it does NOT trigger the
  // allGames → displayedGames → sortedGames cascade. Only the visible
  // `games` slice merges it at read-time when the epoch bumps.
  const enrichmentMapRef = useRef<Map<string, Partial<Game>>>(new Map());
  // Player counts stored out-of-band to avoid re-mapping 6000+ games
  const playerCountMapRef = useRef<Map<number, number>>(new Map());
  const [enrichmentEpoch, setEnrichmentEpoch] = useState(0);

  /**
   * Load a page of catalog games from the pre-fetched app list.
   *
   * Instead of calling the slow `appdetails` API for every single game
   * (which triggers Steam rate-limiting after ~200 requests), we build
   * lightweight Game objects directly from the app list.  The GameCard
   * component already constructs CDN image URLs from the steamAppId
   * (`library_600x900.jpg`, `header.jpg`, etc.) so images load fine
   * without an appdetails call.  Full details are loaded on-demand when
   * the user opens a game's detail page.
   */
  const CATALOG_PAGE_SIZE = 100;

  const fetchCatalogChunk = useCallback((isInitial: boolean): number => {
    const appList = catalogAppListRef.current;
    let offset = catalogOffsetRef.current;
    if (offset >= appList.length) return 0;

    const chunk = appList.slice(offset, offset + CATALOG_PAGE_SIZE);
    offset += chunk.length;

    const games: Game[] = chunk.map(app => ({
      id: `steam-${app.appid}`,
      store: 'steam' as const,
      steamAppId: app.appid,
      title: app.name,
      developer: '',
      publisher: '',
      genre: [],
      platform: [],
      metacriticScore: null,
      releaseDate: '',
      status: 'Want to Play' as const,
      priority: 'Medium' as const,
      publicReviews: '',
      recommendationSource: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (games.length > 0 && isMountedRef.current) {
      if (isInitial && allGamesRef.current.length === 0) {
        setAllGames(games);
        setDisplayCount(games.length);
      } else {
        setAllGames(prev => {
          const existing = new Set(prev.map(g => g.steamAppId));
          const newGames = games.filter(g => !existing.has(g.steamAppId));
          return [...prev, ...newGames];
        });
        setDisplayCount(prev => prev + games.length);
      }
    }

    catalogOffsetRef.current = offset;
    setCatalogHasMore(offset < appList.length);
    return games.length;
  }, []);

  // Fetch games based on category
  const fetchGames = useCallback(async (cat: GameCategory) => {
    // Catalog mode has its own flow
    if (cat === 'catalog') {
      setLoading(true);
      setError(null);
      setAllGames([]);
      setDisplayCount(0);
      catalogOffsetRef.current = 0;

      try {
        // Fast path: reuse the background-preloaded app list if available
        let appList = catalogListReadyRef.current
          ? catalogAppListRef.current
          : null;

        if (!appList || appList.length === 0) {
          catalogListReadyRef.current = false;
          console.log('[useSteamGames] Loading catalog app list...');
          appList = await loadCatalogAppList({ sorted: true });
          catalogAppListRef.current = appList;
          catalogListReadyRef.current = true;
          setCatalogTotalCount(appList.length);
          console.log(`[useSteamGames] Catalog ready: ${appList.length} apps`);
        } else {
          // Ensure the preloaded list is sorted (preload doesn't sort)
          if (!_catalogMemCacheSorted) {
            sortCatalogAZ(appList);
            _catalogMemCacheSorted = true;
          }
          console.log(`[useSteamGames] Catalog: reusing preloaded ${appList.length} apps`);
        }

        // If a letter was already set, jump there
        if (catalogLetterRef.current) {
          const lowerLetter = catalogLetterRef.current.toLowerCase();
          const idx = appList.findIndex(a => a.name.toLowerCase() >= lowerLetter);
          catalogOffsetRef.current = idx >= 0 ? idx : 0;
        }

        // Load first page (synchronous — no API calls)
        fetchCatalogChunk(true);
      } catch (err) {
        console.error('[useSteamGames] Failed to load catalog:', err);
        if (isMountedRef.current) setError(err instanceof Error ? err.message : 'Failed to load catalog');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
      return;
    }

    // Fast path: if prefetched data was already loaded into initial state
    // (via useState initializer), skip the fetch entirely on first mount.
    // This eliminates the 1-2s blank/skeleton flash on dashboard open.
    if (
      (cat === 'trending' || cat === 'all') &&
      allGamesRef.current.length > 0 &&
      !initialFetchDoneRef.current
    ) {
      initialFetchDoneRef.current = true;
      console.log(`[useSteamGames] Skipping fetch — ${allGamesRef.current.length} games already in initial state`);
      return;
    }
    initialFetchDoneRef.current = true;

    setLoading(true);
    setError(null);
    // Don't reset displayCount to a tiny number — it will be set to the full
    // dataset size once fetching completes. Setting it low here only matters
    // briefly during the loading state, so 0 is safe (no stale items shown).
    setDisplayCount(0);
    // Reset catalog refs when leaving catalog
    catalogAppListRef.current = [];
    catalogOffsetRef.current = 0;
    catalogListReadyRef.current = false;
    setCatalogLetter(null);
    setCatalogHasMore(false);
    setCatalogTotalCount(0);
    allCatalogActiveRef.current = false;
    enrichmentMapRef.current.clear();
    setEnrichmentEpoch(0);
    detailEnricher.reset();

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
            setDisplayCount(fetchedGames.length);
            setLoading(false);
          }
          return; // Early return to skip date sorting
        case 'trending': {
          // Use prefetched data if available (already contains top sellers + epic catalog).
          // This avoids 3 redundant API calls on dashboard mount.
          const prefetchedForTrending = getPrefetchedGames();
          if (prefetchedForTrending && prefetchedForTrending.length > 0) {
            fetchedGames = prefetchedForTrending;
            console.log(`[useSteamGames] Trending: using ${prefetchedForTrending.length} pre-fetched games (instant)`);
          } else {
            fetchedGames = await gameService.getTopSellers();
          }
          break;
        }
        case 'recent':
          fetchedGames = await gameService.getNewReleases();
          break;
        case 'award-winning':
          // "award-winning" is repurposed as "Coming Soon" — fetch from both stores
          fetchedGames = await gameService.getComingSoon();
          break;
        case 'free':
          // Free games from Epic (Steam doesn't have a dedicated free-games endpoint)
          fetchedGames = await epicService.getFreeGames().catch(() => [] as Game[]);
          console.log(`[useSteamGames] Fetched ${fetchedGames.length} free games from Epic`);
          break;
        case 'all':
        default: {
          // ---- Step 1: Use pre-fetched / cached data (instant — no API calls) ----
          const prefetched = getPrefetchedGames();
          if (prefetched && prefetched.length > 0) {
            fetchedGames = prefetched;
            console.log(`[useSteamGames] Using ${prefetched.length} pre-fetched games (instant, no API calls)`);
          } else {
            // Fallback: loading screen didn't prefetch (edge case / error).
            // Do a full fetch now — same logic as prefetch-store.
            console.warn('[useSteamGames] No pre-fetched data — fetching now (slow path)');
            setIsSyncing(true);
            const [mostPlayed, newReleases, topSellers, comingSoon, epicCatalog, epicFreeGames] = await Promise.all([
              steamService.getMostPlayedGames(500),
              steamService.getNewReleases(),
              steamService.getTopSellers(),
              steamService.getComingSoon(),
              epicService.browseCatalog(0).catch(() => [] as Game[]),
              epicService.getFreeGames().catch(() => [] as Game[]),
            ]);

            const allRawGames: Game[] = [
              ...mostPlayed, ...newReleases, ...topSellers, ...comingSoon,
              ...epicCatalog, ...epicFreeGames,
            ];
            fetchedGames = await dedupSortInWorker(allRawGames);
            // Cache for next time
            setPrefetchedGames(fetchedGames);
            markBackgroundRefreshDone(); // count this as a full refresh
            if (isMountedRef.current) setIsSyncing(false);
            console.log(`[useSteamGames] Fetched and deduped: ${fetchedGames.length} games`);
          }

          // ---- Step 2: Background catalog preload for infinite scroll ----
          // Uses tiered cache: memory → IndexedDB → API (only if stale/missing).
          if (!_catalogPreloaded) {
            _catalogPreloaded = true;
            const catalogPromise = loadCatalogAppList().then(appList => {
              if (isMountedRef.current) {
                catalogAppListRef.current = appList;
                catalogListReadyRef.current = true;
                catalogOffsetRef.current = 0;
                setCatalogTotalCount(appList.length);
                console.log(`[useSteamGames] Background catalog preload: ${appList.length} apps ready`);
              }
            }).catch(err => {
              _catalogPreloaded = false; // allow retry on next mount
              console.warn('[useSteamGames] Background catalog preload failed:', err);
            });
            void catalogPromise;
          } else if (catalogListReadyRef.current) {
            // Already loaded in memory from a previous mount — nothing to do.
          }

          // ---- Step 3: Throttled background refresh (module-level guard) ----
          // Only fires if more than BG_REFRESH_INTERVAL_MS (1 hour) has
          // elapsed since the last refresh. Survives tab switches (module
          // scope) and app restarts (localStorage).  No refresh on every
          // mount — the user sees cached data instantly.
          if (prefetched && prefetched.length > 0 && shouldBackgroundRefresh()) {
            bgRefreshTimerRef.current = setTimeout(() => {
              bgRefreshTimerRef.current = null;
              if (!isMountedRef.current || _bgRefreshRunning) return;
              _bgRefreshRunning = true;
              if (isMountedRef.current) setIsSyncing(true);

              Promise.all([
                steamService.getMostPlayedGames(500),
                steamService.getNewReleases(),
                steamService.getTopSellers(),
                steamService.getComingSoon(),
                // Re-use existing Epic-originating data from the prefetch store
                // instead of re-fetching the full catalog (saves ~60+ seconds
                // of API calls).  Include both Epic-primary games AND cross-store
                // games that the dedup worker merged into Steam entries — those
                // have store:'steam' but availableOn includes 'epic'.  Without
                // this, the refresh silently drops hundreds of catalog games.
                Promise.resolve(
                  getPrefetchedGames()?.filter(g =>
                    g.store === 'epic' || g.availableOn?.includes('epic')
                  ) ?? []
                ),
                epicService.getFreeGames().catch(() => [] as Game[]),
              ]).then(async ([mp, nr, ts, cs, ec, ef]) => {
                if (!isMountedRef.current) return;
                const raw: Game[] = [...mp, ...nr, ...ts, ...cs, ...ec, ...ef];
                // Offload dedup + sort to Web Worker
                const fresh = await dedupSortInWorker(raw);

                if (!isMountedRef.current) return;

                // Safety net: if the refresh produced significantly fewer games
                // than the current set, a data source probably failed silently.
                // Skip the swap to avoid the user seeing games disappear.
                const currentCount = allGamesRef.current.length;
                if (currentCount > 0 && fresh.length < currentCount * 0.9) {
                  console.warn(
                    `[useSteamGames] Background refresh dropped from ${currentCount} to ${fresh.length} games — skipping swap to prevent data loss`
                  );
                  return;
                }

                // Atomic swap — single setState call, no intermediate renders
                setAllGames(fresh);
                // Expose full refreshed dataset — virtual grid only renders visible items
                setDisplayCount(fresh.length);
                setPrefetchedGames(fresh);
                console.log(`[useSteamGames] Background refresh complete: ${fresh.length} games (atomic swap)`);
              }).catch(err => {
                console.warn('[useSteamGames] Background refresh failed:', err);
              }).finally(() => {
                markBackgroundRefreshDone();
                if (isMountedRef.current) setIsSyncing(false);
              });
            }, 10_000); // 10s delay — let the UI settle before refreshing
          }

          break;
        }
      }
      
      // Pre-compute numeric release timestamps + sort by release date (newest first)
      for (const g of fetchedGames) {
        (g as any)._releaseTs = g.releaseDate ? new Date(g.releaseDate).getTime() : 0;
      }
      fetchedGames.sort((a, b) => ((b as any)._releaseTs ?? 0) - ((a as any)._releaseTs ?? 0));
      
      console.log(`[useSteamGames] Fetched and sorted ${fetchedGames.length} ${cat} games`);
      if (isMountedRef.current) {
        setAllGames(fetchedGames);
        // Expose the full dataset to the dashboard — the virtual grid only renders
        // visible cards (~40), so there's no rendering cost.  Capping to a small
        // number (e.g. 100) breaks store/genre/year filters that run AFTER the
        // slice, causing most filtered results to be silently truncated.
        setDisplayCount(fetchedGames.length);
      }
    } catch (err) {
      console.error('[useSteamGames] Failed to fetch games:', err);
      if (isMountedRef.current) setError(err instanceof Error ? err.message : 'Failed to fetch games');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchCatalogChunk]);

  // Fetch when category changes
  useEffect(() => {
    isMountedRef.current = true;
    fetchGames(category);
    return () => {
      isMountedRef.current = false;
      // Cancel pending background refresh to prevent state updates after unmount
      if (bgRefreshTimerRef.current) {
        clearTimeout(bgRefreshTimerRef.current);
        bgRefreshTimerRef.current = null;
      }
    };
  }, [category, fetchGames]);

  // After the first paint, expand displayCount to the full dataset so filters
  // and scroll work over the complete list.  The heavy filter/sort computation
  // in the dashboard is already deferred (useDeferredFilterSort), so this
  // expansion only costs the enrichment useMemo (which is identity-stable
  // for most games).  Using rAF ensures the initial 120-item render is
  // painted before we trigger the enrichment pass for the full dataset.
  useEffect(() => {
    if (allGames.length > displayCount) {
      const id = requestAnimationFrame(() => {
        if (isMountedRef.current) {
          setDisplayCount(allGames.length);
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [allGames.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Background catalog count — fires once per session regardless of category.
  // Loads the full Steam app list (cached 24h on disk) just to get the count
  // for the "X of 155K" display in the toolbar.  Also primes the list for
  // when the user switches to Catalog (A–Z) mode.
  useEffect(() => {
    if (_catalogPreloaded || catalogTotalCount > 0) return;
    _catalogPreloaded = true;
    loadCatalogAppList().then(appList => {
      if (isMountedRef.current) {
        catalogAppListRef.current = appList;
        catalogListReadyRef.current = true;
        catalogOffsetRef.current = 0;
        setCatalogTotalCount(appList.length);
        console.log(`[useSteamGames] Background catalog count: ${appList.length} games`);
      }
    }).catch(err => {
      _catalogPreloaded = false;
      console.warn('[useSteamGames] Background catalog count failed:', err);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Periodic catalog staleness check ─────────────────────────────────────
  // Every 30 minutes while the app is open, check if the catalog cache is
  // older than 6 hours.  If so, silently re-sync in the background so the
  // user always has a fresh list available.
  useEffect(() => {
    const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min

    const checkAndRefresh = async () => {
      try {
        const stale = await isCatalogStale();
        if (!stale) return;
        console.log('[useSteamGames] Catalog cache is stale, refreshing in background...');
        const appList = await loadCatalogAppList({ forceRefresh: true }); // force API fetch, no sort needed
        if (isMountedRef.current) {
          catalogAppListRef.current = appList;
          catalogListReadyRef.current = true;
          setCatalogTotalCount(appList.length);
          console.log(`[useSteamGames] Background catalog refresh complete: ${appList.length} apps`);
        }
      } catch (err) {
        console.warn('[useSteamGames] Periodic catalog refresh failed:', err);
      }
    };

    const intervalId = setInterval(checkAndRefresh, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jump-to-letter for catalog mode (synchronous — no API calls).
  // Builds the first page of games directly and replaces allGames in a single
  // setState call.  This avoids the append-vs-replace ambiguity of calling
  // fetchCatalogChunk after setAllGames([]) (the ref check inside the chunk
  // loader can't see the pending [] because React hasn't rendered yet).
  const jumpToLetter = useCallback((letter: string) => {
    if (category !== 'catalog' || !catalogListReadyRef.current) return;
    setCatalogLetter(letter);

    const lowerLetter = letter.toLowerCase();
    const appList = catalogAppListRef.current;
    const idx = appList.findIndex(a => a.name.toLowerCase() >= lowerLetter);
    const startOffset = idx >= 0 ? idx : 0;

    // Slice the first page from the new starting position
    const chunk = appList.slice(startOffset, startOffset + CATALOG_PAGE_SIZE);
    const newOffset = startOffset + chunk.length;

    const games: Game[] = chunk.map(app => ({
      id: `steam-${app.appid}`,
      store: 'steam' as const,
      steamAppId: app.appid,
      title: app.name,
      developer: '',
      publisher: '',
      genre: [],
      platform: [],
      metacriticScore: null,
      releaseDate: '',
      status: 'Want to Play' as const,
      priority: 'Medium' as const,
      publicReviews: '',
      recommendationSource: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // Direct replacement — single setState, no batching ambiguity
    catalogOffsetRef.current = newOffset;
    allGamesRef.current = games;          // keep ref in sync immediately
    setAllGames(games);
    setDisplayCount(games.length);
    setCatalogHasMore(newOffset < appList.length);
  }, [category]);

  // Once games are loaded, fetch real-time player counts in the background.
  // Counts come from ISteamUserStats/GetNumberOfCurrentPlayers (Steam API).
  // NOTE: Epic Games Store does not expose player count data, so only Steam
  // games (including multi-store games with a Steam ID) receive live counts.
  // We accumulate all counts first, then apply a single state update to avoid
  // Player counts: fetch only for the first ~100 visible Steam IDs and store
  // out-of-band in a ref. A single enrichmentEpoch bump causes the `games`
  // useMemo to re-merge, re-rendering only the ~40 visible virtual cards.
  useEffect(() => {
    if (loading || allGames.length === 0) return;

    let cancelled = false;
    const BATCH_SIZE = 20;

    const fetchLiveCounts = async () => {
      // Only fetch for the visible/capped range — not all 6000+
      const steamIds = allGames
        .slice(0, Math.min(displayCount, 100))
        .map(g => g.steamAppId)
        .filter((id): id is number => id !== undefined && id !== null);

      if (steamIds.length === 0) return;

      for (let i = 0; i < steamIds.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = steamIds.slice(i, i + BATCH_SIZE);
        try {
          const counts = await steamService.getMultiplePlayerCounts(batch);
          if (cancelled) return;
          for (const [idStr, count] of Object.entries(counts)) {
            playerCountMapRef.current.set(Number(idStr), count);
          }
        } catch {
          // Non-critical — skip this batch
        }
      }

      // Single epoch bump → games useMemo re-merges visible player counts
      if (!cancelled && playerCountMapRef.current.size > 0) {
        setEnrichmentEpoch(e => e + 1);
      }
    };

    fetchLiveCounts();
    return () => { cancelled = true; };
  // Only run once per load, not on every allGames mutation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Subscribe to library changes — bump enrichment epoch so the `games` useMemo
  // re-merges library status for the visible slice only (not all 6000).
  useEffect(() => {
    return libraryStore.subscribe(() => {
      setEnrichmentEpoch(e => e + 1);
    });
  }, []);

  // Whether the "All" view has switched to catalog-backed loading
  const allCatalogActiveRef = useRef(false);

  // Load catalog app list for "All" mode fallback (called once when curated set runs out)
  const loadCatalogForAllMode = useCallback(async () => {
    if (catalogListReadyRef.current) return; // Already loaded
    console.log('[useSteamGames] Loading catalog app list for All Games infinite scroll...');
    const appList = await loadCatalogAppList({ sorted: true });
    if (!isMountedRef.current) return;
    catalogAppListRef.current = appList;
    catalogListReadyRef.current = true;
    catalogOffsetRef.current = 0;
    setCatalogTotalCount(appList.length);
    console.log(`[useSteamGames] Catalog ready for All Games (${appList.length} apps)`);
  }, []);

  // Pagination + enrichment — merges player-counts, detail enrichment, and
  // library status into the game objects at read-time.
  //
  // **Stability optimisation**: returns the SAME array reference if no game
  // actually changed.  This prevents the dashboard's deferred filter/sort
  // hook from re-scheduling heavy computation on every enrichmentEpoch bump
  // that only touched a handful of games (or none at all).
  const prevGamesRef = useRef<Game[]>([]);
  const games = useMemo(() => {
    const slice = allGames.slice(0, displayCount);
    let anyDiff = slice.length !== prevGamesRef.current.length;

    const result = slice.map((game, idx) => {
      // Determine what enrichment data is available
      const enrichment = enrichmentMapRef.current.get(game.id);
      const pc = game.steamAppId ? playerCountMapRef.current.get(game.steamAppId) : undefined;
      const libraryEntry = libraryStore.getEntry(game.id);

      // Fast path: nothing to merge — return the original object
      if (!enrichment && pc === undefined && !libraryEntry) {
        if (!anyDiff && game !== prevGamesRef.current[idx]) anyDiff = true;
        return game;
      }

      // Merge enrichment data
      let merged = game;
      if (enrichment) merged = { ...merged, ...enrichment };
      if (pc !== undefined) merged = { ...merged, playerCount: pc, playerCountSource: 'steam' as const };
      if (libraryEntry) {
        merged = { ...merged, isInLibrary: true, status: libraryEntry.status || merged.status };
      }

      // Mark as different (merged objects are always new references)
      anyDiff = true;
      return merged;
    });

    // If nothing changed, return the previous reference to avoid downstream cascading
    if (!anyDiff) return prevGamesRef.current;
    prevGamesRef.current = result;
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames, displayCount, enrichmentEpoch]);
  // "all" mode: always has more games (catalog has 155k+)
  const hasMore = category === 'catalog'
    ? catalogHasMore
    : category === 'all'
      ? (allCatalogActiveRef.current ? catalogHasMore : true)
      : displayCount < allGames.length;

  const loadMore = useCallback(async () => {
    // Catalog mode: load next page from the pre-fetched app list (synchronous)
    if (category === 'catalog') {
      if (!catalogListReadyRef.current) return;
      fetchCatalogChunk(false);
      return;
    }

    // "All" mode — once user reaches the end of the curated set, switch to
    // catalog-backed infinite scroll. The catalog app list is preloaded in the
    // background during the initial fetch, so it's usually ready by now.
    if (category === 'all' && displayCount >= allGames.length - 50) {
      // Still have regular pagination room → just bump displayCount
      if (displayCount < allGames.length) {
        setDisplayCount(prev => Math.min(prev + 50, allGames.length));
        return;
      }

      // Curated set is exhausted — switch to catalog
      if (catalogListReadyRef.current) {
        allCatalogActiveRef.current = true;
        fetchCatalogChunk(false);
        setCatalogHasMore(catalogOffsetRef.current < catalogAppListRef.current.length);
        return;
      }

      // Catalog still loading in background — wait for it
      if (!loadingMore) {
        setLoadingMore(true);
        try {
          await loadCatalogForAllMode();
          if (isMountedRef.current) {
            allCatalogActiveRef.current = true;
            fetchCatalogChunk(false);
            setCatalogHasMore(catalogOffsetRef.current < catalogAppListRef.current.length);
          }
        } catch (err) {
          console.error('[useSteamGames] Failed to load catalog for All mode:', err);
        } finally {
          if (isMountedRef.current) setLoadingMore(false);
        }
      }
      return;
    }

    setDisplayCount(prev => Math.min(prev + 50, allGames.length));
  }, [allGames.length, category, displayCount, loadingMore, fetchCatalogChunk, loadCatalogForAllMode]);

  // Refresh
  const refresh = useCallback(() => {
    gameService.clearCache();
    clearBrowseCache(); // Clear the prefetch IndexedDB cache too
    clearCatalogCache(); // Clear the persistent catalog cache so it re-fetches fresh
    _catalogMemCache = null; // Wipe in-memory catalog copy
    detailEnricher.reset();
    enrichmentMapRef.current.clear();
    setEnrichmentEpoch(0);
    genreSearchIndexRef.current = 0;
    catalogAppListRef.current = [];
    catalogOffsetRef.current = 0;
    catalogListReadyRef.current = false;
    allCatalogActiveRef.current = false;
    _catalogPreloaded = false;
    // Reset the module-level refresh guard so manual refresh forces a re-fetch
    _lastBgRefreshMs = 0;
    _bgRefreshRunning = false;
    try { localStorage.removeItem(BG_REFRESH_LS_KEY); } catch { /* ignore */ }
    fetchGames(category);
  }, [fetchGames, category]);

  // --- Detail enrichment for lightweight catalog cards ---
  // Write enrichment data into a ref (NOT state) so the allGames array stays
  // unchanged.  This avoids triggering the sort/filter cascade that causes
  // scroll jumps.  A simple epoch counter triggers one re-render to merge
  // the enrichment data into the visible `games` slice.
  const MAX_ENRICHMENT_MAP_SIZE = 2_000;
  const enrichGames = useCallback((enrichments: Map<string, Partial<Game>>) => {
    if (enrichments.size === 0) return;
    const map = enrichmentMapRef.current;
    for (const [id, data] of enrichments) {
      map.set(id, data);
    }
    // Evict oldest entries when the map grows too large (prevents memory bloat
    // during long catalog browsing sessions).
    if (map.size > MAX_ENRICHMENT_MAP_SIZE) {
      const excess = map.size - MAX_ENRICHMENT_MAP_SIZE;
      let removed = 0;
      for (const key of map.keys()) {
        if (removed >= excess) break;
        map.delete(key);
        removed++;
      }
    }
    setEnrichmentEpoch(prev => prev + 1);
  }, []);

  // Total game count — tracks the full catalog size once it's loaded.
  // Updated explicitly when the catalog finishes loading (ref → state bridge).
  const [catalogTotalCount, setCatalogTotalCount] = useState(0);

  const totalCount = useMemo(() => {
    if ((category === 'catalog' || category === 'all') && catalogTotalCount > 0) {
      return catalogTotalCount;
    }
    return allGames.length;
  }, [category, allGames.length, catalogTotalCount]);

  return {
    games,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    refresh,
    totalCount,
    // Full Steam catalog count (~155K) — loaded in background for display purposes
    catalogTotalCount,
    // Sync state — true while background refresh is in progress
    isSyncing,
    // Catalog-specific
    catalogLetter,
    jumpToLetter,
    // Detail enrichment
    enrichGames,
    allGamesRef,
    enrichmentMapRef,
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
        const releases = await gameService.getNewReleases();
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
        const comingSoon = await gameService.getComingSoon();
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
 * Custom hook for searching games.
 * Searches in-memory prefetched data first (instant) and falls back to API
 * calls only if the in-memory search yields no results.
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
        // 1. Instant in-memory search from prefetched data
        const memResults = searchPrefetchedGames(query, 20);
        if (memResults && memResults.length > 0) {
          if (currentId === requestIdRef.current) {
            setResults(memResults);
            setError(null);
            setLoading(false);
          }
          // If we got good in-memory results, no need for API calls
          if (memResults.length >= 5) return;
        }

        // 2. Supplement with API search for broader coverage
        const apiResults = await gameService.searchGames(query, 20);
        if (currentId !== requestIdRef.current) return;

        if (memResults && memResults.length > 0) {
          // Merge: in-memory results first, then API results not already present
          const seenIds = new Set(memResults.map(g => g.id));
          const extra = apiResults.filter(g => !seenIds.has(g.id));
          setResults([...memResults, ...extra].slice(0, 30));
        } else {
          setResults(apiResults);
        }
        setError(null);
        setLoading(false);
      } catch (err) {
        console.error('[useGameSearch] Search error:', err);
        if (currentId === requestIdRef.current) {
          // If we already had in-memory results, keep showing them
          const memFallback = searchPrefetchedGames(query, 20);
          if (memFallback && memFallback.length > 0) {
            setResults(memFallback);
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : 'Search failed');
            setResults([]);
          }
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

  const addToLibrary = useCallback((
    input: { gameId: string; steamAppId?: number; status?: GameStatus; priority?: 'High' | 'Medium' | 'Low'; cachedMeta?: CachedGameMeta } | string,
    statusOrMeta: GameStatus | CachedGameMeta = 'Want to Play',
    metaArg?: CachedGameMeta,
  ) => {
    // Support both object and legacy string-based API
    if (typeof input === 'string') {
      // Legacy: addToLibrary(gameId, status?, cachedMeta?)
      const status: GameStatus = typeof statusOrMeta === 'string' ? statusOrMeta : 'Want to Play';
      const meta: CachedGameMeta | undefined = typeof statusOrMeta === 'object' ? statusOrMeta : metaArg;
      return libraryStore.addToLibrary({
        gameId: input,
        status,
        priority: 'Medium',
        publicReviews: '',
        recommendationSource: '',
        cachedMeta: meta,
      });
    }
    return libraryStore.addToLibrary({
      gameId: input.gameId,
      steamAppId: input.steamAppId,
      status: input.status || 'Want to Play',
      priority: input.priority || 'Medium',
      publicReviews: '',
      recommendationSource: '',
      cachedMeta: input.cachedMeta,
    });
  }, []);

  const removeFromLibrary = useCallback((gameId: string) => {
    return libraryStore.removeFromLibrary(gameId);
  }, []);

  const updateEntry = useCallback((gameId: string, input: UpdateLibraryEntry) => {
    return libraryStore.updateEntry(gameId, input);
  }, []);

  // isInLibrary reads directly from the store (synchronous) — no need
  // to depend on updateCount, which was causing the callback and all its
  // downstream dependents (handleStatusChange, handleSave) to be recreated
  // on every library change.
  const isInLibrary = useCallback((gameId: string) => {
    return libraryStore.isInLibrary(gameId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addCustomGame = useCallback((input: CreateCustomGameEntry) => {
    return customGameStore.addGame(input);
  }, []);

  const removeCustomGame = useCallback((id: string) => {
    return customGameStore.removeGame(id);
  }, []);

  const getAllGameIds = useCallback(() => {
    return libraryStore.getAllGameIds();
  }, []);

  const getAllEntries = useCallback(() => {
    return libraryStore.getAllEntries();
  }, [updateCount]);

  // Memoize librarySize — only recalculate when library or custom games change
  const librarySize = useMemo(
    () => libraryStore.getSize() + customGameStore.getCount(),
    [updateCount, customGamesUpdateCount]
  );

  return {
    addToLibrary,
    removeFromLibrary,
    updateEntry,
    isInLibrary,
    librarySize,
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
  // Cache of previously fetched game details — keyed by gameId.
  // On subsequent library changes we only fetch NEW games and reuse
  // existing data for unchanged ones (avoids N IPC calls per change).
  const gameDetailsCacheRef = useRef<Map<string, Game>>(new Map());

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
        if (isMounted) { setGames([]); gameDetailsCacheRef.current.clear(); }
        return;
      }

      // Diff: only fetch details for game IDs we haven't seen before.
      // For existing games, update library-specific fields (status, priority)
      // without an API call.
      const cache = gameDetailsCacheRef.current;
      const newIds = gameIds.filter(id => !cache.has(id));
      const isInitialLoad = cache.size === 0;

      if (isMounted && isInitialLoad) {
        setLoading(true);
        setError(null);
      }

      try {
        // Fetch details only for NEW library games (routes to correct store automatically).
        // If the API is unreachable (e.g. Epic/Cloudflare), fall back to cached
        // metadata stored in the library entry at add-time.
        const gamePromises = newIds.map(async (id) => {
          const game = await gameService.getGameDetails(id);
          if (game) return game;

          // API returned null — reconstruct from local stores so the game
          // is never silently lost from the library view.
          const entry = libraryStore.getEntry(id);
          if (!entry) return null; // orphan ID — shouldn't happen

          // Fallback 1: cachedMeta (stored at add-time, richest data)
          if (entry.cachedMeta) {
            const meta = entry.cachedMeta;
            return {
              id,
              store: meta.store,
              steamAppId: meta.steamAppId,
              epicNamespace: meta.epicNamespace,
              epicOfferId: meta.epicOfferId,
              title: meta.title,
              developer: meta.developer || 'Unknown',
              publisher: meta.publisher || '',
              genre: meta.genre || [],
              platform: meta.platform || [],
              metacriticScore: meta.metacriticScore ?? null,
              releaseDate: meta.releaseDate || '',
              summary: meta.summary,
              coverUrl: meta.coverUrl,
              headerImage: meta.headerImage,
              epicSlug: meta.epicSlug,
              status: entry.status,
              priority: entry.priority,
              publicReviews: entry.publicReviews,
              recommendationSource: entry.recommendationSource,
              createdAt: entry.addedAt,
              updatedAt: entry.updatedAt,
            } as Game;
          }

          // Fallback 2: Journey store (persists title + coverUrl from first add)
          const journeyEntry = journeyStore.getEntry(id);
          if (journeyEntry) {
            const store: 'steam' | 'epic' | 'custom' | undefined =
              id.startsWith('epic-') ? 'epic' : id.startsWith('steam-') ? 'steam' : undefined;
            return {
              id,
              store,
              title: journeyEntry.title,
              developer: 'Unknown',
              publisher: '',
              genre: journeyEntry.genre || [],
              platform: journeyEntry.platform || [],
              metacriticScore: null,
              releaseDate: journeyEntry.releaseDate || '',
              coverUrl: journeyEntry.coverUrl,
              status: entry.status,
              priority: entry.priority,
              publicReviews: entry.publicReviews,
              recommendationSource: entry.recommendationSource,
              createdAt: entry.addedAt,
              updatedAt: entry.updatedAt,
            } as Game;
          }

          // Fallback 3: bare-minimum placeholder from the gameId itself
          // The game card will be sparse but the game won't vanish.
          const store: 'steam' | 'epic' | 'custom' | undefined =
            id.startsWith('epic-') ? 'epic' : id.startsWith('steam-') ? 'steam' : undefined;
          return {
            id,
            store,
            title: id.replace(/^(epic-|steam-)/, '').replace(/:/g, ' — '),
            developer: 'Unknown',
            publisher: '',
            genre: [],
            platform: [],
            metacriticScore: null,
            releaseDate: '',
            status: entry.status,
            priority: entry.priority,
            publicReviews: entry.publicReviews,
            recommendationSource: entry.recommendationSource,
            createdAt: entry.addedAt,
            updatedAt: entry.updatedAt,
          } as Game;
        });

        const results = await Promise.all(gamePromises);
        if (isMounted) {
          // Store newly fetched games in the detail cache
          const newGames = results.filter((g): g is Game => g !== null);
          for (const g of newGames) cache.set(g.id, g);

          // Remove games no longer in library from the cache
          const currentIdSet = new Set(gameIds);
          for (const key of cache.keys()) {
            if (!currentIdSet.has(key)) cache.delete(key);
          }

          // Build final list: use cached data + refresh library-specific fields
          const validGames: Game[] = [];
          for (const id of gameIds) {
            const cached = cache.get(id);
            if (!cached) continue;
            // Refresh mutable library fields without an API call
            const entry = libraryStore.getEntry(id);
            if (entry) {
              validGames.push({ ...cached, status: entry.status, priority: entry.priority, isInLibrary: true });
            } else {
              validGames.push(cached);
            }
          }

          // Fetch real-time player counts only for NEW Steam games (skip already-counted)
          const newSteamIds = newGames
            .map(g => g.steamAppId)
            .filter((id): id is number => id !== undefined && id !== null);

          if (newSteamIds.length > 0) {
            const playerCounts = await steamService.getMultiplePlayerCounts(newSteamIds);
            // Attach counts to the matching games
            for (let i = 0; i < validGames.length; i++) {
              const g = validGames[i];
              if (g.steamAppId && playerCounts[g.steamAppId]) {
                validGames[i] = { ...g, playerCount: playerCounts[g.steamAppId] };
              }
            }
          }

          setGames(validGames);

          // Backfill cachedMeta for existing library entries that lack it
          // (gradual migration so entries become resilient to API outages).
          for (const game of newGames) {
            const entry = libraryStore.getEntry(game.id);
            if (entry && !entry.cachedMeta && game.title) {
              libraryStore.updateEntry(game.id, { cachedMeta: extractCachedMeta(game) });
            }
          }

          // Seed journey history with full game metadata (only for new games)
          for (const game of newGames) {
            const libEntry = libraryStore.getEntry(game.id);
            journeyStore.record({
              gameId: game.id,
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

          // Backfill journey entries with missing coverUrl — patches older
          // entries that were saved before the image URL was available.
          for (const game of validGames) {
            if (!game.coverUrl) continue;
            const jEntry = journeyStore.getEntry(game.id);
            if (jEntry && !jEntry.coverUrl) {
              journeyStore.record({
                gameId: jEntry.gameId,
                title: jEntry.title,
                coverUrl: game.coverUrl,
                genre: jEntry.genre,
                platform: jEntry.platform,
                releaseDate: jEntry.releaseDate,
                status: jEntry.status,
                hoursPlayed: jEntry.hoursPlayed,
                rating: jEntry.rating,
                addedAt: jEntry.addedAt,
              });
            }
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
export function useGameDetails(gameId: string | null) {
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) {
      setGame(null);
      return;
    }

    let isMounted = true;

    const fetchDetails = async () => {
      setLoading(true);
      setError(null);

      try {
        const details = await gameService.getGameDetails(gameId);
        if (isMounted) setGame(details);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to fetch game details');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchDetails();
    return () => { isMounted = false; };
  }, [gameId]);

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
    category: 'trending',
    releaseYear: 'All',
    store: [],
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
      category: 'trending',
      releaseYear: 'All',
      store: [],
    });
  }, []);

  const hasActiveFilters = useMemo(() => {
    return (
      filters.status !== 'All' ||
      filters.priority !== 'All' ||
      filters.genre !== 'All' ||
      filters.platform !== 'All' ||
      filters.releaseYear !== 'All' ||
      filters.category !== 'trending' ||
      filters.store.length > 0
    );
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'All') count++;
    if (filters.priority !== 'All') count++;
    if (filters.genre !== 'All') count++;
    if (filters.platform !== 'All') count++;
    if (filters.releaseYear !== 'All') count++;
    if (filters.category !== 'trending') count++;
    if (filters.store.length > 0) count++;
    return count;
  }, [filters]);

  // IMPORTANT: Memoize the merged filters object so downstream useMemo consumers
  // (displayedGames, sortedGames in Dashboard) don't recalculate on every render.
  // Without this, `{ ...filters, search: debouncedSearch }` creates a new object
  // reference every render, defeating all dependent memos.
  const mergedFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch]
  );

  return {
    filters: mergedFilters,
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

