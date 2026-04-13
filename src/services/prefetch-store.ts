/**
 * Prefetch Store — Pre-fetches, deduplicates, and caches browse data.
 *
 * This module-level singleton orchestrates fetching game data from both
 * Steam and Epic during the splash screen, so the dashboard can display
 * games instantly without any API calls or card reorganisation.
 *
 * Architecture:
 *   SplashScreen → prefetchBrowseData() → IndexedDB + memory
 *   useSteamGames → getPrefetchedGames() (sync, instant)
 *                 → background silent refresh later
 */

import { Game } from '@/types/game';
import { steamService } from './steam-service';
import { epicService } from './epic-service';
import { gameService } from './game-service';
import { dedupSortInWorker } from '@/workers/use-dedup-worker';
import { scoreGame, buildSingleSearchIndex, normalizeSearchText } from './game-search-scoring';
import type { SearchIndexEntry } from './game-search-scoring';

export { scoreGame, buildSingleSearchIndex } from './game-search-scoring';
export type { SearchIndexEntry } from './game-search-scoring';

// ---------------------------------------------------------------------------
// IndexedDB via Web Worker (avoids structured-clone jank on main thread)
// ---------------------------------------------------------------------------

let idbWorker: Worker | null = null;

function getIdbWorker(): Worker {
  if (!idbWorker) {
    idbWorker = new Worker(
      new URL('../workers/idb-cache.worker.ts', import.meta.url),
      { type: 'module', name: 'Ark Cache Worker' },
    );
  }
  return idbWorker;
}

// ---------------------------------------------------------------------------
// In-memory state  (survives Vite HMR via globalThis stash)
// ---------------------------------------------------------------------------

// During development, Vite HMR re-executes this module on every save, which
// would wipe the in-memory game cache and break the browse grid.  We stash
// the state on globalThis so it survives module re-initialization.

interface PrefetchHmrState {
  games: Game[] | null;
  ready: boolean;
  searchIndex: SearchIndexEntry[] | null;
}
const _hmr: PrefetchHmrState = ((globalThis as any).__ARK_PREFETCH_STATE__ ??= {
  games: null,
  ready: false,
  searchIndex: null,
});

let prefetchedGames: Game[] | null = _hmr.games;
let prefetchReady = _hmr.ready;
let prefetchPromise: Promise<Game[]> | null = null;
/** Top Sellers (Steam + Epic 99 + free) preloaded during splash for instant dashboard display */
let prefetchedTopSellers: Game[] | null = null;
let topSellersPromise: Promise<Game[]> | null = null;
// Pre-computed lowercase search strings — avoids calling .toLowerCase() on
// every game during every keystroke. Built once when games are set.
let searchIndex: SearchIndexEntry[] | null = _hmr.searchIndex;

function buildSearchIndex(games: Game[]): void {
  // Build in chunks via requestIdleCallback/setTimeout to avoid blocking main thread
  const CHUNK_SIZE = 500;
  const result: SearchIndexEntry[] = new Array(games.length);
  let offset = 0;

  const processChunk = () => {
    const end = Math.min(offset + CHUNK_SIZE, games.length);
    for (let i = offset; i < end; i++) {
      const g = games[i];
      const titleLower = g.title.toLowerCase().trim();
      result[i] = {
        titleLower,
        titleNorm: normalizeSearchText(g.title),
        titleWords: titleLower.split(/\s+/).filter(Boolean),
        devLower: (g.developer || '').toLowerCase(),
        pubLower: (g.publisher || '').toLowerCase(),
        genresLower: (g.genre || []).map(genre => genre.toLowerCase()),
      };
    }
    offset = end;

    if (offset < games.length) {
      // Yield to the main thread between chunks
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(processChunk);
      } else {
        setTimeout(processChunk, 0);
      }
    } else {
      // Done — commit
      searchIndex = result;
      _hmr.searchIndex = searchIndex;
    }
  };

  // If dataset is small, build synchronously to avoid search-before-ready gaps
  if (games.length <= CHUNK_SIZE) {
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const titleLower = g.title.toLowerCase().trim();
      result[i] = {
        titleLower,
        titleNorm: normalizeSearchText(g.title),
        titleWords: titleLower.split(/\s+/).filter(Boolean),
        devLower: (g.developer || '').toLowerCase(),
        pubLower: (g.publisher || '').toLowerCase(),
        genresLower: (g.genre || []).map(genre => genre.toLowerCase()),
      };
    }
    searchIndex = result;
    _hmr.searchIndex = searchIndex;
    return;
  }

  processChunk();
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export interface PrefetchProgress {
  step: string;
  current: number;
  total: number;
  /** Number of games this particular source returned (only on "Fetched …" steps) */
  sourceGameCount?: number;
}

export type ProgressCallback = (progress: PrefetchProgress) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// A healthy prefetch (Steam + Epic) should produce well over 1000 games.
// If the cache holds fewer, it was likely written after a partial fetch
// (e.g. the Epic catalog timed out).  Treat it as stale so a full refresh
// runs and recovers the missing data.
const MIN_HEALTHY_CACHE_SIZE = 500;

/**
 * Read cached browse data from IndexedDB (via worker).
 * Returns the games array + freshness flag if cache exists and is within stale TTL.
 * Also stores in memory for synchronous access by useSteamGames.
 */
export async function getCachedBrowseData(): Promise<{
  games: Game[];
  isFresh: boolean;
} | null> {
  try {
    const w = getIdbWorker();
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'load-result') {
          w.removeEventListener('message', handler);
          const data = e.data.data;
          if (data?.games) {
            // If the cached set is suspiciously small, force a refresh even
            // if the timestamp says "fresh".  This self-heals after a partial
            // initial fetch (e.g. Epic catalog timed out on first launch).
            const tooSmall = data.games.length < MIN_HEALTHY_CACHE_SIZE;
            if (tooSmall) {
              console.warn(
                `[PrefetchStore] IDB cache has only ${data.games.length} games (< ${MIN_HEALTHY_CACHE_SIZE}) — marking stale to trigger recovery`,
              );
            }
            const effectiveFresh = data.isFresh && !tooSmall;

            console.log(
              `[PrefetchStore] IDB cache loaded: ${data.games.length} games (isFresh=${effectiveFresh}${tooSmall ? ', forced stale — too few games' : ''})`,
            );
            // Store in memory for sync access
            prefetchedGames = data.games;
            prefetchReady = true;
            _hmr.games = prefetchedGames;
            _hmr.ready = prefetchReady;
            buildSearchIndex(data.games);
            resolve({ games: data.games, isFresh: effectiveFresh });
          } else {
            console.log('[PrefetchStore] IDB cache: miss (no data or empty)');
            resolve(data);
          }
        }
      };
      w.addEventListener('message', handler);
      w.postMessage({ type: 'load' });
    });
  } catch {
    return null;
  }
}

/**
 * Save browse data to IndexedDB cache (via worker — non-blocking).
 * The worker slims game objects before persisting (strips heavy detail fields).
 */
export function saveBrowseCache(games: Game[]): Promise<void> {
  try {
    const w = getIdbWorker();
    // Fire-and-forget — the worker handles the persistence
    w.postMessage({ type: 'save', games });
    return Promise.resolve();
  } catch (err) {
    console.warn('[PrefetchStore] Failed to post to IDB worker:', err);
    return Promise.resolve();
  }
}

/**
 * Fetch all game data from Steam + Epic, deduplicate, sort, cache, and
 * store in memory. Reports progress via optional callback.
 *
 * Safe to call multiple times — concurrent calls share the same promise.
 */
export async function prefetchBrowseData(
  onProgress?: ProgressCallback,
): Promise<Game[]> {
  startTopSellersPreload();

  // Prevent duplicate concurrent fetches
  if (prefetchPromise) return prefetchPromise;

  prefetchPromise = _doPrefetch(onProgress);
  try {
    return await prefetchPromise;
  } finally {
    prefetchPromise = null;
  }
}

/**
 * Preloaded Top Sellers (Steam + Epic 99 + free) from splash. Use in useSteamGames for trending.
 */
export function getPrefetchedTopSellers(): Game[] | null {
  return prefetchedTopSellers;
}

/**
 * Start Top Sellers preload (e.g. from splash on mount). Safe to call multiple times.
 * Does not block; results are available via getPrefetchedTopSellers() when ready.
 */
export function startTopSellersPreload(): void {
  if (topSellersPromise) return;
  topSellersPromise = gameService
    .getTopSellers()
    .then((games) => {
      prefetchedTopSellers = games;
      if (games.length > 0) {
        console.log(`[PrefetchStore] Top Sellers preload: ${games.length} games`);
      }
      return games;
    })
    .finally(() => {
      topSellersPromise = null;
    });
}

/**
 * Wait for the Top Sellers preload to complete (or timeout). Use when fetch returned &lt;50
 * so we can upgrade to the preload result if it has more games.
 */
export function waitForTopSellersPreload(maxMs: number): Promise<Game[] | null> {
  const existing = getPrefetchedTopSellers();
  if (existing && existing.length >= 50) return Promise.resolve(existing);
  if (!topSellersPromise) return Promise.resolve(getPrefetchedTopSellers());
  return Promise.race([
    topSellersPromise,
    new Promise<null>((r) => setTimeout(() => r(null), maxMs)),
  ]).then((games) => (Array.isArray(games) ? games : null));
}

// Total steps: 6 API sources + 1 dedup step
const TOTAL_STEPS = 7;

async function _doPrefetch(onProgress?: ProgressCallback): Promise<Game[]> {
  let completed = 0;

  const report = (step: string, sourceGameCount?: number) => {
    onProgress?.({ step, current: completed, total: TOTAL_STEPS, sourceGameCount });
  };

  report('Connecting to game stores...');

  // Wrap each source so progress increments when it resolves (success or fail)
  const wrapSource = <T>(
    promise: Promise<T>,
    name: string,
    timeoutMs?: number,
  ): Promise<T> => {
    let p = promise;
    if (timeoutMs) {
      p = Promise.race([
        promise,
        new Promise<T>((resolve) =>
          setTimeout(() => {
            console.warn(`[PrefetchStore] ${name} timed out after ${timeoutMs / 1000}s`);
            resolve([] as unknown as T);
          }, timeoutMs),
        ),
      ]);
    }
    return p
      .then((result) => {
        completed++;
        const count = Array.isArray(result) ? result.length : 0;
        report(`Fetched ${name}`, count);
        return result;
      })
      .catch((err) => {
        completed++;
        console.warn(`[PrefetchStore] ${name} failed:`, err);
        report(`${name} unavailable`, 0);
        return [] as unknown as T;
      });
  };

  // Parallel fetch from all sources
  const t0 = performance.now();
  const [
    mostPlayed,
    newReleases,
    topSellers,
    comingSoon,
    epicCatalog,
    epicFreeGames,
  ] = await Promise.all([
    wrapSource(steamService.getMostPlayedGames(500), 'Steam most-played'),
    wrapSource(steamService.getNewReleases(), 'Steam new releases'),
    wrapSource(steamService.getTopSellers(), 'Steam top sellers'),
    wrapSource(steamService.getComingSoon(), 'Steam coming soon'),
    wrapSource(epicService.browseCatalog(0), 'Epic full catalog', 180_000),
    wrapSource(epicService.getFreeGames(), 'Epic free games'),
  ]);

  console.log(
    `[PrefetchStore] Source counts after ${((performance.now() - t0) / 1000).toFixed(1)}s: ` +
      `mostPlayed=${mostPlayed.length}, newReleases=${newReleases.length}, ` +
      `topSellers=${topSellers.length}, comingSoon=${comingSoon.length}, ` +
      `epicCatalog=${epicCatalog.length}, epicFreeGames=${epicFreeGames.length}`,
  );

  // Deduplicate
  report('Deduplicating across stores...');

  const allRawGames: Game[] = [
    ...mostPlayed,
    ...newReleases,
    ...topSellers,
    ...comingSoon,
    ...epicCatalog,
    ...epicFreeGames,
  ];

  // Offload dedup + sort to a Web Worker (keeps main thread responsive)
  const deduplicated = await dedupSortInWorker(allRawGames);

  completed = TOTAL_STEPS;
  report(`Aggregation complete — ${deduplicated.length} unique games`);

  // Store in memory for synchronous access by useSteamGames
  prefetchedGames = deduplicated;
  prefetchReady = true;
  _hmr.games = prefetchedGames;
  _hmr.ready = prefetchReady;
  buildSearchIndex(deduplicated);

  // Save to IndexedDB (non-blocking)
  saveBrowseCache(deduplicated).catch((err) => { console.warn('[Prefetch] Cache save:', err); });

  console.log(
    `[PrefetchStore] Prefetch complete: ${deduplicated.length} games ` +
      `(Steam: ${mostPlayed.length}+${newReleases.length}+${topSellers.length}+${comingSoon.length}, ` +
      `Epic: ${epicCatalog.length}+${epicFreeGames.length})`,
  );

  return deduplicated;
}

/**
 * Synchronous read of in-memory pre-fetched games.
 * Returns null if prefetch hasn't completed yet.
 */
export function getPrefetchedGames(): Game[] | null {
  return prefetchedGames;
}

/**
 * Find a specific game by its ID in the prefetched data.
 * Supports exact match and cross-store lookup via secondaryId.
 */
export function findGameById(id: string): Game | null {
  // Check the navigation transfer first (set by the card click that navigated here).
  // Uses a 10-second TTL instead of consume-once so it survives React StrictMode
  // double-execution in development.
  if (
    _navTransfer &&
    _navTransfer.game.id === id &&
    Date.now() - _navTransfer.ts < 10_000
  ) {
    return _navTransfer.game;
  }
  if (!prefetchedGames) return null;
  // Direct match
  const direct = prefetchedGames.find(g => g.id === id);
  if (direct) return direct;
  // Cross-store match (a game might be stored under its Steam ID but have a secondaryId for Epic or vice-versa)
  const secondary = prefetchedGames.find(g => g.secondaryId === id);
  if (secondary) return secondary;
  return null;
}

// ---------------------------------------------------------------------------
// Navigation transfer — lets the game card pass its full Game object to the
// details page without encoding it in the URL.  Valid for 10 seconds (survives
// React StrictMode double-execution).
// ---------------------------------------------------------------------------
let _navTransfer: { game: Game; ts: number } | null = null;

/**
 * Stash a Game object before navigating to /game/:id.
 * The details page will pick it up via findGameById on mount.
 */
export function setNavigatingGame(game: Game): void {
  _navTransfer = { game, ts: Date.now() };
}

/**
 * Search prefetched games in-memory with tokenized, relevance-scored matching.
 * Searches title, developer, publisher, and genre.  Supports multi-word
 * queries ("assassin creed") and typo tolerance via bounded edit distance.
 * Results are sorted by relevance score (highest first).
 * Instant, no API calls needed. Falls back to null if no prefetched data.
 */
export function searchPrefetchedGames(
  query: string,
  limit: number = 20,
): Game[] | null {
  if (!prefetchedGames || !query.trim()) return null;
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const scored: Array<{ game: Game; score: number }> = [];

  if (searchIndex && searchIndex.length === prefetchedGames.length) {
    for (let i = 0; i < searchIndex.length; i++) {
      const s = scoreGame(searchIndex[i], tokens, q, prefetchedGames[i]);
      if (s > 0) scored.push({ game: prefetchedGames[i], score: s });
    }
  } else {
    // Fallback if index is stale or not built yet
    for (const game of prefetchedGames) {
      const idx = buildSingleSearchIndex(game);
      const s = scoreGame(idx, tokens, q, game);
      if (s > 0) scored.push({ game, score: s });
    }
  }

  // Sort by score descending, then take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.game);
}

/**
 * Whether prefetched data is available in memory.
 */
export function isPrefetchReady(): boolean {
  return prefetchReady;
}

/**
 * Replace in-memory data (used by background refresh in useSteamGames).
 */
export function setPrefetchedGames(games: Game[]): void {
  prefetchedGames = games;
  prefetchReady = true;
  _hmr.games = prefetchedGames;
  _hmr.ready = prefetchReady;
  buildSearchIndex(games);
  // Persist to IndexedDB silently
  saveBrowseCache(games).catch((err) => { console.warn('[Prefetch] Cache save:', err); });
}

/**
 * Clear all cached data (used on manual refresh).
 */
export async function clearBrowseCache(): Promise<void> {
  prefetchedGames = null;
  prefetchReady = false;
  prefetchedTopSellers = null;
  searchIndex = null;
  _hmr.games = null;
  _hmr.ready = false;
  _hmr.searchIndex = null;
  try {
    const w = getIdbWorker();
    w.postMessage({ type: 'clear' });
  } catch {
    /* ignore */
  }
}
