/**
 * Web Worker: IndexedDB Browse Cache
 *
 * Owns the IDBDatabase connection and handles save/load operations
 * so the main thread never blocks on structured-clone serialization
 * of 6000+ game objects.
 *
 * Messages:
 *   → { type: 'save', games: Game[] }  — slim & persist to IDB
 *   → { type: 'load' }                 — read from IDB, post back result
 *   ← { type: 'save-done' }
 *   ← { type: 'load-result', data: { games, isFresh } | null }
 */

// We don't import Game type to keep the worker dependency-free.
// The game objects are passed as plain objects.

const BROWSE_DB_NAME = 'ark-browse-cache';
const BROWSE_DB_VERSION = 1;
const BROWSE_STORE = 'data';
const CACHE_KEY = 'browse-games';
const CACHE_TTL = 60 * 60 * 1000;              // 1 hour fresh (aligned with bg refresh interval)
const CACHE_STALE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days stale-usable (hourly bg refresh keeps data current)

// Bump this whenever the dedup/merge logic changes to invalidate old cached
// game objects that are missing new cross-store fields (epicSlug, availableOn, etc.)
const CACHE_FORMAT_VERSION = 2;

// Heavy fields stripped from browse cache (summary kept for reco engine embeddings).
// Only fields browse games actually carry: `detailedDescription` / `aboutTheGame` were listed
// here but no Game object has them, while the Steam `longDescription` HTML went through whole.
const STRIP_KEYS = ['screenshots', 'videos', 'movies'];

/**
 * Cap on the cached `longDescription`: the adult-content filter reads only the first 1500
 * characters (`getCombinedText`), and browse cards never show it. The detail page fetches
 * the full description itself.
 */
export const LONG_DESCRIPTION_CACHE_CHARS = 1500;

interface BrowseCacheEntry {
  key: string;
  games: any[];
  timestamp: number;
  formatVersion?: number;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

/** Drop the cached connection so the next call reopens (failed open, closed or stale handle). */
function resetDB(): void {
  dbInstance = null;
  dbPromise = null;
}

/** Test hook — module state otherwise outlives individual tests. */
export function __resetIdbCacheWorkerForTests(): void {
  try { dbInstance?.close(); } catch { /* ignore */ }
  resetDB();
}

/**
 * Same reset pattern as catalog-store's getDB: a failed open used to stay
 * cached as a rejected promise, so every later save/load failed for the rest
 * of the session and the next launch re-fetched everything.
 */
function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(BROWSE_DB_NAME, BROWSE_DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IDB blocked')); };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => { resetDB(); };
      dbInstance.onversionchange = () => { dbInstance?.close(); resetDB(); };
      resolve(dbInstance);
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(BROWSE_STORE)) {
        db.createObjectStore(BROWSE_STORE, { keyPath: 'key' });
      }
    };
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Slim game objects — strip heavy detail fields before caching
// ---------------------------------------------------------------------------

/**
 * Plain-text, capped `longDescription` for the cache. Truncates the raw text to the same
 * window the adult filter reads (trim + first 1500 chars) BEFORE stripping tags, so the
 * filter never sees text from further in than it did on the raw HTML, and replaces each
 * tag with a space so words on either side of a tag stay separate.
 */
export function slimLongDescription(raw: string): string {
  if (!raw) return raw;
  const window = raw.trim().slice(0, LONG_DESCRIPTION_CACHE_CHARS);
  return window
    .replace(/<[^>]*>?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slimGames(games: any[]): any[] {
  return games.map((game) => {
    const slim: any = {};
    for (const key of Object.keys(game)) {
      if (!STRIP_KEYS.includes(key)) {
        slim[key] = game[key];
      }
    }
    if (typeof slim.longDescription === 'string' && slim.longDescription) {
      slim.longDescription = slimLongDescription(slim.longDescription);
    }
    return slim;
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/** `db.transaction()` on a connection the browser already closed throws InvalidStateError: reopen next time. */
function dropIfStale(err: unknown): void {
  if ((err as { name?: string } | null)?.name === 'InvalidStateError') resetDB();
}

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === 'save') {
    // An empty set would replace a usable 7-day cache with nothing (offline / every source failed).
    if (!Array.isArray(e.data.games) || e.data.games.length === 0) {
      self.postMessage({ type: 'save-done', skipped: true });
      return;
    }
    try {
      const db = await openDB();
      const slimmed = slimGames(e.data.games);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BROWSE_STORE, 'readwrite');
        const store = tx.objectStore(BROWSE_STORE);
        const entry: BrowseCacheEntry = {
          key: CACHE_KEY,
          games: slimmed,
          timestamp: Date.now(),
          formatVersion: CACHE_FORMAT_VERSION,
        };
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      self.postMessage({ type: 'save-done' });
    } catch (err) {
      dropIfStale(err);
      console.warn('[IDB Worker] Failed to save:', err);
      self.postMessage({ type: 'save-done', error: true });
    }
  } else if (type === 'load') {
    try {
      const db = await openDB();
      const result = await new Promise<{ games: any[]; isFresh: boolean } | null>((resolve) => {
        const tx = db.transaction(BROWSE_STORE, 'readonly');
        const store = tx.objectStore(BROWSE_STORE);
        const req = store.get(CACHE_KEY);

        req.onsuccess = () => {
          const entry = req.result as BrowseCacheEntry | undefined;
          if (!entry?.games || entry.games.length === 0) {
            resolve(null);
            return;
          }
          const age = Date.now() - entry.timestamp;
          if (age > CACHE_STALE_TTL) {
            resolve(null);
            return;
          }
          // If the cache was written by an older format version (missing
          // cross-store fields etc.), treat it as stale so a fresh
          // fetch + dedup runs.
          const versionMatch = (entry.formatVersion ?? 0) >= CACHE_FORMAT_VERSION;
          resolve({ games: entry.games, isFresh: versionMatch && age <= CACHE_TTL });
        };
        req.onerror = () => resolve(null);
      });
      self.postMessage({ type: 'load-result', data: result });
    } catch (err) {
      dropIfStale(err);
      self.postMessage({ type: 'load-result', data: null });
    }
  } else if (type === 'clear') {
    try {
      const db = await openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BROWSE_STORE, 'readwrite');
        const store = tx.objectStore(BROWSE_STORE);
        store.delete(CACHE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      self.postMessage({ type: 'clear-done' });
    } catch (err) {
      dropIfStale(err);
      self.postMessage({ type: 'clear-done', error: true });
    }
  }
};
