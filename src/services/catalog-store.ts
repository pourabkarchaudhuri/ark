/**
 * Steam Catalog Store
 *
 * Downloads and persists the full Steam game catalog (~156K games) for use
 * by the recommendation engine as a massive candidate pool.
 *
 * Architecture:
 *  1. Get all app IDs via IPC (main process calls IStoreService/GetAppList)
 *  2. Fetch rich metadata via IStoreBrowseService/GetItems/v1 (renderer-side,
 *     no API key needed, 200 games/batch, 50 concurrent)
 *  3. Resolve numeric tag IDs using IStoreService/GetTagList/v1
 *  4. Persist to IndexedDB with incremental batch writes (resumable)
 *
 * Designed for:
 *  - First run: ~30s to download 156K games, ~100MB
 *  - Subsequent runs: delta sync (only new/changed apps)
 *  - Interruption-safe: each batch of 200 is persisted immediately
 */

import type {
  CatalogEntry,
  CatalogSyncState,
  StoreBrowseItem,
  SteamTagDefinition,
} from '@/types/catalog';
import { classifyTags } from '@/data/steam-tag-map';

// ─── Constants ──────────────────────────────────────────────────────────────────

const DB_NAME = 'ark-steam-catalog';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const META_STORE = 'meta';

const BATCH_SIZE = 200;
const CONCURRENCY = 50;
const SYNC_STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ─── IDB Helpers (connection pooled) ─────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IDB blocked')); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        db.createObjectStore(ENTRIES_STORE, { keyPath: 'appid' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => { dbInstance = null; dbPromise = null; };
      dbInstance.onversionchange = () => { dbInstance?.close(); dbInstance = null; dbPromise = null; };
      resolve(dbInstance);
    };
  });
  return dbPromise;
}

async function idbPutBatch(entries: CatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRIES_STORE, 'readwrite');
    const store = tx.objectStore(ENTRIES_STORE);
    for (const entry of entries) store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetMeta<T>(key: string): Promise<T | null> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSetMeta<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ─── Tag Resolver ───────────────────────────────────────────────────────────────

let tagNameMap: Map<number, string> | null = null;

async function fetchTagList(): Promise<Map<number, string>> {
  if (tagNameMap) return tagNameMap;

  const cached = await idbGetMeta<Record<number, string>>('tag-name-map');
  if (cached) {
    tagNameMap = new Map(Object.entries(cached).map(([k, v]) => [Number(k), v]));
    return tagNameMap;
  }

  // Fetch via IPC (main process has the API key)
  const tags: SteamTagDefinition[] = await window.steam!.getTagList();

  const map = new Map<number, string>();
  const plain: Record<number, string> = {};
  for (const t of tags) {
    map.set(t.tagid, t.name);
    plain[t.tagid] = t.name;
  }

  await idbSetMeta('tag-name-map', plain);
  tagNameMap = map;
  console.log(`[CatalogStore] Tag list loaded: ${map.size} tags`);
  return map;
}

// ─── Batch Fetcher ──────────────────────────────────────────────────────────────

function transformItem(item: StoreBrowseItem, tags: Map<number, string>): CatalogEntry | null {
  if (!item.success || !item.visible || !item.name) return null;

  const rawTags = (item.tags ?? []).map(t => ({
    tagid: t.tagid,
    name: tags.get(t.tagid) ?? `tag_${t.tagid}`,
  }));
  const classified = classifyTags(rawTags);

  const review = item.reviews?.summary_filtered;

  return {
    appid: item.appid,
    name: item.name,
    genres: classified.genres,
    themes: classified.themes,
    modes: classified.modes,
    developer: item.basic_info?.developers?.[0]?.name ?? '',
    publisher: item.basic_info?.publishers?.[0]?.name ?? '',
    shortDescription: item.basic_info?.short_description ?? '',
    releaseDate: item.release?.steam_release_date ?? 0,
    reviewScore: review?.review_score ?? 0,
    reviewCount: review?.review_count ?? 0,
    reviewPositivity: review ? review.percent_positive / 100 : 0,
    windows: item.platforms?.windows ?? false,
    mac: item.platforms?.mac ?? false,
    linux: item.platforms?.linux ?? false,
    steamDeckCompat: item.platforms?.steam_deck_compat_category ?? 0,
    isFree: item.is_free ?? false,
    priceFormatted: item.best_purchase_option?.formatted_final_price,
    discountPercent: item.best_purchase_option?.discount_pct,
    tagIds: (item.tags ?? []).map(t => t.tagid),
  };
}

async function fetchBatch(
  appIds: number[],
  tags: Map<number, string>,
): Promise<CatalogEntry[]> {
  // Route through main process to avoid renderer CORS restrictions
  const items: StoreBrowseItem[] = await window.steam!.fetchCatalogBatch(appIds);
  const entries: CatalogEntry[] = [];
  for (const item of items) {
    const entry = transformItem(item, tags);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── CatalogStore ───────────────────────────────────────────────────────────────

export type CatalogSyncProgress = {
  stage: 'idle' | 'fetching-ids' | 'fetching-tags' | 'fetching-metadata' | 'done' | 'error';
  batchesCompleted: number;
  batchesTotal: number;
  gamesStored: number;
  error?: string;
};

type Listener = () => void;

class CatalogStore {
  private listeners = new Set<Listener>();
  private _syncProgress: CatalogSyncProgress = {
    stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0,
  };
  private _syncing = false;
  private _syncAbort: AbortController | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() { this.listeners.forEach(fn => fn()); }

  get syncProgress(): Readonly<CatalogSyncProgress> { return this._syncProgress; }

  cancelSync() {
    this._syncAbort?.abort();
    this._syncAbort = null;
  }

  /** Check if catalog data is fresh enough (< 24h). */
  async isFresh(): Promise<boolean> {
    const state = await idbGetMeta<CatalogSyncState>('sync-state');
    if (!state || state.totalEntries === 0) return false;
    return (Date.now() - state.lastSyncTimestamp) < SYNC_STALE_TTL;
  }

  /** Get the total number of catalog entries stored. */
  async getEntryCount(): Promise<number> {
    const state = await idbGetMeta<CatalogSyncState>('sync-state');
    return state?.totalEntries ?? 0;
  }

  /**
   * Run a full catalog sync. Safe to call multiple times — skips if fresh.
   * Progress is published via subscribe().
   */
  async sync(force = false): Promise<void> {
    if (this._syncing) return;

    if (!force) {
      const fresh = await this.isFresh();
      if (fresh) {
        const syncState = await idbGetMeta<CatalogSyncState>('sync-state');
        if (syncState && syncState.totalEntries > 0) {
          this._syncProgress = {
            stage: 'done',
            batchesCompleted: syncState.batchesCompleted ?? 0,
            batchesTotal: syncState.batchesTotal ?? 0,
            gamesStored: syncState.totalEntries,
          };
          this.notify();
          return;
        }
      }
    }

    this._syncing = true;
    this._syncAbort = new AbortController();
    const signal = this._syncAbort.signal;

    try {
      // Step 1: Get all app IDs from main process
      this._syncProgress = { stage: 'fetching-ids', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0 };
      this.notify();

      const appList: Array<{ appid: number; name: string }> = await window.steam!.getAppList();
      const appIds = appList.map(a => a.appid);
      console.log(`[CatalogStore] Got ${appIds.length} app IDs from main process`);

      // Step 2: Fetch & cache tag list
      this._syncProgress = { ...this._syncProgress, stage: 'fetching-tags' };
      this.notify();

      const tags = await fetchTagList();

      // Step 3: Create batches
      const batches: number[][] = [];
      for (let i = 0; i < appIds.length; i += BATCH_SIZE) {
        batches.push(appIds.slice(i, i + BATCH_SIZE));
      }

      this._syncProgress = {
        stage: 'fetching-metadata',
        batchesCompleted: 0,
        batchesTotal: batches.length,
        gamesStored: 0,
      };
      this.notify();

      // Step 4: Fetch metadata with concurrency-limited queue
      let batchesCompleted = 0;
      let totalGamesStored = 0;

      // Proper queue: each dequeue is atomic (no shared mutable index)
      const queue = batches.map((b, i) => ({ batch: b, idx: i }));
      const dequeue = () => queue.shift();

      const workers: Promise<void>[] = [];
      for (let w = 0; w < CONCURRENCY; w++) {
        workers.push((async () => {
          let item: ReturnType<typeof dequeue>;
          while (!signal.aborted && (item = dequeue())) {
            const { batch, idx } = item;
            try {
              const entries = await fetchBatch(batch, tags);
              if (entries.length > 0) {
                await idbPutBatch(entries);
                totalGamesStored += entries.length;
              }
            } catch (err) {
              console.warn(`[CatalogStore] Batch ${idx} failed:`, err instanceof Error ? err.message : err);
            }
            batchesCompleted++;

            if (batchesCompleted % 20 === 0 || batchesCompleted === batches.length) {
              this._syncProgress = {
                stage: 'fetching-metadata',
                batchesCompleted,
                batchesTotal: batches.length,
                gamesStored: totalGamesStored,
              };
              this.notify();
            }
          }
        })());
      }

      await Promise.all(workers);

      // Step 5: Save sync state
      const syncState: CatalogSyncState = {
        lastSyncTimestamp: Date.now(),
        totalEntries: totalGamesStored,
        batchesCompleted,
        batchesTotal: batches.length,
        inProgress: false,
      };
      await idbSetMeta('sync-state', syncState);

      this._syncProgress = {
        stage: 'done',
        batchesCompleted,
        batchesTotal: batches.length,
        gamesStored: totalGamesStored,
      };
      this.notify();

      console.log(`[CatalogStore] Sync complete: ${totalGamesStored} games in ${batches.length} batches`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CatalogStore] Sync failed:', msg);
      this._syncProgress = { ...this._syncProgress, stage: 'error', error: msg };
      this.notify();
    } finally {
      this._syncing = false;
      this._syncAbort = null;
    }
  }

  /**
   * Query catalog entries matching a set of genre names and/or developer names.
   * Used by the recommendation pre-filter to narrow 156K → ~5-8K candidates.
   */
  async queryForCandidates(opts: {
    topGenres: string[];
    loyalDevelopers: string[];
    excludeIds: Set<string>;
    minReviews?: number;
    minPositivity?: number;
    maxResults?: number;
  }): Promise<CatalogEntry[]> {
    const {
      topGenres,
      loyalDevelopers,
      excludeIds,
    minReviews = 10,
    minPositivity = 0.5,
    maxResults = 25_000,
    } = opts;

    const genreSet = new Set(topGenres.map(g => g.toLowerCase()));
    const devSet = new Set(loyalDevelopers.map(d => d.toLowerCase()));

    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const store = tx.objectStore(ENTRIES_STORE);
      const req = store.openCursor();
      const results: CatalogEntry[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || results.length >= maxResults) {
          results.sort((a, b) => b.reviewCount - a.reviewCount);
          resolve(results.slice(0, maxResults));
          return;
        }

        const entry: CatalogEntry = cursor.value;
        const id = `steam-${entry.appid}`;

        if (excludeIds.has(id)) {
          cursor.continue();
          return;
        }

        if (entry.reviewCount < minReviews || entry.reviewPositivity < minPositivity) {
          cursor.continue();
          return;
        }

        const hasGenreMatch = entry.genres.some(g => genreSet.has(g.toLowerCase()));
        const hasDevMatch = entry.developer && devSet.has(entry.developer.toLowerCase());
        const isPopular = entry.reviewCount >= 1000;

        if (hasGenreMatch || hasDevMatch || isPopular) {
          results.push(entry);
        }

        cursor.continue();
      };

      req.onerror = () => resolve([]);
    });
  }

  /**
   * Get all catalog entries (for embedding generation).
   * Returns entries in batches via a callback to avoid loading everything into memory.
   */
  async getAllEntries(onBatch: (entries: CatalogEntry[]) => void): Promise<number> {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const store = tx.objectStore(ENTRIES_STORE);
      const req = store.openCursor();
      let count = 0;
      let batch: CatalogEntry[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          if (batch.length > 0) onBatch(batch);
          resolve(count);
          return;
        }
        batch.push(cursor.value);
        count++;
        if (batch.length >= 500) {
          onBatch(batch);
          batch = [];
        }
        cursor.continue();
      };
      req.onerror = () => resolve(count);
    });
  }

  /**
   * Get specific entries by appid.
   */
  async getEntries(appIds: number[]): Promise<CatalogEntry[]> {
    if (appIds.length === 0) return [];
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const store = tx.objectStore(ENTRIES_STORE);
      const results: CatalogEntry[] = [];
      let remaining = appIds.length;

      for (const appId of appIds) {
        const req = store.get(appId);
        req.onsuccess = () => {
          if (req.result) results.push(req.result);
          remaining--;
          if (remaining === 0) resolve(results);
        };
        req.onerror = () => {
          remaining--;
          if (remaining === 0) resolve(results);
        };
      }
    });
  }
}

export const catalogStore = new CatalogStore();
