/**
 * BM25 hybrid retrieval index (MiniSearch).
 *
 * Indexes Steam (+ Epic when available) catalog text fields for lexical
 * candidate retrieval alongside ANN. Persists a serialized index in
 * IndexedDB `ark-bm25-index` and invalidates when catalog sync generation changes.
 */

import MiniSearch from 'minisearch';
import { catalogStore } from './catalog-store';
import { epicCatalogStore } from './epic-catalog-store';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Bm25Document {
  id: string;
  title: string;
  genres: string;
  themes: string;
  developer: string;
  publisher: string;
  shortDescription: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

interface PersistedBm25Meta {
  generation: string;
  docCount: number;
  savedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_NAME = 'ark-bm25-index';
const DB_VERSION = 1;
const STORE_NAME = 'meta';
const KEY_INDEX_JSON = 'index-json';
const KEY_META = 'meta';

const INDEX_FIELDS = [
  'title',
  'genres',
  'themes',
  'developer',
  'publisher',
  'shortDescription',
] as const;

const MINISEARCH_OPTS = {
  fields: [...INDEX_FIELDS],
  storeFields: ['id'] as string[],
  idField: 'id',
  searchOptions: {
    boost: {
      title: 3,
      genres: 2,
      themes: 1.5,
      developer: 1.5,
      publisher: 1,
      shortDescription: 0.5,
    },
    fuzzy: 0.15,
    prefix: true,
  },
};

const IDLE_CHUNK = 400;
const YIELD_MS = 16;

// ─── Pure index helpers (unit-tested) ─────────────────────────────────────────

export function createEmptyBm25Index(): MiniSearch<Bm25Document> {
  return new MiniSearch<Bm25Document>(MINISEARCH_OPTS);
}

export function addBm25Documents(
  index: MiniSearch<Bm25Document>,
  docs: Bm25Document[],
): void {
  if (docs.length === 0) return;
  index.addAll(docs);
}

export function searchBm25Index(
  index: MiniSearch<Bm25Document>,
  query: string,
  k: number,
): Bm25Hit[] {
  const q = query.trim();
  if (!q || k <= 0) return [];
  try {
    const results = index.search(q, { combineWith: 'OR' });
    return results.slice(0, k).map((r) => ({ id: String(r.id), score: r.score }));
  } catch {
    return [];
  }
}

function joinTags(tags: string[] | undefined): string {
  if (!tags?.length) return '';
  return tags.filter(Boolean).join(' ');
}

export function catalogEntryToBm25Doc(entry: {
  appid: number;
  name: string;
  genres?: string[];
  themes?: string[];
  developer?: string;
  publisher?: string;
  shortDescription?: string;
}): Bm25Document {
  return {
    id: `steam-${entry.appid}`,
    title: entry.name || '',
    genres: joinTags(entry.genres),
    themes: joinTags(entry.themes),
    developer: entry.developer || '',
    publisher: entry.publisher || '',
    shortDescription: entry.shortDescription || '',
  };
}

export function epicEntryToBm25Doc(entry: {
  epicId: string;
  name: string;
  genres?: string[];
  themes?: string[];
  developer?: string;
  publisher?: string;
  description?: string;
}): Bm25Document {
  return {
    id: `epic-${entry.epicId}`,
    title: entry.name || '',
    genres: joinTags(entry.genres),
    themes: joinTags(entry.themes),
    developer: entry.developer || '',
    publisher: entry.publisher || '',
    shortDescription: entry.description || '',
  };
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('IDB blocked'));
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbPromise = null;
      };
      resolve(dbInstance);
    };
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await getDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result?.value as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await getDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* non-fatal */
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: YIELD_MS * 4 });
    } else {
      setTimeout(resolve, YIELD_MS);
    }
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

class Bm25IndexService {
  private index: MiniSearch<Bm25Document> | null = null;
  private generation: string | null = null;
  private ready = false;
  private building = false;
  private buildPromise: Promise<boolean> | null = null;
  private idleScheduled = false;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  get isReady(): boolean {
    return this.ready && this.index != null;
  }

  get isBuilding(): boolean {
    return this.building;
  }

  get documentCount(): number {
    return this.index?.documentCount ?? 0;
  }

  /** Current catalog sync generation used for invalidation. */
  async currentGeneration(): Promise<string> {
    const [steamTs, steamCount, epicTs, epicCount] = await Promise.all([
      catalogStore.getLastSyncTimestamp(),
      catalogStore.getEntryCount(),
      epicCatalogStore.getLastSyncTimestamp(),
      epicCatalogStore.getEntryCount(),
    ]);
    return `steam:${steamTs}:${steamCount}|epic:${epicTs}:${epicCount}`;
  }

  /**
   * Ensure an in-memory index is loaded (from IDB) or built from catalogs.
   * Safe to call repeatedly; concurrent callers share one build.
   */
  async ensureReady(): Promise<boolean> {
    if (this.ready && this.index) {
      const gen = await this.currentGeneration();
      if (this.generation === gen) return true;
      // Stale — fall through to rebuild
      this.ready = false;
    }
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.loadOrRebuild().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /** Force rebuild from catalogs and persist. */
  async rebuild(): Promise<boolean> {
    this.ready = false;
    this.index = null;
    this.generation = null;
    if (this.buildPromise) {
      await this.buildPromise.catch(() => false);
    }
    this.buildPromise = this.buildFromCatalogs().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /**
   * Schedule a non-blocking rebuild/load after catalog sync (idle).
   * Dedupes concurrent schedules.
   */
  scheduleIdleRebuild(): void {
    if (this.idleScheduled || this.building) return;
    this.idleScheduled = true;
    const run = () => {
      this.idleScheduled = false;
      void this.ensureReady().catch((err) => {
        console.warn('[Bm25Index] idle ensureReady failed:', err);
      });
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 8_000 });
    } else {
      setTimeout(run, 250);
    }
  }

  /** Drop in-memory + mark for rebuild on next ensureReady. */
  invalidate(): void {
    this.ready = false;
    this.index = null;
    this.generation = null;
    this.notify();
  }

  search(query: string, k: number): Bm25Hit[] {
    if (!this.index) return [];
    return searchBm25Index(this.index, query, k);
  }

  private async loadOrRebuild(): Promise<boolean> {
    const gen = await this.currentGeneration();
    if (gen === 'steam:0:0|epic:0:0') {
      console.log('[Bm25Index] No catalog data yet — skipping');
      return false;
    }

    const meta = await idbGet<PersistedBm25Meta>(KEY_META);
    if (meta?.generation === gen) {
      const json = await idbGet<string>(KEY_INDEX_JSON);
      if (json) {
        try {
          this.building = true;
          this.notify();
          this.index = await MiniSearch.loadJSONAsync(json, MINISEARCH_OPTS);
          this.generation = gen;
          this.ready = true;
          this.building = false;
          this.notify();
          console.log(
            `[Bm25Index] Restored from IDB (${meta.docCount} docs, gen=${gen})`,
          );
          return true;
        } catch (err) {
          console.warn('[Bm25Index] Failed to load persisted index:', err);
        } finally {
          this.building = false;
        }
      }
    }

    return this.buildFromCatalogs();
  }

  private async buildFromCatalogs(): Promise<boolean> {
    if (this.building) return false;
    this.building = true;
    this.notify();

    try {
      const gen = await this.currentGeneration();
      const index = createEmptyBm25Index();
      const docs: Bm25Document[] = [];

      // Collect Steam + Epic docs, then addAsync in chunks to avoid UI jank.
      await catalogStore.getAllEntries((batch) => {
        for (const entry of batch) docs.push(catalogEntryToBm25Doc(entry));
      });
      await yieldToMain();

      const epicCount = await epicCatalogStore.getEntryCount();
      if (epicCount > 0) {
        await epicCatalogStore.getAllEntries((batch) => {
          for (const entry of batch) docs.push(epicEntryToBm25Doc(entry));
        });
        await yieldToMain();
      }

      if (docs.length === 0) {
        console.log('[Bm25Index] Build produced 0 documents');
        this.ready = false;
        this.index = null;
        return false;
      }

      await index.addAllAsync(docs, { chunkSize: IDLE_CHUNK });

      this.index = index;
      this.generation = gen;
      this.ready = true;

      // Persist (may be large — fire-and-forget after assign so search can proceed)
      void this.persist(index, gen, docs.length);

      console.log(`[Bm25Index] Built ${docs.length.toLocaleString()} docs (gen=${gen})`);
      return true;
    } catch (err) {
      console.warn('[Bm25Index] Build failed:', err);
      this.ready = false;
      this.index = null;
      return false;
    } finally {
      this.building = false;
      this.notify();
    }
  }

  private async persist(
    index: MiniSearch<Bm25Document>,
    generation: string,
    docCount: number,
  ): Promise<void> {
    try {
      const json = JSON.stringify(index);
      await idbSet(KEY_INDEX_JSON, json);
      await idbSet<PersistedBm25Meta>(KEY_META, {
        generation,
        docCount,
        savedAt: Date.now(),
      });
      console.log(`[Bm25Index] Persisted index (${docCount} docs)`);
    } catch (err) {
      console.warn('[Bm25Index] Persist failed (non-fatal):', err);
    }
  }
}

export const bm25Index = new Bm25IndexService();
