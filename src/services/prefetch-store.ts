/**
 * Prefetch Store — Pre-fetches, deduplicates, and caches browse data.
 *
 * This module-level singleton orchestrates fetching game data from both
 * Steam and Epic during the loading screen, so the dashboard can display
 * games instantly without any API calls or card reorganization.
 *
 * Architecture:
 *   LoadingScreen → prefetchBrowseData() → IndexedDB + memory
 *   useSteamGames → getPrefetchedGames() (sync, instant)
 *                 → background silent refresh later
 */

import { Game } from '@/types/game';
import { steamService } from './steam-service';
import { epicService } from './epic-service';
import { dedupSortInWorker } from '@/workers/use-dedup-worker';

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
// In-memory state
// ---------------------------------------------------------------------------

let prefetchedGames: Game[] | null = null;
let prefetchReady = false;
let prefetchPromise: Promise<Game[]> | null = null;
// Pre-computed lowercase search strings — avoids calling .toLowerCase() on
// every game during every keystroke. Built once when games are set.
let searchIndex: Array<{ titleLower: string; devLower: string }> | null = null;

function buildSearchIndex(games: Game[]): void {
  searchIndex = games.map(g => ({
    titleLower: g.title.toLowerCase(),
    devLower: (g.developer || '').toLowerCase(),
  }));
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export interface PrefetchProgress {
  step: string;
  current: number;
  total: number;
}

export type ProgressCallback = (progress: PrefetchProgress) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
            // Store in memory for sync access
            prefetchedGames = data.games;
            prefetchReady = true;
            buildSearchIndex(data.games);
          }
          resolve(data);
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
 * store in memory. Reports progress via callback for the loading screen.
 *
 * Safe to call multiple times — concurrent calls share the same promise.
 */
export async function prefetchBrowseData(
  onProgress?: ProgressCallback,
): Promise<Game[]> {
  // Prevent duplicate concurrent fetches
  if (prefetchPromise) return prefetchPromise;

  prefetchPromise = _doPrefetch(onProgress);
  try {
    return await prefetchPromise;
  } finally {
    prefetchPromise = null;
  }
}

// Total steps: 6 API sources + 1 dedup step
const TOTAL_STEPS = 7;

async function _doPrefetch(onProgress?: ProgressCallback): Promise<Game[]> {
  let completed = 0;

  const report = (step: string) => {
    onProgress?.({ step, current: completed, total: TOTAL_STEPS });
  };

  report('Connecting to game stores...');

  // Wrap each source so progress increments when it resolves (success or fail)
  const wrapSource = <T>(
    promise: Promise<T>,
    name: string,
    timeoutMs?: number,
  ): Promise<T> => {
    let p = promise;
    // Optional timeout: resolve with empty array rather than block forever
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
        report(`Fetched ${name}`);
        return result;
      })
      .catch((err) => {
        completed++;
        console.warn(`[PrefetchStore] ${name} failed:`, err);
        report(`${name} unavailable`);
        return [] as unknown as T;
      });
  };

  // Parallel fetch from all sources
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
    wrapSource(epicService.browseCatalog(0), 'Epic full catalog', 60_000),
    wrapSource(epicService.getFreeGames(), 'Epic free games'),
  ]);

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
  buildSearchIndex(deduplicated);

  // Save to IndexedDB (non-blocking)
  saveBrowseCache(deduplicated).catch(() => {});

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
  if (!prefetchedGames) return null;
  // Direct match
  const direct = prefetchedGames.find(g => g.id === id);
  if (direct) return direct;
  // Cross-store match (a game might be stored under its Steam ID but have a secondaryId for Epic or vice-versa)
  const secondary = prefetchedGames.find(g => g.secondaryId === id);
  if (secondary) return secondary;
  return null;
}

/**
 * Search prefetched games in-memory by title (case-insensitive substring).
 * Instant, no API calls needed. Falls back to null if no prefetched data.
 */
export function searchPrefetchedGames(
  query: string,
  limit: number = 20,
): Game[] | null {
  if (!prefetchedGames || !query.trim()) return null;
  const q = query.toLowerCase().trim();
  const results: Game[] = [];

  // Use the pre-computed lowercase index if available (avoids thousands
  // of .toLowerCase() calls on every keystroke).
  if (searchIndex && searchIndex.length === prefetchedGames.length) {
    for (let i = 0; i < searchIndex.length; i++) {
      const idx = searchIndex[i];
      if (idx.titleLower.includes(q) || idx.devLower.includes(q)) {
        results.push(prefetchedGames[i]);
        if (results.length >= limit) break;
      }
    }
  } else {
    // Fallback if index is stale or not built yet
    for (const game of prefetchedGames) {
      if (
        game.title.toLowerCase().includes(q) ||
        game.developer?.toLowerCase().includes(q)
      ) {
        results.push(game);
        if (results.length >= limit) break;
      }
    }
  }
  return results;
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
  buildSearchIndex(games);
  // Persist to IndexedDB silently
  saveBrowseCache(games).catch(() => {});
}

/**
 * Clear all cached data (used on manual refresh).
 */
export async function clearBrowseCache(): Promise<void> {
  prefetchedGames = null;
  prefetchReady = false;
  searchIndex = null;
  try {
    const w = getIdbWorker();
    w.postMessage({ type: 'clear' });
  } catch {
    /* ignore */
  }
}
