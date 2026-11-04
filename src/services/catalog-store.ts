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
import { storeCountExisting, storeGetMany } from './store-bulk';
import { idbStreamStoreBatches } from './idb-stream';
import { levelStreamNamespace, type LevelScanResult } from './level-stream';
import { UpcomingSelector } from '@/lib/upcoming-select';
import { CandidateSelector } from '@/lib/candidate-selector';

// ─── Constants ──────────────────────────────────────────────────────────────────

const DB_NAME = 'ark-steam-catalog';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const META_STORE = 'meta';

const BATCH_SIZE = 200;
// Matches the main process's catalog throttle (CATALOG_MAX_INFLIGHT); 8 just queued behind it.
const CONCURRENCY = 4;
/** Retry round: skipped when more than this share of the first pass failed (offline / blocked). */
const RETRY_ROUND_MAX_RATIO = 0.25;
/** Retry round time budget — leftovers carry over to the next sync as `pendingAppIds`. */
const RETRY_ROUND_BUDGET_MS = 90_000;
/** After an incomplete run, automatic syncs wait this long before resuming the pending games. */
const INCOMPLETE_RETRY_COOLDOWN = 15 * 60 * 1000;
/** Shorter wait after a run that found no network at all (the first batches failed to connect). */
const OFFLINE_RETRY_COOLDOWN = 5 * 60 * 1000;
/**
 * A pass with this many connection failures in a row and no success is offline: stop issuing batches
 * (the rest used to be tried one by one, ~780 failing IPC calls and two retries each, for minutes).
 */
const OFFLINE_ABORT_AFTER = 8;
/** Connection-level failures (no DNS, no route, refused), as opposed to Steam answering with an error. */
const NETWORK_DOWN_RE = /ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY_CONNECTION_FAILED|CONNECTION_REFUSED)|ENOTFOUND|EAI_AGAIN/;
/** @internal exported for tests */
export const isNetworkDownError = (msg: string): boolean => NETWORK_DOWN_RE.test(msg);
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
/** Migration attempts per session before falling back to IDB for the rest of it (see migrateFromIdbIfNeeded). */
const MAX_MIGRATION_ATTEMPTS_PER_SESSION = 2;
/** A sync with more failed batches than this (after one retry round) is not stamped fresh. */
const MAX_FAILED_BATCH_RATIO = 0.01;

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
 * Rejects on the first failed batch write (see idb-stream.ts).
 */
async function idbStreamAllEntries(
  onBatch: (entries: CatalogEntry[]) => Promise<void>,
  size = 500,
): Promise<number> {
  const db = await getDB();
  return idbStreamStoreBatches<CatalogEntry>(db, ENTRIES_STORE, onBatch, size, '[CatalogStore]');
}

// ─── LevelDB Helpers ────────────────────────────────────────────────────────────

/**
 * Set when the IDB→LevelDB migration has failed MAX_MIGRATION_ATTEMPTS_PER_SESSION
 * times: the rest of the session reads and writes IDB (complete, and kept current),
 * and the next launch retries. Without it every store call re-streamed the whole
 * ~155k-row IDB store into LevelDB again (the v1.0.68 retry storm, catalog edition)
 * while reads hit the partially filled LevelDB namespace.
 */
let levelDisabledForSession = false;

/** Test hook — module state otherwise outlives individual CatalogStore instances. */
export function __resetCatalogStoreSessionState(): void {
  levelDisabledForSession = false;
}

function useLevelDB(): boolean {
  return !levelDisabledForSession && typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
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
 * Uses `store.getChunk` under the hood so we never marshal all 155k rows at
 * once. A hop that fails twice ends the walk with `complete: false`.
 */
async function levelStreamAllEntries(
  onEntry: (entry: CatalogEntry) => void,
): Promise<LevelScanResult> {
  return levelStreamNamespace<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, (row) => { onEntry(row.value); }, {
    pageSize: LEVEL_CHUNK_SIZE,
    label: '[CatalogStore]',
  });
}

// ─── Tag Resolver ───────────────────────────────────────────────────────────────

let tagNameMap: Map<number, string> | null = null;

async function fetchTagList(): Promise<Map<number, string>> {
  if (tagNameMap) return tagNameMap;

  const cached = useLevelDB()
    ? await levelGetMeta<Record<number, string>>('tag-name-map')
    : await idbGetMeta<Record<number, string>>('tag-name-map');
  // An empty map is a cached failure (GetTagList returned [] — no key, 403, timeout),
  // not a tag list: treat it as missing so every later sync doesn't label tags `tag_<id>`.
  if (cached && Object.keys(cached).length > 0) {
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

  if (map.size === 0) {
    console.warn('[CatalogStore] Tag list unavailable — tags will be unnamed this sync; retrying next sync');
    return map; // not cached in memory or on disk
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
  stage: 'idle' | 'migrating' | 'fetching-ids' | 'fetching-tags' | 'fetching-metadata' | 'retrying' | 'finalizing' | 'done' | 'error';
  batchesCompleted: number;
  batchesTotal: number;
  gamesStored: number;
  /** First-pass batches that failed (included in batchesCompleted). */
  batchesFailed?: number;
  /** Retry round counters (stage 'retrying'). */
  retryDone?: number;
  retryTotal?: number;
  /** Games still missing after an incomplete run — the next sync resumes just these. */
  pendingGames?: number;
  error?: string;
};

type Listener = () => void;

export class CatalogStore {
  private listeners = new Set<Listener>();
  private _syncProgress: CatalogSyncProgress = {
    stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0,
  };
  private _syncing = false;
  /** In-flight sync shared with every concurrent caller (splash + Oracle used to start two). */
  private _syncPromise: Promise<void> | null = null;
  private _syncAbort: AbortController | null = null;
  private _migrationAttempts = 0;
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
    if (this._migrationAttempts >= MAX_MIGRATION_ATTEMPTS_PER_SESSION) {
      // Give up for this session: serve IDB (see levelDisabledForSession); next launch retries.
      levelDisabledForSession = true;
      this._migrationChecked = true;
      console.warn('[CatalogStore] LevelDB migration keeps failing — using IndexedDB for this session');
      return Promise.resolve();
    }
    this._migrationAttempts++;

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
  sync(force = false): Promise<void> {
    // Late callers join the running sync instead of returning before it finishes
    // (the embedding pipeline used to start on a half-synced catalog).
    if (this._syncPromise) return this._syncPromise;
    this._syncPromise = this.runSync(force).finally(() => { this._syncPromise = null; });
    return this._syncPromise;
  }

  private async runSync(force: boolean): Promise<void> {
    if (this._syncing) return;
    await this.migrateFromIdbIfNeeded();

    const prevState = await getMeta<CatalogSyncState>('sync-state');
    const pending = prevState?.pendingAppIds ?? [];
    if (!force) {
      const fresh = await this.isFresh();
      if (fresh && prevState && prevState.totalEntries > 0) {
        this._syncProgress = {
          stage: 'done',
          batchesCompleted: prevState.batchesCompleted ?? 0,
          batchesTotal: prevState.batchesTotal ?? 0,
          gamesStored: prevState.totalEntries,
        };
        this.notify();
        console.log(`[CatalogStore] Catalog fresh (${prevState.totalEntries} games) — sync skipped`);
        return;
      }
      // An incomplete run just happened: don't hammer Steam again right away (every launch and
      // every Oracle visit used to start a full 780-batch sync that hit the same rate limits).
      const sinceAttempt = Date.now() - (prevState?.lastAttemptTimestamp ?? 0);
      // "Recent attempt that didn't produce a fresh catalog": games pending, or the attempt
      // came after the last complete sync (e.g. Steam's app list was unreachable).
      const recentUnfinished = pending.length > 0 || (prevState?.lastAttemptTimestamp ?? 0) > (prevState?.lastSyncTimestamp ?? 0);
      const cooldown = prevState?.lastAttemptOffline ? OFFLINE_RETRY_COOLDOWN : INCOMPLETE_RETRY_COOLDOWN;
      // An offline attempt cools down even with an empty catalog: otherwise every Oracle visit re-ran the whole pass
      if (recentUnfinished && prevState && (prevState.totalEntries > 0 || prevState.lastAttemptOffline) && sinceAttempt < cooldown) {
        this._syncProgress = {
          stage: 'done',
          batchesCompleted: prevState.batchesCompleted ?? 0,
          batchesTotal: prevState.batchesTotal ?? 0,
          gamesStored: prevState.totalEntries,
          pendingGames: pending.length,
          error: `${pending.length > 0 ? `${pending.length.toLocaleString()} games still pending` : 'Couldn’t reach Steam last time'} — retrying in ${Math.ceil((cooldown - sinceAttempt) / 60_000)} min`,
        };
        this.notify();
        console.log(`[CatalogStore] Previous sync unfinished (${pending.length} games pending) — in cooldown, skipped`);
        return;
      }
    }

    this._syncing = true;
    this._syncAbort = new AbortController();
    const signal = this._syncAbort.signal;
    const startedAt = Date.now();

    try {
      // Resume: a recent incomplete run only re-fetches what it missed (its pending list came
      // from the app list fetched by that run). Once that attempt is older than the stale TTL,
      // a full pass is due again.
      const lastFull = prevState?.lastSyncTimestamp ?? 0;
      const lastAttempt = prevState?.lastAttemptTimestamp ?? 0;
      const resume = !force && pending.length > 0 && (Date.now() - lastAttempt) < SYNC_STALE_TTL;

      let appIds: number[];
      /** Pending games already stored before this resume; null = couldn't count them. */
      let alreadyStoredBeforeResume: number | null = 0;
      if (resume) {
        appIds = pending;
        console.log(`[CatalogStore] Resuming incomplete sync: ${appIds.length} pending games`);
        if (useLevelDB()) {
          // Count only: reading the full rows (up to ~155k) over IPC just to count them was the old cost.
          alreadyStoredBeforeResume = await storeCountExisting(LEVEL_ENTRIES_NAMESPACE, appIds.map(String)).catch((err) => {
            console.warn('[CatalogStore] Could not count already-stored pending games:', err);
            return null;
          });
        }
      } else {
        // Step 1: Get all app IDs from main process
        this._syncProgress = { stage: 'fetching-ids', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0 };
        this.notify();
        const appList: Array<{ appid: number; name: string }> = await window.steam!.getAppList();
        appIds = appList.map(a => a.appid);
        console.log(`[CatalogStore] Got ${appIds.length} app IDs from main process`);
        // The IPC answers [] on failure — never let that overwrite a good catalog's sync-state
        if (appIds.length === 0) {
          // Keep the existing catalog usable (no red error over a good catalog) and record the
          // attempt so automatic syncs back off instead of retrying on every Oracle visit.
          if (prevState && prevState.totalEntries > 0) {
            await setMeta('sync-state', { ...prevState, lastAttemptTimestamp: Date.now(), pendingAppIds: prevState.pendingAppIds ?? [] });
            this._syncProgress = {
              stage: 'done', batchesCompleted: prevState.batchesCompleted, batchesTotal: prevState.batchesTotal,
              gamesStored: prevState.totalEntries, error: 'Couldn’t reach Steam — using the catalog you already have',
            };
            this.notify();
            console.warn('[CatalogStore] Steam app list unavailable — keeping the existing catalog');
            return;
          }
          throw new Error('Steam app list unavailable — try again later');
        }
      }

      // Step 2: Fetch & cache tag list
      this._syncProgress = { ...this._syncProgress, stage: 'fetching-tags' };
      this.notify();

      const tags = await fetchTagList();

      // Step 3: Create batches
      const batches: number[][] = [];
      for (let i = 0; i < appIds.length; i += BATCH_SIZE) {
        batches.push(appIds.slice(i, i + BATCH_SIZE));
      }

      // Progress model: the first pass fills 0–100% of `batchesTotal`; failed batches are
      // counted separately and a retry round gets its own stage + counters, so the UI never
      // sits on a silent "100%" while work continues.
      let batchesCompleted = 0;
      let batchesFailed = 0;
      let totalGamesStored = 0;
      const failed: Array<{ batch: number[]; idx: number }> = [];
      let permanentlyFailed = 0;
      let connectFailStreak = 0;
      let anyBatchSucceeded = false;
      let offline = false;
      const publish = (patch: Partial<CatalogSyncProgress>) => {
        this._syncProgress = {
          stage: 'fetching-metadata',
          batchesCompleted,
          batchesTotal: batches.length,
          gamesStored: totalGamesStored,
          batchesFailed,
          ...patch,
        };
        this.notify();
      };
      publish({});

      const runQueue = async (
        items: Array<{ batch: number[]; idx: number }>,
        concurrency: number,
        onDone: (ok: boolean) => void,
        deadline = Infinity,
      ) => {
        // Proper queue: each dequeue is atomic (no shared mutable index)
        const queue = [...items];
        const dequeue = () => queue.shift();
        const workers: Promise<void>[] = [];
        for (let w = 0; w < concurrency; w++) {
          workers.push((async () => {
            let item: ReturnType<typeof dequeue>;
            while (!signal.aborted && !offline && Date.now() < deadline && (item = dequeue())) {
              const { batch, idx } = item;
              let ok = false;
              try {
                const entries = await fetchBatch(batch, tags);
                if (entries.length > 0) {
                  await putEntriesBatch(entries);
                  totalGamesStored += entries.length;
                }
                ok = true;
                anyBatchSucceeded = true;
                connectFailStreak = 0;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[CatalogStore] Batch ${idx} failed:`, msg);
                if (NETWORK_DOWN_RE.test(msg)) {
                  if (++connectFailStreak >= OFFLINE_ABORT_AFTER && !anyBatchSucceeded && !offline) {
                    offline = true;
                    console.warn('[CatalogStore] No network — stopping the catalog pass; it resumes on a later sync');
                  }
                } else {
                  connectFailStreak = 0;
                }
                // A 4xx other than 429 is Steam rejecting the request itself — retrying won't help,
                // and counting it would keep the catalog "stale" (full re-sync) on every launch.
                if (/IStoreBrowseService 4(?!29)\d\d/.test(msg)) permanentlyFailed++;
                else failed.push(item);
              }
              onDone(ok);
            }
          })());
        }
        await Promise.all(workers);
        // Anything not dequeued (deadline / abort) is still owed
        for (const left of queue) failed.push(left);
      };

      // Step 4: first pass
      await runQueue(batches.map((b, i) => ({ batch: b, idx: i })), CONCURRENCY, (ok) => {
        batchesCompleted++;
        if (!ok) batchesFailed++;
        if (batchesCompleted % 5 === 0 || batchesCompleted === batches.length) publish({});
      });
      console.log(
        `[CatalogStore] First pass: ${batchesCompleted - batchesFailed}/${batches.length} batches ok, ` +
        `${failed.length} to retry, ${permanentlyFailed} rejected — ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );

      // Step 4b: one bounded retry round. Skipped when most of the pass failed (offline /
      // blocked — retrying now only burns time); leftovers carry over to the next sync.
      if (failed.length > 0 && !signal.aborted && failed.length <= Math.ceil(batches.length * RETRY_ROUND_MAX_RATIO)) {
        const retry = failed.splice(0);
        let retryDone = 0;
        publish({ stage: 'retrying', retryDone, retryTotal: retry.length });
        console.log(`[CatalogStore] Retrying ${retry.length} failed batches (budget ${RETRY_ROUND_BUDGET_MS / 1000}s)`);
        await runQueue(retry, 2, () => {
          retryDone++;
          publish({ stage: 'retrying', retryDone, retryTotal: retry.length });
        }, Date.now() + RETRY_ROUND_BUDGET_MS);
        console.log(`[CatalogStore] Retry round: ${retry.length - failed.length}/${retry.length} recovered`);
      }

      // Step 5: Save sync state. Only a complete run is stamped fresh — an aborted or
      // heavily rate-limited run used to count as a full sync for 24h (and moved the
      // embedding watermark), leaving the catalog short until the next day.
      publish({ stage: 'finalizing' });
      const complete = !signal.aborted && failed.length <= Math.ceil(batches.length * MAX_FAILED_BATCH_RATIO);
      const stillPending = failed.flatMap((f) => f.batch);
      const prevTotal = prevState?.totalEntries ?? 0;
      const finishedAt = Date.now();
      const totalEntries = resume && alreadyStoredBeforeResume !== null
        // Pending games may already be stored from an earlier full sync — only newly added rows count
        ? prevTotal + Math.max(0, totalGamesStored - alreadyStoredBeforeResume)
        // Count unavailable: never inflate; rows are keyed overwrites, so keep the larger figure
        : resume ? Math.max(prevTotal, totalGamesStored)
        // Rows are keyed overwrites, so a partial run never shrinks what's stored
        : (complete ? totalGamesStored : Math.max(totalGamesStored, prevTotal));
      const syncState: CatalogSyncState = offline && totalGamesStored === 0
        // Nothing was reachable: keep what the last run knew (do not store ~155k pending ids), just remember the attempt
        ? {
            lastSyncTimestamp: lastFull,
            totalEntries: prevTotal,
            batchesCompleted: prevState?.batchesCompleted ?? 0,
            batchesTotal: prevState?.batchesTotal ?? 0,
            inProgress: false,
            pendingAppIds: prevState?.pendingAppIds,
            lastAttemptTimestamp: finishedAt,
            lastAttemptOffline: true,
          }
        : {
        // A resume that clears the backlog completes the earlier full pass
        lastSyncTimestamp: complete ? finishedAt : lastFull,
        totalEntries,
        batchesCompleted: resume ? (prevState?.batchesCompleted ?? 0) : batchesCompleted,
        batchesTotal: resume ? (prevState?.batchesTotal ?? 0) : batches.length,
        inProgress: false,
        pendingAppIds: complete ? undefined : stillPending,
        lastAttemptTimestamp: finishedAt,
      };
      await setMeta('sync-state', syncState);

      // A partial run still leaves a usable catalog — downstream (embeddings, Oracle) proceeds;
      // `error` / `pendingGames` carry the shortfall, and the next sync resumes just those.
      this._syncProgress = {
        stage: complete || totalEntries > 0 ? 'done' : 'error',
        batchesCompleted: syncState.batchesCompleted,
        batchesTotal: syncState.batchesTotal,
        gamesStored: totalEntries,
        batchesFailed,
        ...(complete ? {} : {
          pendingGames: stillPending.length,
          error: signal.aborted
            ? 'Sync cancelled'
            : offline
              ? 'Couldn’t reach Steam — will retry shortly'
              : `${stillPending.length.toLocaleString()} games pending (Steam rate limit) — will retry`,
        }),
      };
      this.notify();

      console.log(
        `[CatalogStore] Sync ${complete ? 'complete' : 'incomplete'}${resume ? ' (resume)' : ''}: ${totalEntries} games, ` +
        `${stillPending.length} pending, ${permanentlyFailed} batches rejected by Steam — ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
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
  /**
   * Steam releases for the Upcoming calendar, from the synced catalog (one pass over the entries).
   * Dated releases from `fromMs` up to now need `minRecentReviews` reviews (Steam ships ~1,500 games a
   * month; this keeps the ones people actually play), future-dated ones are kept nearest-first. Both
   * groups are capped. Returns [] when the catalog has not been synced.
   */
  async queryUpcoming(opts: {
    fromMs: number;
    toMs: number;
    nowMs?: number;
    minRecentReviews?: number;
    maxRecent?: number;
    maxFuture?: number;
  }): Promise<CatalogEntry[]> {
    const { fromMs, toMs, nowMs = Date.now(), minRecentReviews = 20, maxRecent = 300, maxFuture = 400 } = opts;
    await this.migrateFromIdbIfNeeded();
    const selectOpts = { fromMs, toMs, nowMs, minRecentReviews, maxRecent, maxFuture };
    // LevelDB: filter next to the data in the main process — one IPC returning at most ~700 rows
    // instead of ~155 chunk round trips cloning the whole catalog into the renderer.
    if (useLevelDB() && typeof window.store?.queryUpcoming === 'function') {
      try {
        const res = await window.store.queryUpcoming<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, selectOpts);
        if (!res.error && Array.isArray(res.rows)) return res.rows;
      } catch {
        /* fall through to the renderer scan */
      }
    }
    const selector = new UpcomingSelector<CatalogEntry>(selectOpts);
    const admit = (entry: CatalogEntry) => selector.admit(entry);
    if (useLevelDB()) {
      const scan = await levelStreamAllEntries(admit);
      if (!scan.complete) console.warn(`[CatalogStore] Upcoming scan stopped early — partial results (${scan.count} rows read)`);
    } else {
      const db = await getDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(ENTRIES_STORE, 'readonly');
        const req = tx.objectStore(ENTRIES_STORE).openCursor();
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
    return selector.result();
  }

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

    await this.migrateFromIdbIfNeeded();

    // LevelDB: select next to the data in the main process (same selector as below) — one IPC
    // returning at most maxResults rows instead of ~155 chunk hops cloning the whole catalog here.
    if (useLevelDB() && typeof window.store?.queryCandidates === 'function') {
      try {
        const res = await window.store.queryCandidates<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, {
          topGenres, loyalDevelopers, loyalPublishers, excludeIds: [...excludeIds],
          minReviews, minPositivity, maxResults, maxPopularQuota,
        });
        if (!res.error && Array.isArray(res.rows)) return res.rows;
      } catch {
        /* fall through to the renderer scan */
      }
    }

    const selector = new CandidateSelector<CatalogEntry>({
      topGenres, loyalDevelopers, loyalPublishers, excludeIds,
      minReviews, minPositivity, maxResults, maxPopularQuota,
    });
    const admit = (entry: CatalogEntry) => selector.admit(entry);

    if (useLevelDB()) {
      const scan = await levelStreamAllEntries(admit);
      if (!scan.complete) console.warn(`[CatalogStore] Candidate scan stopped early — partial pool (${scan.count} rows read)`);
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

    return selector.result();
  }

  /**
   * Get all catalog entries (for embedding generation).
   * Returns entries in batches via a callback to avoid loading everything
   * into memory. LevelDB path uses `getChunk` (1000/hop); IDB path uses a
   * cursor with a 500-row buffer.
   */
  async getAllEntries(onBatch: (entries: CatalogEntry[]) => void): Promise<number> {
    const scan = await this.scanAllEntries(onBatch);
    if (!scan.complete) console.warn(`[CatalogStore] Catalog scan stopped early — ${scan.count} entries read (partial)`);
    return scan.count;
  }

  /**
   * `getAllEntries` that also says whether the walk reached the end. Embedding
   * passes use it so a scan cut short by a read error never advances their
   * watermark (the partial set used to be treated as the whole catalog).
   */
  async scanAllEntries(onBatch: (entries: CatalogEntry[]) => void): Promise<LevelScanResult> {
    await this.migrateFromIdbIfNeeded();
    if (useLevelDB()) {
      let buffer: CatalogEntry[] = [];
      const scan = await levelStreamAllEntries((entry) => {
        buffer.push(entry);
        if (buffer.length >= 500) {
          onBatch(buffer);
          buffer = [];
        }
      });
      if (buffer.length > 0) onBatch(buffer);
      return scan;
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
          resolve({ count, complete: true });
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
      req.onerror = () => {
        if (batch.length > 0) onBatch(batch);
        resolve({ count, complete: false });
      };
    });
  }

  /**
   * Get specific entries by appid.
   *
   * On the LevelDB path this is one `store:getMany` round trip per 2000 ids
   * (`storeGetMany`). The previous 400-wide `store:get` fan-out ran into the
   * store IPC rate limiter and silently dropped most rows for large callers
   * (galaxy-cache's ~155k-id enrichment pass).
   */
  async getEntries(appIds: number[]): Promise<CatalogEntry[]> {
    if (appIds.length === 0) return [];
    await this.migrateFromIdbIfNeeded();
    if (useLevelDB()) {
      const values = await storeGetMany<CatalogEntry>(LEVEL_ENTRIES_NAMESPACE, appIds.map(String));
      return values.filter((v): v is CatalogEntry => !!v);
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
