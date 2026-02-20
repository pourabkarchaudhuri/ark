/**
 * Embedding Service (Renderer Side)
 *
 * Two-tier embedding architecture:
 *  - Tier 1 (library): On-demand, includes userNotes → personalized. 30-day TTL.
 *  - Tier 2 (catalog): Background, metadata-only → generic. 90-day TTL.
 *
 * Both tiers are cached in IndexedDB (separate object stores) so they persist
 * across sessions. The reco-store embedding cache is the union of both tiers.
 *
 * Graceful degradation: if Ollama is unavailable, all methods return cleanly
 * and the recommendation engine runs without embeddings.
 */

import { setEmbeddingCache } from './reco-store';
import { annIndex } from './ann-index';
import type { CatalogEntry } from '@/types/catalog';

// ─── Types ─────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    ollama?: {
      healthCheck: () => Promise<{ running: boolean; version: string | null }>;
      setup: () => Promise<{
        ollamaDetected: boolean;
        ollamaVersion: string | null;
        embeddingModelReady: boolean;
        error: string | null;
      }>;
      generateEmbedding: (text: string) => Promise<number[] | null>;
      generateEmbeddings: (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>;
    };
  }
}

interface CachedEmbedding {
  gameId: string;
  embedding: number[];
  textHash: string;
  timestamp: number;
}

// ─── IDB Helpers ───────────────────────────────────────────────────────────────

const DB_NAME = 'ark-embeddings';
const DB_VERSION = 2;
const LIBRARY_STORE = 'embeddings';
const CATALOG_STORE = 'catalog-embeddings';
const LIBRARY_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days
const CATALOG_TTL = 90 * 24 * 60 * 60 * 1000;  // 90 days

let embDbInstance: IDBDatabase | null = null;
let embDbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (embDbInstance) return Promise.resolve(embDbInstance);
  if (embDbPromise) return embDbPromise;

  embDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { embDbPromise = null; reject(req.error); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        db.createObjectStore(LIBRARY_STORE, { keyPath: 'gameId' });
      }
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE, { keyPath: 'gameId' });
      }
    };
    req.onsuccess = () => {
      embDbInstance = req.result;
      embDbInstance.onclose = () => { embDbInstance = null; embDbPromise = null; };
      embDbInstance.onversionchange = () => { embDbInstance?.close(); embDbInstance = null; embDbPromise = null; };
      resolve(embDbInstance);
    };
  });
  return embDbPromise;
}

async function getCachedEmbeddings(
  storeName: string = LIBRARY_STORE,
  ttl: number = LIBRARY_TTL,
): Promise<Map<string, CachedEmbedding>> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
      const map = new Map<string, CachedEmbedding>();
      const now = Date.now();
      for (const entry of (req.result as CachedEmbedding[])) {
        if (now - entry.timestamp < ttl) {
          map.set(entry.gameId, entry);
        }
      }
      resolve(map);
    };
    req.onerror = () => resolve(new Map());
  });
}

async function saveCachedEmbeddings(
  entries: CachedEmbedding[],
  storeName: string = LIBRARY_STORE,
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const entry of entries) {
      store.put(entry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ─── Text Hashing (simple djb2) ────────────────────────────────────────────────

function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(36);
}

/**
 * Build the embedding text for a library game (Tier 1).
 * Includes summary/description and user notes for personalized embeddings.
 */
function buildEmbeddingText(game: {
  title: string;
  genres?: string[];
  themes?: string[];
  developer?: string;
  summary?: string;
  description?: string;
  userNotes?: string;
}): string {
  const parts = [game.title];
  if (game.genres?.length) parts.push(`genres: ${game.genres.join(', ')}`);
  if (game.themes?.length) parts.push(`themes: ${game.themes.join(', ')}`);
  if (game.developer) parts.push(`by ${game.developer}`);
  if (game.summary) parts.push(game.summary.slice(0, 300));
  if (game.description && !game.summary) parts.push(game.description.slice(0, 300));
  if (game.userNotes) parts.push(`player notes: ${game.userNotes.slice(0, 200)}`);
  return parts.join('. ');
}

/**
 * Build embedding text for a catalog game (Tier 2).
 * Metadata only — no userNotes. Kept lightweight for 156K games.
 */
function buildCatalogEmbeddingText(entry: CatalogEntry): string {
  const parts = [entry.name];
  if (entry.genres.length) parts.push(`genres: ${entry.genres.join(', ')}`);
  if (entry.themes.length) parts.push(`themes: ${entry.themes.join(', ')}`);
  if (entry.developer) parts.push(`by ${entry.developer}`);
  if (entry.shortDescription) parts.push(entry.shortDescription.slice(0, 300));
  return parts.join('. ');
}

/**
 * Load only gameId → textHash from the catalog embedding store (no vectors).
 * Used for dedup checking during background generation without loading ~500MB.
 */
async function getCatalogHashIndex(): Promise<Map<string, string>> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
    const req = store.openCursor();
    const map = new Map<string, string>();
    const now = Date.now();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(map); return; }
      const entry = cursor.value as CachedEmbedding;
      if (now - entry.timestamp < CATALOG_TTL) {
        map.set(entry.gameId, entry.textHash);
      }
      cursor.continue();
    };
    req.onerror = () => resolve(new Map());
  });
}

/**
 * Fetch catalog embeddings for a specific set of game IDs (on-demand).
 * Avoids loading the entire catalog embedding store into memory.
 */
async function getCatalogEmbeddingsForIds(
  gameIds: Set<string>,
): Promise<Map<string, number[]>> {
  if (gameIds.size === 0) return new Map();
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
    const result = new Map<string, number[]>();
    const now = Date.now();
    let remaining = gameIds.size;

    for (const gameId of gameIds) {
      const req = store.get(gameId);
      req.onsuccess = () => {
        const entry = req.result as CachedEmbedding | undefined;
        if (entry && (now - entry.timestamp < CATALOG_TTL)) {
          result.set(gameId, entry.embedding);
        }
        remaining--;
        if (remaining === 0) resolve(result);
      };
      req.onerror = () => {
        remaining--;
        if (remaining === 0) resolve(result);
      };
    }
  });
}

/** Live reference to the merged embedding cache (updated incrementally by catalog gen). */
let embeddingCacheRef = new Map<string, number[]>();

// ─── Embedding Service ─────────────────────────────────────────────────────────

class EmbeddingService {
  private ollamaAvailable: boolean | null = null;
  private embeddingModelReady = false;
  private _embeddingsLoaded = false;
  private _loadedCount = 0;

  private _listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() { this._listeners.forEach(fn => fn()); }

  /** Number of embeddings currently loaded (survives across component mounts). */
  get loadedCount(): number {
    return this._loadedCount;
  }

  // ── Library embedding progress (Tier 1, observable) ──
  private _libraryStatus: 'idle' | 'loading' | 'generating' | 'ready' | 'unavailable' = 'idle';
  private _libraryProgress: { completed: number; total: number } = { completed: 0, total: 0 };

  get libraryStatus() { return this._libraryStatus; }
  get libraryProgress(): Readonly<{ completed: number; total: number }> { return this._libraryProgress; }

  private _setLibraryStatus(s: typeof this._libraryStatus) {
    this._libraryStatus = s;
    this._notify();
  }

  resetLibraryStatus() {
    this._libraryStatus = 'idle';
    this._libraryProgress = { completed: 0, total: 0 };
    this._notify();
  }

  /**
   * Compute a single taste centroid vector from weighted user embeddings.
   * Used as the ANN query vector and passed to the worker to avoid
   * per-candidate recomputation of the weighted sum.
   */
  computeTasteCentroid(
    userEmbeddings: Array<{ embedding: number[]; weight: number }>,
  ): Float32Array | null {
    if (userEmbeddings.length === 0) return null;

    const dim = userEmbeddings[0].embedding.length;
    if (dim === 0) return null;

    const centroid = new Float32Array(dim);
    let totalWeight = 0;

    for (const { embedding, weight } of userEmbeddings) {
      if (embedding.length !== dim) continue;
      for (let i = 0; i < dim; i++) centroid[i] += embedding[i] * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return null;
    for (let i = 0; i < dim; i++) centroid[i] /= totalWeight;

    // L2-normalize for cosine metric
    let mag = 0;
    for (let i = 0; i < dim; i++) mag += centroid[i] * centroid[i];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let i = 0; i < dim; i++) centroid[i] /= mag;

    return centroid;
  }

  /**
   * Check if Ollama is available and has the embedding model.
   * Returns true if embeddings can be generated.
   */
  async isAvailable(): Promise<boolean> {
    if (this.ollamaAvailable !== null) return this.ollamaAvailable && this.embeddingModelReady;

    try {
      if (!window.ollama) {
        this.ollamaAvailable = false;
        return false;
      }

      const health = await window.ollama.healthCheck();
      this.ollamaAvailable = health.running;

      if (!health.running) {
        console.log('[EmbeddingService] Ollama not available — running without embeddings');
        return false;
      }

      // Run setup to ensure model is pulled
      const setup = await window.ollama.setup();
      this.embeddingModelReady = setup.embeddingModelReady;

      if (!setup.embeddingModelReady) {
        console.log('[EmbeddingService] Embedding model not ready:', setup.error);
        return false;
      }

      console.log(`[EmbeddingService] Ollama v${setup.ollamaVersion} ready with embedding model`);
      return true;
    } catch (err) {
      console.warn('[EmbeddingService] Error checking availability:', err);
      this.ollamaAvailable = false;
      return false;
    }
  }

  /**
   * Load cached library embeddings from IDB and inject into the reco-store.
   * Only loads Tier 1 (library) eagerly — catalog embeddings are loaded
   * on-demand per candidate pool via enrichWithCatalogEmbeddings().
   */
  async loadCachedEmbeddings(forceReload = false): Promise<number> {
    if (this._embeddingsLoaded && !forceReload) {
      return this._loadedCount;
    }

    this._setLibraryStatus('loading');

    try {
      const libCached = await getCachedEmbeddings(LIBRARY_STORE, LIBRARY_TTL);

      const embeddingMap = new Map<string, number[]>();
      for (const [gameId, entry] of libCached) {
        embeddingMap.set(gameId, entry.embedding);
      }

      embeddingCacheRef = embeddingMap;
      setEmbeddingCache(embeddingMap);
      this._embeddingsLoaded = true;
      this._loadedCount = embeddingMap.size;
      if (embeddingMap.size > 0) this._setLibraryStatus('ready');
      console.log(`[EmbeddingService] Loaded ${embeddingMap.size} library embeddings`);
      return embeddingMap.size;
    } catch (err) {
      console.warn('[EmbeddingService] Failed to load cached embeddings:', err);
      this._embeddingsLoaded = true;
      this._loadedCount = 0;
      return 0;
    }
  }

  /**
   * Load catalog embeddings only for the given candidate IDs and merge them
   * into the live cache. This avoids loading 156K embeddings into memory —
   * only the ~8K candidates that actually need them are fetched.
   */
  async enrichWithCatalogEmbeddings(candidateIds: Set<string>): Promise<number> {
    try {
      const catalogEmbs = await getCatalogEmbeddingsForIds(candidateIds);
      if (catalogEmbs.size === 0) return 0;

      let added = 0;
      for (const [gameId, embedding] of catalogEmbs) {
        if (!embeddingCacheRef.has(gameId)) {
          embeddingCacheRef.set(gameId, embedding);
          added++;
        }
      }
      if (added > 0) setEmbeddingCache(embeddingCacheRef);
      return added;
    } catch (err) {
      console.warn('[EmbeddingService] Failed to enrich catalog embeddings:', err);
      return 0;
    }
  }

  /**
   * Generate embeddings for a batch of games that don't have cached embeddings.
   * Automatically updates the reco-store embedding cache.
   *
   * @param games Array of games with id, title, genres, themes, developer
   * @param onProgress Optional progress callback
   * @returns Number of new embeddings generated
   */
  async generateMissing(
    games: Array<{
      id: string;
      title: string;
      genres?: string[];
      themes?: string[];
      developer?: string;
      summary?: string;
      description?: string;
      userNotes?: string;
    }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    if (!(await this.isAvailable())) {
      this._setLibraryStatus('unavailable');
      return 0;
    }
    if (games.length === 0) return 0;

    this._setLibraryStatus('generating');

    try {
      const cached = await getCachedEmbeddings();

      const needsEmbedding: Array<{ id: string; text: string; hash: string }> = [];

      for (const game of games) {
        const text = buildEmbeddingText(game);
        const hash = hashText(text);
        const existing = cached.get(game.id);

        if (existing && existing.textHash === hash) {
          continue;
        }

        needsEmbedding.push({ id: game.id, text, hash });
      }

      if (needsEmbedding.length === 0) {
        console.log('[EmbeddingService] All embeddings already cached');
        this._setLibraryStatus('ready');
        return 0;
      }

      console.log(`[EmbeddingService] Generating ${needsEmbedding.length} new embeddings...`);
      this._libraryProgress = { completed: 0, total: needsEmbedding.length };
      this._notify();

      const BATCH_SIZE = 100;
      const allNewEntries: CachedEmbedding[] = [];
      let completed = 0;

      for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
        const batch = needsEmbedding.slice(i, i + BATCH_SIZE);
        const items = batch.map(b => ({ id: b.id, text: b.text }));

        const results = await window.ollama!.generateEmbeddings(items);

        const batchEntries: CachedEmbedding[] = [];
        for (const item of batch) {
          if (results[item.id]) {
            batchEntries.push({
              gameId: item.id,
              embedding: results[item.id],
              textHash: item.hash,
              timestamp: Date.now(),
            });
          }
        }

        if (batchEntries.length > 0) {
          await saveCachedEmbeddings(batchEntries);
          allNewEntries.push(...batchEntries);
        }

        completed += batch.length;
        this._libraryProgress = { completed, total: needsEmbedding.length };
        this._notify();
        onProgress?.(completed, needsEmbedding.length);
      }

      for (const entry of allNewEntries) {
        embeddingCacheRef.set(entry.gameId, entry.embedding);
      }
      setEmbeddingCache(embeddingCacheRef);

      if (allNewEntries.length > 0) {
        try {
          const annBatch = allNewEntries.map(e => ({ id: e.gameId, vector: e.embedding }));
          await annIndex.addVectors(annBatch);
        } catch { /* ANN not ready yet — catalog gen will backfill later */ }
      }

      const status = (allNewEntries.length > 0 || this._loadedCount > 0) ? 'ready' as const : 'unavailable' as const;
      this._setLibraryStatus(status);
      this._libraryProgress = { completed: 0, total: 0 };

      console.log(`[EmbeddingService] Generated ${allNewEntries.length} new embeddings, total cached: ${embeddingCacheRef.size}`);
      return allNewEntries.length;
    } catch (err) {
      console.warn('[EmbeddingService] Error generating embeddings:', err);
      this._setLibraryStatus('unavailable');
      return 0;
    }
  }

  /**
   * Background Tier 2: generate embeddings for catalog entries (metadata only,
   * no userNotes). Persisted to the separate catalog-embeddings IDB store.
   *
   * Yields to the main thread between batches via requestIdleCallback / setTimeout
   * to avoid starving the UI or IPC channel.
   *
   * @returns Number of newly generated embeddings
   */
  private _catalogAbort: AbortController | null = null;
  private _catalogProgress: { completed: number; total: number } = { completed: 0, total: 0 };
  private _catalogRunning = false;
  private _catalogPromise: Promise<number> | null = null;

  get catalogProgress(): Readonly<{ completed: number; total: number }> {
    return this._catalogProgress;
  }

  get isCatalogRunning(): boolean { return this._catalogRunning; }

  /** Cancel an in-flight catalog embedding run. */
  cancelCatalogEmbeddings() {
    this._catalogAbort?.abort();
    this._catalogAbort = null;
  }

  /**
   * Background Tier 2: generate embeddings for catalog entries streamed from
   * the catalog store. Idempotent — if already running, returns the existing
   * promise so navigation away and back doesn't restart the work.
   */
  generateCatalogEmbeddings(
    catalogIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>,
  ): Promise<number> {
    if (this._catalogPromise) return this._catalogPromise;
    this._catalogPromise = this._runCatalogEmbeddings(catalogIterator);
    return this._catalogPromise;
  }

  private async _runCatalogEmbeddings(
    catalogIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>,
  ): Promise<number> {
    if (!(await this.isAvailable())) { this._catalogPromise = null; return 0; }

    this._catalogRunning = true;
    this._catalogAbort = new AbortController();
    const signal = this._catalogAbort.signal;
    this._notify();

    try {
      const cachedHashes = await getCatalogHashIndex();

      const needsEmbedding: Array<{ id: string; text: string; hash: string }> = [];
      let scannedTotal = 0;

      await catalogIterator((batch) => {
        for (const entry of batch) {
          const id = `steam-${entry.appid}`;
          const text = buildCatalogEmbeddingText(entry);
          const hash = hashText(text);
          const existingHash = cachedHashes.get(id);
          if (existingHash === hash) continue;
          needsEmbedding.push({ id, text, hash });
        }
        scannedTotal += batch.length;
      });

      cachedHashes.clear();

      if (needsEmbedding.length === 0) {
        console.log(`[EmbeddingService] All ${scannedTotal} catalog embeddings already cached`);
        // Backfill ANN index if it's empty (e.g. first launch after ANN was added, or index file deleted)
        if (!annIndex.isReady) {
          await this._backfillAnnIndex();
        }
        annIndex.finishBuild();
        return 0;
      }

      console.log(`[EmbeddingService] Generating ${needsEmbedding.length} catalog embeddings (background)...`);
      this._catalogProgress = { completed: 0, total: needsEmbedding.length };
      this._notify();

      const EMBED_BATCH = 100;
      const IDLE_DELAY_MS = 50;
      let totalGenerated = 0;
      let completed = 0;

      for (let i = 0; i < needsEmbedding.length; i += EMBED_BATCH) {
        if (signal.aborted) break;

        const batch = needsEmbedding.slice(i, i + EMBED_BATCH);
        const items = batch.map(b => ({ id: b.id, text: b.text }));

        const results = await window.ollama!.generateEmbeddings(items);

        const batchEntries: CachedEmbedding[] = [];
        for (const item of batch) {
          if (results[item.id]) {
            batchEntries.push({
              gameId: item.id,
              embedding: results[item.id],
              textHash: item.hash,
              timestamp: Date.now(),
            });
          }
        }

        if (batchEntries.length > 0) {
          await saveCachedEmbeddings(batchEntries, CATALOG_STORE);
          totalGenerated += batchEntries.length;

          // Feed new vectors to the ANN index incrementally
          const annBatch = batchEntries.map(e => ({
            id: e.gameId,
            vector: e.embedding,
          }));
          await annIndex.addVectors(annBatch);
        }

        completed += batch.length;
        this._catalogProgress = { completed, total: needsEmbedding.length };
        annIndex.setBuildProgress(completed, needsEmbedding.length);
        this._notify();

        await new Promise<void>(resolve => {
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), { timeout: IDLE_DELAY_MS * 2 });
          } else {
            setTimeout(resolve, IDLE_DELAY_MS);
          }
        });
      }

      // Persist the updated ANN index to disk
      if (totalGenerated > 0 && annIndex.vectorCount > 0) {
        await annIndex.save();
        console.log(`[EmbeddingService] ANN index saved: ${annIndex.vectorCount} vectors`);
      }
      annIndex.finishBuild();

      console.log(`[EmbeddingService] Catalog embeddings done: ${totalGenerated} generated`);
      return totalGenerated;
    } catch (err) {
      if (!signal.aborted) {
        console.warn('[EmbeddingService] Catalog embedding error:', err);
      }
      return 0;
    } finally {
      this._catalogAbort = null;
      this._catalogRunning = false;
      this._catalogPromise = null;
      this._notify();
    }
  }

  /**
   * Populate the ANN index from already-cached embeddings in IDB.
   * Reads both catalog and library stores so the index covers all known vectors.
   */
  private async _backfillAnnIndex(): Promise<void> {
    const db = await getDB();

    const readStore = (storeName: string): Promise<Array<{ id: string; vector: number[] }>> =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.openCursor();
        const result: Array<{ id: string; vector: number[] }> = [];

        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const entry = cursor.value as CachedEmbedding;
            if (entry.embedding && entry.embedding.length === 768) {
              result.push({ id: entry.gameId, vector: entry.embedding });
            }
            cursor.continue();
          } else {
            resolve(result);
          }
        };
        req.onerror = () => reject(req.error);
      });

    const [catalogVectors, libraryVectors] = await Promise.all([
      readStore(CATALOG_STORE),
      readStore(LIBRARY_STORE),
    ]);

    const seen = new Set<string>();
    const allVectors: Array<{ id: string; vector: number[] }> = [];
    for (const v of libraryVectors) {
      seen.add(v.id);
      allVectors.push(v);
    }
    for (const v of catalogVectors) {
      if (!seen.has(v.id)) allVectors.push(v);
    }

    if (allVectors.length === 0) return;

    // Phase 2: Push to ANN index in batches via IPC (splice to release memory as we go)
    const BATCH = 500;
    const totalVecs = allVectors.length;
    let sent = 0;
    while (allVectors.length > 0) {
      const batch = allVectors.splice(0, BATCH);
      await annIndex.addVectors(batch);
      sent += batch.length;
      annIndex.setBuildProgress(sent, totalVecs);
    }

    await annIndex.save();
    console.log(`[EmbeddingService] ANN index backfilled: ${sent} vectors from cache`);
  }

  /** Reset availability check (e.g. after user changes Ollama settings). */
  resetAvailability() {
    this.ollamaAvailable = null;
    this.embeddingModelReady = false;
    this._embeddingsLoaded = false;
    this._loadedCount = 0;
  }
}

// Singleton
export const embeddingService = new EmbeddingService();

/**
 * Get the total number of cached embeddings across both stores
 * without loading the actual vectors (fast IDB count).
 */
export async function getEmbeddingCount(): Promise<number> {
  const db = await getDB();
  const countStore = (name: string): Promise<number> =>
    new Promise((resolve) => {
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  const [lib, cat] = await Promise.all([
    countStore(LIBRARY_STORE),
    countStore(CATALOG_STORE),
  ]);
  return lib + cat;
}

/**
 * Retrieve a single embedding vector by gameId (checks library store first,
 * then catalog). Returns null if not found.
 */
export async function getEmbeddingById(gameId: string): Promise<number[] | null> {
  const db = await getDB();
  const fromStore = (name: string): Promise<number[] | null> =>
    new Promise((resolve) => {
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).get(gameId);
      req.onsuccess = () => {
        const entry = req.result as CachedEmbedding | undefined;
        resolve(entry?.embedding ?? null);
      };
      req.onerror = () => resolve(null);
    });
  return (await fromStore(LIBRARY_STORE)) ?? (await fromStore(CATALOG_STORE));
}

/**
 * Load ALL embeddings from both library and catalog IDB stores.
 * Returns a flat Float32Array (n × 768) + parallel id array for maximum
 * performance during PCA. Library embeddings take priority over catalog
 * duplicates. Reports progress via callback.
 */
export async function loadAllEmbeddingsForGraph(
  onProgress?: (loaded: number, store: string) => void,
): Promise<{ ids: string[]; data: Float32Array; dim: number }> {
  const db = await getDB();
  const dim = 768;
  const seen = new Set<string>();
  const ids: string[] = [];
  const chunks: number[][] = [];

  const readStore = (storeName: string, label: string) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.openCursor();
      let count = 0;

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as CachedEmbedding;
        if (entry.embedding?.length === dim && !seen.has(entry.gameId)) {
          seen.add(entry.gameId);
          ids.push(entry.gameId);
          chunks.push(entry.embedding);
          count++;
          if (count % 2000 === 0) onProgress?.(count, label);
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });

  await readStore(LIBRARY_STORE, 'library');
  onProgress?.(ids.length, 'library');

  await readStore(CATALOG_STORE, 'catalog');
  onProgress?.(ids.length, 'catalog');

  const data = new Float32Array(ids.length * dim);
  for (let i = 0; i < chunks.length; i++) {
    data.set(chunks[i], i * dim);
  }

  return { ids, data, dim };
}
