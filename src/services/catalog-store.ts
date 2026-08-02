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
 *  4. Persist to LevelDB (v1.0.65+) with incremental batch writes (resumable).
 *     Legacy IndexedDB (`ark-steam-catalog`) is read one-shot on first launch
 *     after upgrade to hydrate the new store, then left in place for one
 *     release as rollback insurance.
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
const CONCURRENCY = 8;
const SYNC_STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * LevelDB namespaces (v1.0.65+).
 *   - `catalog-entries`  → per-appid CatalogEntry rows keyed as `${appid}`.
 *   - `catalog-meta`     → 'tag-name-map' and 'sync-state' rows.
 * Two namespaces so prefix scans over meta don't walk 155k entry rows,
 * and vice versa.
 */
const LEVEL_ENTRIES_NAMESPACE = 'catalog-entries';
const LEVEL_META_NAMESPACE = 'catalog-meta';
const LEVEL_CHUNK_SIZE = 1000; // rows per getChunk hop (renderer-side pagination)
const LEVEL_MIGRATION_MARKER_KEY = 'ark-steam-catalog-migrated-v1';
// Point-lookup (getEntries) round-trip size — kept comfortably under the
// store:get rate limiter's 500/s-per-channel-per-sender budget so any
// caller, regardless of how many ids it passes in one call, stays safe.
const POINT_LOOKUP_CHUNK = 400;

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

/**
 * Cursor-stream every IDB entry, invoking `onBatch` with up to `size`
 * entries per hop. Used only for the one-shot IDB → LevelDB migration.
 */
async function idbStreamAllEntries(
  onBatch: (entries: CatalogEntry[]) => Promise<void>,
  size = 500,
): Promise<number> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRIES_STORE, 'readonly');
    const store = tx.objectStore(ENTRIES_STORE);
    const req = store.openCursor();
    let count = 0;
    let batch: CatalogEntry[] = [];
    // Buffer for `onBatch` calls that outlive a cursor tick — the cursor
    // must not `continue()` until the async batch write finishes.
    let pending: Promise<void> = Promise.resolve();
    // Set as soon as any batch write rejects. Once true, the cursor stops
    // advancing (see below) so we never silently drop further batches by
    // chaining `.then()` onto an already-rejected `pending` — every batch
    // we have already read but not yet flushed is either flushed or
    // accounted for in the final rejection.
    let failed: unknown = null;

    req.onsuccess = async () => {
      const cursor = req.result;
      if (failed) {
        // A previous batch write already failed — stop reading further rows.
        // `pending` is already rejected; let the tx wind down naturally.
        return;
      }
      if (!cursor) {
        try {
          await pending;
          if (batch.length > 0) await onBatch(batch);
          resolve(count);
        } catch (err) {
          reject(err);
        }
        return;
      }
      batch.push(cursor.value as CatalogEntry);
      count++;
      if (batch.length >= size) {
        const drain = batch;
        batch = [];
        pending = pending.then(() => onBatch(drain)).catch((err) => {
          failed = err;
          throw err;
        });
      }
      if (failed) return; // the batch we just queued may have already settled synchronously as a rejection
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('[CatalogStore] IDB cursor error during migration stream'));
  });
}

// ─── LevelDB Helpers ────────────────────────────────────────────────────────────

function useLevelDB(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
}

async function levelPutBatch(entries: CatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const ops = entries.map((e) => ({
    type: 'put' as const,
    namespace: LEVEL_ENTRIES_NAMESPACE,
    key: String(e.appid),
    value: e,
  }));
  const res = await window.store!.batch(ops);
  if (res.error) {
    throw new Error(`[CatalogStore] batch put failed: ${res.error}`);
  }
}

async function levelGetMeta<T>(key: string): Promise<T | null> {
  const res = await window.store!.get<T>(LEVEL_META_NAMESPACE, key);
  if (res.error) {
    console.error(`[CatalogStore] meta get(${key}) failed:`, res.error);
    return null;
  }
  return (res.value ?? null) as T | null;
}

async function levelSetMeta<T>(key: string, value: T): Promise<void> {
  const res = await window.store!.put(LEVEL_META_NAMESPACE, key, value);
  if (res.error) {
    console.error(`[CatalogStore] meta put(${key}) failed:`, res.error);
  }
}

/**
 * Chunked walk of every LevelDB entry row, invoking `onEntry` per row.
 * Returns total rows visited. Uses `store.getChunk` under the hood so
 * we never marshal all 155k rows at once.
 */
async function levelStreamAllEntries(
  onEntry: (entry: CatalogEntry) => void,
): Promise<number> {
  let startAfter: string | undefined;
  let total = 0;
  while (true) {
    const res = await window.store!.getChunk<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, {
      startAfter,
      limit: LEVEL_CHUNK_SIZE,
    });
    if (res.error) {
      console.error('[CatalogStore] getChunk failed:', res.error);
      break;
    }
    const rows = res.rows ?? [];
    for (const row of rows) {
      onEntry(row.value);
      total++;
    }
    if (res.done || !res.nextKey) break;
    startAfter = res.nextKey;
  }
  return total;
}

// ─── Tag Resolver ───────────────────────────────────────────────────────────────

let tagNameMap: Map<number, string> | null = null;

async function fetchTagList(): Promise<Map<number, string>> {
  if (tagNameMap) return tagNameMap;

  const cached = useLevelDB()
    ? await levelGetMeta<Record<number, string>>('tag-name-map')
    : await idbGetMeta<Record<number, string>>('tag-name-map');
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

  if (useLevelDB()) await levelSetMeta('tag-name-map', plain);
  else await idbSetMeta('tag-name-map', plain);

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

async function putEntriesBatch(entries: CatalogEntry[]): Promise<void> {
  if (useLevelDB()) return levelPutBatch(entries);
  return idbPutBatch(entries);
}

async function getMeta<T>(key: string): Promise<T | null> {
  if (useLevelDB()) return levelGetMeta<T>(key);
  return idbGetMeta<T>(key);
}

async function setMeta<T>(key: string, value: T): Promise<void> {
  if (useLevelDB()) return levelSetMeta(key, value);
  return idbSetMeta(key, value);
}

// ─── CatalogStore ───────────────────────────────────────────────────────────────

export type CatalogSyncProgress = {
  stage: 'idle' | 'migrating' | 'fetching-ids' | 'fetching-tags' | 'fetching-metadata' | 'done' | 'error';
  batchesCompleted: number;
  batchesTotal: number;
  gamesStored: number;
  error?: string;
};

type Listener = () => void;

export class CatalogStore {
  private listeners = new Set<Listener>();
  private _syncProgress: CatalogSyncProgress = {
    stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0,
  };
  private _syncing = false;
  private _syncAbort: AbortController | null = null;
  /**
   * Guard against re-running the one-shot IDB→LevelDB migration within a
   * single session. Set to true ONLY after the marker is stamped (real
   * success) or after we confirm the marker is already set. Left false on
   * any failure so a later call (this session or a future launch) retries.
   */
  private _migrationChecked = false;
  /**
   * In-flight migration promise, shared by every concurrent caller so two
   * callers can never independently run — and prematurely conclude —
   * their own copy of the migration. `null` when no migration is running.
   */
  private _migrationPromise: Promise<void> | null = null;

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

  /**
   * One-shot IDB → LevelDB migration, memoized so every concurrent caller
   * (isFresh, getEntryCount, sync, queryForCandidates, getAllEntries,
   * getEntries all call this first) shares exactly one in-flight attempt
   * instead of racing independent copies.
   *
   * Deliberately does NOT trust a `store.has()` "namespace is non-empty"
   * check as proof of a complete prior migration — that check cannot
   * distinguish "fully migrated" from "a previous attempt partially wrote
   * some batches before crashing," and treating it as proof let stale/
   * partial meta be read as if the whole catalog were present. Instead,
   * every attempt (while the marker is unset) re-streams the ENTIRE IDB
   * `entries` store. This is safe and cheap to repeat because
   * `levelPutBatch` is a keyed overwrite (`put` by `String(appid)`), so
   * re-writing rows that already migrated is a no-op in effect, not a
   * duplicate. The marker + `sync-state` meta are only written AFTER the
   * full stream completes successfully, using the ACTUAL migrated count —
   * never the legacy IDB meta's (possibly stale/absent/non-atomic) claim.
   *
   * The migration is intentionally NOT abortable — cancelling mid-flight
   * would leave the LevelDB store in an ambiguous state. IDB is left in
   * place so a downgrade to v1.0.64 recovers cleanly.
   */
  private migrateFromIdbIfNeeded(): Promise<void> {
    if (this._migrationChecked) return Promise.resolve();
    if (!useLevelDB()) {
      this._migrationChecked = true;
      return Promise.resolve();
    }
    if (localStorage.getItem(LEVEL_MIGRATION_MARKER_KEY) === 'yes') {
      this._migrationChecked = true;
      return Promise.resolve();
    }
    if (this._migrationPromise) return this._migrationPromise;

    this._migrationPromise = this.runMigration().finally(() => {
      this._migrationPromise = null;
    });
    return this._migrationPromise;
  }

  private async runMigration(): Promise<void> {
    try {
      const legacyTagMap = await idbGetMeta<Record<number, string>>('tag-name-map');
      if (legacyTagMap) await levelSetMeta('tag-name-map', legacyTagMap);

      this._syncProgress = {
        stage: 'migrating',
        batchesCompleted: 0,
        batchesTotal: 0,
        gamesStored: 0,
      };
      this.notify();

      let migrated = 0;
      await idbStreamAllEntries(async (entries) => {
        await levelPutBatch(entries);
        migrated += entries.length;
        this._syncProgress = {
          stage: 'migrating',
          batchesCompleted: 0,
          batchesTotal: 0,
          gamesStored: migrated,
        };
        this.notify();
      }, 500);

      // Stream completed without throwing — persist the REAL count we just
      // wrote (not whatever IDB's possibly-stale/absent sync-state claims)
      // and only now stamp the marker.
      if (migrated > 0) {
        const legacySync = await idbGetMeta<CatalogSyncState>('sync-state');
        const state: CatalogSyncState = {
          lastSyncTimestamp: legacySync?.lastSyncTimestamp ?? Date.now(),
          totalEntries: migrated,
          batchesCompleted: legacySync?.batchesCompleted ?? 0,
          batchesTotal: legacySync?.batchesTotal ?? 0,
          inProgress: false,
        };
        await levelSetMeta('sync-state', state);
      }

      localStorage.setItem(LEVEL_MIGRATION_MARKER_KEY, 'yes');
      this._migrationChecked = true;
      console.log(`[CatalogStore] Migrated ${migrated} entries IDB -> LevelDB`);
      this._syncProgress = {
        stage: 'done',
        batchesCompleted: 0,
        batchesTotal: 0,
        gamesStored: migrated,
      };
      this.notify();
    } catch (err) {
      console.error('[CatalogStore] IDB->LevelDB migration failed, will retry on next attempt:', err);
      // Deliberately do NOT set _migrationChecked or stamp the marker —
      // leave both unset so a later call (this session or a future
      // launch) retries the full stream. IDB is untouched throughout, and
      // any entries already written to LevelDB this attempt are harmless
      // (they'll simply be overwritten again on retry).
      this._syncProgress = {
        stage: 'idle',
        batchesCompleted: 0,
        batchesTotal: 0,
        gamesStored: 0,
      };
      this.notify();
    }
  }

  /** Check if catalog data is fresh enough (< 24h). */
  async isFresh(): Promise<boolean> {
    await this.migrateFromIdbIfNeeded();
    const state = await getMeta<CatalogSyncState>('sync-state');
    if (!state || state.totalEntries === 0) return false;
    return (Date.now() - state.lastSyncTimestamp) < SYNC_STALE_TTL;
  }

  /** Get the total number of catalog entries stored. */
  async getEntryCount(): Promise<number> {
    await this.migrateFromIdbIfNeeded();
    const state = await getMeta<CatalogSyncState>('sync-state');
    return state?.totalEntries ?? 0;
  }

  /**
   * Timestamp of the last successful catalog sync (ms since epoch).
   * Returns 0 if no sync has ever completed. Used by the embedding service
   * as a watermark to skip the cursor scan when the catalog is unchanged.
   */
  async getLastSyncTimestamp(): Promise<number> {
    await this.migrateFromIdbIfNeeded();
    const state = await getMeta<CatalogSyncState>('sync-state');
    return state?.lastSyncTimestamp ?? 0;
  }

  /**
   * Run a full catalog sync. Safe to call multiple times — skips if fresh.
   * Progress is published via subscribe().
   */
  async sync(force = false): Promise<void> {
    if (this._syncing) return;
    await this.migrateFromIdbIfNeeded();

    if (!force) {
      const fresh = await this.isFresh();
      if (fresh) {
        const syncState = await getMeta<CatalogSyncState>('sync-state');
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
                await putEntriesBatch(entries);
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
      await setMeta('sync-state', syncState);

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
   *
   * v1.0.65+: LevelDB path streams via `getChunk` (default 1000 rows/hop) so
   * the full 155k-row scan never blocks IPC on a single-shot payload. IDB path
   * keeps the cursor semantics identical to pre-v1.0.65.
   */
  async queryForCandidates(opts: {
    topGenres: string[];
    loyalDevelopers: string[];
    loyalPublishers?: string[];
    excludeIds: Set<string>;
    minReviews?: number;
    minPositivity?: number;
    maxResults?: number;
    /** Cap for reviewCount-only admits (no genre/dev/pub match). Default 200. */
    maxPopularQuota?: number;
  }): Promise<CatalogEntry[]> {
    const {
      topGenres,
      loyalDevelopers,
      loyalPublishers = [],
      excludeIds,
    minReviews = 10,
    minPositivity = 0.5,
    maxResults = 25_000,
    maxPopularQuota = 200,
    } = opts;

    const genreSet = new Set(topGenres.map(g => g.toLowerCase()));
    const devSet = new Set(loyalDevelopers.map(d => d.toLowerCase()));
    const pubSet = new Set(loyalPublishers.map(p => p.toLowerCase()));

    await this.migrateFromIdbIfNeeded();

    const matched: CatalogEntry[] = [];
    const popularOnly: CatalogEntry[] = [];

    const admit = (entry: CatalogEntry) => {
      const id = `steam-${entry.appid}`;
      if (excludeIds.has(id)) return;
      if (entry.reviewCount < minReviews || entry.reviewPositivity < minPositivity) return;

      const hasGenreMatch = entry.genres.some(g => genreSet.has(g.toLowerCase()));
      const hasDevMatch = entry.developer && devSet.has(entry.developer.toLowerCase());
      const hasPubMatch = entry.publisher && pubSet.size > 0 && pubSet.has(entry.publisher.toLowerCase());

      if (hasGenreMatch || hasDevMatch || hasPubMatch) {
        matched.push(entry);
      } else if (entry.reviewCount >= 1000) {
        popularOnly.push(entry);
      }
    };

    if (useLevelDB()) {
      await levelStreamAllEntries(admit);
    } else {
      const db = await getDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(ENTRIES_STORE, 'readonly');
        const store = tx.objectStore(ENTRIES_STORE);
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          admit(cursor.value as CatalogEntry);
          cursor.continue();
        };
        req.onerror = () => resolve();
      });
    }

    popularOnly.sort((a, b) => b.reviewCount - a.reviewCount);
    const popularCap = popularOnly.slice(0, maxPopularQuota);
    const combined = [...matched, ...popularCap];
    combined.sort((a, b) => b.reviewCount - a.reviewCount);
    return combined.slice(0, maxResults);
  }

  /**
   * Get all catalog entries (for embedding generation).
   * Returns entries in batches via a callback to avoid loading everything
   * into memory. LevelDB path uses `getChunk` (1000/hop); IDB path uses a
   * cursor with a 500-row buffer.
   */
  async getAllEntries(onBatch: (entries: CatalogEntry[]) => void): Promise<number> {
    await this.migrateFromIdbIfNeeded();
    if (useLevelDB()) {
      let count = 0;
      let buffer: CatalogEntry[] = [];
      await levelStreamAllEntries((entry) => {
        buffer.push(entry);
        count++;
        if (buffer.length >= 500) {
          onBatch(buffer);
          buffer = [];
        }
      });
      if (buffer.length > 0) onBatch(buffer);
      return count;
    }
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
   *
   * On the LevelDB path, point-lookups are chunked internally
   * (`POINT_LOOKUP_CHUNK` per round-trip, run sequentially) rather than
   * firing every id in one `Promise.all`. `store:get` is rate-limited to
   * 500/s per channel per sender (see `electron/ipc/store-handlers.ts`);
   * a caller passing thousands of ids in one call (e.g. galaxy-cache's
   * embedding-enrichment pass) would otherwise burst past that budget in
   * a single tick. Chunking here means every caller gets the same safe
   * behavior without needing to know the IPC rate-limit internals.
   */
  async getEntries(appIds: number[]): Promise<CatalogEntry[]> {
    if (appIds.length === 0) return [];
    await this.migrateFromIdbIfNeeded();
    if (useLevelDB()) {
      const results: CatalogEntry[] = [];
      for (let i = 0; i < appIds.length; i += POINT_LOOKUP_CHUNK) {
        const slice = appIds.slice(i, i + POINT_LOOKUP_CHUNK);
        const gets = slice.map((id) => window.store!.get<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, String(id)));
        const settled = await Promise.all(gets);
        for (const res of settled) {
          if (res.value) results.push(res.value);
        }
      }
      return results;
    }
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
