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
import { extractFranchiseBase } from '@/services/franchise';
import type { CatalogEntry } from '@/types/catalog';
import type { EpicCatalogEntry } from '@/services/epic-catalog-store';
import { toRerankTier, rerankTierLabel, type RerankTier } from '@/services/oracle-rerank';
import { quantizeEmbedding, dequantizeEmbedding, EMBEDDING_DIM } from '@/services/embedding-quant';
import {
  CURRENT_POOL_VERSION,
  HASH_VERSION_PREFIX as CHUNK_HASH_VERSION_PREFIX,
  buildGameChunks,
  diffChunksAgainstCache,
  hashWholeEmbeddingText,
  poolChunkVectors,
  shouldSkipPooled,
  type ChunkSpec,
  type EmbeddingTier,
} from '@/services/embedding-chunks';

export { extractFranchiseBase };
export {
  CURRENT_POOL_VERSION,
  EMBEDDING_CHUNK_VERSION,
  hashWholeEmbeddingText,
  buildGameChunks,
} from '@/services/embedding-chunks';
export { EMBEDDING_DIM, quantizeEmbedding, dequantizeEmbedding } from '@/services/embedding-quant';

/**
 * Payload of the `ollama:rerank-progress` channel.
 * Mirrors `RerankSetupProgress` in electron/ollama-setup.ts.
 */
export interface RerankSetupProgressEvent {
  status: string;
  pct: number;
  /** Only the terminal event sets this. */
  done?: boolean;
  tier?: string | null;
  tierLabel?: string | null;
  error?: string | null;
  /** False when Ollama never answered, so a missing reranker is not a fault. */
  ollamaUp?: boolean;
}

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
        /** True when a reranker tier stronger than cosine is available. */
        rerankModelReady?: boolean;
        /** Tier resolved during setup — see `RerankTier` in src/services/oracle-rerank.ts. */
        rerankTier?: string | null;
        rerankTierLabel?: string | null;
        error: string | null;
      }>;
      generateEmbedding: (text: string) => Promise<number[] | null>;
      generateEmbeddings: (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>;
      getModelInfo: () => Promise<OllamaModelInfo | null>;
      /** Subscribe to setup progress (status, pct) during ollama:setup. Returns unsubscribe. */
      onSetupProgress?: (callback: (data: { status: string; pct: number }) => void) => () => void;
      /**
       * Subscribe to reranker setup progress. Independent of `onSetupProgress`
       * because the ~600 MB Qwen3 pull continues after `ollama:setup` resolves.
       */
      onRerankProgress?: (callback: (data: RerankSetupProgressEvent) => void) => () => void;
      /**
       * Tiered rerank — structured success `{ results, via }` or `{ error }`.
       * `via` names the tier that produced the ordering, including the weaker
       * `qwen_binary` and `embed_fallback` paths.
       */
      rerank: (payload: {
        query: string;
        documents: string[];
        topN?: number;
      }) => Promise<
        | { results: Array<{ index: number; relevance_score: number }>; via?: RerankTier }
        | { error: { code: string; httpStatus?: number; message: string } }
      >;
      /** Diagnostic probe — reports the winning tier plus why each stronger tier was rejected. */
      rerankDiagnostic?: () => Promise<{
        ollamaUp: boolean;
        ollamaVersion?: string | null;
        modelName: string;
        modelInstalled: boolean;
        rerankWorking: boolean;
        tier?: RerankTier | null;
        tierLabel?: string | null;
        tierModel?: string;
        tierReason?: string;
        tiers?: Array<{
          tier: RerankTier;
          label: string;
          model: string;
          available: boolean;
          detail: string;
          httpStatus?: number;
          latencyMs?: number;
        }>;
        latencyMs?: number;
        error?: string;
      }>;
      /** Embed perf probe — concrete numbers (embeds/sec, GPU mode, VRAM, current profile). */
      embedDiagnostic?: () => Promise<{
        ollamaUp: boolean;
        ollamaVersion: string | null;
        modelLoaded: boolean;
        onGpu: boolean;
        sizeVramBytes: number;
        sizeBytes: number;
        probe: {
          items: number;
          avgTextChars: number;
          totalMs: number;
          embedsPerSec: number;
          msPerEmbed: number;
          successful: number;
          numBatchUsed: number | 'default';
          subBatchUsed: number;
          inFlight: number;
          backgroundMode: boolean;
        } | null;
        error: string | null;
      }>;
    };
  }
}

/** Dual-format pooled row — legacy float or int8+scale. Exactly one vector form. */
export interface CachedEmbedding {
  gameId: string;
  /** Legacy float vector (pre-chunking writes). */
  embedding?: number[];
  /** Int8 quantized vector (Phase A writes). */
  q?: Int8Array;
  scale?: number;
  textHash: string;
  timestamp: number;
  format?: 'f32' | 'i8';
  /** Writers set 1; legacy omit = compatible with skip. */
  poolVersion?: number;
}

export interface CachedChunk {
  chunkId: string;
  tier: EmbeddingTier;
  gameId: string;
  kind: string;
  seq: number;
  q: Int8Array;
  scale: number;
  textHash: string;
  weight: number;
  timestamp: number;
}

// ─── IDB Helpers ───────────────────────────────────────────────────────────────

const DB_NAME = 'ark-embeddings';
const DB_VERSION = 4;
const LIBRARY_STORE = 'embeddings';
const CATALOG_STORE = 'catalog-embeddings';
const CHUNK_STORE = 'chunk-embeddings';
const META_STORE = 'embedding-meta'; // small key/value store for watermarks
const META_EPOCH_KEY = 'embeddingContentEpoch';
const LIBRARY_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days
const CATALOG_TTL = 90 * 24 * 60 * 60 * 1000;  // 90 days

// Refresh an entry's IDB timestamp lazily only when it's older than this.
// Avoids hammering IDB with timestamp-only updates on every launch.
const TTL_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
      // Additive only — never wipe existing stores/rows.
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        db.createObjectStore(LIBRARY_STORE, { keyPath: 'gameId' });
      }
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE, { keyPath: 'gameId' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: 'chunkId' });
        chunkStore.createIndex('byGame', 'gameId', { unique: false });
        chunkStore.createIndex('byTierGame', ['tier', 'gameId'], { unique: false });
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

/** Shared IDB accessor for graph/status consumers that must open at current version. */
export function getEmbeddingDB(): Promise<IDBDatabase> {
  return getDB();
}

/**
 * Coerce IDB / structured-clone `q` payloads into Int8Array of EMBEDDING_DIM.
 * Accepts Int8Array, ArrayBuffer, ArrayBufferView, or array-like length 1024.
 */
export function coerceInt8Q(q: unknown): Int8Array | null {
  if (q instanceof Int8Array) {
    return q.length === EMBEDDING_DIM ? q : null;
  }
  if (q instanceof ArrayBuffer) {
    if (q.byteLength !== EMBEDDING_DIM) return null;
    return new Int8Array(q);
  }
  if (ArrayBuffer.isView(q)) {
    const view = q as ArrayBufferView & { length?: number };
    const len = typeof view.length === 'number' ? view.length : view.byteLength;
    if (len !== EMBEDDING_DIM) return null;
    return new Int8Array(view.buffer, view.byteOffset, EMBEDDING_DIM);
  }
  if (
    q != null &&
    typeof q === 'object' &&
    typeof (q as { length?: unknown }).length === 'number' &&
    (q as { length: number }).length === EMBEDDING_DIM
  ) {
    return Int8Array.from(q as ArrayLike<number>);
  }
  return null;
}

/**
 * Decode boundary: IDB row → f32 1024 (or null).
 * Legacy float arrays and int8+scale both accepted; TypedArrays rejected by Array.isArray.
 */
export function readPooledVector(entry: CachedEmbedding | null | undefined): Float32Array | null {
  if (!entry) return null;
  if (typeof entry.scale === 'number') {
    const q = coerceInt8Q(entry.q);
    if (q) return dequantizeEmbedding(q, entry.scale);
  }
  if (Array.isArray(entry.embedding) && entry.embedding.length === EMBEDDING_DIM) {
    return Float32Array.from(entry.embedding);
  }
  return null;
}

function pooledVectorAsNumberArray(entry: CachedEmbedding | null | undefined): number[] | null {
  const f32 = readPooledVector(entry);
  if (!f32) return null;
  return Array.from(f32);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const entry of entries) {
      store.put(entry);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('saveCachedEmbeddings failed'));
    tx.onabort = () => reject(tx.error ?? new Error('saveCachedEmbeddings aborted'));
  });
}

async function getChunksForTierGame(
  tier: EmbeddingTier,
  gameId: string,
): Promise<Map<string, CachedChunk>> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    if (!store.indexNames.contains('byTierGame')) {
      resolve(new Map());
      return;
    }
    const idx = store.index('byTierGame');
    const req = idx.getAll([tier, gameId]);
    req.onsuccess = () => {
      const map = new Map<string, CachedChunk>();
      for (const row of (req.result as CachedChunk[])) {
        map.set(row.chunkId, row);
      }
      resolve(map);
    };
    req.onerror = () => resolve(new Map());
  });
}

/**
 * Atomically rewrite chunks + pooled int8 row for one game.
 * Rejects on tx error — callers must not ANN-upsert or advance watermarks on failure.
 */
async function writeGameChunksAndPool(opts: {
  tier: EmbeddingTier;
  gameId: string;
  pooledStore: string;
  wholeHash: string;
  chunks: Array<ChunkSpec & { vector: Float32Array | number[] }>;
  staleIds: string[];
}): Promise<Float32Array> {
  const { tier, gameId, pooledStore, wholeHash, chunks, staleIds } = opts;
  const pooledF32 = poolChunkVectors(
    chunks.map(c => ({ vector: c.vector, weight: c.weight })),
  );
  const { q, scale } = quantizeEmbedding(pooledF32);
  const now = Date.now();
  const pooledRow: CachedEmbedding = {
    gameId,
    q,
    scale,
    textHash: wholeHash,
    timestamp: now,
    format: 'i8',
    poolVersion: CURRENT_POOL_VERSION,
  };

  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CHUNK_STORE, pooledStore], 'readwrite');
    const chunkStore = tx.objectStore(CHUNK_STORE);
    const poolStore = tx.objectStore(pooledStore);

    for (const id of staleIds) {
      chunkStore.delete(id);
    }
    for (const chunk of chunks) {
      const cq = quantizeEmbedding(chunk.vector);
      const row: CachedChunk = {
        chunkId: chunk.chunkId,
        tier,
        gameId,
        kind: chunk.kind,
        seq: chunk.seq,
        q: cq.q,
        scale: cq.scale,
        textHash: chunk.textHash,
        weight: chunk.weight,
        timestamp: now,
      };
      chunkStore.put(row);
    }
    // Clear legacy float field by writing int8-only row.
    poolStore.put(pooledRow);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('writeGameChunksAndPool failed'));
    tx.onabort = () => reject(tx.error ?? new Error('writeGameChunksAndPool aborted'));
  });

  return pooledF32;
}

async function bumpEmbeddingContentEpoch(): Promise<number> {
  const current = await getEmbeddingContentEpoch();
  const next = current + 1;
  await setEmbeddingMeta({ key: META_EPOCH_KEY, value: next });
  return next;
}

export async function getEmbeddingContentEpoch(): Promise<number> {
  const row = await getEmbeddingMeta<{ key: string; value: number }>(META_EPOCH_KEY);
  return typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : 0;
}

// ─── Embedding meta (watermark / per-store small key-value) ─────────────────

interface EmbeddingPassWatermark {
  key: string;
  /** Catalog sync timestamp at the time the embedding pass completed. */
  syncTimestamp: number;
  /** Embedding text + model version stamp valid at the time of the pass. */
  versionStamp: string;
  /** When the pass completed (debug). */
  completedAt: number;
}

async function getEmbeddingMeta<T extends { key: string }>(key: string): Promise<T | null> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function setEmbeddingMeta<T extends { key: string }>(value: T): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('setEmbeddingMeta failed'));
    tx.onabort = () => reject(tx.error ?? new Error('setEmbeddingMeta aborted'));
  });
}

/**
 * Refresh just the IDB `timestamp` field on a set of cached entries so they don't
 * expire from TTL — without re-embedding. Used when hash matched but the cached
 * vector is getting close to TTL expiry.
 */
async function refreshCachedTimestamps(
  ids: string[],
  storeName: string,
): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDB();
  const now = Date.now();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const id of ids) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const entry = getReq.result as CachedEmbedding | undefined;
        if (entry) {
          entry.timestamp = now;
          store.put(entry);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ─── Text Hashing (simple djb2) ────────────────────────────────────────────────

/**
 * Bump when the prompt-construction layout changes (gen text shape, field set, ordering).
 * Pure cache invalidation — does not depend on the embedding model.
 * Phase A lock: do NOT bump for chunking rollout (lazy dual-format).
 */
export const EMBEDDING_TEXT_VERSION = 10;

/**
 * Bump when the embedding model itself changes (Ollama model swap, dimensionality
 * change). Invalidates all cached vectors even if prompt text is unchanged.
 * Phase A lock: do NOT bump for chunking rollout.
 */
export const EMBEDDING_MODEL_VERSION = 1;

/** Combined version stamp folded into every hash. Must stay `t10m1`. */
const HASH_VERSION_PREFIX = `t${EMBEDDING_TEXT_VERSION}m${EMBEDDING_MODEL_VERSION}`;

// Dev-time guard: chunk module prefix must match (skip hashes share one alphabet).
if (HASH_VERSION_PREFIX !== CHUNK_HASH_VERSION_PREFIX) {
  console.error(
    `[EmbeddingService] HASH_VERSION_PREFIX mismatch: service=${HASH_VERSION_PREFIX} chunks=${CHUNK_HASH_VERSION_PREFIX}`,
  );
}

function hashText(text: string): string {
  return hashWholeEmbeddingText(text);
}

// ─── Franchise base extraction (mirrors reco.worker.ts logic) ───────────────

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
 *
 * Exported so tests share the production whole-text builder (skip-hash compat).
 */
export function buildEmbeddingText(game: {
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
export function buildCatalogEmbeddingText(entry: CatalogEntry): string {
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
export function buildEpicCatalogEmbeddingText(entry: EpicCatalogEntry): string {
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
 * Load gameId → pooled skip metadata from the catalog store (no vectors in memory).
 * Only rows with a decodable pooled payload are indexed — corrupt/hash-only rows
 * must not short-circuit re-embed.
 */
async function getCatalogHashIndex(): Promise<Map<string, { textHash: string; poolVersion?: number }>> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
    const req = store.openCursor();
    const map = new Map<string, { textHash: string; poolVersion?: number }>();
    const now = Date.now();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(map); return; }
      const entry = cursor.value as CachedEmbedding;
      if (now - entry.timestamp < CATALOG_TTL && readPooledVector(entry)) {
        map.set(entry.gameId, { textHash: entry.textHash, poolVersion: entry.poolVersion });
      }
      cursor.continue();
    };
    req.onerror = () => resolve(new Map());
  });
}

/**
 * Load only gameId → timestamp from the catalog embedding store. Used in
 * conjunction with the hash index to decide which unchanged entries are
 * approaching TTL expiry and need a timestamp refresh.
 */
async function getCatalogTimestampIndex(): Promise<Map<string, number>> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
    const req = store.openCursor();
    const map = new Map<string, number>();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(map); return; }
      const entry = cursor.value as CachedEmbedding;
      map.set(entry.gameId, entry.timestamp);
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
          const vec = pooledVectorAsNumberArray(entry);
          if (vec) result.set(gameId, vec);
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

async function isEmbeddingChunkingEnabled(): Promise<boolean> {
  try {
    const settingsApi = (window as unknown as {
      settings?: { getOllamaSettings?: () => Promise<{ embeddingChunkingEnabled?: boolean }> };
    }).settings;
    const s = await settingsApi?.getOllamaSettings?.();
    // Default true when unset.
    return s?.embeddingChunkingEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Diff chunks for one game, embed only misses, atomic write, return pooled f32.
 * Throws on persist failure (caller must not advance watermark / ANN on throw).
 */
async function embedAndPersistChunkedGame(opts: {
  tier: EmbeddingTier;
  gameId: string;
  pooledStore: string;
  wholeHash: string;
  chunkInput: Parameters<typeof buildGameChunks>[2];
}): Promise<Float32Array | null> {
  const desired = buildGameChunks(opts.tier, opts.gameId, opts.chunkInput);
  if (desired.length === 0) return null;

  const existing = await getChunksForTierGame(opts.tier, opts.gameId);
  const existingMeta = new Map(
    [...existing.entries()].map(([id, row]) => [id, { chunkId: id, textHash: row.textHash }]),
  );
  const { toEmbed, staleIds } = diffChunksAgainstCache(desired, existingMeta);

  const vectorsById = new Map<string, Float32Array>();
  for (const [id, row] of existing) {
    const q = coerceInt8Q(row.q);
    if (q && typeof row.scale === 'number') {
      vectorsById.set(id, dequantizeEmbedding(q, row.scale));
    }
  }

  if (toEmbed.length > 0) {
    const items = toEmbed.map(c => ({ id: c.chunkId, text: c.text }));
    const results = await window.ollama!.generateEmbeddings(items);
    for (const chunk of toEmbed) {
      const vec = results[chunk.chunkId];
      if (!vec || vec.length !== EMBEDDING_DIM) {
        throw new Error(`Missing embedding for chunk ${chunk.chunkId}`);
      }
      vectorsById.set(chunk.chunkId, Float32Array.from(vec));
    }
  }

  const chunksWithVectors: Array<ChunkSpec & { vector: Float32Array }> = [];
  for (const chunk of desired) {
    const vector = vectorsById.get(chunk.chunkId);
    if (!vector) {
      throw new Error(`No vector for required chunk ${chunk.chunkId}`);
    }
    chunksWithVectors.push({ ...chunk, vector });
  }

  return writeGameChunksAndPool({
    tier: opts.tier,
    gameId: opts.gameId,
    pooledStore: opts.pooledStore,
    wholeHash: opts.wholeHash,
    chunks: chunksWithVectors,
    staleIds,
  });
}

// ─── Embedding Service ─────────────────────────────────────────────────────────

const PAUSE_LS_KEY = 'ark-embedding-paused';

function readPausedFromStorage(): boolean {
  try { return localStorage.getItem(PAUSE_LS_KEY) === '1'; } catch { return false; }
}

function writePausedToStorage(paused: boolean): void {
  try {
    if (paused) localStorage.setItem(PAUSE_LS_KEY, '1');
    else localStorage.removeItem(PAUSE_LS_KEY);
  } catch { /* quota */ }
}

class EmbeddingService {
  private ollamaAvailable: boolean | null = null;
  private embeddingModelReady = false;
  /** From `ollama:setup` — true when a tier stronger than cosine resolved. */
  private _rerankModelReady = false;
  private _rerankTier: RerankTier | null = null;
  private _embeddingsLoaded = false;
  private _loadedCount = 0;

  // ── Pause/Resume state (dev-mode controllable) ──
  // Persisted in localStorage so a pause survives app reloads.
  private _paused = readPausedFromStorage();
  private _pauseDeferred: { promise: Promise<void>; resolve: () => void } | null = null;

  private _libraryAbort: AbortController | null = null;

  private _listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() { this._listeners.forEach(fn => fn()); }

  // ── Pause / Resume ──
  /** True when all embedding gen loops are halted between batches. */
  get isPaused(): boolean { return this._paused; }

  /** Halt all embedding gen loops at the next batch boundary. Persists across reloads. */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    if (!this._pauseDeferred) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      this._pauseDeferred = { promise, resolve };
    }
    writePausedToStorage(true);
    this._notify();
  }

  /** Resume any embedding gen loops that were waiting at a pause point. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    const deferred = this._pauseDeferred;
    this._pauseDeferred = null;
    writePausedToStorage(false);
    deferred?.resolve();
    this._notify();
  }

  /**
   * Await this between loop iterations to honor a pause. Returns immediately
   * when not paused; otherwise blocks until resume() is called. Lazily creates
   * the deferred when paused state was restored from localStorage on startup.
   */
  private async _awaitIfPaused(): Promise<void> {
    while (this._paused) {
      if (!this._pauseDeferred) {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        this._pauseDeferred = { promise, resolve };
      }
      await this._pauseDeferred.promise;
    }
  }

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
      // Reranker status used to be dropped on the floor here, so nothing in the
      // renderer could tell a working cross-encoder from silent cosine.
      this._rerankModelReady = setup.rerankModelReady === true;
      this._rerankTier = toRerankTier(setup.rerankTier);

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
        const vec = pooledVectorAsNumberArray(entry);
        if (vec) embeddingMap.set(gameId, vec);
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
    this._libraryAbort = new AbortController();
    const librarySignal = this._libraryAbort.signal;

    try {
      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const cached = await getCachedEmbeddings();

      type Need = {
        game: (typeof games)[number];
        text: string;
        hash: string;
      };
      const needsEmbedding: Need[] = [];

      for (const game of games) {
        const text = buildEmbeddingText(game);
        const hash = hashText(text);
        const existing = cached.get(game.id);
        // Skip only when pooled payload exists AND whole-hash + poolVersion OK.
        if (shouldSkipPooled(existing, hash) && readPooledVector(existing)) continue;
        needsEmbedding.push({ game, text, hash });
      }

      if (needsEmbedding.length === 0) {
        console.log('[EmbeddingService] All embeddings already cached');
        // Backfill ANN if empty (parity with catalog path — cached library + empty ANN → self-only neighbors)
        if (!annIndex.isReady) {
          await this._backfillAnnIndex();
        }
        this._setLibraryStatus('ready');
        return 0;
      }

      console.log(
        `[EmbeddingService] Generating ${needsEmbedding.length} library embeddings ` +
        `(chunking=${chunkingEnabled ? 'on' : 'off'})...`,
      );
      // Progress stays in game units (never raw chunk calls).
      this._libraryProgress = { completed: 0, total: needsEmbedding.length };
      this._notify();

      const BATCH_SIZE = 100;
      let generated = 0;
      let completed = 0;

      for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
        await this._awaitIfPaused();
        if (librarySignal.aborted) break;

        const batch = needsEmbedding.slice(i, i + BATCH_SIZE);

        if (!chunkingEnabled) {
          const items = batch.map(b => ({ id: b.game.id, text: b.text }));
          const results = await window.ollama!.generateEmbeddings(items);
          const batchEntries: CachedEmbedding[] = [];
          for (const item of batch) {
            const vec = results[item.game.id];
            if (!vec) continue;
            batchEntries.push({
              gameId: item.game.id,
              embedding: vec,
              textHash: item.hash,
              timestamp: Date.now(),
              format: 'f32',
            });
          }
          if (batchEntries.length > 0) {
            await saveCachedEmbeddings(batchEntries);
            for (const entry of batchEntries) {
              if (entry.embedding) {
                embeddingCacheRef.set(entry.gameId, entry.embedding);
                generated++;
              }
            }
            setEmbeddingCache(embeddingCacheRef);
            try {
              await annIndex.addVectors(
                batchEntries
                  .filter(e => e.embedding)
                  .map(e => ({ id: e.gameId, vector: e.embedding! })),
              );
            } catch { /* ANN not ready yet */ }
            await bumpEmbeddingContentEpoch();
          }
        } else {
          for (const item of batch) {
            await this._awaitIfPaused();
            if (librarySignal.aborted) break;
            try {
              const pooled = await embedAndPersistChunkedGame({
                tier: 'lib',
                gameId: item.game.id,
                pooledStore: LIBRARY_STORE,
                wholeHash: item.hash,
                chunkInput: {
                  title: item.game.title,
                  genres: item.game.genres,
                  themes: item.game.themes,
                  modes: item.game.modes,
                  playerPerspectives: item.game.playerPerspectives,
                  developer: item.game.developer,
                  summary: item.game.summary,
                  description: item.game.description,
                  userNotes: item.game.userNotes,
                  similarGames: item.game.similarGames,
                },
              });
              if (pooled) {
                const arr = Array.from(pooled);
                embeddingCacheRef.set(item.game.id, arr);
                generated++;
                try {
                  await annIndex.addVectors([{ id: item.game.id, vector: arr }]);
                } catch { /* ANN not ready yet */ }
                await bumpEmbeddingContentEpoch();
              }
            } catch (err) {
              console.warn(`[EmbeddingService] Library chunk write failed for ${item.game.id}:`, err);
            }
          }
          setEmbeddingCache(embeddingCacheRef);
        }

        completed += batch.length;
        this._libraryProgress = { completed, total: needsEmbedding.length };
        this._notify();
        onProgress?.(completed, needsEmbedding.length);

        if (i + BATCH_SIZE < needsEmbedding.length) {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      const status = (generated > 0 || this._loadedCount > 0) ? 'ready' as const : 'unavailable' as const;
      this._setLibraryStatus(status);
      this._libraryProgress = { completed: 0, total: 0 };

      console.log(`[EmbeddingService] Generated ${generated} new embeddings, total cached: ${embeddingCacheRef.size}`);
      return generated;
    } catch (err) {
      console.warn('[EmbeddingService] Error generating embeddings:', err);
      this._setLibraryStatus('unavailable');
      return 0;
    } finally {
      this._libraryAbort = null;
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

  /** True when setup resolved a reranker tier stronger than arctic-embed cosine. */
  get isRerankReady(): boolean { return this._rerankModelReady; }

  /** Tier resolved by the last `ollama:setup`, or null before setup ran. */
  get rerankTier(): RerankTier | null { return this._rerankTier; }

  /** Display name for the resolved tier — derived from the tier, never a label string. */
  get rerankTierLabel(): string { return rerankTierLabel(this._rerankTier); }

  /** Cancel an in-flight catalog embedding run. */
  cancelCatalogEmbeddings() {
    this._catalogAbort?.abort();
    this._catalogAbort = null;
  }

  /** Cancel an in-flight library embedding run. */
  cancelLibraryEmbeddings() {
    this._libraryAbort?.abort();
    this._libraryAbort = null;
  }

  /**
   * Background Tier 2: generate embeddings for catalog entries streamed from
   * the catalog store. Idempotent — if already running, returns the existing
   * promise so navigation away and back doesn't restart the work.
   *
   * @param opts.storeKey            Watermark key, e.g. 'steam-catalog'. Required
   *                                 to use the skip-scan optimization.
   * @param opts.lastSyncTimestamp   When the source catalog was last synced. If
   *                                 ≤ the recorded watermark AND version stamp
   *                                 matches, the cursor scan is skipped entirely.
   */
  generateCatalogEmbeddings(
    catalogIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>,
    opts?: { storeKey?: string; lastSyncTimestamp?: number },
  ): Promise<number> {
    if (this._catalogPromise) return this._catalogPromise;
    this._catalogPromise = this._runCatalogEmbeddings(catalogIterator, opts);
    return this._catalogPromise;
  }

  private async _runCatalogEmbeddings(
    catalogIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>,
    opts?: { storeKey?: string; lastSyncTimestamp?: number },
  ): Promise<number> {
    if (!(await this.isAvailable())) { this._catalogPromise = null; return 0; }

    this._catalogRunning = true;
    this._catalogAbort = new AbortController();
    const signal = this._catalogAbort.signal;
    this._notify();

    const storeKey = opts?.storeKey ?? 'steam-catalog';
    const lastSyncTimestamp = opts?.lastSyncTimestamp ?? 0;

    try {
      // ─── Watermark short-circuit ──────────────────────────────────────────
      // If the source catalog hasn't been re-synced since our last embedding
      // pass AND the version stamp is unchanged, skip the entire cursor scan.
      const watermark = await getEmbeddingMeta<EmbeddingPassWatermark>(storeKey);
      const canSkipScan =
        watermark &&
        lastSyncTimestamp > 0 &&
        lastSyncTimestamp <= watermark.syncTimestamp &&
        watermark.versionStamp === HASH_VERSION_PREFIX;

      if (canSkipScan) {
        console.log(`[EmbeddingService] Catalog unchanged since last pass — skipping scan (${storeKey})`);
        if (!annIndex.isReady) {
          await this._backfillAnnIndex();
        }
        annIndex.finishBuild();
        return 0;
      }

      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const cachedHashes = await getCatalogHashIndex();
      const cachedTimestamps = await getCatalogTimestampIndex();

      const needsEmbedding: Array<{ id: string; text: string; hash: string; entry: CatalogEntry }> = [];
      const refreshTimestampIds: string[] = [];
      let scannedTotal = 0;
      const refreshCutoff = Date.now() - TTL_REFRESH_THRESHOLD_MS;

      await catalogIterator((batch) => {
        for (const entry of batch) {
          const id = `steam-${entry.appid}`;
          const text = buildCatalogEmbeddingText(entry);
          const hash = hashText(text);
          const existing = cachedHashes.get(id);
          if (shouldSkipPooled(existing, hash)) {
            // Same content — just touch the timestamp if it's getting stale.
            const ts = cachedTimestamps.get(id) ?? 0;
            if (ts > 0 && ts < refreshCutoff) refreshTimestampIds.push(id);
            continue;
          }
          needsEmbedding.push({ id, text, hash, entry });
        }
        scannedTotal += batch.length;
      });

      cachedHashes.clear();
      cachedTimestamps.clear();

      if (refreshTimestampIds.length > 0) {
        // Fire-and-forget — purely a TTL extension, never blocks user-facing work.
        refreshCachedTimestamps(refreshTimestampIds, CATALOG_STORE)
          .then(() => console.log(`[EmbeddingService] Refreshed TTL for ${refreshTimestampIds.length} unchanged catalog entries`))
          .catch(() => { /* non-fatal */ });
      }

      if (needsEmbedding.length === 0) {
        console.log(`[EmbeddingService] All ${scannedTotal} catalog embeddings already cached`);
        // Backfill ANN index if it's empty (e.g. first launch after ANN was added, or index file deleted)
        if (!annIndex.isReady) {
          await this._backfillAnnIndex();
        }
        annIndex.finishBuild();
        // Write watermark — scan was clean, no work needed for current sync state.
        if (lastSyncTimestamp > 0) {
          await setEmbeddingMeta<EmbeddingPassWatermark>({
            key: storeKey,
            syncTimestamp: lastSyncTimestamp,
            versionStamp: HASH_VERSION_PREFIX,
            completedAt: Date.now(),
          });
        }
        return 0;
      }

      console.log(
        `[EmbeddingService] Generating ${needsEmbedding.length} catalog embeddings ` +
        `(chunking=${chunkingEnabled ? 'on' : 'off'})...`,
      );
      this._catalogProgress = { completed: 0, total: needsEmbedding.length };
      this._notify();

      const EMBED_BATCH = 100;
      const IDLE_DELAY_MS = 200;
      let totalGenerated = 0;
      let completed = 0;
      let writeFailures = 0;

      for (let i = 0; i < needsEmbedding.length; i += EMBED_BATCH) {
        await this._awaitIfPaused();
        if (signal.aborted) break;

        const batch = needsEmbedding.slice(i, i + EMBED_BATCH);

        if (!chunkingEnabled) {
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
                format: 'f32',
              });
            }
          }
          if (batchEntries.length > 0) {
            try {
              await saveCachedEmbeddings(batchEntries, CATALOG_STORE);
              totalGenerated += batchEntries.length;
              try {
                await annIndex.addVectors(
                  batchEntries
                    .filter(e => e.embedding)
                    .map(e => ({ id: e.gameId, vector: e.embedding! })),
                );
              } catch { /* ANN not ready yet — non-fatal */ }
              await bumpEmbeddingContentEpoch();
            } catch (err) {
              writeFailures += batchEntries.length;
              console.warn('[EmbeddingService] Catalog float persist failed:', err);
            }
          }
        } else {
          for (const item of batch) {
            await this._awaitIfPaused();
            if (signal.aborted) break;
            try {
              const pooled = await embedAndPersistChunkedGame({
                tier: 'cat',
                gameId: item.id,
                pooledStore: CATALOG_STORE,
                wholeHash: item.hash,
                chunkInput: {
                  title: item.entry.name,
                  genres: item.entry.genres,
                  themes: item.entry.themes,
                  modes: item.entry.modes,
                  developer: item.entry.developer,
                  shortDescription: item.entry.shortDescription,
                  source: 'steam',
                },
              });
              if (pooled) {
                totalGenerated++;
                try {
                  await annIndex.addVectors([{ id: item.id, vector: Array.from(pooled) }]);
                } catch { /* ANN not ready yet — non-fatal */ }
                await bumpEmbeddingContentEpoch();
              }
            } catch (err) {
              writeFailures++;
              console.warn(`[EmbeddingService] Catalog chunk write failed for ${item.id}:`, err);
            }
          }
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

      // Watermark only when pass completed with no unpersisted failures.
      if (!signal.aborted && writeFailures === 0 && lastSyncTimestamp > 0) {
        await setEmbeddingMeta<EmbeddingPassWatermark>({
          key: storeKey,
          syncTimestamp: lastSyncTimestamp,
          versionStamp: HASH_VERSION_PREFIX,
          completedAt: Date.now(),
        });
      }

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
    opts?: { storeKey?: string; lastSyncTimestamp?: number },
  ): Promise<number> {
    if (this._epicCatalogPromise) return this._epicCatalogPromise;
    this._epicCatalogPromise = this._runEpicCatalogEmbeddings(epicIterator, opts);
    return this._epicCatalogPromise;
  }

  private async _runEpicCatalogEmbeddings(
    epicIterator: (onBatch: (entries: EpicCatalogEntry[]) => void) => Promise<number>,
    opts?: { storeKey?: string; lastSyncTimestamp?: number },
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

    const storeKey = opts?.storeKey ?? 'epic-catalog';
    const lastSyncTimestamp = opts?.lastSyncTimestamp ?? 0;

    try {
      // Watermark short-circuit (see Steam loop for full explanation).
      const watermark = await getEmbeddingMeta<EmbeddingPassWatermark>(storeKey);
      const canSkipScan =
        watermark &&
        lastSyncTimestamp > 0 &&
        lastSyncTimestamp <= watermark.syncTimestamp &&
        watermark.versionStamp === HASH_VERSION_PREFIX;

      if (canSkipScan) {
        console.log(`[EmbeddingService] Epic catalog unchanged since last pass — skipping scan`);
        return 0;
      }

      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const cachedHashes = await getCatalogHashIndex();
      const cachedTimestamps = await getCatalogTimestampIndex();

      const needsEmbedding: Array<{ id: string; text: string; hash: string; entry: EpicCatalogEntry }> = [];
      const refreshTimestampIds: string[] = [];
      let scannedTotal = 0;
      const refreshCutoff = Date.now() - TTL_REFRESH_THRESHOLD_MS;

      await epicIterator((batch) => {
        for (const entry of batch) {
          const id = `epic-${entry.epicId}`;
          const text = buildEpicCatalogEmbeddingText(entry);
          const hash = hashText(text);
          const existing = cachedHashes.get(id);
          if (shouldSkipPooled(existing, hash)) {
            const ts = cachedTimestamps.get(id) ?? 0;
            if (ts > 0 && ts < refreshCutoff) refreshTimestampIds.push(id);
            continue;
          }
          needsEmbedding.push({ id, text, hash, entry });
        }
        scannedTotal += batch.length;
      });

      cachedHashes.clear();
      cachedTimestamps.clear();

      if (refreshTimestampIds.length > 0) {
        refreshCachedTimestamps(refreshTimestampIds, CATALOG_STORE)
          .then(() => console.log(`[EmbeddingService] Refreshed TTL for ${refreshTimestampIds.length} unchanged Epic entries`))
          .catch(() => { /* non-fatal */ });
      }

      if (needsEmbedding.length === 0) {
        console.log(`[EmbeddingService] All ${scannedTotal} Epic catalog embeddings already cached`);
        if (lastSyncTimestamp > 0) {
          await setEmbeddingMeta<EmbeddingPassWatermark>({
            key: storeKey,
            syncTimestamp: lastSyncTimestamp,
            versionStamp: HASH_VERSION_PREFIX,
            completedAt: Date.now(),
          });
        }
        return 0;
      }

      console.log(
        `[EmbeddingService] Generating ${needsEmbedding.length} Epic catalog embeddings ` +
        `(chunking=${chunkingEnabled ? 'on' : 'off'})...`,
      );
      this._catalogProgress = { completed: 0, total: needsEmbedding.length };
      this._notify();

      const EMBED_BATCH = 100;
      const IDLE_DELAY_MS = 200;
      let totalGenerated = 0;
      let completed = 0;
      let writeFailures = 0;

      for (let i = 0; i < needsEmbedding.length; i += EMBED_BATCH) {
        await this._awaitIfPaused();
        if (signal.aborted) break;

        const batch = needsEmbedding.slice(i, i + EMBED_BATCH);

        if (!chunkingEnabled) {
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
                format: 'f32',
              });
            }
          }
          if (batchEntries.length > 0) {
            try {
              await saveCachedEmbeddings(batchEntries, CATALOG_STORE);
              totalGenerated += batchEntries.length;
              try {
                await annIndex.addVectors(
                  batchEntries
                    .filter(e => e.embedding)
                    .map(e => ({ id: e.gameId, vector: e.embedding! })),
                );
              } catch { /* ANN not ready yet — non-fatal */ }
              await bumpEmbeddingContentEpoch();
            } catch (err) {
              writeFailures += batchEntries.length;
              console.warn('[EmbeddingService] Epic float persist failed:', err);
            }
          }
        } else {
          for (const item of batch) {
            await this._awaitIfPaused();
            if (signal.aborted) break;
            try {
              const pooled = await embedAndPersistChunkedGame({
                tier: 'cat',
                gameId: item.id,
                pooledStore: CATALOG_STORE,
                wholeHash: item.hash,
                chunkInput: {
                  title: item.entry.name,
                  genres: item.entry.genres,
                  themes: item.entry.themes,
                  modes: item.entry.modes,
                  developer: item.entry.developer,
                  description: item.entry.description,
                  longDescription: item.entry.longDescription,
                  source: 'epic',
                },
              });
              if (pooled) {
                totalGenerated++;
                try {
                  await annIndex.addVectors([{ id: item.id, vector: Array.from(pooled) }]);
                } catch { /* ANN not ready yet — non-fatal */ }
                await bumpEmbeddingContentEpoch();
              }
            } catch (err) {
              writeFailures++;
              console.warn(`[EmbeddingService] Epic chunk write failed for ${item.id}:`, err);
            }
          }
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

      if (!signal.aborted && writeFailures === 0 && lastSyncTimestamp > 0) {
        await setEmbeddingMeta<EmbeddingPassWatermark>({
          key: storeKey,
          syncTimestamp: lastSyncTimestamp,
          versionStamp: HASH_VERSION_PREFIX,
          completedAt: Date.now(),
        });
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

    // Yield to the main thread so the cursor sweep + ANN.addVectors calls
    // don't block UI / IPC for the ~30s a full 150K backfill takes.
    const yieldToEventLoop = () => new Promise<void>(resolve => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });

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
          const vec = readPooledVector(entry);
          if (
            vec &&
            !seen.has(entry.gameId) &&
            now - entry.timestamp < ttl
          ) {
            seen.add(entry.gameId);
            batch.push({ id: entry.gameId, vector: Array.from(vec) });
          }
          if (batch.length >= BATCH) {
            // Yield after each flush so other work (UI, IPC, sync) gets cycles.
            flushBatch()
              .then(yieldToEventLoop)
              .then(() => cursor.continue(), reject);
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

  /**
   * Clear the ANN index and rebuild from cached library + catalog pooled vectors.
   * Returns the vector count reported by the ANN service after backfill.
   */
  async rebuildAnnFromCache(): Promise<number> {
    await annIndex.clear();
    annIndex.setBuildProgress(0, 1);
    try {
      await this._backfillAnnIndex();
      await annIndex.refreshStatus();
      const count = annIndex.vectorCount;
      console.log(`[EmbeddingService] ANN rebuild from cache complete: ${count} vectors`);
      return count;
    } finally {
      annIndex.finishBuild();
    }
  }

  /** Reset availability check (e.g. after user changes Ollama settings). */
  resetAvailability() {
    this.ollamaAvailable = null;
    this.embeddingModelReady = false;
    this._rerankModelReady = false;
    this._rerankTier = null;
    this._embeddingsLoaded = false;
    this._loadedCount = 0;
  }
}

// Singleton
export const embeddingService = new EmbeddingService();

/**
 * Pooled embedding count only (library + catalog). Never includes chunk-embeddings.
 */
export async function getPooledEmbeddingCount(): Promise<number> {
  const db = await getDB();
  const countStore = (name: string): Promise<number> =>
    new Promise((resolve) => {
      if (!db.objectStoreNames.contains(name)) { resolve(0); return; }
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
 * Alias of getPooledEmbeddingCount — must not include chunk store rows.
 */
export async function getEmbeddingCount(): Promise<number> {
  return getPooledEmbeddingCount();
}

/**
 * Retrieve a single embedding vector by gameId (checks library store first,
 * then catalog). Returns null if not found. Always dequantized f32 number[].
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
        if (entry && now - entry.timestamp < ttl) {
          resolve(pooledVectorAsNumberArray(entry));
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
          readPooledVector(entry) &&
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
        const vec = readPooledVector(entry);
        if (vec && now - entry.timestamp < ttl) {
          const idx = idToIdx.get(entry.gameId);
          if (idx !== undefined) data.set(vec, idx * dim);
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
          readPooledVector(entry) &&
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
        const emb = readPooledVector(entry);
        if (emb && now - entry.timestamp < ttl) {
          const idx = idToIdx.get(entry.gameId);
          if (idx !== undefined) {
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
