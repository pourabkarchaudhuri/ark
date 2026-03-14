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
 * 2. After paint, the work runs in two phases with a yield (rAF) between them:
 *    phase 1 = filter + dynamic options, phase 2 = sort. That lets the main
 *    thread process input (e.g. hover) and stay responsive during heavy work.
 * 3. The result is applied via `startTransition` so React treats the
 *    resulting re-render as low-priority (interruptible).
 * 4. If inputs change while a computation is in-flight, it's cancelled and
 *    a new one is scheduled.
 */

import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import type { MutableRefObject } from 'react';
import type { Game, GameFilters } from '@/types/game';
import { scoreGame, buildSingleSearchIndex, type SearchIndexEntry } from '@/services/prefetch-store';
import { isAdultContentByDescription } from '@/services/adult-content-filter';

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
  /** Pre-built search index for library games (set by hook to avoid rebuilding on every search). */
  librarySearchIndex?: SearchIndexEntry[] | null;
  /** When false, games classified as adult (by description) are hidden. Default off. */
  allowAdultContent?: boolean;
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

/** Result of filter + dynamic options only (no sort). Used to yield between phases. */
interface FilterAndDynamicResult {
  displayedGames: Game[];
  dynamicGenres: string[];
  dynamicPlatforms: string[];
  dynamicYears: string[];
}

// ---------------------------------------------------------------------------
// Rating sort: Bayesian-style adjusted score so few-review games don't outrank many-review games
// ---------------------------------------------------------------------------

const RATING_PRIOR = 70;   // pull low-review scores toward this
const RATING_MIN_WEIGHT = 15; // virtual "reviews" so 0-review games sit at prior

/**
 * Adjusted rating for sort: (score * n + prior * m) / (n + m).
 * Games with no/few Steam recommendations sort toward RATING_PRIOR so they don't
 * push well-reviewed titles down.
 * Defensive: always returns a finite number (handles missing game, non-numeric score, NaN).
 */
export function getAdjustedRatingForSort(game: Game | null | undefined): number {
  if (!game) return 0;
  const rawScore = game.metacriticScore ?? 0;
  const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 0;
  const n = Math.max(0, Number(game.recommendations) || 0);
  if (score <= 0) return 0;
  const adjusted = (score * n + RATING_PRIOR * RATING_MIN_WEIGHT) / (n + RATING_MIN_WEIGHT);
  return Number.isFinite(adjusted) ? adjusted : 0;
}

// ---------------------------------------------------------------------------
// Pure computation (runs off the render phase)
// ---------------------------------------------------------------------------

/**
 * Phase 1: filter + dynamic options. Yielding after this lets the main thread
 * process input (e.g. hover) before running the sort phase.
 */
function computeFilterAndDynamic(input: FilterSortInput): FilterAndDynamicResult {
  const { currentGames, searchResults, isSearching, viewMode, searchQuery, filters, librarySearchIndex, allowAdultContent } = input;

  // ── 1. displayedGames ────────────────────────────────────────────────
  let games: Game[];
  let skipBrowseFilters = false;

  if (viewMode === 'library') {
    let libraryGames = currentGames;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const tokens = q.split(/\s+/).filter(Boolean);
      const useCachedIndex = librarySearchIndex && librarySearchIndex.length === libraryGames.length;
      const scored = libraryGames.map((g, i) => ({
        game: g,
        score: scoreGame(
          useCachedIndex ? librarySearchIndex[i]! : buildSingleSearchIndex(g),
          tokens,
          q,
          g,
          { allowShorthand: false },
        ),
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

  // When "Allow adult content" is off, hide games classified as sexually explicit (by description).
  if (allowAdultContent === false) {
    games = games.filter((g) => !isAdultContentByDescription(g));
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
      const useCachedIndex = librarySearchIndex && librarySearchIndex.length === lib.length;
      lib = lib.filter((g, i) =>
        scoreGame(
          useCachedIndex ? librarySearchIndex[i]! : buildSingleSearchIndex(g),
          tokens2,
          q2,
          g,
          { allowShorthand: false },
        ) > 0,
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
    const hasStore2 = filters.store.length > 0;
    const storeSet2 = hasStore2 ? new Set(filters.store) : null;
    const hideSentinel2 = viewMode === 'browse';

    const anyBaseFilter = hasStatus || hasPriority || hasStore2 || hideSentinel2;

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

  return { displayedGames, dynamicGenres, dynamicPlatforms, dynamicYears };
}

/**
 * Phase 2: sort displayedGames. Runs after a yield so input/hover can be processed.
 */
function computeSort(displayedGames: Game[], input: FilterSortInput): Game[] {
  const { filters, sortBy, sortDirection, viewMode, isSearching, liveGameIds } = input;

  if (filters.category === 'catalog') {
    return displayedGames;
  }
  if (viewMode === 'browse' && sortBy === 'releaseDate' && sortDirection === 'desc' && !isSearching) {
    return displayedGames;
  }

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

  return [...displayedGames].sort((a, b) => {
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
      case 'default': {
        const adjA = getAdjustedRatingForSort(a);
        const adjB = getAdjustedRatingForSort(b);
        comparison = Number.isFinite(adjA) && Number.isFinite(adjB) ? adjA - adjB : (a.metacriticScore ?? 0) - (b.metacriticScore ?? 0);
        break;
      }
      case 'releaseDate':
        comparison = ((a as any)._releaseTs ?? 0) - ((b as any)._releaseTs ?? 0);
        break;
      default:
        comparison = (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
        break;
    }
    if (comparison !== 0) {
      return sortDirection === 'desc' ? -comparison : comparison;
    }
    const aPos = a.steamListPosition ?? a.epicListPosition ?? 9999;
    const bPos = b.steamListPosition ?? b.epicListPosition ?? 9999;
    if (aPos !== bPos) return aPos - bPos;
    return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
  });
}

function computeAll(input: FilterSortInput): FilterSortOutput {
  const phase1 = computeFilterAndDynamic(input);
  const sortedGames = computeSort(phase1.displayedGames, input);
  return { ...phase1, sortedGames };
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
/** Cache for library search index so we don't rebuild on every search keystroke. */
function getLibrarySearchIndex(
  games: Game[],
  cacheRef: MutableRefObject<{ games: Game[]; index: SearchIndexEntry[] } | null>,
): SearchIndexEntry[] {
  if (cacheRef.current && cacheRef.current.games === games) return cacheRef.current.index;
  const index = games.map(g => buildSingleSearchIndex(g));
  cacheRef.current = { games, index };
  return index;
}

export function useDeferredFilterSort(input: FilterSortInput): FilterSortOutput {
  // Stable ref to the latest input — lets the scheduled callback always
  // read the freshest values without being in the dependency array.
  const inputRef = useRef(input);
  inputRef.current = input;

  const libraryIndexCacheRef = useRef<{ games: Game[]; index: SearchIndexEntry[] } | null>(null);

  // Monotonically increasing version counter — lets us discard stale results.
  const versionRef = useRef(0);

  const augmentInput = useCallback((raw: FilterSortInput): FilterSortInput => {
    if (raw.viewMode !== 'library') return { ...raw, librarySearchIndex: null };
    return {
      ...raw,
      librarySearchIndex: getLibrarySearchIndex(raw.currentGames, libraryIndexCacheRef),
    };
  }, []);

  // Synchronous fast-path for the very first render so the user sees
  // *something* immediately (the initial batch of ~120 games).
  const [output, setOutput] = useState<FilterSortOutput>(() => {
    // Only compute synchronously if the dataset is small enough (~120 items).
    // Large datasets (6000+) are deferred to the effect.
    if (input.currentGames.length <= 200) {
      return computeAll(augmentInput(input));
    }
    return EMPTY_OUTPUT;
  });

  // Track whether the deferred computation has populated at least once.
  // This prevents the auto-reset effect from clearing filters before data arrives.
  const hasPopulated = useRef(output.sortedGames.length > 0);

  // ── Sync recompute when data arrives or grows (e.g. empty→n or 38→137) ─
  // Uses React's "setState during render" pattern to avoid queue conflicts
  // with the deferred startTransition path. Ensures Top Sellers etc. show the
  // full list immediately when the hook receives the larger set, not one frame later.
  const prevDataLenRef = useRef(input.currentGames.length);
  if (input.currentGames.length !== prevDataLenRef.current) {
    const prevLen = prevDataLenRef.current;
    const nextLen = input.currentGames.length;
    prevDataLenRef.current = nextLen;
    const emptyToPopulated = prevLen === 0 && nextLen > 0;
    const smallDatasetGrew = nextLen <= 200 && nextLen > prevLen;
    if (emptyToPopulated || smallDatasetGrew) {
      const fresh = computeAll(augmentInput(input));
      hasPopulated.current = true;
      setOutput(fresh);
    }
  }

  // Stable fingerprint to avoid re-scheduling when array references change
  // but actual content is identical (e.g. enrichment epoch bumps that don't
  // change the games slice thanks to prevGamesRef stability upstream).
  const prevFingerprintRef = useRef('');
  const liveCount = input.liveGameIds?.size ?? 0;
  // Include store filter values (not just length) so Steam vs Epic vs Both trigger recompute
  const storeKey = (input.filters.store || []).slice().sort().join(',');
  // Only include liveCount when it affects sort (library + status priority). Omitting for browse
  // prevents player-count updates from re-running the effect and overwriting store order.
  const livePart = input.viewMode === 'library' ? liveCount : '';
  const adultPart = input.allowAdultContent === true ? '1' : '0';
  const fingerprint = `${input.currentGames.length}|${input.currentGames[0]?.id ?? ''}|${input.currentGames[input.currentGames.length - 1]?.id ?? ''}|${input.searchResults.length}|${input.isSearching}|${input.viewMode}|${input.searchQuery}|${input.filters.genre}|${input.filters.platform}|${input.filters.status}|${input.filters.priority}|${input.filters.releaseYear}|${storeKey}|${input.filters.category}|${input.sortBy}|${input.sortDirection}|${livePart}|${adultPart}`;

  // ── Inline recompute on viewMode transition ───────────────────────────
  // For small datasets we compute synchronously so the grid paints immediately.
  // For large datasets we only stamp the fingerprint and let the effect run
  // (with phased yield) so the main thread stays responsive for hover/input.
  const prevViewModeRef = useRef(input.viewMode);
  if (input.viewMode !== prevViewModeRef.current) {
    prevViewModeRef.current = input.viewMode;
    if (input.currentGames.length <= 300) {
      const fresh = computeAll(augmentInput(inputRef.current));
      hasPopulated.current = true;
      setOutput(fresh);
      prevFingerprintRef.current = fingerprint;
    }
  }

  // Schedule heavy computation after paint; yield between filter and sort
  // so the main thread can process input (e.g. hover) and stay responsive.
  useEffect(() => {
    if (fingerprint === prevFingerprintRef.current) return;
    prevFingerprintRef.current = fingerprint;

    const version = ++versionRef.current;
    let raf1 = 0;
    let raf2 = 0;

    raf1 = requestAnimationFrame(() => {
      if (version !== versionRef.current) return;
      const phase1 = computeFilterAndDynamic(augmentInput(inputRef.current));

      raf2 = requestAnimationFrame(() => {
        if (version !== versionRef.current) return;
        const sortedGames = computeSort(phase1.displayedGames, inputRef.current);
        if (version === versionRef.current) {
          startTransition(() => {
            hasPopulated.current = true;
            setOutput({ ...phase1, sortedGames });
          });
        }
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  return output;
}
