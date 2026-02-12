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

// Heavy fields that are only needed on the detail page (not browse cards)
const STRIP_KEYS = ['screenshots', 'videos', 'summary', 'movies', 'detailedDescription', 'aboutTheGame'];

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

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(BROWSE_DB_NAME, BROWSE_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      dbInstance = req.result;
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

function slimGames(games: any[]): any[] {
  return games.map((game) => {
    const slim: any = {};
    for (const key of Object.keys(game)) {
      if (!STRIP_KEYS.includes(key)) {
        slim[key] = game[key];
      }
    }
    return slim;
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  if (type === 'save') {
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
    } catch {
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
    } catch {
      self.postMessage({ type: 'clear-done', error: true });
    }
  }
};
