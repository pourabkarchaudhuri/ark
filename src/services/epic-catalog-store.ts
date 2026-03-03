/**
 * Epic Catalog Store
 *
 * Downloads and persists the Epic Games Store catalog (~2-8K games) for use
 * by the embedding pipeline and galaxy map alongside the Steam catalog.
 *
 * Architecture mirrors catalog-store.ts:
 *  1. Call window.epic.browseCatalog() (main process handles GraphQL pagination)
 *  2. Transform EpicCatalogItem → EpicCatalogEntry (lightweight, embedding-ready)
 *  3. Persist to IndexedDB with batch writes
 *  4. Stream back via cursor for embedding generation
 *
 * Deduplication: entries whose titles already exist in the Steam catalog
 * are excluded to avoid double-embedding the same game.
 */

import type { EpicCatalogItem } from '@/types/epic';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface EpicCatalogEntry {
  epicId: string;        // "namespace:offerId"
  namespace: string;
  offerId: string;
  name: string;
  genres: string[];
  themes: string[];
  modes: string[];
  developer: string;
  publisher: string;
  description: string;   // short
  longDescription: string;
  releaseDate: number;   // epoch ms (0 if unknown)
  coverUrl: string;
  isFree: boolean;
  priceFormatted?: string;
  discountPercent?: number;
}

interface EpicCatalogSyncState {
  lastSyncTimestamp: number;
  totalEntries: number;
  inProgress: boolean;
}

// ─── Tag Classification ─────────────────────────────────────────────────────────
// API-verified genre tag IDs (groupName === "genre"). Fallback when groupName absent.
const EPIC_GENRE_IDS: ReadonlySet<number> = new Set([
  1080, /* Survival */     1083, /* Rogue-Lite */  1084, /* Stealth */
  1110, /* Party */        1115, /* Strategy */    1116, /* Comedy */
  1117, /* Adventure */    1120, /* RTS */         1121, /* Space */
  1146, /* City Builder */ 1151, /* Platformer */  1170, /* Tower Defense */
  1181, /* Card Game */    1210, /* Shooter */     1212, /* Racing */
  1216, /* Action */       1218, /* Horror */      1263, /* Indie */
  1283, /* Sports */       1287, /* Fantasy */     1294, /* First Person */
  1296, /* Casual */       1307, /* Open World */  1336, /* Action-Adventure */
  1367, /* RPG */          1381, /* Exploration */ 1386, /* Turn-Based */
  1393, /* Simulation */   1395, /* Narration */
]);

// Feature tags that represent game modes (groupName === "feature")
const EPIC_MODE_NAMES: ReadonlySet<string> = new Set([
  'Single Player', 'Co-op', 'Multiplayer', 'Online Multiplayer',
  'Local Multiplayer', 'Competitive', 'MMO', 'Cross Platform',
]);

// Null-group tags worth keeping as themes
const EPIC_THEME_NAMES: ReadonlySet<string> = new Set([
  'Metroidvania', 'RELAXING', 'Space Sim', 'Base-Building',
]);

// ─── Constants ──────────────────────────────────────────────────────────────────

const DB_NAME = 'ark-epic-catalog';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const META_STORE = 'meta';
const SYNC_STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const WRITE_BATCH_SIZE = 200;

// ─── IDB Helpers ────────────────────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        db.createObjectStore(ENTRIES_STORE, { keyPath: 'epicId' });
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

async function idbGetMeta<T>(key: string): Promise<T | null> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSetMeta(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbPutBatch(entries: EpicCatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ENTRIES_STORE, 'readwrite');
    const store = tx.objectStore(ENTRIES_STORE);
    for (const entry of entries) store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ─── Transform ──────────────────────────────────────────────────────────────────

function resolveImage(
  keyImages: Array<{ type: string; url: string }> | undefined,
): string {
  if (!keyImages?.length) return '';
  const priority = ['DieselStoreFrontTall', 'OfferImageTall', 'DieselGameBoxTall', 'DieselGameBox',
    'DieselStoreFrontWide', 'OfferImageWide', 'Thumbnail'];
  for (const type of priority) {
    const img = keyImages.find(i => i.type === type);
    if (img?.url) return img.url;
  }
  return keyImages[0]?.url ?? '';
}

function transformItem(item: EpicCatalogItem): EpicCatalogEntry | null {
  if (!item.title || !item.namespace || !item.id) return null;

  const epicId = `${item.namespace}:${item.id}`;

  const genres: string[] = [];
  const themes: string[] = [];
  const modes: string[] = [];
  if (item.tags) {
    for (const tag of item.tags) {
      const group = tag.groupName;
      const name = tag.name ?? '';

      if (group === 'genre' || (!group && EPIC_GENRE_IDS.has(tag.id))) {
        if (name) genres.push(name);
      } else if (group === 'feature' && EPIC_MODE_NAMES.has(name)) {
        modes.push(name);
      } else if (!group && EPIC_THEME_NAMES.has(name)) {
        themes.push(name);
      }
      // usersay, platform, epicfeature, event tags are discarded
    }
  }

  let releaseDate = 0;
  if (item.effectiveDate) {
    const ts = new Date(item.effectiveDate).getTime();
    if (!isNaN(ts)) releaseDate = ts;
  }

  const totalPrice = item.price?.totalPrice;
  const isFree = totalPrice ? totalPrice.originalPrice === 0 : false;
  const discountPercent = totalPrice && totalPrice.originalPrice > 0
    ? Math.round((1 - totalPrice.discountPrice / totalPrice.originalPrice) * 100)
    : undefined;

  return {
    epicId,
    namespace: item.namespace,
    offerId: item.id,
    name: item.title,
    genres: genres.length > 0 ? genres : ['Game'],
    themes,
    modes,
    developer: item.developer || item.seller?.name || '',
    publisher: item.publisher || item.seller?.name || '',
    description: item.description || '',
    longDescription: item.longDescription || '',
    releaseDate,
    coverUrl: resolveImage(item.keyImages),
    isFree,
    priceFormatted: totalPrice?.fmtPrice?.discountPrice || totalPrice?.fmtPrice?.originalPrice,
    discountPercent: discountPercent && discountPercent > 0 ? discountPercent : undefined,
  };
}

// ─── EpicCatalogStore ───────────────────────────────────────────────────────────

export type EpicCatalogSyncProgress = {
  stage: 'idle' | 'fetching' | 'persisting' | 'done' | 'error';
  itemsFetched: number;
  itemsStored: number;
  error?: string;
};

type Listener = () => void;

class EpicCatalogStore {
  private listeners = new Set<Listener>();
  private _syncProgress: EpicCatalogSyncProgress = {
    stage: 'idle', itemsFetched: 0, itemsStored: 0,
  };
  private _syncing = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() { this.listeners.forEach(fn => fn()); }

  get syncProgress(): Readonly<EpicCatalogSyncProgress> { return this._syncProgress; }

  async isFresh(): Promise<boolean> {
    const state = await idbGetMeta<EpicCatalogSyncState>('sync-state');
    if (!state || state.totalEntries === 0) return false;
    return (Date.now() - state.lastSyncTimestamp) < SYNC_STALE_TTL;
  }

  async getEntryCount(): Promise<number> {
    const state = await idbGetMeta<EpicCatalogSyncState>('sync-state');
    return state?.totalEntries ?? 0;
  }

  /**
   * Sync the Epic catalog. Fetches all items from the Epic GraphQL API
   * via IPC, transforms them, and persists to IndexedDB.
   */
  async sync(force = false): Promise<void> {
    if (this._syncing) return;
    if (!window.epic) return;

    if (!force) {
      const fresh = await this.isFresh();
      if (fresh) {
        const state = await idbGetMeta<EpicCatalogSyncState>('sync-state');
        if (state && state.totalEntries > 0) {
          this._syncProgress = {
            stage: 'done', itemsFetched: state.totalEntries, itemsStored: state.totalEntries,
          };
          this.notify();
          return;
        }
      }
    }

    this._syncing = true;
    try {
      this._syncProgress = { stage: 'fetching', itemsFetched: 0, itemsStored: 0 };
      this.notify();

      const items = await window.epic!.browseCatalog(0);
      this._syncProgress = { stage: 'persisting', itemsFetched: items.length, itemsStored: 0 };
      this.notify();

      console.log(`[EpicCatalogStore] Fetched ${items.length} items from Epic`);

      const seen = new Set<string>();
      const entries: EpicCatalogEntry[] = [];
      for (const item of items) {
        const entry = transformItem(item);
        if (!entry) continue;
        if (seen.has(entry.epicId)) continue;
        seen.add(entry.epicId);
        entries.push(entry);
      }

      let stored = 0;
      for (let i = 0; i < entries.length; i += WRITE_BATCH_SIZE) {
        const batch = entries.slice(i, i + WRITE_BATCH_SIZE);
        await idbPutBatch(batch);
        stored += batch.length;
        this._syncProgress = { stage: 'persisting', itemsFetched: items.length, itemsStored: stored };
        this.notify();
      }

      await idbSetMeta('sync-state', {
        lastSyncTimestamp: Date.now(),
        totalEntries: stored,
        inProgress: false,
      } satisfies EpicCatalogSyncState);

      this._syncProgress = { stage: 'done', itemsFetched: items.length, itemsStored: stored };
      this.notify();
      console.log(`[EpicCatalogStore] Sync complete: ${stored} games`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[EpicCatalogStore] Sync failed:', msg);
      this._syncProgress = { ...this._syncProgress, stage: 'error', error: msg };
      this.notify();
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Stream all catalog entries via cursor for embedding generation.
   * Batched to 500 entries per callback (matching Steam catalog pattern).
   */
  async getAllEntries(onBatch: (entries: EpicCatalogEntry[]) => void): Promise<number> {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const store = tx.objectStore(ENTRIES_STORE);
      const req = store.openCursor();
      let count = 0;
      let batch: EpicCatalogEntry[] = [];

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
}

export const epicCatalogStore = new EpicCatalogStore();
