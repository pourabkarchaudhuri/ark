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
// In-memory state  (survives Vite HMR via globalThis stash)
// ---------------------------------------------------------------------------

// During development, Vite HMR re-executes this module on every save, which
// would wipe the in-memory game cache and break the browse grid.  We stash
// the state on globalThis so it survives module re-initialization.
export interface SearchIndexEntry {
  titleLower: string;
  /** Title stripped of all non-alphanumeric characters for fuzzy/token matching */
  titleNorm: string;
  /** Individual lowercase words from the title */
  titleWords: string[];
  devLower: string;
  pubLower: string;
  genresLower: string[];
}

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
      const titleLower = g.title.toLowerCase();
      result[i] = {
        titleLower,
        titleNorm: titleLower.replace(/[^a-z0-9\s]/g, ''),
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
      const titleLower = g.title.toLowerCase();
      result[i] = {
        titleLower,
        titleNorm: titleLower.replace(/[^a-z0-9\s]/g, ''),
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
// Scoring helpers — used by searchPrefetchedGames and exported for library
// ---------------------------------------------------------------------------

/**
 * Simple edit-distance check: returns true if `a` and `b` are within
 * `maxDist` Levenshtein edits.  Uses an early-exit bounded algorithm
 * so it stays fast even on long strings (O(n * maxDist) instead of O(n*m)).
 */
function isWithinEditDistance(a: string, b: string, maxDist: number): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return false;
  if (la === 0) return lb <= maxDist;
  if (lb === 0) return la <= maxDist;

  // Bounded Levenshtein using two rows
  let prev = new Uint16Array(lb + 1);
  let curr = new Uint16Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let minVal = curr[0];
    const jStart = Math.max(1, i - maxDist);
    const jEnd = Math.min(lb, i + maxDist);
    // Fill out-of-band cells with maxDist+1 so they're never picked
    if (jStart > 1) curr[jStart - 1] = maxDist + 1;
    for (let j = jStart; j <= jEnd; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < minVal) minVal = curr[j];
    }
    // Fill remaining out-of-band
    if (jEnd < lb) curr[jEnd + 1] = maxDist + 1;
    if (minVal > maxDist) return false; // early exit
    [prev, curr] = [curr, prev];
  }
  return prev[lb] <= maxDist;
}

/**
 * Score a game against a set of query tokens.  Higher is more relevant.
 * Returns 0 if no match.
 *
 * Scoring tiers (cumulative across tokens):
 *   200 — exact full-title match
 *   100 — title starts with the full query
 *    60 — every token starts a word boundary in the title
 *    40 — every token is a substring of the title
 *    20 — token matches developer or publisher
 *    10 — token matches a genre
 *     5 — fuzzy match (within 1-2 edit distance of a title word)
 *
 * Bonus:  +1 per 1000 metacriticScore (subtle tiebreaker for popular games)
 */
export function scoreGame(
  idx: SearchIndexEntry,
  tokens: string[],
  fullQuery: string,
  game?: Game | null,
): number {
  let score = 0;

  // Exact full-title match
  if (idx.titleLower === fullQuery) return 200 + (game?.metacriticScore ?? 0) / 1000;
  // Title starts with full query
  if (idx.titleLower.startsWith(fullQuery)) score = Math.max(score, 100);

  let allTokensMatchTitle = true;
  let allTokensWordBoundary = true;

  for (const token of tokens) {
    const tLen = token.length;
    let tokenMatchedTitle = false;
    let tokenWordBoundary = false;

    // Word-boundary check: does a title word start with this token?
    for (const word of idx.titleWords) {
      if (word.startsWith(token)) {
        tokenWordBoundary = true;
        tokenMatchedTitle = true;
        break;
      }
    }

    // Substring check
    if (!tokenMatchedTitle && idx.titleLower.includes(token)) {
      tokenMatchedTitle = true;
    }

    if (!tokenMatchedTitle) allTokensMatchTitle = false;
    if (!tokenWordBoundary) allTokensWordBoundary = false;

    // Developer / publisher substring
    if (idx.devLower.includes(token) || idx.pubLower.includes(token)) {
      score += 20;
    }

    // Genre match
    if (idx.genresLower.some(g => g.includes(token))) {
      score += 10;
    }

    // Fuzzy match against title words (only for tokens of 4+ chars to avoid false positives)
    if (!tokenMatchedTitle && tLen >= 4) {
      const maxDist = tLen <= 5 ? 1 : 2;
      for (const word of idx.titleWords) {
        if (isWithinEditDistance(token, word, maxDist)) {
          score += 5;
          tokenMatchedTitle = true; // count it for the "all tokens" check
          break;
        }
      }
    }
  }

  if (allTokensMatchTitle && allTokensWordBoundary) score = Math.max(score, 60);
  else if (allTokensMatchTitle) score = Math.max(score, 40);

  // Small tiebreaker for popular games
  if (score > 0 && game) {
    score += (game.metacriticScore ?? 0) / 1000;
    if (game.playerCount) score += Math.min(game.playerCount / 100_000, 0.5);
  }

  return score;
}

/**
 * Build search index entry for a single game (used by library search).
 */
export function buildSingleSearchIndex(g: Game): SearchIndexEntry {
  const titleLower = g.title.toLowerCase();
  return {
    titleLower,
    titleNorm: titleLower.replace(/[^a-z0-9\s]/g, ''),
    titleWords: titleLower.split(/\s+/).filter(Boolean),
    devLower: (g.developer || '').toLowerCase(),
    pubLower: (g.publisher || '').toLowerCase(),
    genresLower: (g.genre || []).map(genre => genre.toLowerCase()),
  };
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
