/**
 * useDeferredFilterSort — Moves heavy filter/sort/dynamic-filter computation
 * off the React render phase and into an asynchronous effect.
 *
 * **Why this exists:**
 * Processing 6000+ games through 4 sequential useMemos (filter → dynamic
 * filter options → sort → cascade resets) blocks the main thread for
 * ~200-400ms per render cycle.  React StrictMode doubles that.  Combined
 * with cascading re-renders from enrichment epoch bumps, player count
 * arrivals, and catalog count updates, the dashboard freezes for 1-2s on
 * mount.
 *
 * **How it works:**
 * 1. The first render uses whatever data is available (empty or stale) so
 *    the browser can paint immediately.
 * 2. After paint, `requestAnimationFrame` schedules the heavy computation.
 * 3. The result is applied via `startTransition` so React treats the
 *    resulting re-render as low-priority (interruptible).
 * 4. If inputs change while a computation is in-flight, it's cancelled and
 *    a new one is scheduled.
 */

import { useState, useEffect, useLayoutEffect, useRef, startTransition } from 'react';
import type { Game, GameFilters } from '@/types/game';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterSortInput {
  currentGames: Game[];
  searchResults: Game[];
  isSearching: boolean;
  viewMode: string;
  searchQuery: string;
  filters: GameFilters;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
}

export interface FilterSortOutput {
  displayedGames: Game[];
  sortedGames: Game[];
  dynamicGenres: string[];
  dynamicPlatforms: string[];
  dynamicYears: string[];
}

const EMPTY_OUTPUT: FilterSortOutput = {
  displayedGames: [],
  sortedGames: [],
  dynamicGenres: [],
  dynamicPlatforms: [],
  dynamicYears: [],
};

// ---------------------------------------------------------------------------
// Pure computation (runs off the render phase)
// ---------------------------------------------------------------------------

function computeAll(input: FilterSortInput): FilterSortOutput {
  const { currentGames, searchResults, isSearching, viewMode, searchQuery, filters, sortBy, sortDirection } = input;

  // ── 1. displayedGames ────────────────────────────────────────────────
  let games: Game[];
  let skipBrowseFilters = false;

  if (viewMode === 'library') {
    let libraryGames = currentGames;
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
    games = searchResults;
    skipBrowseFilters = true;
  } else {
    games = currentGames;
  }

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
          const year = game.releaseDate.slice(0, 4);
          if (year !== filters.releaseYear) return false;
        }
        if (storeSet) {
          const isBothStores = storeSet.has('steam') && storeSet.has('epic');
          if (isBothStores) {
            const hasBothAvailable = game.availableOn
              && game.availableOn.includes('steam')
              && game.availableOn.includes('epic');
            const hasBothIds = !!game.steamAppId && !!(game.epicSlug || game.epicNamespace);
            if (!hasBothAvailable && !hasBothIds) return false;
          } else {
            const directMatch = game.store && storeSet.has(game.store);
            const availMatch = game.availableOn?.some(s => storeSet.has(s));
            const inferredMatch = !directMatch && !availMatch
              ? (game.id.startsWith('steam-') && storeSet.has('steam')) ||
                (game.id.startsWith('epic-') && storeSet.has('epic'))
              : false;
            if (!directMatch && !availMatch && !inferredMatch) return false;
          }
        }
        if (hideSentinel && game.comingSoon && game.releaseDate === 'Coming Soon') return false;
        if (hideSentinel && filters.category !== 'award-winning' && game.releaseDate) {
          const y = game.releaseDate.slice(0, 4);
          if (y >= '2099') return false;
        }
        return true;
      });
    }
  }

  const displayedGames = games;

  // ── 2. Dynamic filter options (cascading) ────────────────────────────
  let baseGames: Game[];
  let skipDynamic = false;

  if (viewMode === 'library') {
    let lib = currentGames;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      lib = lib.filter(g =>
        g.title.toLowerCase().includes(query) ||
        g.developer.toLowerCase().includes(query) ||
        g.genre.some((genre: string) => genre.toLowerCase().includes(query)) ||
        g.platform.some((platform: string) => platform.toLowerCase().includes(query))
      );
    }
    baseGames = lib;
  } else if (viewMode === 'browse' && isSearching) {
    baseGames = searchResults;
    skipDynamic = true;
  } else {
    baseGames = currentGames;
  }

  if (!skipDynamic) {
    const hasStatus = filters.status !== 'All' && viewMode === 'library';
    const hasPriority = filters.priority !== 'All' && viewMode === 'library';
    const hasStore = filters.store.length > 0;
    const storeSet2 = hasStore ? new Set(filters.store) : null;
    const hideSentinel2 = viewMode === 'browse';

    const anyBaseFilter = hasStatus || hasPriority || hasStore || hideSentinel2;

    if (anyBaseFilter) {
      baseGames = baseGames.filter(game => {
        if (hasStatus && !(game.isInLibrary && game.status === filters.status)) return false;
        if (hasPriority && !(game.isInLibrary && game.priority === filters.priority)) return false;
        if (storeSet2) {
          const isBothStores = storeSet2.has('steam') && storeSet2.has('epic');
          if (isBothStores) {
            const hasBothAvailable = game.availableOn
              && game.availableOn.includes('steam')
              && game.availableOn.includes('epic');
            const hasBothIds = !!game.steamAppId && !!(game.epicSlug || game.epicNamespace);
            if (!hasBothAvailable && !hasBothIds) return false;
          } else {
            const directMatch = game.store && storeSet2.has(game.store);
            const availMatch = game.availableOn?.some(s => storeSet2.has(s));
            const inferredMatch = !directMatch && !availMatch
              ? (game.id.startsWith('steam-') && storeSet2.has('steam')) ||
                (game.id.startsWith('epic-') && storeSet2.has('epic'))
              : false;
            if (!directMatch && !availMatch && !inferredMatch) return false;
          }
        }
        if (hideSentinel2 && game.comingSoon && game.releaseDate === 'Coming Soon') return false;
        if (hideSentinel2 && filters.category !== 'award-winning' && game.releaseDate) {
          const y = game.releaseDate.slice(0, 4);
          if (y >= '2099') return false;
        }
        return true;
      });
    }
  }

  // Genre options (from base pool)
  const genreSet = new Set<string>();
  for (const g of baseGames) {
    for (const genre of g.genre) if (genre) genreSet.add(genre);
  }
  const dynamicGenres = Array.from(genreSet).sort();

  // Platform options (from base pool + genre filter)
  let afterGenre = baseGames;
  if (filters.genre !== 'All') {
    afterGenre = baseGames.filter(g => g.genre.includes(filters.genre));
  }
  const platformSet = new Set<string>();
  for (const g of afterGenre) {
    for (const p of g.platform) if (p) platformSet.add(p);
  }
  const dynamicPlatforms = Array.from(platformSet).sort();

  // Year options (from base pool + genre + platform)
  let afterPlatform = afterGenre;
  if (filters.platform !== 'All') {
    const pLower = filters.platform.toLowerCase();
    afterPlatform = afterGenre.filter(g =>
      g.platform.some(p => p.toLowerCase().includes(pLower))
    );
  }
  const yearSet = new Set<string>();
  for (const g of afterPlatform) {
    if (g.releaseDate && g.releaseDate !== 'Coming Soon') {
      const y = g.releaseDate.slice(0, 4);
      if (y && y >= '1970' && y <= '2099') yearSet.add(y);
    }
  }
  const dynamicYears = Array.from(yearSet).sort().reverse();

  // ── 3. Sort ──────────────────────────────────────────────────────────
  let sortedGames: Game[];

  if (filters.category === 'catalog') {
    sortedGames = displayedGames;
  } else {
    const indexMap = new Map<string, number>();
    displayedGames.forEach((g, i) => indexMap.set(g.id, i));

    sortedGames = [...displayedGames].sort((a, b) => {
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
          comparison = ((a as any)._releaseTs ?? 0) - ((b as any)._releaseTs ?? 0);
          break;
      }
      if (comparison !== 0) {
        return sortDirection === 'desc' ? -comparison : comparison;
      }
      return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
    });
  }

  return { displayedGames, sortedGames, dynamicGenres, dynamicPlatforms, dynamicYears };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Computes filtered games, dynamic filter options, and sorted games
 * asynchronously (after the first paint), so the dashboard never freezes.
 *
 * On the very first render, returns a synchronous fast-path result computed
 * from whatever data is available (typically a small initial batch).
 * Subsequent heavy computations happen off the render phase.
 */
export function useDeferredFilterSort(input: FilterSortInput): FilterSortOutput {
  // Stable ref to the latest input — lets the scheduled callback always
  // read the freshest values without being in the dependency array.
  const inputRef = useRef(input);
  inputRef.current = input;

  // Monotonically increasing version counter — lets us discard stale results.
  const versionRef = useRef(0);

  // Synchronous fast-path for the very first render so the user sees
  // *something* immediately (the initial batch of ~120 games).
  const [output, setOutput] = useState<FilterSortOutput>(() => {
    // Only compute synchronously if the dataset is small enough (~120 items).
    // Large datasets (6000+) are deferred to the effect.
    if (input.currentGames.length <= 200) {
      return computeAll(input);
    }
    return EMPTY_OUTPUT;
  });

  // Track whether the deferred computation has populated at least once.
  // This prevents the auto-reset effect from clearing filters before data arrives.
  const hasPopulated = useRef(output.sortedGames.length > 0);

  // ── Synchronous recompute on viewMode transition ──────────────────────
  // Without this, switching from browse → library (or vice-versa) would
  // show one frame of stale data from the previous view because the
  // deferred rAF + startTransition path runs AFTER the first paint.
  // useLayoutEffect fires after the DOM commit but BEFORE the browser
  // paints, so the stale frame is never visible to the user.
  const prevViewModeRef = useRef(input.viewMode);
  useLayoutEffect(() => {
    if (input.viewMode !== prevViewModeRef.current) {
      prevViewModeRef.current = input.viewMode;
      const fresh = computeAll(inputRef.current);
      hasPopulated.current = true;
      setOutput(fresh);
    }
  }, [input.viewMode]);

  // Schedule heavy computation after paint using rAF + startTransition.
  // Cancels any in-flight computation when inputs change.
  useEffect(() => {
    const version = ++versionRef.current;
    let rafId = 0;

    rafId = requestAnimationFrame(() => {
      // Double-check we haven't been superseded
      if (version !== versionRef.current) return;

      const result = computeAll(inputRef.current);

      // Only update state if this is still the latest computation
      if (version === versionRef.current) {
        startTransition(() => {
          hasPopulated.current = true;
          setOutput(result);
        });
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    input.currentGames,
    input.searchResults,
    input.isSearching,
    input.viewMode,
    input.searchQuery,
    input.filters,
    input.sortBy,
    input.sortDirection,
  ]);

  return output;
}
