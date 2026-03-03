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

import { useState, useEffect, useRef, startTransition } from 'react';
import type { Game, GameFilters } from '@/types/game';
import { scoreGame, buildSingleSearchIndex } from '@/services/prefetch-store';

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
  liveGameIds?: Set<string>;
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
  const { currentGames, searchResults, isSearching, viewMode, searchQuery, filters, sortBy, sortDirection, liveGameIds } = input;

  // ── 1. displayedGames ────────────────────────────────────────────────
  let games: Game[];
  let skipBrowseFilters = false;

  if (viewMode === 'library') {
    let libraryGames = currentGames;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      const scored = libraryGames.map(g => ({
        game: g,
        score: scoreGame(buildSingleSearchIndex(g), tokens, q, g),
      })).filter(s => s.score > 0);
      scored.sort((a, b) => b.score - a.score);
      libraryGames = scored.map(s => s.game);
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
  // Base pool for dynamic options: search-filtered but before genre/platform/year
  // so the cascading dropdowns show all available values.
  let baseGames: Game[];
  let skipDynamic = false;

  if (viewMode === 'library') {
    let lib = currentGames;
    if (searchQuery.trim()) {
      const q2 = searchQuery.toLowerCase().trim();
      const tokens2 = q2.split(/\s+/).filter(Boolean);
      lib = lib.filter(g => scoreGame(buildSingleSearchIndex(g), tokens2, q2, g) > 0);
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

  // Extract genre/platform/year options in a single pass over baseGames.
  // Cascading: platforms come from genre-filtered pool, years from genre+platform-filtered pool.
  const genreSet = new Set<string>();
  const platformSet = new Set<string>();
  const yearSet = new Set<string>();
  const hasGenreFilter = filters.genre !== 'All';
  const hasPlatformFilter = filters.platform !== 'All';
  const platformFilterLower = hasPlatformFilter ? filters.platform.toLowerCase() : '';

  for (let i = 0; i < baseGames.length; i++) {
    const g = baseGames[i];
    for (let j = 0; j < g.genre.length; j++) if (g.genre[j]) genreSet.add(g.genre[j]);

    const matchesGenre = !hasGenreFilter || g.genre.includes(filters.genre);
    if (matchesGenre) {
      for (let j = 0; j < g.platform.length; j++) if (g.platform[j]) platformSet.add(g.platform[j]);

      const matchesPlatform = !hasPlatformFilter ||
        g.platform.some(p => p.toLowerCase().includes(platformFilterLower));
      if (matchesPlatform && g.releaseDate && g.releaseDate !== 'Coming Soon') {
        const y = g.releaseDate.slice(0, 4);
        if (y && y >= '1970' && y <= '2099') yearSet.add(y);
      }
    }
  }

  const dynamicGenres = Array.from(genreSet).sort();
  const dynamicPlatforms = Array.from(platformSet).sort();
  const dynamicYears = Array.from(yearSet).sort().reverse();

  // ── 3. Sort ──────────────────────────────────────────────────────────
  let sortedGames: Game[];

  if (filters.category === 'catalog') {
    sortedGames = displayedGames;
  } else if (viewMode === 'browse' && sortBy === 'releaseDate' && sortDirection === 'desc' && !isSearching) {
    // Browse games arrive pre-sorted by release date (desc) from useSteamGames.
    // Skip the expensive copy+sort for the default/most common case.
    sortedGames = displayedGames;
  } else {
    const indexMap = new Map<string, number>();
    displayedGames.forEach((g, i) => indexMap.set(g.id, i));

    const statusPriority = (game: Game) => {
      const isLive = liveGameIds?.has(game.id) ||
        (game.steamAppId ? liveGameIds?.has(`steam-${game.steamAppId}`) : false);
      if (isLive || game.status === 'Playing Now') return 0;
      if (game.status === 'Playing') return 1;
      if (game.status === 'On Hold') return 2;
      if (game.status === 'Want to Play') return 3;
      if (game.status === 'Completed') return 4;
      return 5;
    };

    sortedGames = [...displayedGames].sort((a, b) => {
      if (viewMode === 'library' && filters.status === 'All') {
        const aStatus = a.isInLibrary ? statusPriority(a) : 5;
        const bStatus = b.isInLibrary ? statusPriority(b) : 5;
        if (aStatus !== bStatus) return aStatus - bStatus;
      }

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

  // ── Sync recompute when data arrives (empty → populated) ──────────────
  // Uses React's "setState during render" pattern to avoid queue conflicts
  // with the deferred startTransition path. useLayoutEffect + setOutput +
  // startTransition targeting the same state triggers "Should have a queue"
  // errors. Calling setOutput during render is safe: React abandons the
  // current render and immediately re-renders with the new state.
  // Only fires once per empty→populated transition (hasPopulated guard).
  const prevDataLenRef = useRef(input.currentGames.length);
  if (input.currentGames.length !== prevDataLenRef.current) {
    const prevLen = prevDataLenRef.current;
    prevDataLenRef.current = input.currentGames.length;
    if (prevLen === 0 && input.currentGames.length > 0) {
      const fresh = computeAll(input);
      hasPopulated.current = true;
      setOutput(fresh);
    }
  }

  // Stable fingerprint to avoid re-scheduling when array references change
  // but actual content is identical (e.g. enrichment epoch bumps that don't
  // change the games slice thanks to prevGamesRef stability upstream).
  const prevFingerprintRef = useRef('');
  const liveCount = input.liveGameIds?.size ?? 0;
  const fingerprint = `${input.currentGames.length}|${input.currentGames[0]?.id ?? ''}|${input.currentGames[input.currentGames.length - 1]?.id ?? ''}|${input.searchResults.length}|${input.isSearching}|${input.viewMode}|${input.searchQuery}|${input.filters.genre}|${input.filters.platform}|${input.filters.status}|${input.filters.priority}|${input.filters.releaseYear}|${input.filters.store.length}|${input.filters.category}|${input.sortBy}|${input.sortDirection}|${liveCount}`;

  // ── Inline recompute on viewMode transition ───────────────────────────
  // Compute synchronously during render so the grid paints immediately
  // with the correct data — no blank flash. For small datasets this is
  // trivial; for larger datasets (~6000 games) the cost is ~50-80ms but
  // avoids the jarring empty→fill transition. The fingerprint is stamped
  // so the deferred useEffect doesn't redundantly re-run the same work.
  const prevViewModeRef = useRef(input.viewMode);
  if (input.viewMode !== prevViewModeRef.current) {
    prevViewModeRef.current = input.viewMode;
    const fresh = computeAll(inputRef.current);
    hasPopulated.current = true;
    setOutput(fresh);
    prevFingerprintRef.current = fingerprint;
  }

  // Schedule heavy computation after paint using rAF + startTransition.
  // Cancels any in-flight computation when inputs change.
  useEffect(() => {
    // Skip if fingerprint is identical (content unchanged despite new references)
    if (fingerprint === prevFingerprintRef.current) return;
    prevFingerprintRef.current = fingerprint;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  return output;
}
