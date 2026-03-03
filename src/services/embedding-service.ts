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
import { toCanonicalGenres } from '@/data/canonical-genres';
import type { CatalogEntry } from '@/types/catalog';
import type { EpicCatalogEntry } from '@/services/epic-catalog-store';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OllamaModelInfo {
  name: string;
  installed: boolean;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
}

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
      getModelInfo: () => Promise<OllamaModelInfo | null>;
      /** Subscribe to setup progress (status, pct) during ollama:setup. Returns unsubscribe. */
      onSetupProgress?: (callback: (data: { status: string; pct: number }) => void) => () => void;
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

export const EMBEDDING_TEXT_VERSION = 10;

function hashText(text: string): string {
  const versioned = `v${EMBEDDING_TEXT_VERSION}:${text}`;
  let hash = 5381;
  for (let i = 0; i < versioned.length; i++) {
    hash = ((hash << 5) + hash + versioned.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(36);
}

// ─── Franchise base extraction (mirrors reco.worker.ts logic) ───────────────

const FRANCHISE_STRIP_PATTERNS = [
  /\s+([\divxlc]+|\d+)$/i,
  /\s*:\s*(remastered|goty|game of the year|deluxe|ultimate|definitive|complete|enhanced|anniversary|remake|hd|collection|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+(remastered|remake|definitive|enhanced|anniversary|hd|complete|ultimate|deluxe|goty|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+game\s+of\s+the\s+year(\s+edition)?$/i,
  /\s+edition$/i,
  /\s*\([^)]*\)$/,
  /\s*:\s+[^:]+$/,
  /\s+-\s+.*$/,
];

export function extractFranchiseBase(title: string): string {
  let base = title.trim();
  const original = base;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const pattern of FRANCHISE_STRIP_PATTERNS) {
      const stripped = base.replace(pattern, '').trim();
      if (stripped.length >= 3 && stripped !== base) {
        base = stripped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Fallback: strip trailing word for 4+-word titles where no pattern matched
  // (catches "Assassin's Creed Valhalla" → "Assassin's Creed")
  // Requires 4+ words to avoid false positives like "Grand Theft Auto" → "Grand Theft"
  if (base === original) {
    const words = base.split(/\s+/);
    if (words.length >= 4) {
      const candidate = words.slice(0, -1).join(' ');
      const newLast = candidate.split(/\s+/).pop()?.toLowerCase() ?? '';
      const stopWords = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'for', 'to', 'a', 'an']);
      if (candidate.length >= 3 && !stopWords.has(newLast)) base = candidate;
    }
  }
  return base.toLowerCase().trim();
}

// ─── Embedding text builders ────────────────────────────────────────────────

const EMBEDDING_NOISE_GENRES = new Set([
  'indie', 'free to play', 'early access', 'software', 'utilities',
  'design & illustration', 'animation & modeling', 'photo editing',
  'video production', 'web publishing', 'education', 'accounting',
  'comedy', 'fantasy', 'space',
]);

function gameplayGenres(genres: string[]): string[] {
  return genres.filter(g => !EMBEDDING_NOISE_GENRES.has(g.toLowerCase()));
}

/**
 * Build the embedding text for a library game (Tier 1).
 *
 * Layout: gameplay genres first (strongest signal), then canonical categories,
 * franchise series, modes, themes, developer, short description, user notes.
 * No prefix — snowflake-arctic-embed2 embeds documents without instruction prefix.
 * Publisher intentionally excluded (noise — same publisher ≠ similar gameplay).
 * "Indie" filtered from genres (business model, not gameplay).
 */
function buildEmbeddingText(game: {
  title: string;
  genres?: string[];
  themes?: string[];
  modes?: string[];
  playerPerspectives?: string[];
  developer?: string;
  publisher?: string;
  summary?: string;
  description?: string;
  userNotes?: string;
  similarGames?: Array<{ name: string }>;
}): string {
  const parts = [game.title];
  const gpGenres = game.genres ? gameplayGenres(game.genres) : [];
  if (gpGenres.length) {
    parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const canonical = toCanonicalGenres(gpGenres);
    if (canonical.length) parts.push(`type: ${canonical.join(', ')}`);
  }
  const franchise = extractFranchiseBase(game.title);
  if (franchise && franchise !== game.title.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (game.playerPerspectives?.length) parts.push(`perspective: ${game.playerPerspectives.join(', ')}`);
  if (game.modes?.length) parts.push(`modes: ${game.modes.join(', ')}`);
  if (game.themes?.length) parts.push(`setting: ${game.themes.join(', ')}`);
  if (game.developer) parts.push(`by ${game.developer}`);
  if (game.summary) parts.push(game.summary.slice(0, 1000));
  if (game.description) parts.push(game.description.slice(0, 3000));
  if (game.similarGames?.length) {
    const names = game.similarGames.slice(0, 6).map(g => g.name);
    parts.push(`similar to: ${names.join(', ')}`);
  }
  if (game.userNotes) parts.push(`player notes: ${game.userNotes.slice(0, 1000)}`);
  if (gpGenres.length) parts.push(`${game.title}, ${gpGenres[0]}`);
  return parts.join('. ');
}

/**
 * Build embedding text for a catalog game (Tier 2).
 *
 * Same layout as Tier 1 but metadata-only (no userNotes).
 */
function buildCatalogEmbeddingText(entry: CatalogEntry): string {
  const parts = [entry.name];
  const gpGenres = gameplayGenres(entry.genres);
  if (gpGenres.length) {
    parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const canonical = toCanonicalGenres(gpGenres);
    if (canonical.length) parts.push(`type: ${canonical.join(', ')}`);
  }
  const franchise = extractFranchiseBase(entry.name);
  if (franchise && franchise !== entry.name.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (entry.modes.length) parts.push(`modes: ${entry.modes.join(', ')}`);
  if (entry.themes.length) parts.push(`setting: ${entry.themes.join(', ')}`);
  if (entry.developer) parts.push(`by ${entry.developer}`);
  if (entry.shortDescription) parts.push(entry.shortDescription.slice(0, 1000));
  if (gpGenres.length) parts.push(`${entry.name}, ${gpGenres[0]}`);
  return parts.join('. ');
}

/**
 * Build embedding text for an Epic catalog game (Tier 2).
 *
 * Epic has richer descriptions than Steam catalog browse data — we include
 * both short description and longDescription for higher-quality embeddings.
 */
function buildEpicCatalogEmbeddingText(entry: EpicCatalogEntry): string {
  const parts = [entry.name];
  const gpGenres = gameplayGenres(entry.genres);
  if (gpGenres.length) {
    parts.push(`gameplay: ${gpGenres.join(', ')}`);
    const canonical = toCanonicalGenres(gpGenres);
    if (canonical.length) parts.push(`type: ${canonical.join(', ')}`);
  }
  const franchise = extractFranchiseBase(entry.name);
  if (franchise && franchise !== entry.name.toLowerCase().trim()) {
    parts.push(`series: ${franchise}`);
  }
  if (entry.modes?.length) parts.push(`modes: ${entry.modes.join(', ')}`);
  if (entry.themes.length) parts.push(`setting: ${entry.themes.join(', ')}`);
  if (entry.developer) parts.push(`by ${entry.developer}`);
  if (entry.description) parts.push(entry.description.slice(0, 1000));
  if (entry.longDescription) parts.push(entry.longDescription.slice(0, 3000));
  if (gpGenres.length) parts.push(`${entry.name}, ${gpGenres[0]}`);
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
    // Return cached result only if we already confirmed the model is ready.
    // If a previous check found Ollama running but the model pull failed,
    // re-run setup so the pull is retried (the user may have fixed the issue).
    if (this.ollamaAvailable !== null && this.embeddingModelReady) return true;
    if (this.ollamaAvailable === false) return false;

    try {
      if (!window.ollama) {
        this.ollamaAvailable = false;
        this._notify();
        return false;
      }

      const health = await window.ollama.healthCheck();
      this.ollamaAvailable = health.running;
      this._notify();

      if (!health.running) {
        console.log('[EmbeddingService] Ollama not available — running without embeddings');
        return false;
      }

      // Run setup — detects Ollama, checks for the embedding model, and
      // automatically pulls it if missing. This is the runtime auto-download.
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
      this._notify();
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
  private _libraryPromise: Promise<number> | null = null;
  async generateMissing(
    games: Array<{
      id: string;
      title: string;
      genres?: string[];
      themes?: string[];
      modes?: string[];
      playerPerspectives?: string[];
      developer?: string;
      publisher?: string;
      summary?: string;
      description?: string;
      userNotes?: string;
      similarGames?: Array<{ name: string }>;
    }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    if (this._libraryPromise) return this._libraryPromise;
    this._libraryPromise = this._runGenerateMissing(games, onProgress);
    try { return await this._libraryPromise; } finally { this._libraryPromise = null; }
  }

  private async _runGenerateMissing(
    games: Array<{
      id: string;
      title: string;
      genres?: string[];
      themes?: string[];
      modes?: string[];
      playerPerspectives?: string[];
      developer?: string;
      publisher?: string;
      summary?: string;
      description?: string;
      userNotes?: string;
      similarGames?: Array<{ name: string }>;
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

        if (i + BATCH_SIZE < needsEmbedding.length) {
          await new Promise(r => setTimeout(r, 0));
        }
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

  /** True once the Ollama availability check has completed (regardless of result). */
  get isOllamaChecked(): boolean { return this.ollamaAvailable !== null; }

  /** True if Ollama was confirmed unavailable. */
  get isOllamaUnavailable(): boolean { return this.ollamaAvailable === false; }

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
          try {
            const annBatch = batchEntries.map(e => ({
              id: e.gameId,
              vector: e.embedding,
            }));
            await annIndex.addVectors(annBatch);
          } catch { /* ANN not ready yet — non-fatal */ }
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
   * Background Tier 2b: generate embeddings for Epic catalog entries.
   * Runs sequentially after Steam catalog embeddings (waits for _catalogPromise).
   * Shares the same IDB catalog-embeddings store and ANN index.
   */
  private _epicCatalogPromise: Promise<number> | null = null;

  generateEpicCatalogEmbeddings(
    epicIterator: (onBatch: (entries: EpicCatalogEntry[]) => void) => Promise<number>,
  ): Promise<number> {
    if (this._epicCatalogPromise) return this._epicCatalogPromise;
    this._epicCatalogPromise = this._runEpicCatalogEmbeddings(epicIterator);
    return this._epicCatalogPromise;
  }

  private async _runEpicCatalogEmbeddings(
    epicIterator: (onBatch: (entries: EpicCatalogEntry[]) => void) => Promise<number>,
  ): Promise<number> {
    // Wait for any in-flight Steam catalog embedding run to finish first
    if (this._catalogPromise) {
      try { await this._catalogPromise; } catch { /* non-fatal */ }
    }

    if (!(await this.isAvailable())) { this._epicCatalogPromise = null; return 0; }

    this._catalogRunning = true;
    this._catalogAbort = new AbortController();
    const signal = this._catalogAbort.signal;
    this._notify();

    try {
      const cachedHashes = await getCatalogHashIndex();

      const needsEmbedding: Array<{ id: string; text: string; hash: string }> = [];
      let scannedTotal = 0;

      await epicIterator((batch) => {
        for (const entry of batch) {
          const id = `epic-${entry.epicId}`;
          const text = buildEpicCatalogEmbeddingText(entry);
          const hash = hashText(text);
          const existingHash = cachedHashes.get(id);
          if (existingHash === hash) continue;
          needsEmbedding.push({ id, text, hash });
        }
        scannedTotal += batch.length;
      });

      cachedHashes.clear();

      if (needsEmbedding.length === 0) {
        console.log(`[EmbeddingService] All ${scannedTotal} Epic catalog embeddings already cached`);
        return 0;
      }

      console.log(`[EmbeddingService] Generating ${needsEmbedding.length} Epic catalog embeddings (background)...`);
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

          try {
            const annBatch = batchEntries.map(e => ({ id: e.gameId, vector: e.embedding }));
            await annIndex.addVectors(annBatch);
          } catch { /* ANN not ready yet — non-fatal */ }
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

      if (totalGenerated > 0 && annIndex.vectorCount > 0) {
        await annIndex.save();
        console.log(`[EmbeddingService] ANN index saved (Epic): ${annIndex.vectorCount} vectors`);
      }

      console.log(`[EmbeddingService] Epic catalog embeddings done: ${totalGenerated} generated`);
      return totalGenerated;
    } catch (err) {
      if (!signal.aborted) {
        console.warn('[EmbeddingService] Epic catalog embedding error:', err);
      }
      return 0;
    } finally {
      this._catalogAbort = null;
      this._catalogRunning = false;
      this._epicCatalogPromise = null;
      this._notify();
    }
  }

  /**
   * Populate the ANN index from already-cached embeddings in IDB.
   * Reads both catalog and library stores so the index covers all known vectors.
   */
  private async _backfillAnnIndex(): Promise<void> {
    const db = await getDB();
    const now = Date.now();
    const seen = new Set<string>();
    let sent = 0;

    const streamStore = (storeName: string, ttl: number) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.openCursor();
        const batch: Array<{ id: string; vector: number[] }> = [];
        const BATCH = 500;

        const flushBatch = async () => {
          if (batch.length === 0) return;
          const chunk = batch.splice(0);
          await annIndex.addVectors(chunk);
          sent += chunk.length;
          annIndex.setBuildProgress(sent, sent);
        };

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            flushBatch().then(() => resolve(), reject);
            return;
          }
          const entry = cursor.value as CachedEmbedding;
          if (
            entry.embedding?.length === 1024 &&
            !seen.has(entry.gameId) &&
            now - entry.timestamp < ttl
          ) {
            seen.add(entry.gameId);
            batch.push({ id: entry.gameId, vector: entry.embedding });
          }
          if (batch.length >= BATCH) {
            flushBatch().then(() => cursor.continue(), reject);
          } else {
            cursor.continue();
          }
        };
        req.onerror = () => reject(req.error);
      });

    // Library first (higher priority — dedup via `seen`)
    await streamStore(LIBRARY_STORE, LIBRARY_TTL);
    await streamStore(CATALOG_STORE, CATALOG_TTL);

    if (sent > 0) {
      await annIndex.save();
      console.log(`[EmbeddingService] ANN index backfilled: ${sent} vectors from cache`);
    }
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
  const now = Date.now();
  const fromStore = (name: string, ttl: number): Promise<number[] | null> =>
    new Promise((resolve) => {
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).get(gameId);
      req.onsuccess = () => {
        const entry = req.result as CachedEmbedding | undefined;
        if (entry?.embedding && now - entry.timestamp < ttl) {
          resolve(entry.embedding);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  return (await fromStore(LIBRARY_STORE, LIBRARY_TTL)) ?? (await fromStore(CATALOG_STORE, CATALOG_TTL));
}

/**
 * Load ALL embeddings from both library and catalog IDB stores.
 * Returns a flat Float32Array (n × 1024) + parallel id array for maximum
 * performance during PCA. Library embeddings take priority over catalog
 * duplicates. Reports progress via callback.
 */
export async function loadAllEmbeddingsForGraph(
  onProgress?: (loaded: number, store: string) => void,
): Promise<{ ids: string[]; data: Float32Array; dim: number }> {
  const db = await getDB();
  const dim = 1024;

  // Pass 1: collect IDs only — no vectors in memory yet.
  // This gives us exact count + dedup order for pre-allocating the Float32Array.
  const seen = new Set<string>();
  const ids: string[] = [];

  const now = Date.now();
  const collectIds = (storeName: string, label: string, ttl: number) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.openCursor();
      let count = 0;

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as CachedEmbedding;
        if (
          entry.embedding?.length === dim &&
          !seen.has(entry.gameId) &&
          now - entry.timestamp < ttl
        ) {
          seen.add(entry.gameId);
          ids.push(entry.gameId);
          count++;
          if (count % 2000 === 0) onProgress?.(count, label);
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });

  await collectIds(LIBRARY_STORE, 'library', LIBRARY_TTL);
  onProgress?.(ids.length, 'library');
  await collectIds(CATALOG_STORE, 'catalog', CATALOG_TTL);
  onProgress?.(ids.length, 'catalog');

  // Pass 2: allocate final buffer and fill vectors directly.
  // Avoids the intermediate number[][] copy that peaked at ~370MB for 60K vectors.
  const n = ids.length;
  const data = new Float32Array(n * dim);
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) idToIdx.set(ids[i], i);

  const fillFromStore = (storeName: string, ttl: number) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as CachedEmbedding;
        if (entry.embedding?.length === dim && now - entry.timestamp < ttl) {
          const idx = idToIdx.get(entry.gameId);
          if (idx !== undefined) data.set(entry.embedding, idx * dim);
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });

  await fillFromStore(LIBRARY_STORE, LIBRARY_TTL);
  await fillFromStore(CATALOG_STORE, CATALOG_TTL);

  return { ids, data, dim };
}

// ─── Streaming Random-Projected Embeddings (low-memory galaxy path) ──────────

const PROJ_DIM = 100;

function generateGaussianProjectionMatrix(srcDim: number, tgtDim: number): Float32Array {
  const scale = 1 / Math.sqrt(tgtDim);
  const R = new Float32Array(tgtDim * srcDim);
  for (let i = 0; i < R.length; i++) {
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    R[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
  }
  return R;
}

/**
 * Load ALL embeddings but stream-project each 1024D vector to 100D during the
 * IDB cursor pass.  The caller never holds the full 1024D buffer in memory.
 *
 * Memory comparison (71K vectors):
 *   loadAllEmbeddingsForGraph: allocates 71K × 1024 × 4 = 292 MB Float32Array
 *   loadProjectedEmbeddingsForGraph: allocates 71K × 100 × 4 = 29 MB Float32Array
 *
 * The output is L2-normalized → random-projected → centered, ready for UMAP.
 */
export async function loadProjectedEmbeddingsForGraph(
  onProgress?: (loaded: number, store: string) => void,
): Promise<{ ids: string[]; projected: Float32Array; projDim: number }> {
  const db = await getDB();
  const srcDim = 1024;

  const seen = new Set<string>();
  const ids: string[] = [];
  const now = Date.now();

  const collectIds = (storeName: string, label: string, ttl: number) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.openCursor();
      let count = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as CachedEmbedding;
        if (
          entry.embedding?.length === srcDim &&
          !seen.has(entry.gameId) &&
          now - entry.timestamp < ttl
        ) {
          seen.add(entry.gameId);
          ids.push(entry.gameId);
          count++;
          if (count % 2000 === 0) onProgress?.(count, label);
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });

  await collectIds(LIBRARY_STORE, 'library', LIBRARY_TTL);
  onProgress?.(ids.length, 'library');
  await collectIds(CATALOG_STORE, 'catalog', CATALOG_TTL);
  onProgress?.(ids.length, 'catalog');

  const n = ids.length;
  if (n === 0) return { ids, projected: new Float32Array(0), projDim: PROJ_DIM };

  // L2-normalize + random-project each vector during the IDB cursor.
  // Only the 29 MB projected buffer is held, never the 292 MB raw buffer.
  const R = generateGaussianProjectionMatrix(srcDim, PROJ_DIM);
  const projected = new Float32Array(n * PROJ_DIM);
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) idToIdx.set(ids[i], i);

  const projectFromStore = (storeName: string, ttl: number) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as CachedEmbedding;
        if (entry.embedding?.length === srcDim && now - entry.timestamp < ttl) {
          const idx = idToIdx.get(entry.gameId);
          if (idx !== undefined) {
            const emb = entry.embedding;
            let norm = 0;
            for (let j = 0; j < srcDim; j++) norm += emb[j] * emb[j];
            norm = Math.sqrt(norm);
            const invNorm = norm > 1e-10 ? 1 / norm : 0;

            const dstOff = idx * PROJ_DIM;
            for (let k = 0; k < PROJ_DIM; k++) {
              let s = 0;
              const rOff = k * srcDim;
              for (let j = 0; j < srcDim; j++) s += R[rOff + j] * (emb[j] * invNorm);
              projected[dstOff + k] = s;
            }
          }
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });

  await projectFromStore(LIBRARY_STORE, LIBRARY_TTL);
  await projectFromStore(CATALOG_STORE, CATALOG_TTL);

  // Center the projected data in-place
  const mean = new Float32Array(PROJ_DIM);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < PROJ_DIM; j++) mean[j] += projected[i * PROJ_DIM + j];
  for (let j = 0; j < PROJ_DIM; j++) mean[j] /= n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < PROJ_DIM; j++) projected[i * PROJ_DIM + j] -= mean[j];

  return { ids, projected, projDim: PROJ_DIM };
}
