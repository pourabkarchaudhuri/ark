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
import { titleCollator } from '@/lib/title-collator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterSortInput {
  currentGames: Game[];
  searchResults: Game[];
  isSearching: boolean;
  /** Browse: typed query not yet debounced — avoid showing category list under the search dropdown. */
  browseSearchPending?: boolean;
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
  /**
   * Bumped when player counts / catalog enrichment are merged into `currentGames` (same ids,
   * new objects). NOT part of the fingerprint: a bump only remaps the current Browse output to
   * the fresh objects (same order, same filter), so live counts and developer/genre show up
   * without a full recompute. Library invalidation keys on `currentGames` identity instead.
   */
  contentVersion?: number;
}

export interface FilterSortOutput {
  displayedGames: Game[];
  sortedGames: Game[];
  dynamicGenres: string[];
  dynamicPlatforms: string[];
  dynamicYears: string[];
  /**
   * The view and fingerprint this output was computed for (null until the first compute).
   * The Dashboard shows the output as is, empty included, only when it belongs to its view.
   */
  computedFor: { viewMode: string; fingerprint: string } | null;
}

const EMPTY_OUTPUT: FilterSortOutput = {
  displayedGames: [],
  sortedGames: [],
  dynamicGenres: [],
  dynamicPlatforms: [],
  dynamicYears: [],
  computedFor: null,
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
  const {
    currentGames,
    searchResults,
    isSearching,
    browseSearchPending = false,
    viewMode,
    searchQuery,
    filters,
    librarySearchIndex,
    allowAdultContent,
    liveGameIds,
  } = input;

  // ── 1. displayedGames ────────────────────────────────────────────────
  let games: Game[];
  let skipBrowseFilters = false;

  // Library: search-matched list before the adult/status/store filters, reused as the base pool
  // for the dynamic options below (scoring every game twice doubled the search cost).
  let searchMatched: Game[] = currentGames;

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
    searchMatched = libraryGames;
    games = libraryGames;
  } else if (viewMode === 'browse' && browseSearchPending) {
    games = [];
  } else if (viewMode === 'browse' && isSearching) {
    games = searchResults;
    // Apply same browse filters (genre, platform, year, store, sentinels) as non-search; relevance order preserved in computeSort.
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
        if (hasStatus) {
          if (!game.isInLibrary) return false;
          // "Playing Now" filter = only games actually running (tracked), not stored status
          if (filters.status === 'Playing Now') {
            const isLive = liveGameIds?.has(game.id) || (game.steamAppId ? liveGameIds?.has(`steam-${game.steamAppId}`) : false);
            if (!isLive) return false;
          } else if (game.status !== filters.status) {
            return false;
          }
        }
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
    baseGames = searchMatched;
  } else if (viewMode === 'browse' && browseSearchPending) {
    baseGames = [];
  } else if (viewMode === 'browse' && isSearching) {
    baseGames = searchResults;
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
        if (hasStatus) {
          if (!game.isInLibrary) return false;
          if (filters.status === 'Playing Now') {
            const isLive = liveGameIds?.has(game.id) || (game.steamAppId ? liveGameIds?.has(`steam-${game.steamAppId}`) : false);
            if (!isLive) return false;
          } else if (game.status !== filters.status) {
            return false;
          }
        }
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
/** Release timestamp for sorting; 0 for missing or unparseable dates ('Coming Soon', 'TBA'). */
function releaseTsForSort(releaseDate: string | undefined): number {
  if (!releaseDate) return 0;
  const t = Date.parse(releaseDate);
  return Number.isFinite(t) ? t : 0;
}

function computeSort(displayedGames: Game[], input: FilterSortInput): Game[] {
  const { filters, sortBy, sortDirection, viewMode, isSearching, liveGameIds } = input;

  if (filters.category === 'catalog') {
    return displayedGames;
  }
  // Browse search results are already relevance-sorted; do not re-order by title/rating.
  if (viewMode === 'browse' && isSearching) {
    return displayedGames;
  }
  if (viewMode === 'browse' && sortBy === 'releaseDate' && sortDirection === 'desc' && !isSearching) {
    return displayedGames;
  }

  const indexMap = new Map<string, number>();
  displayedGames.forEach((g, i) => indexMap.set(g.id, i));

  // Release-date sort: browse games carry a precomputed _releaseTs; library and custom games
  // never do, so derive it from releaseDate (every comparison was 0 before → no-op sort).
  let tsMap: Map<string, number> | null = null;
  if (sortBy === 'releaseDate') {
    tsMap = new Map();
    for (const g of displayedGames) {
      const pre = (g as { _releaseTs?: unknown })._releaseTs;
      const t = typeof pre === 'number' ? pre : releaseTsForSort(g.releaseDate);
      tsMap.set(g.id, Number.isFinite(t) ? t : 0);
    }
  }

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
      // Within each status section: always alphabetical by title
      return titleCollator.compare(a.title, b.title);
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
        comparison = (tsMap!.get(a.id) ?? 0) - (tsMap!.get(b.id) ?? 0);
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

/** Test seam: the two phases, called through this object so tests can count runs. */
export const __filterSortInternals = { computeFilterAndDynamic, computeSort };

function computeAll(input: FilterSortInput, fingerprint: string): FilterSortOutput {
  const phase1 = __filterSortInternals.computeFilterAndDynamic(input);
  const sortedGames = __filterSortInternals.computeSort(phase1.displayedGames, input);
  return { ...phase1, sortedGames, computedFor: { viewMode: input.viewMode, fingerprint } };
}

/**
 * Stable fingerprint to avoid re-scheduling when array references change but the inputs that
 * decide the result are the same. Enrichment / player-count merges create new objects with the
 * same ids, so they do not change it (see `contentVersion`). `libRev` counts library-list
 * rebuilds and is only part of the library view's fingerprint.
 */
function computeFingerprint(input: FilterSortInput, libRev: number): string {
  const liveCount = input.liveGameIds?.size ?? 0;
  // Include store filter values (not just length) so Steam vs Epic vs Both trigger recompute
  const storeKey = (input.filters.store || []).slice().sort().join(',');
  // Only include liveCount when it affects sort (library + status priority). Omitting for browse
  // prevents player-count updates from re-running the effect and overwriting store order.
  const livePart = input.viewMode === 'library' ? liveCount : '';
  const adultPart = input.allowAdultContent === true ? '1' : '0';
  const pendingPart = input.browseSearchPending ? '1' : '0';
  // Never for browse: enrichment churn there is handled by the contentVersion remap.
  const libRevPart = input.viewMode === 'library' ? libRev : '';
  return `${input.currentGames.length}|${input.currentGames[0]?.id ?? ''}|${input.currentGames[input.currentGames.length - 1]?.id ?? ''}|${input.searchResults.length}|${input.isSearching}|${pendingPart}|${input.viewMode}|${input.searchQuery}|${input.filters.genre}|${input.filters.platform}|${input.filters.status}|${input.filters.priority}|${input.filters.releaseYear}|${storeKey}|${input.filters.category}|${input.sortBy}|${input.sortDirection}|${livePart}|${adultPart}|${libRevPart}`;
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

  // ── Library invalidation: identity of the library list ─────────────────
  // useLibraryGames rebuilds the list ~200 ms after a library mutation, so a store version
  // bumps before the fresh data exists (recompute on stale data, then nothing picks up the
  // rebuild: the status pill reverted). A new `currentGames` reference in library view is the
  // signal instead; the counter folds it into the library fingerprint.
  const prevLibGamesRef = useRef<Game[]>(input.currentGames);
  const libGamesRevRef = useRef(0);
  let libGamesChanged = false;
  if (input.viewMode === 'library' && input.currentGames !== prevLibGamesRef.current) {
    prevLibGamesRef.current = input.currentGames;
    libGamesRevRef.current++;
    libGamesChanged = true;
  }

  const fingerprint = computeFingerprint(input, libGamesRevRef.current);

  // Synchronous fast-path for the very first render so the user sees
  // *something* immediately (the initial batch of ~120 games).
  const [output, setOutput] = useState<FilterSortOutput>(() => {
    // Only compute synchronously if the dataset is small enough (~120 items).
    // Large datasets (6000+) are deferred to the effect.
    if (input.currentGames.length <= 200) {
      return computeAll(augmentInput(input), fingerprint);
    }
    return EMPTY_OUTPUT;
  });

  // Track whether the deferred computation has populated at least once.
  // This prevents the auto-reset effect from clearing filters before data arrives.
  const hasPopulated = useRef(output.sortedGames.length > 0);

  // ── Sync recomputes (React's "setState during render" pattern) ─────────
  // Avoids queue conflicts with the deferred startTransition path. Each output records the
  // fingerprint it was computed for, so the effect below skips work a sync path already did
  // (no refs are stamped during render).
  let computedSync = false;
  const runSync = () => {
    setOutput(computeAll(augmentInput(input), fingerprint));
    hasPopulated.current = true;
    computedSync = true;
  };

  // Data arrives or grows (e.g. empty→n or 38→137): Top Sellers etc. show the full list
  // immediately when the hook receives the larger set, not one frame later.
  const prevDataLenRef = useRef(input.currentGames.length);
  if (input.currentGames.length !== prevDataLenRef.current) {
    const prevLen = prevDataLenRef.current;
    const nextLen = input.currentGames.length;
    prevDataLenRef.current = nextLen;
    const emptyToPopulated = prevLen === 0 && nextLen > 0;
    const smallDatasetGrew = nextLen <= 200 && nextLen > prevLen;
    if (emptyToPopulated || smallDatasetGrew) runSync();
  }
  // Rebuilt library list (status pill flip, priority edit, custom game change): cheap at
  // library sizes, and done here so the card never shows the old status for a frame.
  if (!computedSync && libGamesChanged && input.currentGames.length <= 500) runSync();

  // ── Inline recompute on viewMode transition ───────────────────────────
  // For small datasets we compute synchronously so the grid paints immediately.
  // For large datasets the effect runs (with phased yield) so the main thread stays
  // responsive for hover/input. Previous view is state, not a ref written during render, so an
  // interrupted transition cannot leave the grid on the previous view's list.
  const [prevViewMode, setPrevViewMode] = useState(input.viewMode);
  if (input.viewMode !== prevViewMode) {
    setPrevViewMode(input.viewMode);
    if (!computedSync && input.currentGames.length <= 300) runSync();
  }

  // Schedule heavy computation after paint; yield between filter and sort
  // so the main thread can process input (e.g. hover) and stay responsive.
  const prevFingerprintRef = useRef('');
  useEffect(() => {
    if (output.computedFor?.fingerprint === fingerprint) {
      prevFingerprintRef.current = fingerprint; // a sync path already computed it
      return;
    }
    if (fingerprint === prevFingerprintRef.current) return;
    prevFingerprintRef.current = fingerprint;

    const version = ++versionRef.current;
    let raf1 = 0;
    let raf2 = 0;
    let done = false;

    raf1 = requestAnimationFrame(() => {
      if (version !== versionRef.current) return;
      const phase1 = __filterSortInternals.computeFilterAndDynamic(augmentInput(inputRef.current));

      raf2 = requestAnimationFrame(() => {
        if (version !== versionRef.current) return;
        const sortedGames = __filterSortInternals.computeSort(phase1.displayedGames, inputRef.current);
        if (version === versionRef.current) {
          done = true;
          const computedFor = { viewMode: inputRef.current.viewMode, fingerprint };
          startTransition(() => {
            hasPopulated.current = true;
            setOutput({ ...phase1, sortedGames, computedFor });
          });
        }
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      // A run cancelled before it delivered (StrictMode's mount-cleanup-mount, or an input
      // change) must not leave its fingerprint marked done, or it is never retried.
      if (!done && prevFingerprintRef.current === fingerprint) prevFingerprintRef.current = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  // ── Content remap (Browse) ─────────────────────────────────────────────
  // Player counts and catalog enrichment arrive as new objects with the same ids, which the
  // fingerprint deliberately ignores. When only the content changed, swap the fresh objects
  // into the current output (same order, same filter; re-sorting on enriched fields is an
  // accepted limitation). Library view and searches are left alone.
  const prevContentVersionRef = useRef(input.contentVersion);
  useEffect(() => {
    if (input.contentVersion === prevContentVersionRef.current) return;
    prevContentVersionRef.current = input.contentVersion;
    const cur = inputRef.current;
    if (cur.viewMode === 'library' || cur.isSearching || cur.browseSearchPending || cur.searchQuery.trim()) return;
    // A pending recompute for a new fingerprint reads the fresh objects anyway.
    if (output.computedFor?.fingerprint !== fingerprint) return;
    const byId = new Map<string, Game>();
    for (const g of cur.currentGames) byId.set(g.id, g);
    const remap = (list: Game[]): Game[] | null => {
      let out: Game[] | null = null;
      for (let i = 0; i < list.length; i++) {
        const fresh = byId.get(list[i]!.id);
        if (fresh && fresh !== list[i]) {
          if (!out) out = list.slice();
          out[i] = fresh;
        }
      }
      return out;
    };
    // No element identity changed: no state update at all.
    if (!remap(output.sortedGames) && !remap(output.displayedGames)) return;
    // An older in-flight deferred compute must not overwrite the remapped objects.
    ++versionRef.current;
    setOutput(prev => {
      if (prev.computedFor?.fingerprint !== fingerprint) return prev;
      const sortedGames = remap(prev.sortedGames);
      const displayedGames = remap(prev.displayedGames);
      if (!sortedGames && !displayedGames) return prev;
      return {
        ...prev,
        sortedGames: sortedGames ?? prev.sortedGames,
        displayedGames: displayedGames ?? prev.displayedGames,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.contentVersion]);

  return output;
}
