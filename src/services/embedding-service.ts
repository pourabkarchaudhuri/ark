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
import { storeGetMany } from '@/services/store-bulk';
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
import {
  RECHUNK_META_KEY,
  advanceRechunkCursor,
  beginRechunkPhase,
  createInitialRechunkWatermark,
  gameNeedsChunkWork,
  gamesAfterCursor,
  nextRechunkPhase,
  recordRechunkFailure,
  rechunkBlockedReason,
  shouldResumeIdleRechunk,
  type RechunkPhase,
  type RechunkWatermark,
} from '@/services/embedding-rechunk';

export { extractFranchiseBase };
export {
  CURRENT_POOL_VERSION,
  EMBEDDING_CHUNK_VERSION,
  hashWholeEmbeddingText,
  buildGameChunks,
} from '@/services/embedding-chunks';
export {
  RECHUNK_META_KEY,
  shouldResumeIdleRechunk,
  rechunkProgressPercent,
  type RechunkPhase,
  type RechunkWatermark,
} from '@/services/embedding-rechunk';
export { EMBEDDING_DIM, quantizeEmbedding, dequantizeEmbedding } from '@/services/embedding-quant';

/** Library/custom game input for the Wave 3.1 re-chunk job. */
export type RechunkLibraryGame = {
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
};

export interface RechunkJobDeps {
  libraryGames: RechunkLibraryGame[];
  steamIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>;
  epicIterator?: (onBatch: (entries: EpicCatalogEntry[]) => void) => Promise<number>;
  /** Optional totals for progress UI (catalog entry counts). */
  steamTotal?: number;
  epicTotal?: number;
}

export interface RechunkJobResult {
  status: 'done' | 'cancelled' | 'blocked' | 'error';
  successCount: number;
  skippedCount: number;
  failureCount: number;
  blockedReason?: string;
  suggestRebuildAnn: boolean;
}

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
      generateEmbeddings: {
        (items: Array<{ id: string; text: string }>): Promise<Record<string, number[]>>;
        /** v1.0.73: also report ids that failed for transient reasons (timeout / never sent). */
        (items: Array<{ id: string; text: string }>, opts: { reportTransient: true }): Promise<{ results: Record<string, number[]>; transientIds: string[] } | Record<string, number[]>>;
      };
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

/** One decoded pooled vector ready for ANN IPC (collect phase of backfill). */
export type AnnBackfillRow = { id: string; vector: number[] };

/** Max eligible rows collected per IDB cursor session before closing the tx. */
const ANN_BACKFILL_PAGE_SIZE = 1000;
/** IPC addVectors batch size — used only outside IDB transactions. */
const ANN_BACKFILL_FLUSH_BATCH = 500;

/**
 * Split collected ANN rows into flush-sized batches for `addVectors` outside IDB.
 * Pure helper — keeps cursor collect and IPC flush phases separable/testable.
 */
export function partitionEmbeddingRowsForAnnBackfill<T>(
  rows: readonly T[],
  batchSize: number,
): T[][] {
  if (batchSize <= 0) throw new Error('batchSize must be > 0');
  if (rows.length === 0) return [];
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize) as T[]);
  }
  return batches;
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

// ─── LevelDB migration (v1.0.67) ────────────────────────────────────────────
//
// Same hardened pattern established in catalog-store.ts / epic-catalog-store.ts
// (v1.0.65, refined after an adversarial review found 6 real bugs in the first
// draft): no `store.has()`-based "already migrated" shortcut — a crashed prior
// attempt that wrote some rows would satisfy that check and permanently
// orphan the rest. No trust in a single meta value's presence as a proxy for
// "does data exist." The migration marker + meta counts are stamped only
// after a FULL successful stream, using the ACTUAL migrated counts. A failed
// attempt never permanently blocks a later retry (in-session or a future
// launch). Concurrent callers share one in-flight migration via a memoized
// promise.
//
// Namespace layout (all in the same LevelDB used by every other store):
//   embed-library  — Tier 1 pooled embeddings, key = gameId.
//   embed-catalog  — Tier 2 pooled embeddings, key = gameId (steam-/epic- prefixed).
//   embed-chunks   — facet chunks, DENORMALIZED: key = `${tier}:${gameId}`,
//                    value = CachedChunk[] for that exact (tier,gameId) pair.
//                    This directly replaces IDB's `byTierGame` index (used by
//                    4 call sites) with a single point lookup instead of an
//                    index range scan. IDB's `byGame` index (cross-tier, used
//                    by the exported `getChunksForGame` — confirmed to have
//                    ZERO callers anywhere in the codebase today) is not
//                    replicated as its own structure; `getChunksForGame`
//                    below falls back to a full-namespace scan + filter on
//                    the LevelDB path, which is fine since nothing calls it.
//   embed-meta     — small KV: embeddingContentEpoch, rechunk-job watermark,
//                    steam-catalog / epic-catalog embedding-pass watermarks.
//
// LevelDB values are JSON-encoded — an Int8Array does NOT survive
// JSON.stringify/parse (it round-trips as a plain object with numeric string
// keys: `{"0":1,"1":2,...}`, which fails every branch of `coerceInt8Q` since
// that object has no `.length`). Every LevelDB write below converts `q`
// fields to a plain `number[]` via `Array.from()` before storing; no special
// handling is needed on read, since `coerceInt8Q`'s array-like branch
// (`typeof q.length === 'number' && q.length === EMBEDDING_DIM`) already
// accepts a real `Array` and converts it back to `Int8Array`.

const LEVEL_LIBRARY_NAMESPACE = 'embed-library';
const LEVEL_CATALOG_NAMESPACE = 'embed-catalog';
const LEVEL_CHUNKS_NAMESPACE = 'embed-chunks';
const LEVEL_META_NAMESPACE = 'embed-meta';
const LEVEL_CHUNK_PAGE_SIZE = 1000;
const LEVEL_MIGRATION_MARKER_KEY = 'ark-embeddings-migrated-v1';

/**
 * Set once a migration attempt fails this session (see
 * `runEmbeddingsMigration`'s catch block for the full rationale). While
 * true, `useLevelDB()` reports false so every dual-pathed function
 * genuinely falls back to the legacy IDB path — which still holds the
 * complete, untouched data — instead of silently operating on a LevelDB
 * namespace that a failed migration may have only partially populated.
 */
let _embedMigrationFailedThisSession = false;

function useLevelDB(): boolean {
  if (_embedMigrationFailedThisSession) return false;
  return typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
}

/** Convert a pooled row's Int8Array `q` (if present) to a plain array for LevelDB's JSON encoding. */
function toLevelPooled(entry: CachedEmbedding): CachedEmbedding {
  if (entry.q == null) return entry;
  return { ...entry, q: Array.from(entry.q) as unknown as Int8Array };
}

/** Convert a chunk row's Int8Array `q` to a plain array for LevelDB's JSON encoding. */
function toLevelChunk(row: CachedChunk): CachedChunk {
  return { ...row, q: Array.from(row.q) as unknown as Int8Array };
}

function pooledNamespaceFor(storeName: string): string {
  return storeName === CATALOG_STORE ? LEVEL_CATALOG_NAMESPACE : LEVEL_LIBRARY_NAMESPACE;
}

// ─── Pooled key index (cheap counts) ────────────────────────────────────────
//
// LevelDB has no cheap count and the store API has no keys-only scan, so
// `getPooledEmbeddingCount` used to page through every VALUE (~4 KB of JSON
// per vector, ~160k vectors) each time galaxy-cache polled it. Instead the
// first complete walk of a pooled namespace seeds a Set of its keys, and every
// write through this module adds its keys — this module is the only writer of
// these namespaces and never deletes pooled rows, so `set.size` stays exact.
// Writes that land while a seeding walk is still in progress are journaled
// and merged in when it finishes.

const _pooledKeyIndex = new Map<string, Set<string>>();
const _pooledKeyJournal = new Map<string, Set<string>>();
const _pooledCountInFlight = new Map<string, Promise<number>>();

function notePooledKeysWritten(namespace: string, keys: Iterable<string>): void {
  const set = _pooledKeyIndex.get(namespace);
  const journal = _pooledKeyJournal.get(namespace);
  if (!set && !journal) return;
  for (const k of keys) {
    set?.add(k);
    journal?.add(k);
  }
}

function invalidatePooledKeyIndex(): void {
  _pooledKeyIndex.clear();
}

/** Cached pooled-row count for one namespace; seeds the key index on first use. */
async function levelPooledCount(namespace: string): Promise<number> {
  const known = _pooledKeyIndex.get(namespace);
  if (known) return known.size;
  let inFlight = _pooledCountInFlight.get(namespace);
  if (!inFlight) {
    inFlight = levelStreamPooled(namespace, () => { /* count only */ })
      .then((n) => _pooledKeyIndex.get(namespace)?.size ?? n)
      .finally(() => { _pooledCountInFlight.delete(namespace); });
    _pooledCountInFlight.set(namespace, inFlight);
  }
  return inFlight;
}

async function levelGetMeta<T>(key: string): Promise<T | null> {
  const res = await window.store!.get<T>(LEVEL_META_NAMESPACE, key);
  if (res.error) {
    console.error(`[EmbeddingService] meta get(${key}) failed:`, res.error);
    return null;
  }
  return (res.value ?? null) as T | null;
}

async function levelSetMeta<T extends { key: string }>(value: T): Promise<void> {
  const res = await window.store!.put(LEVEL_META_NAMESPACE, value.key, value);
  if (res.error) console.error(`[EmbeddingService] meta put(${value.key}) failed:`, res.error);
}

async function levelGetPooled(namespace: string, gameId: string): Promise<CachedEmbedding | null> {
  const res = await window.store!.get<CachedEmbedding>(namespace, gameId);
  if (res.error) {
    console.error(`[EmbeddingService] get(${namespace}, ${gameId}) failed:`, res.error);
    return null;
  }
  return res.value ?? null;
}

async function levelPutPooledBatch(namespace: string, entries: CachedEmbedding[]): Promise<void> {
  if (entries.length === 0) return;
  const ops = entries.map((e) => ({
    type: 'put' as const,
    namespace,
    key: e.gameId,
    value: toLevelPooled(e),
  }));
  const res = await window.store!.batch(ops);
  if (res.error) throw new Error(`[EmbeddingService] batch put(${namespace}) failed: ${res.error}`);
  notePooledKeysWritten(namespace, entries.map((e) => e.gameId));
}

/**
 * Paginated walk over a pooled store (embed-library / embed-catalog).
 *
 * `prefix` limits the walk to keys starting with it (e.g. `steam-` / `epic-`
 * in the shared catalog namespace): the scan starts just before the prefix
 * and stops at the first key past it, instead of reading the other store's
 * rows only to discard them. A complete un-prefixed walk seeds the pooled
 * key index used for cheap counts.
 */
async function levelStreamPooled(
  namespace: string,
  onEntry: (entry: CachedEmbedding) => void | Promise<void>,
  opts?: { prefix?: string },
): Promise<number> {
  const prefix = opts?.prefix;
  const seed = !prefix && !_pooledKeyIndex.has(namespace) && !_pooledKeyJournal.has(namespace);
  const seenKeys = seed ? new Set<string>() : null;
  if (seed) _pooledKeyJournal.set(namespace, new Set());
  // Keys are compared lexicographically and every key with the prefix sorts
  // strictly after the bare prefix itself, so it is a valid exclusive start.
  let startAfter: string | undefined = prefix;
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const res = await window.store!.getChunk<CachedEmbedding>(namespace, { startAfter, limit: LEVEL_CHUNK_PAGE_SIZE });
      if (res.error) {
        console.error(`[EmbeddingService] getChunk(${namespace}) failed:`, res.error);
        break;
      }
      const rows = res.rows ?? [];
      let pastPrefix = false;
      for (const row of rows) {
        if (prefix && !row.key.startsWith(prefix)) { pastPrefix = true; break; }
        seenKeys?.add(row.key);
        await onEntry(row.value);
        total++;
      }
      if (pastPrefix || res.done || !res.nextKey) { complete = true; break; }
      startAfter = res.nextKey;
    }
  } finally {
    if (seed) {
      const journal = _pooledKeyJournal.get(namespace);
      _pooledKeyJournal.delete(namespace);
      if (complete && seenKeys) {
        if (journal) for (const k of journal) seenKeys.add(k);
        _pooledKeyIndex.set(namespace, seenKeys);
      }
    }
  }
  return total;
}

async function levelGetChunkGroup(tier: EmbeddingTier, gameId: string): Promise<CachedChunk[]> {
  const res = await window.store!.get<CachedChunk[]>(LEVEL_CHUNKS_NAMESPACE, `${tier}:${gameId}`);
  if (res.error) {
    console.error('[EmbeddingService] get(embed-chunks) failed:', res.error);
    return [];
  }
  return res.value ?? [];
}

/** Paginated full-namespace walk over embed-chunks (each row is one game's chunk array). */
async function levelStreamAllChunkGroups(
  onGroup: (chunks: CachedChunk[]) => void | Promise<void>,
): Promise<number> {
  let startAfter: string | undefined;
  let total = 0;
  while (true) {
    const res = await window.store!.getChunk<CachedChunk[]>(LEVEL_CHUNKS_NAMESPACE, { startAfter, limit: LEVEL_CHUNK_PAGE_SIZE });
    if (res.error) {
      console.error('[EmbeddingService] getChunk(embed-chunks) failed:', res.error);
      break;
    }
    const rows = res.rows ?? [];
    for (const row of rows) { await onGroup(row.value); total++; }
    if (res.done || !res.nextKey) break;
    startAfter = res.nextKey;
  }
  return total;
}

/**
 * Read one page of an IDB object store in primary-key order, strictly after
 * `afterKey`. The readonly transaction only ever runs synchronous
 * `cursor.continue()` and is left to auto-commit once the page resolves —
 * never awaited across, so it can't go inactive mid-cursor.
 */
function idbReadStorePage<T>(
  db: IDBDatabase,
  storeName: string,
  afterKey: IDBValidKey | null,
  size: number,
): Promise<{ rows: T[]; lastKey: IDBValidKey | null; done: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = afterKey != null
      ? store.openCursor(IDBKeyRange.lowerBound(afterKey, true))
      : store.openCursor();
    const rows: T[] = [];
    let lastKey: IDBValidKey | null = null;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve({ rows, lastKey, done: true }); return; }
      rows.push(cursor.value as T);
      lastKey = cursor.primaryKey;
      if (rows.length >= size) { resolve({ rows, lastKey, done: false }); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error(`[EmbeddingService] IDB cursor error streaming ${storeName}`));
  });
}

/**
 * Stream every row of an IDB object store in pages of `size`, AWAITING
 * `onBatch` before the next page is read.
 *
 * The previous version kept one cursor running while chaining writes onto a
 * `pending` promise (awaiting inside the cursor would let the transaction go
 * inactive). The cursor therefore outran the writes and buffered the entire
 * store — ~160k vectors — in memory before the first write finished. Paging
 * by re-opening a fresh transaction from an exclusive lower bound keeps
 * memory bounded to one page and gives true backpressure. A write failure
 * propagates out immediately (no further pages are read).
 */
async function idbStreamStore<T>(
  storeName: string,
  onBatch: (rows: T[]) => Promise<void>,
  size = 500,
): Promise<number> {
  const db = await getDB();
  if (!db.objectStoreNames.contains(storeName)) return 0;
  let afterKey: IDBValidKey | null = null;
  let count = 0;
  for (;;) {
    const page: { rows: T[]; lastKey: IDBValidKey | null; done: boolean } =
      await idbReadStorePage<T>(db, storeName, afterKey, size);
    if (page.rows.length > 0) {
      await onBatch(page.rows);
      count += page.rows.length;
    }
    if (page.done || page.lastKey == null) break;
    afterKey = page.lastKey;
  }
  return count;
}

type IdbChunkGroup = { tier: EmbeddingTier; gameId: string; chunks: CachedChunk[] };

/**
 * Read up to `maxGroups` COMPLETE (tier,gameId) chunk groups via the
 * `byTierGame` index, strictly after the group key `afterKey`. A page only
 * ever ends at a group boundary (when the cursor reaches the first row of
 * group `maxGroups + 1`, that row is left for the next page), so a group is
 * never split across pages. See `idbStreamChunkGroups` for why the compound
 * index (not the chunkId primary key) is iterated.
 */
function idbReadChunkGroupPage(
  db: IDBDatabase,
  afterKey: [string, string] | null,
  maxGroups: number,
): Promise<{ groups: IdbChunkGroup[]; lastKey: [string, string] | null; done: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const index = tx.objectStore(CHUNK_STORE).index('byTierGame');
    const req = afterKey != null
      ? index.openCursor(IDBKeyRange.lowerBound(afterKey, true))
      : index.openCursor();
    const groups: IdbChunkGroup[] = [];
    let current: IdbChunkGroup | null = null;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        const last = groups[groups.length - 1];
        resolve({ groups, lastKey: last ? [last.tier, last.gameId] : null, done: true });
        return;
      }
      const row = cursor.value as CachedChunk;
      if (!current || row.tier !== current.tier || row.gameId !== current.gameId) {
        if (groups.length >= maxGroups) {
          const last = groups[groups.length - 1];
          resolve({ groups, lastKey: [last.tier, last.gameId], done: false });
          return;
        }
        current = { tier: row.tier, gameId: row.gameId, chunks: [] };
        groups.push(current);
      }
      current.chunks.push(row);
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('[EmbeddingService] IDB cursor error streaming chunk-embeddings'));
  });
}

/**
 * Stream CHUNK_STORE grouped by (tier,gameId), `groupsPerPage` complete groups
 * at a time, awaiting `onGroups` before the next page is read (same bounded-
 * memory paging as `idbStreamStore`).
 *
 * Iterates via the `byTierGame` COMPOUND INDEX (`[tier, gameId]`), not the
 * primary key (`chunkId`). This is deliberate: an earlier version grouped by
 * comparing the STRING `` `${tier}:${gameId}` `` while iterating the primary
 * key (chunkId = `` `${tier}:${gameId}::${kind}#${seq}` ``), reasoning that
 * chunks sharing a gameId share an identical chunkId prefix and are
 * therefore contiguous. That reasoning is false whenever one game's id is a
 * proper prefix of another's — e.g. gameId "42" and gameId "42::ghost" (Epic
 * ids can contain arbitrary API-supplied text after their `namespace:` part,
 * unsanitized) produce chunkIds that *interleave* in ascending string order
 * (`lib:42::facets#0` < `lib:42::ghost::facets#0` < `lib:42::notes#0`),
 * causing this game's chunks to be flushed twice with the LATER flush
 * silently overwriting — and losing — the earlier one's chunks.
 *
 * IDB's compound-index key comparison has no such ambiguity: it compares
 * the actual `[tier, gameId]` field VALUES pairwise, not a synthesized
 * concatenated string, so two rows share the exact same index key if and
 * only if their `tier` and `gameId` are literally equal — no prefix/
 * separator collision is possible regardless of what characters either
 * field contains. This guarantees every one of one game's chunks is
 * contiguous in this iteration, and lets a page resume from an exclusive
 * lower bound on the last complete group's `[tier, gameId]` key.
 */
async function idbStreamChunkGroups(
  onGroups: (groups: IdbChunkGroup[]) => Promise<void>,
  groupsPerPage: number,
): Promise<number> {
  const db = await getDB();
  if (!db.objectStoreNames.contains(CHUNK_STORE)) return 0;
  {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    if (!tx.objectStore(CHUNK_STORE).indexNames.contains('byTierGame')) return 0;
  }
  let afterKey: [string, string] | null = null;
  let totalGroups = 0;
  for (;;) {
    const page: { groups: IdbChunkGroup[]; lastKey: [string, string] | null; done: boolean } =
      await idbReadChunkGroupPage(db, afterKey, groupsPerPage);
    if (page.groups.length > 0) {
      await onGroups(page.groups);
      totalGroups += page.groups.length;
    }
    if (page.done || page.lastKey == null) break;
    afterKey = page.lastKey;
  }
  return totalGroups;
}

/** Pooled rows per IDB read page / `store.batch` during migration. */
const MIGRATION_POOLED_PAGE = 500;
/** Chunk groups (one game each, a handful of chunks) per `store.batch` during migration. */
const MIGRATION_CHUNK_GROUPS_PER_BATCH = 200;
let _embedMigrationChecked = false;
let _embedMigrationPromise: Promise<void> | null = null;

/**
 * One-shot IDB → LevelDB migration for all four embedding stores, memoized
 * so every concurrent caller shares one in-flight attempt. See the namespace
 * layout comment above for the full design rationale.
 */
function migrateEmbeddingsFromIdbIfNeeded(): Promise<void> {
  if (_embedMigrationChecked) return Promise.resolve();
  if (!useLevelDB()) {
    _embedMigrationChecked = true;
    return Promise.resolve();
  }
  if (localStorage.getItem(LEVEL_MIGRATION_MARKER_KEY) === 'yes') {
    _embedMigrationChecked = true;
    return Promise.resolve();
  }
  if (_embedMigrationPromise) return _embedMigrationPromise;

  _embedMigrationPromise = runEmbeddingsMigration().finally(() => {
    _embedMigrationPromise = null;
  });
  return _embedMigrationPromise;
}

async function runEmbeddingsMigration(): Promise<void> {
  try {
    // Every write below is a `store.batch` of hundreds of rows, awaited
    // before the next IDB page is read. The chunk groups used to be copied
    // with one `store.put` per game in sequence — tens of thousands of IPC
    // calls that tripped the store rate limiter, threw, and (with no marker
    // stamped) re-ran the whole migration on every launch.
    let libraryCount = 0;
    await idbStreamStore<CachedEmbedding>(LIBRARY_STORE, async (rows) => {
      await levelPutPooledBatch(LEVEL_LIBRARY_NAMESPACE, rows);
      libraryCount += rows.length;
    }, MIGRATION_POOLED_PAGE);

    let catalogCount = 0;
    await idbStreamStore<CachedEmbedding>(CATALOG_STORE, async (rows) => {
      await levelPutPooledBatch(LEVEL_CATALOG_NAMESPACE, rows);
      catalogCount += rows.length;
    }, MIGRATION_POOLED_PAGE);

    let chunkGroupCount = 0;
    await idbStreamChunkGroups(async (groups) => {
      const res = await window.store!.batch(groups.map((g) => ({
        type: 'put' as const,
        namespace: LEVEL_CHUNKS_NAMESPACE,
        key: `${g.tier}:${g.gameId}`,
        value: g.chunks.map(toLevelChunk),
      })));
      if (res.error) {
        throw new Error(`[EmbeddingService] chunk group batch failed: ${res.error}`);
      }
      chunkGroupCount += groups.length;
    }, MIGRATION_CHUNK_GROUPS_PER_BATCH);

    // Meta keys: copy whichever of the known keys actually exist. Missing
    // keys (e.g. a fresh install that never ran the rechunk job) are simply
    // skipped — there is nothing to preserve.
    const metaKeys = ['embeddingContentEpoch', RECHUNK_META_KEY, 'steam-catalog', 'epic-catalog', EMBED_FAILURES_META_KEY];
    const metaOps: Array<{ type: 'put'; namespace: string; key: string; value: unknown }> = [];
    for (const key of metaKeys) {
      const legacy = await idbGetEmbeddingMeta<{ key: string }>(key);
      if (legacy) metaOps.push({ type: 'put', namespace: LEVEL_META_NAMESPACE, key: legacy.key, value: legacy });
    }
    if (metaOps.length > 0) {
      const res = await window.store!.batch(metaOps);
      if (res.error) throw new Error(`[EmbeddingService] meta batch failed: ${res.error}`);
    }

    // A key set seeded by a scan that raced the copy above may be incomplete.
    invalidatePooledKeyIndex();
    localStorage.setItem(LEVEL_MIGRATION_MARKER_KEY, 'yes');
    _embedMigrationChecked = true;

    console.log(
      `[EmbeddingService] Migrated ${libraryCount} library + ${catalogCount} catalog embeddings, ` +
      `${chunkGroupCount} chunk groups, IDB -> LevelDB`,
    );
  } catch (err) {
    console.error('[EmbeddingService] IDB->LevelDB migration failed, will retry next session:', err);
    // Deliberately do NOT stamp the localStorage marker — a fresh app
    // launch (new module load, all migration flags reset to their initial
    // false) will retry the full stream then, self-healing across restarts.
    //
    // BUT this differs from catalog-store.ts's "retry on next call" policy:
    // there, dual-pathed functions are called infrequently (top-level sync
    // orchestration). Here, `getChunksForTierGame`/`writeGameChunksAndPool`
    // are called from `embedAndPersistChunkedGame`, invoked ONCE PER GAME
    // inside a tight loop that runs up to ~163k times during a full catalog
    // embedding pass. If migration were left retryable per-call, EVERY one
    // of those thousands of calls would independently kick off a brand-new
    // full migration attempt (re-streaming the entire library+catalog+
    // chunks IDB data every time), and if the underlying cause is anything
    // other than a one-off transient hiccup, every retry fails too — a
    // retry-storm that manifests as the whole embedding pass hanging
    // indefinitely (reported by users as progress stuck at "Waiting for
    // embeddings"). Setting BOTH flags here stops that at the source:
    // `_embedMigrationChecked` skips the retry attempt itself, and
    // `_embedMigrationFailedThisSession` makes `useLevelDB()` report false
    // so every dual-pathed function falls back to the legacy IDB path
    // (still complete and untouched) instead of silently reading/writing a
    // LevelDB namespace a failed migration may have only partially filled.
    _embedMigrationChecked = true;
    _embedMigrationFailedThisSession = true;
  }
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

/** Public: all chunk rows for a game (any tier), undecoded. */
/**
 * All chunk rows for a game, any tier. No consumer calls this anywhere in the
 * codebase today (confirmed dead export, kept for API compatibility) — the
 * LevelDB path implements it correctly via a full-namespace scan + filter
 * rather than a dedicated index, since nothing depends on it being fast.
 */
export async function getChunksForGame(gameId: string): Promise<CachedChunk[]> {
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) {
    const out: CachedChunk[] = [];
    await levelStreamAllChunkGroups((chunks) => {
      for (const c of chunks) if (c.gameId === gameId) out.push(c);
    });
    return out;
  }
  const db = await getDB();
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(CHUNK_STORE)) {
      resolve([]);
      return;
    }
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    if (!store.indexNames.contains('byGame')) {
      resolve([]);
      return;
    }
    const req = store.index('byGame').getAll(gameId);
    req.onsuccess = () => resolve((req.result as CachedChunk[]) ?? []);
    req.onerror = () => resolve([]);
  });
}

/** Decode one chunk row for ANN ingest (null when expired / undecodable). */
function chunkRowToAnn(row: CachedChunk, now: number, ttl: number): AnnBackfillRow | null {
  if (now - row.timestamp >= ttl) return null;
  const q = coerceInt8Q(row.q);
  if (!q || typeof row.scale !== 'number') return null;
  return { id: row.chunkId, vector: Array.from(dequantizeEmbedding(q, row.scale)) };
}

/**
 * Stream decoded chunk-embeddings rows for ANN ingest, `pageSize` rows at a
 * time, awaiting `onPage` (the ANN flush) before reading further. Uses
 * coerceInt8Q + dequantize; skips undecodable rows. Chunk ANN ids contain
 * `::`; pooled game ids do not (filter via isChunkAnnId).
 *
 * Replaces collecting EVERY chunk vector into one `number[]`-per-row array
 * (several hundred thousand × 1024 doubles — multiple GB) before the first
 * ANN flush, which is what ran the renderer out of memory on a full catalog.
 */
export async function streamChunkVectorsForAnn(
  onPage: (rows: AnnBackfillRow[]) => Promise<void>,
  pageSize = ANN_BACKFILL_PAGE_SIZE,
): Promise<number> {
  await migrateEmbeddingsFromIdbIfNeeded();
  const now = Date.now();
  const ttl = Math.max(LIBRARY_TTL, CATALOG_TTL);
  let total = 0;

  if (useLevelDB()) {
    let buffer: AnnBackfillRow[] = [];
    await levelStreamAllChunkGroups(async (chunks) => {
      for (const row of chunks) {
        const decoded = chunkRowToAnn(row, now, ttl);
        if (decoded) buffer.push(decoded);
      }
      if (buffer.length >= pageSize) {
        const page = buffer;
        buffer = [];
        total += page.length;
        await onPage(page);
      }
    });
    if (buffer.length > 0) {
      total += buffer.length;
      await onPage(buffer);
    }
    return total;
  }

  const db = await getDB();
  if (!db.objectStoreNames.contains(CHUNK_STORE)) return 0;
  await idbStreamStore<CachedChunk>(CHUNK_STORE, async (rows) => {
    const page: AnnBackfillRow[] = [];
    for (const row of rows) {
      const decoded = chunkRowToAnn(row, now, ttl);
      if (decoded) page.push(decoded);
    }
    if (page.length > 0) {
      total += page.length;
      await onPage(page);
    }
  }, pageSize);
  return total;
}

/**
 * Decode all chunk-embeddings rows for ANN ingest into one array. Kept for
 * API compatibility / tests only — the backfill streams via
 * `streamChunkVectorsForAnn` instead, since this holds every vector at once.
 */
export async function listChunkVectorsForAnn(): Promise<AnnBackfillRow[]> {
  const out: AnnBackfillRow[] = [];
  await streamChunkVectorsForAnn(async (rows) => { out.push(...rows); });
  return out;
}
async function getCachedEmbeddings(
  storeName: string = LIBRARY_STORE,
  ttl: number = LIBRARY_TTL,
): Promise<Map<string, CachedEmbedding>> {
  await migrateEmbeddingsFromIdbIfNeeded();
  const map = new Map<string, CachedEmbedding>();
  const now = Date.now();

  if (useLevelDB()) {
    await levelStreamPooled(pooledNamespaceFor(storeName), (entry) => {
      if (now - entry.timestamp < ttl) map.set(entry.gameId, entry);
    });
    return map;
  }

  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
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
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) {
    return levelPutPooledBatch(pooledNamespaceFor(storeName), entries);
  }
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
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) {
    const chunks = await levelGetChunkGroup(tier, gameId);
    const map = new Map<string, CachedChunk>();
    for (const row of chunks) map.set(row.chunkId, row);
    return map;
  }
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

/** Quantized rows for one game's chunk-group + pooled rewrite. */
function buildGameWriteRows(opts: {
  tier: EmbeddingTier;
  gameId: string;
  wholeHash: string;
  chunks: Array<ChunkSpec & { vector: Float32Array | number[] }>;
}): { pooledF32: Float32Array; pooledRow: CachedEmbedding; chunkRows: CachedChunk[] } {
  const { tier, gameId, wholeHash, chunks } = opts;
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

  const chunkRows: CachedChunk[] = chunks.map((chunk) => {
    const cq = quantizeEmbedding(chunk.vector);
    return {
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
  });
  return { pooledF32, pooledRow, chunkRows };
}

/** The two LevelDB ops (chunk group + pooled row) that rewrite one game. */
function levelGameWriteOps(
  tier: EmbeddingTier,
  gameId: string,
  pooledStore: string,
  rows: { pooledRow: CachedEmbedding; chunkRows: CachedChunk[] },
): Array<{ type: 'put'; namespace: string; key: string; value: unknown }> {
  // `chunkRows` is already the game's FULL current desired set (every facet
  // chunk currently wanted, whether newly-embedded or reused unchanged), so
  // writing it as the whole denormalized array for this (tier,gameId) key
  // implicitly drops any stale chunk ids — no separate delete step needed,
  // unlike IDB's per-row store.
  return [
    {
      type: 'put',
      namespace: LEVEL_CHUNKS_NAMESPACE,
      key: `${tier}:${gameId}`,
      value: rows.chunkRows.map(toLevelChunk),
    },
    {
      type: 'put',
      namespace: pooledNamespaceFor(pooledStore),
      key: gameId,
      value: toLevelPooled(rows.pooledRow),
    },
  ];
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
  const { tier, gameId, pooledStore, staleIds } = opts;
  const { pooledF32, pooledRow, chunkRows } = buildGameWriteRows(opts);

  await migrateEmbeddingsFromIdbIfNeeded();

  if (useLevelDB()) {
    // One atomic `batch()` call spans both the chunk-group row and the
    // pooled row, matching IDB's single-transaction guarantee.
    const res = await window.store!.batch(levelGameWriteOps(tier, gameId, pooledStore, { pooledRow, chunkRows }));
    if (res.error) {
      throw new Error(`[EmbeddingService] writeGameChunksAndPool batch failed: ${res.error}`);
    }
    notePooledKeysWritten(pooledNamespaceFor(pooledStore), [gameId]);
    return pooledF32;
  }

  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CHUNK_STORE, pooledStore], 'readwrite');
    const chunkStore = tx.objectStore(CHUNK_STORE);
    const poolStore = tx.objectStore(pooledStore);

    for (const id of staleIds) {
      chunkStore.delete(id);
    }
    for (const row of chunkRows) {
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
/**
 * Last epoch read/written this session. This module is the epoch's only
 * writer, so a bump needs one meta write instead of a read + write per game.
 */
let _epochCache: number | null = null;

async function bumpEmbeddingContentEpoch(): Promise<number> {
  const current = _epochCache ?? await getEmbeddingContentEpoch();
  const next = current + 1;
  _epochCache = next;
  await setEmbeddingMeta({ key: META_EPOCH_KEY, value: next });
  return next;
}

export async function getEmbeddingContentEpoch(): Promise<number> {
  if (_epochCache !== null) return _epochCache;
  const row = await getEmbeddingMeta<{ key: string; value: number }>(META_EPOCH_KEY);
  const value = typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : 0;
  _epochCache = value;
  return value;
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

async function idbGetEmbeddingMeta<T extends { key: string }>(key: string): Promise<T | null> {
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSetEmbeddingMeta<T extends { key: string }>(value: T): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('setEmbeddingMeta failed'));
    tx.onabort = () => reject(tx.error ?? new Error('setEmbeddingMeta aborted'));
  });
}

/** Dual-path meta getter — LevelDB (post-migration) or legacy IDB fallback. */
async function getEmbeddingMeta<T extends { key: string }>(key: string): Promise<T | null> {
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) return levelGetMeta<T>(key);
  return idbGetEmbeddingMeta<T>(key);
}

/** Dual-path meta setter — LevelDB (post-migration) or legacy IDB fallback. */
async function setEmbeddingMeta<T extends { key: string }>(value: T): Promise<void> {
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) return levelSetMeta(value);
  return idbSetEmbeddingMeta(value);
}

// ─── Poison-game ledger ─────────────────────────────────────────────────────
//
// Per-game embed failure counts, persisted in embedding meta. A game whose
// text Ollama keeps rejecting used to (a) block the catalog pass watermark
// forever — so every launch rescanned the whole catalog — and (b) stop the
// re-chunk job dead without advancing its cursor. After POISON_MAX_ATTEMPTS
// failures on the SAME text hash the game is skipped (a content change resets
// it), and passes may complete — watermark written / cursor advanced — past it.

const EMBED_FAILURES_META_KEY = 'embed-failures';
export const POISON_MAX_ATTEMPTS = 3;
/** Bound on persisted records — oldest dropped first. */
const POISON_MAX_RECORDS = 5000;

interface EmbedFailureRecord { attempts: number; hash: string; lastAt: number }
interface EmbedFailuresMeta { key: typeof EMBED_FAILURES_META_KEY; games: Record<string, EmbedFailureRecord> }

class EmbedFailureLedger {
  private readonly games = new Map<string, EmbedFailureRecord>();
  private dirty = false;

  constructor(initial?: Record<string, EmbedFailureRecord> | null) {
    for (const [k, v] of Object.entries(initial ?? {})) {
      if (v && typeof v.attempts === 'number' && typeof v.hash === 'string') this.games.set(k, v);
    }
  }

  /** True once `key` failed POISON_MAX_ATTEMPTS times with this exact text hash. */
  isPoisoned(key: string, hash: string): boolean {
    const rec = this.games.get(key);
    return !!rec && rec.hash === hash && rec.attempts >= POISON_MAX_ATTEMPTS;
  }

  /** Count one failed attempt; returns the attempt total for this hash. */
  record(key: string, hash: string): number {
    const rec = this.games.get(key);
    const attempts = rec && rec.hash === hash ? rec.attempts + 1 : 1;
    this.games.set(key, { attempts, hash, lastAt: Date.now() });
    this.dirty = true;
    return attempts;
  }

  markPoisoned(key: string, hash: string): void {
    this.games.set(key, { attempts: POISON_MAX_ATTEMPTS, hash, lastAt: Date.now() });
    this.dirty = true;
  }

  clear(key: string): void {
    if (this.games.delete(key)) this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    let entries = [...this.games.entries()];
    if (entries.length > POISON_MAX_RECORDS) {
      entries.sort((a, b) => b[1].lastAt - a[1].lastAt);
      entries = entries.slice(0, POISON_MAX_RECORDS);
      this.games.clear();
      for (const [k, v] of entries) this.games.set(k, v);
    }
    try {
      await setEmbeddingMeta<EmbedFailuresMeta>({ key: EMBED_FAILURES_META_KEY, games: Object.fromEntries(entries) });
    } catch (err) {
      this.dirty = true;
      console.warn('[EmbeddingService] Failed to persist embed-failure ledger:', err);
    }
  }
}

/** Session singleton — Steam, Epic and re-chunk passes share one ledger so saves never clobber. */
let _failureLedgerPromise: Promise<EmbedFailureLedger> | null = null;

function getEmbedFailureLedger(): Promise<EmbedFailureLedger> {
  if (!_failureLedgerPromise) {
    _failureLedgerPromise = getEmbeddingMeta<EmbedFailuresMeta>(EMBED_FAILURES_META_KEY)
      .then((row) => new EmbedFailureLedger(row?.games))
      .catch(() => new EmbedFailureLedger());
  }
  return _failureLedgerPromise;
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
  await migrateEmbeddingsFromIdbIfNeeded();
  const now = Date.now();

  if (useLevelDB()) {
    // One bulk `store:getMany` round-trip per slice (instead of fanning out a
    // `store:get` per id) — `ids` accumulates every unchanged entry across a
    // full catalog scan, which can be tens of thousands.
    const namespace = pooledNamespaceFor(storeName);
    for (let i = 0; i < ids.length; i += EMBEDDING_POINT_LOOKUP_CHUNK) {
      const slice = ids.slice(i, i + EMBEDDING_POINT_LOOKUP_CHUNK);
      let gets: Array<CachedEmbedding | null>;
      try {
        gets = await storeGetMany<CachedEmbedding>(namespace, slice);
      } catch (err) {
        console.error('[EmbeddingService] refreshCachedTimestamps getMany failed:', err);
        return;
      }
      const ops: Array<{ type: 'put'; namespace: string; key: string; value: unknown }> = [];
      for (let j = 0; j < slice.length; j++) {
        const entry = gets[j];
        if (!entry) continue;
        ops.push({ type: 'put', namespace, key: slice[j], value: toLevelPooled({ ...entry, timestamp: now }) });
      }
      if (ops.length > 0) {
        const res = await window.store!.batch(ops);
        if (res.error) console.error('[EmbeddingService] refreshCachedTimestamps batch failed:', res.error);
      }
    }
    return;
  }

  const db = await getDB();
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
 * Cheap "would readPooledVector decode this row?" check — validates shape
 * only, without dequantizing 1024 values per row across a 160k-row scan.
 */
function hasDecodablePooledVector(entry: CachedEmbedding): boolean {
  if (typeof entry.scale === 'number' && entry.q != null) {
    const q = entry.q as unknown as { length?: number; byteLength?: number };
    const len = typeof q.length === 'number' ? q.length : q.byteLength;
    if (len === EMBEDDING_DIM) return true;
  }
  return Array.isArray(entry.embedding) && entry.embedding.length === EMBEDDING_DIM;
}

type CatalogSkipMeta = { textHash: string; poolVersion?: number; timestamp: number };

/**
 * One scan of the catalog embedding store for everything a catalog pass needs
 * to decide skip vs re-embed vs TTL refresh: gameId → { textHash, poolVersion,
 * timestamp } (no vectors kept in memory). Only rows with a decodable pooled
 * payload that are inside the TTL are indexed — corrupt / hash-only / expired
 * rows must not short-circuit a re-embed.
 *
 * Replaces two separate full scans per pass (hash index + timestamp index),
 * and only walks the rows of the pass's own source (`steam-` / `epic-` ids).
 */
async function getCatalogSkipIndex(idPrefix: string): Promise<Map<string, CatalogSkipMeta>> {
  await migrateEmbeddingsFromIdbIfNeeded();
  const map = new Map<string, CatalogSkipMeta>();
  const now = Date.now();
  const add = (entry: CachedEmbedding) => {
    if (now - entry.timestamp < CATALOG_TTL && hasDecodablePooledVector(entry)) {
      map.set(entry.gameId, { textHash: entry.textHash, poolVersion: entry.poolVersion, timestamp: entry.timestamp });
    }
  };

  if (useLevelDB()) {
    await levelStreamPooled(LEVEL_CATALOG_NAMESPACE, add, { prefix: idPrefix });
    return map;
  }

  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
    const req = store.openCursor(IDBKeyRange.bound(idPrefix, `${idPrefix}￿`));

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(map); return; }
      add(cursor.value as CachedEmbedding);
      cursor.continue();
    };
    req.onerror = () => resolve(new Map());
  });
}
// Keys per bulk `store:getMany` round-trip (the IPC caps a call at 10k keys;
// vectors are ~4 KB of JSON each, so keep each response a few MB).
const EMBEDDING_POINT_LOOKUP_CHUNK = 1000;

/**
 * Fetch catalog embeddings for a specific set of game IDs (on-demand).
 * Avoids loading the entire catalog embedding store into memory.
 */
async function getCatalogEmbeddingsForIds(
  gameIds: Set<string>,
): Promise<Map<string, number[]>> {
  if (gameIds.size === 0) return new Map();
  await migrateEmbeddingsFromIdbIfNeeded();
  const now = Date.now();
  const result = new Map<string, number[]>();

  if (useLevelDB()) {
    const ids = Array.from(gameIds);
    for (let i = 0; i < ids.length; i += EMBEDDING_POINT_LOOKUP_CHUNK) {
      const slice = ids.slice(i, i + EMBEDDING_POINT_LOOKUP_CHUNK);
      // One bulk round-trip per slice — fanning out 400 concurrent `get`s
      // per slice is what used to trip the store rate limiter.
      const entries = await storeGetMany<CachedEmbedding>(LEVEL_CATALOG_NAMESPACE, slice);
      for (let j = 0; j < slice.length; j++) {
        const entry = entries[j];
        if (entry && (now - entry.timestamp < CATALOG_TTL)) {
          const vec = pooledVectorAsNumberArray(entry);
          if (vec) result.set(slice[j], vec);
        }
      }
    }
    return result;
  }

  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(CATALOG_STORE, 'readonly');
    const store = tx.objectStore(CATALOG_STORE);
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

type ChunkInput = Parameters<typeof buildGameChunks>[2];

interface ChunkedGameJob {
  gameId: string;
  wholeHash: string;
  chunkInput: ChunkInput;
}

type ChunkedGameOutcome =
  | { status: 'ok'; pooled: Float32Array }
  /** No chunk text could be built for this game — nothing to embed. */
  | { status: 'empty' }
  /** Ollama returned no vector for at least one of the game's chunks. */
  /** `transient`: Ollama timed out / never got the text — not evidence the game itself is bad. */
  | { status: 'embed-failed'; error: string; transient?: boolean }
  /** Vectors were produced but persisting them failed. */
  | { status: 'write-failed'; error: string };

/** Chunk groups for many games — one bulk read on LevelDB, per-game on IDB. */
async function getChunkGroupsForTierGames(
  tier: EmbeddingTier,
  gameIds: string[],
): Promise<Array<Map<string, CachedChunk>>> {
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB() && gameIds.length > 1) {
    try {
      const groups = await storeGetMany<CachedChunk[]>(LEVEL_CHUNKS_NAMESPACE, gameIds.map((id) => `${tier}:${id}`));
      return groups.map((chunks) => {
        const map = new Map<string, CachedChunk>();
        for (const row of chunks ?? []) map.set(row.chunkId, row);
        return map;
      });
    } catch (err) {
      console.warn('[EmbeddingService] bulk chunk-group read failed, falling back to per-game reads:', err);
    }
  }
  const out: Array<Map<string, CachedChunk>> = [];
  for (const id of gameIds) out.push(await getChunksForTierGame(tier, id));
  return out;
}

/**
 * Diff, embed and persist facet chunks for MANY games with a single Ollama
 * call, then split the results back per game.
 *
 * With chunking on, each game is only 2–5 short texts; embedding games one
 * IPC call at a time meant the main process never had enough texts to fill a
 * GPU sub-batch, so the GPU batching path never engaged. Grouping ~48 games
 * per call restores it, and the LevelDB writes for the group go out as one
 * `store.batch` (still atomic per game, since the whole batch is atomic).
 *
 * Never throws for per-game problems — each game gets an outcome. Throws only
 * if the Ollama IPC itself throws. `requested` / `returned` count chunk texts
 * sent to / vectors received from Ollama, for the circuit breaker.
 */
/**
 * generateEmbeddings plus the ids that failed for a transient reason (timeout, server gone,
 * never sent). Older preloads / test mocks return the bare map — then nothing is transient.
 */
async function generateEmbeddingsReportingTransient(
  items: Array<{ id: string; text: string }>,
): Promise<{ results: Record<string, number[]>; transient: Set<string> }> {
  const raw = await window.ollama!.generateEmbeddings(items, { reportTransient: true });
  if (raw && typeof raw === 'object' && Array.isArray((raw as { transientIds?: unknown }).transientIds)) {
    const r = raw as { results: Record<string, number[]>; transientIds: string[] };
    return { results: r.results ?? {}, transient: new Set(r.transientIds) };
  }
  return { results: (raw ?? {}) as Record<string, number[]>, transient: new Set() };
}

async function embedAndPersistChunkedGames(
  tier: EmbeddingTier,
  pooledStore: string,
  jobs: ChunkedGameJob[],
): Promise<{ outcomes: Map<string, ChunkedGameOutcome>; requested: number; returned: number }> {
  const outcomes = new Map<string, ChunkedGameOutcome>();
  if (jobs.length === 0) return { outcomes, requested: 0, returned: 0 };

  type Prepared = {
    job: ChunkedGameJob;
    desired: ChunkSpec[];
    staleIds: string[];
    toEmbed: ChunkSpec[];
    vectorsById: Map<string, Float32Array>;
  };
  const withChunks: Array<{ job: ChunkedGameJob; desired: ChunkSpec[] }> = [];
  for (const job of jobs) {
    const desired = buildGameChunks(tier, job.gameId, job.chunkInput);
    if (desired.length === 0) outcomes.set(job.gameId, { status: 'empty' });
    else withChunks.push({ job, desired });
  }

  const existingGroups = await getChunkGroupsForTierGames(tier, withChunks.map((w) => w.job.gameId));
  const prepared: Prepared[] = withChunks.map(({ job, desired }, idx) => {
    const existing = existingGroups[idx] ?? new Map<string, CachedChunk>();
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
    return { job, desired, staleIds, toEmbed, vectorsById };
  });

  const items = prepared.flatMap((p) => p.toEmbed.map((c) => ({ id: c.chunkId, text: c.text })));
  let returned = 0;
  let transient = new Set<string>();
  if (items.length > 0) {
    const res = await generateEmbeddingsReportingTransient(items);
    const results = res.results;
    transient = res.transient;
    for (const p of prepared) {
      for (const chunk of p.toEmbed) {
        const vec = results[chunk.chunkId];
        if (vec && vec.length === EMBEDDING_DIM) {
          p.vectorsById.set(chunk.chunkId, Float32Array.from(vec));
          returned++;
        }
      }
    }
  }

  type Ready = {
    job: ChunkedGameJob;
    staleIds: string[];
    chunks: Array<ChunkSpec & { vector: Float32Array }>;
  };
  const ready: Ready[] = [];
  for (const p of prepared) {
    const chunks: Array<ChunkSpec & { vector: Float32Array }> = [];
    let missing: string | null = null;
    for (const chunk of p.desired) {
      const vector = p.vectorsById.get(chunk.chunkId);
      if (!vector) { missing = chunk.chunkId; break; }
      chunks.push({ ...chunk, vector });
    }
    if (missing) {
      outcomes.set(p.job.gameId, {
        status: 'embed-failed',
        error: `Missing embedding for chunk ${missing}`,
        transient: p.toEmbed.some((c) => transient.has(c.chunkId)),
      });
    } else {
      ready.push({ job: p.job, staleIds: p.staleIds, chunks });
    }
  }

  const written: Array<{ gameId: string; pooled: Float32Array; chunks: Array<ChunkSpec & { vector: Float32Array }> }> = [];
  if (ready.length > 0) {
    await migrateEmbeddingsFromIdbIfNeeded();
    if (useLevelDB()) {
      const ops: Array<{ type: 'put'; namespace: string; key: string; value: unknown }> = [];
      const built = ready.map((r) => {
        const rows = buildGameWriteRows({ tier, gameId: r.job.gameId, wholeHash: r.job.wholeHash, chunks: r.chunks });
        ops.push(...levelGameWriteOps(tier, r.job.gameId, pooledStore, rows));
        return { r, pooled: rows.pooledF32 };
      });
      const res = await window.store!.batch(ops);
      if (res.error) {
        for (const { r } of built) {
          outcomes.set(r.job.gameId, { status: 'write-failed', error: String(res.error) });
        }
      } else {
        notePooledKeysWritten(pooledNamespaceFor(pooledStore), built.map(({ r }) => r.job.gameId));
        for (const { r, pooled } of built) written.push({ gameId: r.job.gameId, pooled, chunks: r.chunks });
      }
    } else {
      for (const r of ready) {
        try {
          const pooled = await writeGameChunksAndPool({
            tier,
            gameId: r.job.gameId,
            pooledStore,
            wholeHash: r.job.wholeHash,
            chunks: r.chunks,
            staleIds: r.staleIds,
          });
          written.push({ gameId: r.job.gameId, pooled, chunks: r.chunks });
        } catch (err) {
          outcomes.set(r.job.gameId, { status: 'write-failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  for (const w of written) outcomes.set(w.gameId, { status: 'ok', pooled: w.pooled });

  // Dual presence: pooled game id + each chunk id in one usearch index.
  if (written.length > 0) {
    try {
      await annIndex.addVectors(written.flatMap((w) => [
        { id: w.gameId, vector: Array.from(w.pooled) },
        ...w.chunks.map((c) => ({ id: c.chunkId, vector: Array.from(c.vector) })),
      ]));
    } catch { /* ANN not ready yet */ }
  }

  return { outcomes, requested: items.length, returned };
}

/**
 * Diff chunks for one game, embed only misses, atomic write, return pooled f32.
 * Throws on embed/persist failure (caller must not advance watermark / ANN on throw).
 */
async function embedAndPersistChunkedGame(opts: {
  tier: EmbeddingTier;
  gameId: string;
  pooledStore: string;
  wholeHash: string;
  chunkInput: ChunkInput;
}): Promise<Float32Array | null> {
  const { outcomes } = await embedAndPersistChunkedGames(opts.tier, opts.pooledStore, [{
    gameId: opts.gameId,
    wholeHash: opts.wholeHash,
    chunkInput: opts.chunkInput,
  }]);
  const outcome = outcomes.get(opts.gameId);
  if (!outcome || outcome.status === 'empty') return null;
  if (outcome.status === 'ok') return outcome.pooled;
  throw new Error(outcome.error);
}

// ─── Embedding Service ─────────────────────────────────────────────────────────

// Pause used to be persisted here, so a pause someone forgot about survived
// restarts and every embedding pass silently waited forever ("stuck for
// hours"). It is session-only now; clear the legacy flag on load.
const PAUSE_LS_KEY = 'ark-embedding-paused';
try { localStorage.removeItem(PAUSE_LS_KEY); } catch { /* storage unavailable */ }

/** Resolves when `promise` settles or `signal` aborts, whichever is first. */
function untilSettledOrAborted(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise.then(() => undefined, () => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
    );
  });
}

/** Abortable sleep. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return untilSettledOrAborted(new Promise((r) => setTimeout(r, ms)), signal);
}

/** Yield to the renderer between batches (idle callback, else a timer). */
function idleYield(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: delayMs * 2 });
    } else {
      setTimeout(resolve, delayMs);
    }
  });
}

/** Negative availability results are re-checked after this long. */
const OLLAMA_UNAVAILABLE_TTL_MS = 60_000;
/** Consecutive whole-call Ollama failures that stop a pass (circuit breaker). */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** First / max delay before a tripped breaker probes Ollama again. */
const BREAKER_RESUME_BASE_MS = 60_000;
const BREAKER_RESUME_MAX_MS = 15 * 60_000;
/** Games per Ollama call in a chunked catalog pass (2–5 chunk texts each). */
const CATALOG_CHUNKED_GAMES_PER_CALL = 48;
/** Games per Ollama call in an un-chunked (whole-text) catalog pass. */
const CATALOG_FLAT_GAMES_PER_CALL = 100;
/** Progress notifications are coalesced to at most one per this interval. */
const PROGRESS_NOTIFY_MS = 1000;

type CatalogSource = 'steam' | 'epic';

interface CatalogPassState {
  abort: AbortController | null;
  running: boolean;
  promise: Promise<number> | null;
}

class EmbeddingService {
  private ollamaAvailable: boolean | null = null;
  private embeddingModelReady = false;
  /** While in the future, `isAvailable()` returns false without re-probing. */
  private _unavailableUntil = 0;
  private _availabilityInFlight: Promise<boolean> | null = null;
  /** From `ollama:setup` — true when a tier stronger than cosine resolved. */
  private _rerankModelReady = false;
  private _rerankTier: RerankTier | null = null;
  private _embeddingsLoaded = false;
  private _loadedCount = 0;

  // ── Pause/Resume state ──
  // Session-only (see PAUSE_LS_KEY above) — every launch starts unpaused.
  private _paused = false;
  private _pauseDeferred: { promise: Promise<void>; resolve: () => void } | null = null;

  private _libraryAbort: AbortController | null = null;

  private _listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() { this._listeners.forEach(fn => fn()); }

  private _lastProgressNotifyAt = 0;
  /**
   * Progress-only notify, coalesced to one per PROGRESS_NOTIFY_MS. Passes
   * used to notify every subscriber (status panel, settings, galaxy) on each
   * batch; `force` is for terminal states, which must never be dropped.
   */
  private _notifyProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastProgressNotifyAt < PROGRESS_NOTIFY_MS) return;
    this._lastProgressNotifyAt = now;
    this._notify();
  }

  // ── Pause / Resume ──
  /** True when all embedding gen loops are halted between batches. */
  get isPaused(): boolean { return this._paused; }

  /** Halt all embedding gen loops at the next batch boundary (this session only). */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    if (!this._pauseDeferred) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      this._pauseDeferred = { promise, resolve };
    }
    this._notify();
  }

  /** Resume any embedding gen loops that were waiting at a pause point. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    const deferred = this._pauseDeferred;
    this._pauseDeferred = null;
    deferred?.resolve();
    this._notify();
  }

  /**
   * Await this between loop iterations to honor a pause. Returns immediately
   * when not paused; otherwise blocks until resume() is called OR `signal`
   * aborts — a cancel issued while paused must not wait for a resume that
   * may never come. Callers check `signal.aborted` right after.
   */
  private async _awaitIfPaused(signal?: AbortSignal): Promise<void> {
    while (this._paused) {
      if (signal?.aborted) return;
      if (!this._pauseDeferred) {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        this._pauseDeferred = { promise, resolve };
      }
      await untilSettledOrAborted(this._pauseDeferred.promise, signal);
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
   *
   * A positive result is cached for the session. A negative one is cached for
   * OLLAMA_UNAVAILABLE_TTL_MS and then re-probed — it used to be cached
   * forever, so Ollama started after the app (or recovering from a hang)
   * was never picked up. Concurrent callers share one in-flight probe.
   */
  async isAvailable(): Promise<boolean> {
    if (this.ollamaAvailable === true && this.embeddingModelReady) return true;
    if (Date.now() < this._unavailableUntil) return false;
    if (this._availabilityInFlight) return this._availabilityInFlight;
    this._availabilityInFlight = this._probeAvailability().finally(() => {
      this._availabilityInFlight = null;
    });
    return this._availabilityInFlight;
  }

  /** Record a negative availability result (honoured for OLLAMA_UNAVAILABLE_TTL_MS). */
  private _markUnavailable(): void {
    this.ollamaAvailable = false;
    this._unavailableUntil = Date.now() + OLLAMA_UNAVAILABLE_TTL_MS;
    this._notify();
  }

  private async _probeAvailability(): Promise<boolean> {
    try {
      if (!window.ollama) {
        this._markUnavailable();
        return false;
      }

      const health = await window.ollama.healthCheck();
      this.ollamaAvailable = health.running;
      this._notify();

      if (!health.running) {
        console.log('[EmbeddingService] Ollama not available — running without embeddings');
        this._markUnavailable();
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
        // Ollama is up but the model isn't — retry setup (re-pull) after the
        // TTL rather than on every single call.
        console.log('[EmbeddingService] Embedding model not ready:', setup.error);
        this._unavailableUntil = Date.now() + OLLAMA_UNAVAILABLE_TTL_MS;
        return false;
      }

      this._unavailableUntil = 0;
      console.log(`[EmbeddingService] Ollama v${setup.ollamaVersion} ready with embedding model`);
      return true;
    } catch (err) {
      console.warn('[EmbeddingService] Error checking availability:', err);
      this._markUnavailable();
      return false;
    }
  }

  /**
   * End-to-end liveness check: availability plus one tiny real embedding.
   * `/api/version` keeps answering while the embed runner is hung, so the
   * circuit breaker needs an actual embed to decide Ollama has recovered.
   */
  private async _probeOllamaEmbedding(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    try {
      const res = await window.ollama!.generateEmbeddings([{ id: '__ark_probe__', text: 'embedding health probe' }]);
      const vec = res?.['__ark_probe__'];
      return Array.isArray(vec) && vec.length === EMBEDDING_DIM;
    } catch {
      return false;
    }
  }

  // ── Circuit breaker ──
  // A hung Ollama made every request wait out its full timeout (120 s + 4 s
  // per text) and the catalog loop just moved on to the next batch — hours
  // per pass. After CIRCUIT_BREAKER_THRESHOLD consecutive calls that returned
  // nothing, a pass stops, Ollama is marked unavailable, and the pass resumes
  // automatically once a backed-off probe sees a real embedding come back.
  private _breakerOpen = false;
  private _breakerTimer: ReturnType<typeof setTimeout> | null = null;
  private _breakerBackoffMs = BREAKER_RESUME_BASE_MS;
  private _breakerResume: Partial<Record<CatalogSource, () => Promise<number>>> = {};

  /** True while a pass is stopped waiting for Ollama to recover. */
  get isOllamaStalled(): boolean { return this._breakerOpen; }

  private _tripCircuitBreaker(which: CatalogSource, resume: () => Promise<number>): void {
    this._breakerOpen = true;
    this._breakerResume[which] = resume;
    this._markUnavailable();
    this._scheduleBreakerProbe();
  }

  private _scheduleBreakerProbe(): void {
    if (this._breakerTimer) return;
    const delay = this._breakerBackoffMs;
    this._breakerTimer = setTimeout(() => {
      this._breakerTimer = null;
      void (async () => {
        const healthy = await this._probeOllamaEmbedding();
        if (!healthy) {
          this._breakerBackoffMs = Math.min(this._breakerBackoffMs * 2, BREAKER_RESUME_MAX_MS);
          console.log(`[EmbeddingService] Ollama still not embedding — next probe in ${Math.round(this._breakerBackoffMs / 1000)}s`);
          this._scheduleBreakerProbe();
          return;
        }
        console.log('[EmbeddingService] Ollama recovered — resuming stopped embedding passes');
        this._breakerOpen = false;
        this._breakerBackoffMs = BREAKER_RESUME_BASE_MS;
        const pending = this._breakerResume;
        this._breakerResume = {};
        this._notify();
        // Same order as boot: Steam, then Epic.
        if (pending.steam) { try { await pending.steam(); } catch { /* logged by the pass */ } }
        if (pending.epic) { try { await pending.epic(); } catch { /* logged by the pass */ } }
      })();
    }, delay);
  }

  private _clearCircuitBreaker(): void {
    if (this._breakerTimer) { clearTimeout(this._breakerTimer); this._breakerTimer = null; }
    this._breakerOpen = false;
    this._breakerBackoffMs = BREAKER_RESUME_BASE_MS;
    this._breakerResume = {};
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
   * A game counts as already embedded when it has a valid library vector, OR
   * a valid catalog vector and no user notes (notes are the only input that
   * makes the Tier 1 text personal) — the catalog vector is then served from
   * the live cache. Oracle used to re-embed ~4k catalog candidates that
   * already had catalog embeddings on every compute.
   *
   * Never blocks on a pause: when embeddings are paused this returns
   * immediately (or stops at the next batch boundary) instead of waiting for a
   * resume, so callers such as Oracle can never hang behind one.
   *
   * @param games Array of games with id, title, genres, themes, developer
   * @param onProgress Optional progress callback
   * @param opts.signal   Abort — stops at the next batch boundary.
   * @param opts.deadline Epoch ms after which no new batch is started.
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
    opts?: { signal?: AbortSignal; deadline?: number },
  ): Promise<number> {
    if (this._paused) {
      console.log('[EmbeddingService] Embeddings paused — skipping library generation');
      return 0;
    }
    if (opts?.signal?.aborted) return 0;
    if (this._libraryPromise) {
      // Joined an in-flight run started by another caller: our signal can't
      // stop that run, but it can stop us waiting for it.
      if (!opts?.signal) return this._libraryPromise;
      const shared = this._libraryPromise;
      let result = 0;
      await untilSettledOrAborted(shared.then((n) => { result = n; }), opts.signal);
      return opts.signal.aborted ? 0 : result;
    }
    this._libraryPromise = this._runGenerateMissing(games, onProgress, opts);
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
    opts?: { signal?: AbortSignal; deadline?: number },
  ): Promise<number> {
    if (!(await this.isAvailable())) {
      this._setLibraryStatus('unavailable');
      return 0;
    }
    if (games.length === 0) return 0;

    this._setLibraryStatus('generating');
    this._libraryAbort = new AbortController();
    const librarySignal = this._libraryAbort.signal;
    const callerSignal = opts?.signal;
    const deadline = opts?.deadline;
    const shouldStop = (): boolean =>
      librarySignal.aborted
      || !!callerSignal?.aborted
      || this._paused
      || (deadline !== undefined && Date.now() >= deadline);

    try {
      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const cached = await getCachedEmbeddings();

      type Need = {
        game: (typeof games)[number];
        text: string;
        hash: string;
      };
      let needsEmbedding: Need[] = [];

      for (const game of games) {
        const text = buildEmbeddingText(game);
        const hash = hashText(text);
        const existing = cached.get(game.id);
        // Skip only when pooled payload exists AND whole-hash + poolVersion OK.
        if (shouldSkipPooled(existing, hash) && readPooledVector(existing)) continue;
        needsEmbedding.push({ game, text, hash });
      }

      // An existing catalog embedding counts as present for games without
      // personal notes — serve it from the live cache instead of re-embedding.
      const catalogCandidates = needsEmbedding.filter((n) => !n.game.userNotes);
      if (catalogCandidates.length > 0) {
        const catalogVecs = await getCatalogEmbeddingsForIds(new Set(catalogCandidates.map((n) => n.game.id)))
          .catch(() => new Map<string, number[]>());
        if (catalogVecs.size > 0) {
          let injected = 0;
          for (const [id, vec] of catalogVecs) {
            if (!embeddingCacheRef.has(id)) { embeddingCacheRef.set(id, vec); injected++; }
          }
          if (injected > 0) setEmbeddingCache(embeddingCacheRef);
          needsEmbedding = needsEmbedding.filter((n) => !catalogVecs.has(n.game.id));
          console.log(`[EmbeddingService] ${catalogVecs.size} games already have catalog embeddings — not re-embedding`);
        }
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

      const BATCH_SIZE = chunkingEnabled ? CATALOG_CHUNKED_GAMES_PER_CALL : 100;
      let generated = 0;
      let completed = 0;
      let consecutiveFailedCalls = 0;

      for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
        if (shouldStop()) break;

        const batch = needsEmbedding.slice(i, i + BATCH_SIZE);
        let requested = 0;
        let returned = 0;

        if (!chunkingEnabled) {
          const items = batch.map(b => ({ id: b.game.id, text: b.text }));
          const results = await window.ollama!.generateEmbeddings(items);
          requested = items.length;
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
          returned = batchEntries.length;
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
          const res = await embedAndPersistChunkedGames('lib', LIBRARY_STORE, batch.map((item) => ({
            gameId: item.game.id,
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
          })));
          requested = res.requested;
          returned = res.returned;
          let wrote = 0;
          for (const item of batch) {
            const outcome = res.outcomes.get(item.game.id);
            if (outcome?.status === 'ok') {
              // ANN upsert (pooled + chunks) happens inside embedAndPersistChunkedGames
              embeddingCacheRef.set(item.game.id, Array.from(outcome.pooled));
              generated++;
              wrote++;
            } else if (outcome && outcome.status !== 'empty') {
              console.warn(`[EmbeddingService] Library chunk write failed for ${item.game.id}: ${outcome.error}`);
            }
          }
          if (wrote > 0) await bumpEmbeddingContentEpoch();
          setEmbeddingCache(embeddingCacheRef);
        }

        completed += batch.length;
        this._libraryProgress = { completed, total: needsEmbedding.length };
        this._notifyProgress();
        onProgress?.(completed, needsEmbedding.length);

        // Circuit breaker: Ollama answered nothing for several calls in a row.
        if (requested > 0 && returned === 0) {
          if (++consecutiveFailedCalls >= CIRCUIT_BREAKER_THRESHOLD) {
            console.warn('[EmbeddingService] Ollama returned no embeddings for several batches — stopping library generation');
            this._markUnavailable();
            break;
          }
        } else if (requested > 0) {
          consecutiveFailedCalls = 0;
        }

        if (i + BATCH_SIZE < needsEmbedding.length) {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      this._notifyProgress(true);
      // Stopped early by a deadline / pause / caller abort says nothing about Ollama — don't
      // report "unavailable" for that; only a run that actually tried and got nothing is.
      const stoppedEarly = librarySignal.aborted || !!callerSignal?.aborted || (deadline !== undefined && Date.now() >= deadline);
      const status = (generated > 0 || this._loadedCount > 0 || stoppedEarly) ? 'ready' as const : 'unavailable' as const;
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
  // Per-source pass state. Steam and Epic used to share one abort controller
  // and one running flag, so whichever pass finished first cleared the flag
  // (and the controller) out from under the other one still running.
  private _passes: Record<CatalogSource, CatalogPassState> = {
    steam: { abort: null, running: false, promise: null },
    epic: { abort: null, running: false, promise: null },
  };
  // Split Steam/Epic so Epic's run starting at {0,N} can never overwrite
  // Steam's already-completed {N,N} — they used to share one field and Epic
  // unconditionally reset it to its own {0, needsEmbedding.length} the
  // moment it started, hiding a just-finished Steam pass from the widget.
  private _steamCatalogProgress: { completed: number; total: number } = { completed: 0, total: 0 };
  private _epicCatalogProgress: { completed: number; total: number } = { completed: 0, total: 0 };

  /** Merged Steam + Epic progress for the "Catalog Embeddings" status widget. */
  get catalogProgress(): Readonly<{ completed: number; total: number }> {
    return {
      completed: this._steamCatalogProgress.completed + this._epicCatalogProgress.completed,
      total: this._steamCatalogProgress.total + this._epicCatalogProgress.total,
    };
  }

  get isCatalogRunning(): boolean { return this._passes.steam.running || this._passes.epic.running; }

  /**
   * Clears a leftover partial progress reading (completed < total) left by an
   * interrupted prior pass, so a subsequent no-op/skip/error exit never shows
   * a stuck-looking bar once `embRunning` goes false again. A pass that
   * genuinely finished (completed >= total) is left untouched.
   */
  private _resetProgressIfStale(which: 'steam' | 'epic'): void {
    const field = which === 'steam' ? this._steamCatalogProgress : this._epicCatalogProgress;
    if (field.completed < field.total) {
      const cleared = { completed: 0, total: 0 };
      if (which === 'steam') this._steamCatalogProgress = cleared;
      else this._epicCatalogProgress = cleared;
      this._notify();
    }
  }

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

  /** Cancel in-flight (or queued) Steam and Epic catalog embedding runs. */
  cancelCatalogEmbeddings() {
    this._passes.steam.abort?.abort();
    this._passes.epic.abort?.abort();
    // A cancel is deliberate — don't auto-resume what the user just stopped.
    if (this._breakerResume.steam || this._breakerResume.epic) this._clearCircuitBreaker();
  }

  /**
   * Cancel both catalog passes and resolve once they have fully settled, so a
   * follow-up run (e.g. Settings → Force Re-index) never races the cancelled
   * one over the ANN index / progress fields.
   */
  async cancelCatalogEmbeddingsAndWait(): Promise<void> {
    this.cancelCatalogEmbeddings();
    const pending = [this._passes.steam.promise, this._passes.epic.promise].filter(
      (p): p is Promise<number> => p !== null,
    );
    await Promise.allSettled(pending);
  }

  /** Cancel an in-flight library embedding run. */
  cancelLibraryEmbeddings() {
    this._libraryAbort?.abort();
    this._libraryAbort = null;
  }

  // ── Wave 3.1 idle/forced re-chunk job ──────────────────────────────────────
  private _rechunkAbort: AbortController | null = null;
  private _rechunkPromise: Promise<RechunkJobResult> | null = null;
  private _rechunkRunning = false;
  private _rechunkStatus: 'idle' | 'running' | 'done' | 'cancelled' | 'blocked' | 'error' = 'idle';
  private _rechunkProgress: {
    completed: number;
    total: number;
    phase: RechunkPhase;
  } = { completed: 0, total: 0, phase: 'library' };
  private _rechunkMessage: string | null = null;
  private _rechunkSuggestRebuildAnn = false;

  get isRechunkRunning(): boolean { return this._rechunkRunning; }
  get rechunkStatus() { return this._rechunkStatus; }
  get rechunkProgress(): Readonly<{ completed: number; total: number; phase: RechunkPhase }> {
    return this._rechunkProgress;
  }
  get rechunkMessage(): string | null { return this._rechunkMessage; }
  get rechunkSuggestRebuildAnn(): boolean { return this._rechunkSuggestRebuildAnn; }

  clearRechunkSuggestRebuildAnn(): void {
    this._rechunkSuggestRebuildAnn = false;
    this._notify();
  }

  /** Cancel an in-flight re-chunk job (watermark preserved for resume). */
  cancelRechunkJob(): void {
    this._rechunkAbort?.abort();
    this._rechunkAbort = null;
  }

  /**
   * Settings / idle entry: walk library then catalog, writing facet chunks for
   * games that still lack them. Respects kill switch, pause, and cancel.
   * Watermark advances only after successful write or already-complete skip.
   *
   * @param opts.force  Restart from library even if a prior job finished.
   */
  startRechunkJob(
    deps: RechunkJobDeps,
    opts?: { force?: boolean },
  ): Promise<RechunkJobResult> {
    if (this._rechunkPromise) return this._rechunkPromise;
    this._rechunkPromise = this._runRechunkJob(deps, opts);
    return this._rechunkPromise;
  }

  /**
   * Idle scheduler: resume only when chunking is on and watermark ≠ done.
   * No-op (resolved blocked/done) when there is nothing to do.
   */
  async maybeStartIdleRechunk(deps: RechunkJobDeps): Promise<RechunkJobResult | null> {
    if (this._rechunkRunning) return this._rechunkPromise;
    const chunkingEnabled = await isEmbeddingChunkingEnabled();
    const wm = await getEmbeddingMeta<RechunkWatermark>(RECHUNK_META_KEY);
    if (!shouldResumeIdleRechunk(wm, chunkingEnabled)) return null;
    return this.startRechunkJob(deps, { force: false });
  }

  private async _runRechunkJob(
    deps: RechunkJobDeps,
    opts?: { force?: boolean },
  ): Promise<RechunkJobResult> {
    const blockedEmpty = (): RechunkJobResult => ({
      status: 'blocked',
      successCount: 0,
      skippedCount: 0,
      failureCount: 0,
      suggestRebuildAnn: false,
    });

    this._rechunkRunning = true;
    this._rechunkStatus = 'running';
    this._rechunkMessage = null;
    this._rechunkSuggestRebuildAnn = false;
    this._rechunkAbort = new AbortController();
    const signal = this._rechunkAbort.signal;
    this._notify();

    try {
      // Wait for organic embedding passes so we don't fight the same IDB/ANN.
      if (this._libraryPromise) {
        try { await this._libraryPromise; } catch { /* non-fatal */ }
      }
      if (this._passes.steam.promise) {
        try { await this._passes.steam.promise; } catch { /* non-fatal */ }
      }
      if (this._passes.epic.promise) {
        try { await this._passes.epic.promise; } catch { /* non-fatal */ }
      }

      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const ollamaOk = await this.isAvailable();
      const blocked = rechunkBlockedReason({ chunkingEnabled, ollamaAvailable: ollamaOk });
      if (blocked) {
        this._rechunkStatus = 'blocked';
        this._rechunkMessage = blocked;
        this._notify();
        return { ...blockedEmpty(), blockedReason: blocked };
      }

      let wm =
        (await getEmbeddingMeta<RechunkWatermark>(RECHUNK_META_KEY)) ??
        createInitialRechunkWatermark();

      // Force, or a prior completed job → start a fresh library→catalog pass.
      if (opts?.force || wm.phase === 'done') {
        wm = createInitialRechunkWatermark();
      }
      await setEmbeddingMeta(wm);

      const ledger = await getEmbedFailureLedger();
      const IDLE_DELAY_MS = 200;
      const RETRY_DELAY_MS = 2000;
      // `annIndex.save()` serialises the whole index on the main process; it
      // used to run every 25 games. Now at most once a minute + end of phase.
      const ANN_SAVE_INTERVAL_MS = 60_000;
      let successesSinceSave = 0;
      let lastAnnSaveAt = Date.now();
      let ollamaStalled = false;

      const persistWm = async (next: RechunkWatermark) => {
        wm = next;
        await setEmbeddingMeta(wm);
      };

      const maybeSaveAnn = async (force = false) => {
        if (successesSinceSave === 0) return;
        if (!force && Date.now() - lastAnnSaveAt < ANN_SAVE_INTERVAL_MS) return;
        try { await annIndex.save(); } catch { /* non-fatal */ }
        successesSinceSave = 0;
        lastAnnSaveAt = Date.now();
      };

      const yieldPolite = async () => {
        await this._awaitIfPaused(signal);
        // Pause while a game session is active (reuse embedding polite mid-pass).
        for (;;) {
          if (signal.aborted) return;
          try {
            const sessions = await window.sessionTracker?.getActiveSessions?.();
            if (!sessions || sessions.length === 0) break;
          } catch {
            break;
          }
          await sleepAbortable(4000, signal);
          await this._awaitIfPaused(signal);
        }
        await idleYield(IDLE_DELAY_MS);
      };

      const setProgress = (completed: number, total: number, phase: RechunkPhase, force = false) => {
        this._rechunkProgress = { completed, total, phase };
        this._rechunkMessage =
          `${phase}: ${completed.toLocaleString()} / ${Math.max(total, 1).toLocaleString()} games` +
          (wm.successCount > 0 ? ` · ${wm.successCount} written` : '');
        this._notifyProgress(force);
      };

      type PhaseItem = {
        id: string;
        tier: EmbeddingTier;
        pooledStore: string;
        wholeHash: string;
        chunkInput: ChunkInput;
        onPooled?: (pooled: Float32Array) => void;
      };

      /**
       * Walk one phase from the cursor. A failing game is retried in place
       * (up to POISON_MAX_ATTEMPTS); on the last strike a real probe embed
       * decides whether the GAME is bad (mark poisoned, advance the cursor
       * past it, keep going) or OLLAMA is (stop, cursor kept on the game).
       * The job used to stop at the first failure without advancing, so one
       * bad game stalled the whole job until the next launch — every launch.
       */
      const runPhase = async (
        phase: Exclude<RechunkPhase, 'done'>,
        items: PhaseItem[],
        totalHint?: number,
      ): Promise<'complete' | 'stopped'> => {
        const queue = gamesAfterCursor(items, wm.cursorAfter);
        const total = totalHint ?? items.length;
        const already = items.length - queue.length;
        setProgress(already, total, phase, true);

        for (let i = 0; i < queue.length; i++) {
          await yieldPolite();
          if (signal.aborted) return 'stopped';
          if (!(await isEmbeddingChunkingEnabled())) return 'stopped';

          const item = queue[i];
          const ledgerKey = `${item.tier}:${item.id}`;
          if (ledger.isPoisoned(ledgerKey, item.wholeHash)) {
            await persistWm(advanceRechunkCursor(wm, item.id, 'skipped'));
            setProgress(already + i + 1, total, phase);
            continue;
          }

          const desired = buildGameChunks(item.tier, item.id, item.chunkInput);
          const existing = await getChunksForTierGame(item.tier, item.id);
          const existingMeta = new Map(
            [...existing.entries()].map(([id, row]) => [id, { chunkId: id, textHash: row.textHash }]),
          );

          if (!gameNeedsChunkWork(desired, existingMeta)) {
            await persistWm(advanceRechunkCursor(wm, item.id, 'skipped'));
            setProgress(already + i + 1, total, phase);
            continue;
          }

          for (let attempt = 1; ; attempt++) {
            try {
              const pooled = await embedAndPersistChunkedGame({
                tier: item.tier,
                gameId: item.id,
                pooledStore: item.pooledStore,
                wholeHash: item.wholeHash,
                chunkInput: item.chunkInput,
              });
              ledger.clear(ledgerKey);
              if (pooled) {
                item.onPooled?.(pooled);
                await bumpEmbeddingContentEpoch();
                await persistWm(advanceRechunkCursor(wm, item.id, 'success'));
                successesSinceSave++;
                await maybeSaveAnn();
              } else {
                await persistWm(advanceRechunkCursor(wm, item.id, 'skipped'));
              }
              break;
            } catch (err) {
              console.warn(`[EmbeddingService] Re-chunk ${phase} failed for ${item.id} (attempt ${attempt}):`, err);
              await persistWm(recordRechunkFailure(wm));
              if (attempt < POISON_MAX_ATTEMPTS) {
                await sleepAbortable(RETRY_DELAY_MS * attempt, signal);
                if (signal.aborted) return 'stopped';
                continue;
              }
              if (!(await this._probeOllamaEmbedding())) {
                // Ollama, not the game — keep the cursor on it for next resume.
                ollamaStalled = true;
                return 'stopped';
              }
              ledger.markPoisoned(ledgerKey, item.wholeHash);
              await ledger.save();
              console.warn(`[EmbeddingService] Re-chunk: skipping ${item.id} after ${attempt} failed attempts`);
              await persistWm(advanceRechunkCursor(wm, item.id, 'skipped'));
              break;
            }
          }
          setProgress(already + i + 1, total, phase);
        }
        return 'complete';
      };

      // ── Library phase ────────────────────────────────────────────────────
      if (wm.phase === 'library' && !signal.aborted) {
        if (!(await isEmbeddingChunkingEnabled())) {
          this._rechunkStatus = 'blocked';
          this._rechunkMessage = 'Facet chunk embeddings disabled mid-job';
          this._notify();
          return {
            status: 'blocked',
            successCount: wm.successCount,
            skippedCount: wm.skippedCount,
            failureCount: wm.failureCount,
            blockedReason: this._rechunkMessage,
            suggestRebuildAnn: wm.successCount > 0,
          };
        }

        const items: PhaseItem[] = deps.libraryGames.map((game) => ({
          id: game.id,
          tier: 'lib',
          pooledStore: LIBRARY_STORE,
          wholeHash: hashText(buildEmbeddingText(game)),
          chunkInput: {
            title: game.title,
            genres: game.genres,
            themes: game.themes,
            modes: game.modes,
            playerPerspectives: game.playerPerspectives,
            developer: game.developer,
            summary: game.summary,
            description: game.description,
            userNotes: game.userNotes,
            similarGames: game.similarGames,
          },
          onPooled: (pooled) => {
            embeddingCacheRef.set(game.id, Array.from(pooled));
            setEmbeddingCache(embeddingCacheRef);
          },
        }));
        // Only advance phase when every library id was processed or skipped.
        if ((await runPhase('library', items)) === 'complete') {
          await maybeSaveAnn(true);
          await persistWm(beginRechunkPhase(wm, nextRechunkPhase('library')));
        }
      }

      // ── Steam catalog phase ──────────────────────────────────────────────
      if (wm.phase === 'steam' && !signal.aborted && !ollamaStalled && (await isEmbeddingChunkingEnabled())) {
        const items: PhaseItem[] = [];
        await deps.steamIterator((batch) => {
          for (const entry of batch) {
            items.push({
              id: `steam-${entry.appid}`,
              tier: 'cat',
              pooledStore: CATALOG_STORE,
              wholeHash: hashText(buildCatalogEmbeddingText(entry)),
              chunkInput: {
                title: entry.name,
                genres: entry.genres,
                themes: entry.themes,
                modes: entry.modes,
                developer: entry.developer,
                shortDescription: entry.shortDescription,
                source: 'steam',
              },
            });
          }
        });
        if ((await runPhase('steam', items, deps.steamTotal)) === 'complete') {
          await maybeSaveAnn(true);
          await persistWm(beginRechunkPhase(wm, nextRechunkPhase('steam')));
        }
      }

      // ── Epic catalog phase ───────────────────────────────────────────────
      if (wm.phase === 'epic' && !signal.aborted && !ollamaStalled && (await isEmbeddingChunkingEnabled())) {
        const items: PhaseItem[] = [];
        if (deps.epicIterator) {
          await deps.epicIterator((batch) => {
            for (const entry of batch) {
              items.push({
                id: `epic-${entry.epicId}`,
                tier: 'cat',
                pooledStore: CATALOG_STORE,
                wholeHash: hashText(buildEpicCatalogEmbeddingText(entry)),
                chunkInput: {
                  title: entry.name,
                  genres: entry.genres,
                  themes: entry.themes,
                  modes: entry.modes,
                  developer: entry.developer,
                  description: entry.description,
                  longDescription: entry.longDescription,
                  source: 'epic',
                },
              });
            }
          });
        }
        if ((await runPhase('epic', items, deps.epicTotal)) === 'complete') {
          await maybeSaveAnn(true);
          await persistWm(beginRechunkPhase(wm, nextRechunkPhase('epic')));
        }
      }

      await maybeSaveAnn(true);
      await ledger.save();
      this._notifyProgress(true);

      if (ollamaStalled) {
        this._markUnavailable();
        this._rechunkStatus = 'blocked';
        this._rechunkMessage = `Ollama is not responding — re-chunk paused at ${wm.phase} (progress saved)`;
        this._rechunkSuggestRebuildAnn = wm.successCount > 0;
        this._notify();
        return {
          status: 'blocked',
          successCount: wm.successCount,
          skippedCount: wm.skippedCount,
          failureCount: wm.failureCount,
          blockedReason: 'Ollama not responding',
          suggestRebuildAnn: wm.successCount > 0,
        };
      }

      if (signal.aborted) {
        this._rechunkStatus = 'cancelled';
        this._rechunkMessage = 'Re-chunk cancelled — progress saved; resume anytime';
        this._rechunkSuggestRebuildAnn = wm.successCount > 0;
        this._notify();
        return {
          status: 'cancelled',
          successCount: wm.successCount,
          skippedCount: wm.skippedCount,
          failureCount: wm.failureCount,
          suggestRebuildAnn: wm.successCount > 0,
        };
      }

      if (wm.phase === 'done') {
        this._rechunkStatus = 'done';
        this._rechunkSuggestRebuildAnn = wm.successCount > 0;
        this._rechunkMessage = wm.successCount > 0
          ? `Re-chunk complete — ${wm.successCount} games written. Rebuild ANN recommended.`
          : 'Re-chunk complete — all games already had facet chunks.';
        this._notify();
        return {
          status: 'done',
          successCount: wm.successCount,
          skippedCount: wm.skippedCount,
          failureCount: wm.failureCount,
          suggestRebuildAnn: wm.successCount > 0,
        };
      }

      // Stopped mid-phase (kill switch) — keep watermark for resume.
      this._rechunkStatus = 'idle';
      this._rechunkMessage = `Re-chunk paused at ${wm.phase} (cursor ${wm.cursorAfter ?? 'start'})`;
      this._rechunkSuggestRebuildAnn = wm.successCount > 0;
      this._notify();
      return {
        status: 'cancelled',
        successCount: wm.successCount,
        skippedCount: wm.skippedCount,
        failureCount: wm.failureCount,
        suggestRebuildAnn: wm.successCount > 0,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[EmbeddingService] Re-chunk job error:', err);
      this._rechunkStatus = 'error';
      this._rechunkMessage = `Re-chunk failed: ${detail}`;
      this._notify();
      return {
        status: 'error',
        successCount: 0,
        skippedCount: 0,
        failureCount: 0,
        blockedReason: detail,
        suggestRebuildAnn: false,
      };
    } finally {
      this._rechunkAbort = null;
      this._rechunkRunning = false;
      this._rechunkPromise = null;
      this._notify();
    }
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
   * @param opts.force               Bypass both the watermark short-circuit and
   *                                 the per-entry content-hash skip, so every
   *                                 entry is regenerated even if its cached
   *                                 vector's hash still matches — used by the
   *                                 Settings "Force Re-index" action to recover
   *                                 from suspected cache corruption, where the
   *                                 hash bookkeeping may still agree with a
   *                                 corrupted stored vector.
   */
  generateCatalogEmbeddings(
    catalogIterator: (onBatch: (entries: CatalogEntry[]) => void) => Promise<number>,
    opts?: { storeKey?: string; lastSyncTimestamp?: number; force?: boolean },
  ): Promise<number> {
    return this._startCatalogPass('steam', (signal) => this._runCatalogPass<CatalogEntry>({
      which: 'steam',
      signal,
      iterate: catalogIterator,
      storeKey: opts?.storeKey ?? 'steam-catalog',
      lastSyncTimestamp: opts?.lastSyncTimestamp ?? 0,
      force: opts?.force ?? false,
      idOf: (entry) => `steam-${entry.appid}`,
      textOf: buildCatalogEmbeddingText,
      chunkInputOf: (entry) => ({
        title: entry.name,
        genres: entry.genres,
        themes: entry.themes,
        modes: entry.modes,
        developer: entry.developer,
        shortDescription: entry.shortDescription,
        source: 'steam',
      }),
      resume: () => this.generateCatalogEmbeddings(catalogIterator, opts),
    }));
  }

  /**
   * Background Tier 2b: generate embeddings for Epic catalog entries.
   * Runs sequentially after Steam catalog embeddings (waits for the Steam pass).
   * Shares the same catalog embedding store and ANN index.
   */
  generateEpicCatalogEmbeddings(
    epicIterator: (onBatch: (entries: EpicCatalogEntry[]) => void) => Promise<number>,
    opts?: { storeKey?: string; lastSyncTimestamp?: number; force?: boolean },
  ): Promise<number> {
    return this._startCatalogPass('epic', async (signal) => {
      // Wait for any in-flight Steam catalog embedding run to finish first
      const steam = this._passes.steam.promise;
      if (steam) await untilSettledOrAborted(steam, signal);
      return this._runCatalogPass<EpicCatalogEntry>({
        which: 'epic',
        signal,
        iterate: epicIterator,
        storeKey: opts?.storeKey ?? 'epic-catalog',
        lastSyncTimestamp: opts?.lastSyncTimestamp ?? 0,
        force: opts?.force ?? false,
        idOf: (entry) => `epic-${entry.epicId}`,
        textOf: buildEpicCatalogEmbeddingText,
        chunkInputOf: (entry) => ({
          title: entry.name,
          genres: entry.genres,
          themes: entry.themes,
          modes: entry.modes,
          developer: entry.developer,
          description: entry.description,
          longDescription: entry.longDescription,
          source: 'epic',
        }),
        resume: () => this.generateEpicCatalogEmbeddings(epicIterator, opts),
      });
    });
  }

  /**
   * Single-flight wrapper per source. A live (non-cancelled) run is shared
   * with every caller. A CANCELLED run that is still unwinding is awaited
   * before the new run starts: `cancelCatalogEmbeddings()` used to abort the
   * old run but leave its promise in place until its own `finally`, so an
   * immediate forced re-index got the old promise back and reported success
   * without doing anything.
   */
  private _startCatalogPass(
    which: CatalogSource,
    runner: (signal: AbortSignal) => Promise<number>,
  ): Promise<number> {
    const pass = this._passes[which];
    if (pass.promise && pass.abort && !pass.abort.signal.aborted) return pass.promise;

    const prior = pass.promise;
    const controller = new AbortController();
    pass.abort = controller;
    let run: Promise<number> | null = null;
    run = (async () => {
      // Let `run` be assigned before any synchronous exit reaches `finally`.
      await Promise.resolve();
      try {
        if (prior) { try { await prior; } catch { /* settled either way */ } }
        if (controller.signal.aborted) {
          this._resetProgressIfStale(which);
          return 0;
        }
        return await runner(controller.signal);
      } finally {
        if (pass.promise === run) pass.promise = null;
        if (pass.abort === controller) pass.abort = null;
      }
    })();
    pass.promise = run;
    return run;
  }

  /**
   * One catalog embedding pass (Steam or Epic — identical apart from ids,
   * text builders and chunk inputs).
   *
   *  - One scan of the source's own rows in the embedding store decides
   *    skip / re-embed / TTL refresh (was two full-store scans per pass).
   *  - With chunking on, CATALOG_CHUNKED_GAMES_PER_CALL games share one
   *    Ollama call so the main process can fill GPU sub-batches.
   *  - Circuit breaker: CIRCUIT_BREAKER_THRESHOLD consecutive calls that
   *    return no vectors stop the pass (resumed once Ollama recovers).
   *  - Poison games: a game failing on a text hash POISON_MAX_ATTEMPTS times
   *    is skipped, and no longer blocks the watermark.
   */
  private async _runCatalogPass<E>(cfg: {
    which: CatalogSource;
    signal: AbortSignal;
    iterate: (onBatch: (entries: E[]) => void) => Promise<number>;
    storeKey: string;
    lastSyncTimestamp: number;
    force: boolean;
    idOf: (entry: E) => string;
    textOf: (entry: E) => string;
    chunkInputOf: (entry: E) => ChunkInput;
    resume: () => Promise<number>;
  }): Promise<number> {
    const { which, signal, storeKey, lastSyncTimestamp, force } = cfg;
    const pass = this._passes[which];
    const label = which === 'steam' ? 'Catalog' : 'Epic catalog';
    const setProgress = (p: { completed: number; total: number }) => {
      if (which === 'steam') this._steamCatalogProgress = p;
      else this._epicCatalogProgress = p;
    };

    if (!(await this.isAvailable()) || signal.aborted) {
      // Turned away because the other source's pass tripped the breaker: queue this
      // pass for the recovery resume too, or it would be skipped for the session.
      if (this._breakerOpen && !signal.aborted) this._breakerResume[which] = cfg.resume;
      this._resetProgressIfStale(which);
      return 0;
    }

    pass.running = true;
    this._notify();

    try {
      // ─── Watermark short-circuit ──────────────────────────────────────────
      // If the source catalog hasn't been re-synced since our last embedding
      // pass AND the version stamp is unchanged, skip the entire cursor scan.
      // `force` always bypasses this — a forced re-index means "regenerate
      // everything," not "trust the watermark."
      const watermark = await getEmbeddingMeta<EmbeddingPassWatermark>(storeKey);
      const canSkipScan =
        !force &&
        watermark &&
        lastSyncTimestamp > 0 &&
        lastSyncTimestamp <= watermark.syncTimestamp &&
        watermark.versionStamp === HASH_VERSION_PREFIX;

      if (canSkipScan) {
        console.log(`[EmbeddingService] ${label} unchanged since last pass — skipping scan (${storeKey})`);
        if (!annIndex.isReady) {
          await this._backfillAnnIndex();
        }
        annIndex.finishBuild();
        this._resetProgressIfStale(which);
        return 0;
      }

      const chunkingEnabled = await isEmbeddingChunkingEnabled();
      const skipIndex = await getCatalogSkipIndex(which === 'steam' ? 'steam-' : 'epic-');
      const ledger = await getEmbedFailureLedger();

      const needsEmbedding: Array<{ id: string; text: string; hash: string; entry: E }> = [];
      const refreshTimestampIds: string[] = [];
      let scannedTotal = 0;
      let poisonSkipped = 0;
      const refreshCutoff = Date.now() - TTL_REFRESH_THRESHOLD_MS;

      await cfg.iterate((batch) => {
        for (const entry of batch) {
          const id = cfg.idOf(entry);
          const text = cfg.textOf(entry);
          const hash = hashText(text);
          const existing = skipIndex.get(id);
          if (!force && shouldSkipPooled(existing, hash)) {
            // Same content — just touch the timestamp if it's getting stale.
            const ts = existing?.timestamp ?? 0;
            if (ts > 0 && ts < refreshCutoff) refreshTimestampIds.push(id);
            continue;
          }
          if (!force && ledger.isPoisoned(`cat:${id}`, hash)) {
            poisonSkipped++;
            continue;
          }
          needsEmbedding.push({ id, text, hash, entry });
        }
        scannedTotal += batch.length;
      });

      skipIndex.clear();
      if (signal.aborted) {
        console.log(`[EmbeddingService] ${label} embeddings cancelled`);
        this._resetProgressIfStale(which);
        return 0;
      }
      if (poisonSkipped > 0) {
        console.log(`[EmbeddingService] ${label}: skipping ${poisonSkipped} games that failed ${POISON_MAX_ATTEMPTS}+ times`);
      }

      if (refreshTimestampIds.length > 0) {
        // Fire-and-forget — purely a TTL extension, never blocks user-facing work.
        refreshCachedTimestamps(refreshTimestampIds, CATALOG_STORE)
          .then(() => console.log(`[EmbeddingService] Refreshed TTL for ${refreshTimestampIds.length} unchanged ${label} entries`))
          .catch(() => { /* non-fatal */ });
      }

      if (needsEmbedding.length === 0) {
        console.log(`[EmbeddingService] All ${scannedTotal} ${label} embeddings already cached`);
        // Reflect the scanned total so the status widget shows "N vectors"
        // instead of a stale/blank {0,0} after a no-op pass.
        setProgress({ completed: scannedTotal, total: scannedTotal });
        this._notify();
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
        `[EmbeddingService] Generating ${needsEmbedding.length} ${label} embeddings ` +
        `(chunking=${chunkingEnabled ? 'on' : 'off'})...`,
      );
      setProgress({ completed: 0, total: needsEmbedding.length });
      this._notify();

      const groupSize = chunkingEnabled ? CATALOG_CHUNKED_GAMES_PER_CALL : CATALOG_FLAT_GAMES_PER_CALL;
      const IDLE_DELAY_MS = 200;
      let totalGenerated = 0;
      let completed = 0;
      let writeFailures = 0;
      /** Failed games still under the poison limit — they block the watermark. */
      let unresolvedFailures = 0;
      let consecutiveFailedCalls = 0;
      /**
       * Games that failed inside calls where Ollama returned NOTHING. Those
       * may be Ollama's fault, not the games', so their attempts are only
       * counted once a later call proves Ollama is answering.
       */
      let failureStreak: Array<{ key: string; hash: string }> = [];
      let tripped = false;

      const commitFailures = (failures: Array<{ key: string; hash: string }>) => {
        for (const f of failures) {
          if (ledger.record(f.key, f.hash) >= POISON_MAX_ATTEMPTS) {
            console.warn(`[EmbeddingService] ${label}: ${f.key} failed ${POISON_MAX_ATTEMPTS} times — skipping it from now on`);
          } else {
            unresolvedFailures++;
          }
        }
      };

      for (let i = 0; i < needsEmbedding.length; i += groupSize) {
        await this._awaitIfPaused(signal);
        if (signal.aborted) break;

        const batch = needsEmbedding.slice(i, i + groupSize);
        const gameFailures: Array<{ key: string; hash: string }> = [];
        let requested = 0;
        let returned = 0;

        if (!chunkingEnabled) {
          const items = batch.map(b => ({ id: b.id, text: b.text }));
          const { results, transient } = await generateEmbeddingsReportingTransient(items);
          requested = items.length;
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
            } else if (transient.has(item.id)) {
              unresolvedFailures++; // not the game's fault — no strike, but retry before advancing the watermark
            } else {
              gameFailures.push({ key: `cat:${item.id}`, hash: item.hash });
            }
          }
          returned = batchEntries.length;
          if (batchEntries.length > 0) {
            try {
              await saveCachedEmbeddings(batchEntries, CATALOG_STORE);
              totalGenerated += batchEntries.length;
              for (const e of batchEntries) ledger.clear(`cat:${e.gameId}`);
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
              console.warn(`[EmbeddingService] ${label} float persist failed:`, err);
            }
          }
        } else {
          const res = await embedAndPersistChunkedGames('cat', CATALOG_STORE, batch.map((item) => ({
            gameId: item.id,
            wholeHash: item.hash,
            chunkInput: cfg.chunkInputOf(item.entry),
          })));
          requested = res.requested;
          returned = res.returned;
          let wrote = 0;
          for (const item of batch) {
            const outcome = res.outcomes.get(item.id);
            if (!outcome || outcome.status === 'empty') continue;
            if (outcome.status === 'ok') {
              // ANN upsert (pooled + chunks) happens inside embedAndPersistChunkedGames
              totalGenerated++;
              wrote++;
              ledger.clear(`cat:${item.id}`);
            } else if (outcome.status === 'embed-failed') {
              if (outcome.transient) unresolvedFailures++; // retry later, no strike
              else gameFailures.push({ key: `cat:${item.id}`, hash: item.hash });
            } else {
              writeFailures++;
              console.warn(`[EmbeddingService] ${label} chunk write failed for ${item.id}: ${outcome.error}`);
            }
          }
          if (wrote > 0) await bumpEmbeddingContentEpoch();
        }

        // ── Circuit breaker / poison bookkeeping ──
        if (requested > 0 && returned === 0) {
          consecutiveFailedCalls++;
          failureStreak.push(...gameFailures);
          // A whole multi-game call can take its full timeout (120 s + 4 s/text) to fail, so
          // waiting for CIRCUIT_BREAKER_THRESHOLD of them meant ~1.5 h on a hung Ollama. Ask a
          // one-text probe right away: dead → trip now; alive → the games themselves failed.
          if (consecutiveFailedCalls >= CIRCUIT_BREAKER_THRESHOLD || !(await this._probeOllamaEmbedding())) {
            tripped = true;
          } else {
            consecutiveFailedCalls = 0;
            commitFailures(failureStreak);
            failureStreak = [];
          }
        } else if (requested > 0) {
          // Ollama is answering — failures in this call (and the streak
          // before it) belong to the games themselves.
          consecutiveFailedCalls = 0;
          commitFailures(failureStreak);
          commitFailures(gameFailures);
          failureStreak = [];
        } else {
          commitFailures(gameFailures);
        }

        completed += batch.length;
        setProgress({ completed, total: needsEmbedding.length });
        annIndex.setBuildProgress(completed, needsEmbedding.length);
        this._notifyProgress();

        if (tripped) break;
        await idleYield(IDLE_DELAY_MS);
      }

      // A trailing all-failed call (e.g. a re-run where only bad games are
      // left) never sees a later success to prove Ollama is fine. Ask with a
      // probe — otherwise a lone poison game would be retried forever.
      if (!tripped && !signal.aborted && failureStreak.length > 0 && (await this._probeOllamaEmbedding())) {
        commitFailures(failureStreak);
        failureStreak = [];
      }

      await ledger.save();

      if (tripped) {
        console.warn(
          `[EmbeddingService] ${label}: ${CIRCUIT_BREAKER_THRESHOLD} consecutive Ollama calls returned nothing — ` +
          'stopping this pass; it resumes automatically once Ollama answers again',
        );
        if (totalGenerated > 0 && annIndex.vectorCount > 0) await annIndex.save();
        annIndex.finishBuild();
        setProgress({ completed: 0, total: 0 });
        this._notify();
        this._tripCircuitBreaker(which, cfg.resume);
        return totalGenerated;
      }

      if (signal.aborted) {
        // Cancelled mid-run — don't report a misleading partial vector count
        // once embRunning goes false; fall back to idle so this pass reads as
        // unambiguously retryable rather than "stuck".
        annIndex.finishBuild();
        setProgress({ completed: 0, total: 0 });
        this._notify();
        console.log(`[EmbeddingService] ${label} embeddings cancelled`);
        return totalGenerated;
      }

      this._notifyProgress(true);

      // Persist the updated ANN index to disk
      if (totalGenerated > 0 && annIndex.vectorCount > 0) {
        await annIndex.save({ force: true }); // on disk before the watermark below
        console.log(`[EmbeddingService] ANN index saved (${label}): ${annIndex.vectorCount} vectors`);
      }
      annIndex.finishBuild();

      // Games that failed only inside all-null calls at the very end are
      // ambiguous (Ollama vs game) — retry them next time, don't count them.
      unresolvedFailures += failureStreak.length;

      // Watermark once nothing is left to retry: no unpersisted writes, and
      // every failed game has reached the poison limit (and will be skipped).
      if (writeFailures === 0 && unresolvedFailures === 0 && lastSyncTimestamp > 0) {
        await setEmbeddingMeta<EmbeddingPassWatermark>({
          key: storeKey,
          syncTimestamp: lastSyncTimestamp,
          versionStamp: HASH_VERSION_PREFIX,
          completedAt: Date.now(),
        });
      } else if (writeFailures > 0 || unresolvedFailures > 0) {
        console.log(
          `[EmbeddingService] ${label}: ${unresolvedFailures} failed games will be retried ` +
          `(${writeFailures} write failures) — watermark not advanced`,
        );
      }

      console.log(`[EmbeddingService] ${label} embeddings done: ${totalGenerated} generated`);
      return totalGenerated;
    } catch (err) {
      if (!signal.aborted) {
        console.warn(`[EmbeddingService] ${label} embedding error:`, err);
      }
      // Never leave a partial completed<total reading once embRunning flips
      // false — this is the exit path a bug used to leave permanently wedged.
      setProgress({ completed: 0, total: 0 });
      annIndex.finishBuild();
      return 0;
    } finally {
      pass.running = false;
      this._notify();
    }
  }

  /**
   * Populate the ANN index from already-cached embeddings in IDB.
   * Reads both catalog and library stores so the index covers all known vectors.
   *
   * IMPORTANT: never `await` IPC (addVectors) before `cursor.continue()` — IDB
   * transactions go inactive after a turn of the event loop (TransactionInactiveError).
   * Collect decoded rows with sync continue (paged by key), then flush outside the tx.
   */
  private async _backfillAnnIndex(): Promise<void> {
    await migrateEmbeddingsFromIdbIfNeeded();
    if (useLevelDB()) {
      return this._backfillAnnIndexLevel();
    }
    const db = await getDB();
    const now = Date.now();
    const seen = new Set<string>();
    let sent = 0;

    const yieldToEventLoop = () => new Promise<void>((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });

    const countStore = (storeName: string): Promise<number> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve(0);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

    // Upper-bound progress total (pooled + chunks; includes expired / undecodable).
    const [libCount, catCount, chunkCount] = await Promise.all([
      countStore(LIBRARY_STORE),
      countStore(CATALOG_STORE),
      countStore(CHUNK_STORE),
    ]);
    const progressTotal = Math.max(1, libCount + catCount + chunkCount);
    annIndex.setBuildProgress(0, progressTotal);
    let pooledSent = 0;
    let chunkSent = 0;

    /**
     * One readonly IDB page: decode up to `pageSize` eligible vectors with
     * sync `cursor.continue` only — no await inside onsuccess.
     */
    const collectPage = (
      storeName: string,
      ttl: number,
      afterKey: string | null,
      pageSize: number,
    ): Promise<{ rows: AnnBackfillRow[]; nextAfterKey: string | null }> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) {
          resolve({ rows: [], nextAfterKey: null });
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const range =
          afterKey != null ? IDBKeyRange.lowerBound(afterKey, true) : undefined;
        const req = range ? store.openCursor(range) : store.openCursor();
        const rows: AnnBackfillRow[] = [];
        let lastKey: string | null = null;

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve({ rows, nextAfterKey: null });
            return;
          }
          lastKey = String(cursor.key);
          const entry = cursor.value as CachedEmbedding;
          const vec = readPooledVector(entry);
          if (
            vec &&
            !seen.has(entry.gameId) &&
            now - entry.timestamp < ttl
          ) {
            seen.add(entry.gameId);
            rows.push({ id: entry.gameId, vector: Array.from(vec) });
          }
          if (rows.length >= pageSize) {
            // Stop this cursor/tx; resume later via nextAfterKey. No await here.
            resolve({ rows, nextAfterKey: lastKey });
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });

    const flushRows = async (
      rows: AnnBackfillRow[],
      kind: 'pooled' | 'chunk',
    ): Promise<void> => {
      // addVectors is IPC — only called outside IDB transactions.
      for (const chunk of partitionEmbeddingRowsForAnnBackfill(rows, ANN_BACKFILL_FLUSH_BATCH)) {
        await annIndex.addVectors(chunk);
        sent += chunk.length;
        if (kind === 'pooled') pooledSent += chunk.length;
        else chunkSent += chunk.length;
        annIndex.setBuildProgress(sent, progressTotal);
        await yieldToEventLoop();
      }
    };

    const streamStore = async (storeName: string, ttl: number): Promise<void> => {
      let afterKey: string | null = null;
      for (;;) {
        const page = await collectPage(storeName, ttl, afterKey, ANN_BACKFILL_PAGE_SIZE);
        if (page.rows.length > 0) {
          await flushRows(page.rows, 'pooled');
        }
        if (page.nextAfterKey == null) break;
        afterKey = page.nextAfterKey;
      }
    };

    // try/finally guarantees annIndex._building always resolves to false when
    // this function exits, regardless of how — including 0-vectors-eligible
    // (setBuildProgress(0, Math.max(sent,1)) below would otherwise read as
    // done<total===true forever) and a thrown save error.
    try {
      // Library first (higher priority — dedup via `seen`)
      await streamStore(LIBRARY_STORE, LIBRARY_TTL);
      await streamStore(CATALOG_STORE, CATALOG_TTL);

      // Phase B.1: dual presence — also ingest facet chunk vectors (ids
      // contain `::`), streamed page by page instead of all at once.
      await streamChunkVectorsForAnn((rows) => flushRows(rows, 'chunk'));

      annIndex.setBuildProgress(sent, Math.max(sent, 1));

      if (sent > 0) {
        const saved = await annIndex.save({ force: true }); // end of backfill
        // Only hard-fail when ANN IPC exists but save refused — absent ANN is soft-degrade.
        if (!saved && typeof window !== 'undefined' && window.ann) {
          throw new Error('ANN index save failed after backfill');
        }
        console.log(
          `[EmbeddingService] ANN index backfilled: ${sent} vectors ` +
            `(${pooledSent} pooled + ${chunkSent} chunks) from cache`,
        );
      }
    } finally {
      annIndex.finishBuild();
    }
  }

  /**
   * LevelDB counterpart to `_backfillAnnIndex`. Same algorithm (library then
   * catalog pooled vectors, deduped via `seen`, then facet chunk vectors),
   * paginated via `getChunk` instead of a raw IDB cursor. Buffers at most
   * `ANN_BACKFILL_PAGE_SIZE` rows before flushing to the ANN index.
   *
   * The progress total no longer comes from a separate full pre-count scan
   * of all three namespaces (which tripled the I/O of every backfill): the
   * pooled counts come from the cached key index, and chunk rows — about
   * three per game — are estimated, with the total grown if exceeded.
   */
  private async _backfillAnnIndexLevel(): Promise<void> {
    const now = Date.now();
    const seen = new Set<string>();
    let sent = 0;

    const yieldToEventLoop = () => new Promise<void>((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });

    const pooledCount =
      (await levelPooledCount(LEVEL_LIBRARY_NAMESPACE)) + (await levelPooledCount(LEVEL_CATALOG_NAMESPACE));
    let progressTotal = Math.max(1, pooledCount * 4);
    annIndex.setBuildProgress(0, progressTotal);
    let pooledSent = 0;
    let chunkSent = 0;

    const flushRows = async (
      rows: AnnBackfillRow[],
      kind: 'pooled' | 'chunk',
    ): Promise<void> => {
      for (const chunk of partitionEmbeddingRowsForAnnBackfill(rows, ANN_BACKFILL_FLUSH_BATCH)) {
        await annIndex.addVectors(chunk);
        sent += chunk.length;
        if (kind === 'pooled') pooledSent += chunk.length;
        else chunkSent += chunk.length;
        if (sent >= progressTotal) progressTotal = sent + ANN_BACKFILL_PAGE_SIZE;
        annIndex.setBuildProgress(sent, progressTotal);
        await yieldToEventLoop();
      }
    };

    const streamPooledNs = async (namespace: string, ttl: number): Promise<void> => {
      let buffer: AnnBackfillRow[] = [];
      await levelStreamPooled(namespace, async (entry) => {
        if (seen.has(entry.gameId)) return;
        const vec = readPooledVector(entry);
        if (!vec || now - entry.timestamp >= ttl) return;
        seen.add(entry.gameId);
        buffer.push({ id: entry.gameId, vector: Array.from(vec) });
        if (buffer.length >= ANN_BACKFILL_PAGE_SIZE) {
          const toFlush = buffer;
          buffer = [];
          await flushRows(toFlush, 'pooled');
        }
      });
      if (buffer.length > 0) await flushRows(buffer, 'pooled');
    };

    // try/finally guarantees annIndex._building always resolves to false when
    // this function exits — same rationale as _backfillAnnIndex's IDB path.
    try {
      // Library first (higher priority — dedup via `seen`)
      await streamPooledNs(LEVEL_LIBRARY_NAMESPACE, LIBRARY_TTL);
      await streamPooledNs(LEVEL_CATALOG_NAMESPACE, CATALOG_TTL);

      // Phase B.1: dual presence — also ingest facet chunk vectors (ids
      // contain `::`). Streamed and flushed page by page: collecting every
      // chunk vector first is what ran the renderer out of memory.
      await streamChunkVectorsForAnn((rows) => flushRows(rows, 'chunk'));

      annIndex.setBuildProgress(sent, Math.max(sent, 1));

      if (sent > 0) {
        const saved = await annIndex.save({ force: true }); // end of backfill
        if (!saved && typeof window !== 'undefined' && window.ann) {
          throw new Error('ANN index save failed after backfill');
        }
        console.log(
          `[EmbeddingService] ANN index backfilled: ${sent} vectors ` +
            `(${pooledSent} pooled + ${chunkSent} chunks) from cache`,
        );
      }
    } finally {
      annIndex.finishBuild();
    }
  }

  /**
   * Clear the ANN index and rebuild from cached library + catalog pooled vectors.
   * Returns the vector count reported by the ANN service after backfill.
   * Propagates errors so Settings can surface the failure string.
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[EmbeddingService] ANN rebuild from cache failed: ${msg}`, err);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      annIndex.finishBuild();
    }
  }

  /**
   * Forget a cached "Ollama unavailable" verdict so the next check probes again
   * (Ollama settings saved). Unlike resetAvailability, keeps loaded embeddings.
   */
  clearUnavailableVerdict() {
    if (this.ollamaAvailable === false) this.ollamaAvailable = null;
    this._unavailableUntil = 0;
  }

  /** Reset availability check (e.g. after user changes Ollama settings). */
  resetAvailability() {
    this.ollamaAvailable = null;
    this.embeddingModelReady = false;
    this._unavailableUntil = 0;
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
 *
 * On the LevelDB path the first call per session pages through each
 * namespace once (LevelDB has no cheap analog to IDB's `count()` and the
 * store API has no keys-only scan) and seeds the pooled key index; after
 * that the count is `Set.size`, kept exact by this module's own writes.
 * galaxy-cache polls this every few seconds while waiting for embeddings —
 * each poll used to re-read every vector.
 */
export async function getPooledEmbeddingCount(): Promise<number> {
  await migrateEmbeddingsFromIdbIfNeeded();
  if (useLevelDB()) {
    const [lib, cat] = await Promise.all([
      levelPooledCount(LEVEL_LIBRARY_NAMESPACE),
      levelPooledCount(LEVEL_CATALOG_NAMESPACE),
    ]);
    return lib + cat;
  }

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
  await migrateEmbeddingsFromIdbIfNeeded();
  const now = Date.now();

  if (useLevelDB()) {
    const fromNamespace = async (namespace: string, ttl: number): Promise<number[] | null> => {
      const entry = await levelGetPooled(namespace, gameId);
      if (entry && now - entry.timestamp < ttl) return pooledVectorAsNumberArray(entry);
      return null;
    };
    return (await fromNamespace(LEVEL_LIBRARY_NAMESPACE, LIBRARY_TTL))
      ?? (await fromNamespace(LEVEL_CATALOG_NAMESPACE, CATALOG_TTL));
  }

  const db = await getDB();
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
 * Every pooled embedding (library + catalog), deduped by gameId with library
 * taking priority, decoded to a plain number[] vector. Used by
 * `game-graph-store.ts` in place of that file's former direct IDB access
 * (which hardcoded the `'embeddings'`/`'catalog-embeddings'` store names and
 * would have silently broken on any storage-backend change).
 */
export async function getAllPooledEmbeddingsForGraph(): Promise<Array<{ gameId: string; embedding: number[] }>> {
  await migrateEmbeddingsFromIdbIfNeeded();
  const seen = new Set<string>();
  const out: Array<{ gameId: string; embedding: number[] }> = [];

  const collect = (entry: CachedEmbedding) => {
    if (seen.has(entry.gameId)) return;
    const vec = readPooledVector(entry);
    if (!vec) return;
    seen.add(entry.gameId);
    out.push({ gameId: entry.gameId, embedding: Array.from(vec) });
  };

  if (useLevelDB()) {
    await levelStreamPooled(LEVEL_LIBRARY_NAMESPACE, collect);
    await levelStreamPooled(LEVEL_CATALOG_NAMESPACE, collect);
    return out;
  }

  const db = await getDB();
  for (const storeName of [LIBRARY_STORE, CATALOG_STORE]) {
    if (!db.objectStoreNames.contains(storeName)) continue;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        for (const entry of (req.result as CachedEmbedding[])) collect(entry);
        resolve();
      };
      req.onerror = () => resolve();
    });
  }
  return out;
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
  await migrateEmbeddingsFromIdbIfNeeded();
  const dim = 1024;
  const now = Date.now();
  const seen = new Set<string>();
  const ids: string[] = [];

  if (useLevelDB()) {
    const collectIdsLevel = async (namespace: string, label: string, ttl: number) => {
      let count = 0;
      await levelStreamPooled(namespace, (entry) => {
        if (readPooledVector(entry) && !seen.has(entry.gameId) && now - entry.timestamp < ttl) {
          seen.add(entry.gameId);
          ids.push(entry.gameId);
          count++;
          if (count % 2000 === 0) onProgress?.(count, label);
        }
      });
    };
    await collectIdsLevel(LEVEL_LIBRARY_NAMESPACE, 'library', LIBRARY_TTL);
    onProgress?.(ids.length, 'library');
    await collectIdsLevel(LEVEL_CATALOG_NAMESPACE, 'catalog', CATALOG_TTL);
    onProgress?.(ids.length, 'catalog');

    const n = ids.length;
    const data = new Float32Array(n * dim);
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < n; i++) idToIdx.set(ids[i], i);

    const fillFromLevel = async (namespace: string, ttl: number) => {
      await levelStreamPooled(namespace, (entry) => {
        const vec = readPooledVector(entry);
        if (vec && now - entry.timestamp < ttl) {
          const idx = idToIdx.get(entry.gameId);
          if (idx !== undefined) data.set(vec, idx * dim);
        }
      });
    };
    await fillFromLevel(LEVEL_LIBRARY_NAMESPACE, LIBRARY_TTL);
    await fillFromLevel(LEVEL_CATALOG_NAMESPACE, CATALOG_TTL);

    return { ids, data, dim };
  }

  const db = await getDB();

  // Pass 1: collect IDs only — no vectors in memory yet.
  // This gives us exact count + dedup order for pre-allocating the Float32Array.
  // Cursor paths below only sync-decode + cursor.continue — never await IPC mid-cursor.
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
  await migrateEmbeddingsFromIdbIfNeeded();
  const srcDim = 1024;
  const seen = new Set<string>();
  const ids: string[] = [];
  const now = Date.now();

  if (useLevelDB()) {
    const collectIdsLevel = async (namespace: string, label: string, ttl: number) => {
      let count = 0;
      await levelStreamPooled(namespace, (entry) => {
        if (readPooledVector(entry) && !seen.has(entry.gameId) && now - entry.timestamp < ttl) {
          seen.add(entry.gameId);
          ids.push(entry.gameId);
          count++;
          if (count % 2000 === 0) onProgress?.(count, label);
        }
      });
    };
    await collectIdsLevel(LEVEL_LIBRARY_NAMESPACE, 'library', LIBRARY_TTL);
    onProgress?.(ids.length, 'library');
    await collectIdsLevel(LEVEL_CATALOG_NAMESPACE, 'catalog', CATALOG_TTL);
    onProgress?.(ids.length, 'catalog');

    const n = ids.length;
    if (n === 0) return { ids, projected: new Float32Array(0), projDim: PROJ_DIM };

    const R = generateGaussianProjectionMatrix(srcDim, PROJ_DIM);
    const projected = new Float32Array(n * PROJ_DIM);
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < n; i++) idToIdx.set(ids[i], i);

    const projectFromLevel = async (namespace: string, ttl: number) => {
      await levelStreamPooled(namespace, (entry) => {
        const emb = readPooledVector(entry);
        if (!emb || now - entry.timestamp >= ttl) return;
        const idx = idToIdx.get(entry.gameId);
        if (idx === undefined) return;
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
      });
    };
    await projectFromLevel(LEVEL_LIBRARY_NAMESPACE, LIBRARY_TTL);
    await projectFromLevel(LEVEL_CATALOG_NAMESPACE, CATALOG_TTL);

    const mean = new Float32Array(PROJ_DIM);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < PROJ_DIM; j++) mean[j] += projected[i * PROJ_DIM + j];
    for (let j = 0; j < PROJ_DIM; j++) mean[j] /= n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < PROJ_DIM; j++) projected[i * PROJ_DIM + j] -= mean[j];

    return { ids, projected, projDim: PROJ_DIM };
  }

  const db = await getDB();

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
