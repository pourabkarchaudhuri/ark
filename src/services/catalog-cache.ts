/**
 * Catalog Cache — persists the Steam app list (~155K entries) in IndexedDB
 * with a sync timestamp so we only re-fetch when stale (≥ 6 hours) or missing.
 *
 * This avoids hitting the Steam API on every app launch for data that rarely
 * changes, and makes Catalog (A-Z) mode available instantly from cache.
 */

import { SteamAppListItem } from '@/types/steam';

const DB_NAME = 'ark-catalog-cache';
const DB_VERSION = 1;
const STORE_NAME = 'appList';
const META_KEY = 'catalog-sync';

/** 6 hours in milliseconds */
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

interface CatalogMeta {
  key: string;
  syncedAt: number; // epoch ms
  count: number;
}

// ─── Module-level singleton DB handle ────────────────────────────────────────

let _db: IDBDatabase | null = null;
let _dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[CatalogCache] Failed to open IndexedDB:', request.error);
      _dbPromise = null;
      reject(request.error);
    };

    request.onsuccess = () => {
      _db = request.result;
      resolve(_db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // App list store — one row per app, keyed by appid
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'appid' });
      }

      // Metadata store for sync timestamp
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
  });

  return _dbPromise;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Returns the last sync timestamp (epoch ms), or 0 if never synced. */
export async function getCatalogSyncTime(): Promise<number> {
  try {
    const db = await getDB();
    return new Promise<number>((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(META_KEY);
      req.onsuccess = () => {
        const meta = req.result as CatalogMeta | undefined;
        resolve(meta?.syncedAt ?? 0);
      };
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

/** True if the cached catalog is missing or older than STALE_THRESHOLD_MS. */
export async function isCatalogStale(): Promise<boolean> {
  const syncedAt = await getCatalogSyncTime();
  if (syncedAt === 0) return true;
  return Date.now() - syncedAt >= STALE_THRESHOLD_MS;
}

/**
 * Load the cached app list from IndexedDB.  Returns [] if empty / error.
 *
 * By default the list is returned **unsorted** (IDB key order = appid).
 * Pass `sorted: true` to get the list sorted A-Z by name.  Sorting 155K+
 * items with `localeCompare` takes 3-10 s, so it should only be requested
 * when the user actually opens Catalog (A-Z) mode — never during the
 * background preload that just needs a count.
 */
export async function getCachedCatalog(opts?: { sorted?: boolean }): Promise<SteamAppListItem[]> {
  try {
    const db = await getDB();
    return new Promise<SteamAppListItem[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const items = req.result as SteamAppListItem[];
        if (opts?.sorted) {
          sortCatalogAZ(items);
        }
        resolve(items);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Sort a catalog array A-Z by title using pre-computed lowercase keys.
 * ~10-30× faster than `localeCompare` for 155K items (300ms vs 5-10s).
 * Mutates the array in-place and returns it for chaining.
 */
export function sortCatalogAZ(items: SteamAppListItem[]): SteamAppListItem[] {
  // Pre-compute lowercase keys once (O(n)), then sort with simple string
  // comparison (O(n log n) with O(1) comparator) instead of calling
  // localeCompare inside the comparator (which is O(n log n) × locale overhead).
  const keys = new Array<string>(items.length);
  for (let i = 0; i < items.length; i++) {
    keys[i] = items[i].name.toLowerCase();
  }
  // Build index array and sort by pre-computed key
  const indices = Array.from({ length: items.length }, (_, i) => i);
  indices.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  // Reorder in-place via a temporary copy
  const copy = items.slice();
  for (let i = 0; i < indices.length; i++) {
    items[i] = copy[indices[i]];
  }
  return items;
}

/**
 * Persist an app list to IndexedDB and update the sync timestamp.
 * Clears the old data first to avoid stale leftovers.
 */
export async function setCachedCatalog(apps: SteamAppListItem[]): Promise<void> {
  try {
    const db = await getDB();

    // 1. Clear + bulk-insert app list
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const app of apps) {
        store.put(app);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 2. Write metadata
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const meta: CatalogMeta = { key: META_KEY, syncedAt: Date.now(), count: apps.length };
      const req = tx.objectStore('meta').put(meta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    console.log(`[CatalogCache] Persisted ${apps.length} apps to IndexedDB`);
  } catch (err) {
    console.warn('[CatalogCache] Failed to persist catalog:', err);
  }
}

/** Clear both the app list and the sync metadata. */
export async function clearCatalogCache(): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, 'meta'], 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore('meta').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log('[CatalogCache] Cache cleared');
  } catch (err) {
    console.warn('[CatalogCache] Failed to clear cache:', err);
  }
}
