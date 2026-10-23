/**
 * ANN Index Manager (Main Process)
 *
 * Manages an HNSW approximate nearest-neighbor index via usearch.
 * Persists the index + ID mapping to disk in the app's userData directory.
 * Exposed to the renderer via IPC handlers in ann-handlers.ts.
 *
 * Native memory: a full-catalog index is several GB of native (non-V8) memory
 * that V8's heap accounting never sees, so a dropped JS reference can keep the
 * old graph alive for a long time. There is exactly ONE module-level instance;
 * `loadIndex` is a no-op while it exists (renderer reloads call `ann:load`
 * every time), and the old instance is always released — and a GC requested —
 * before a replacement is created, so two indexes are never held at once.
 *
 * Coherence: `coherent` is true only when the in-memory index reflects every
 * cached vector (loaded from disk, or a renderer backfill completed and said so
 * with `save({ complete: true })`). A cleared / implicitly created / half-rebuilt
 * index is never written to disk — not by a throttled save, not by a forced
 * end-of-pass save, not by the before-quit flush — so a partial rebuild can no
 * longer be persisted and then load as "ready" forever.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './safe-logger.js';
import { atomicWriteFileSync } from './safe-write.js';
import { settingsStore } from './settings-store.js';

let Index: any;
let MetricKind: any;
let ScalarKind: any;

try {
  const usearch = require('usearch');
  Index = usearch.Index;
  MetricKind = usearch.MetricKind;
  ScalarKind = usearch.ScalarKind;
} catch (err) {
  logger.error('[ANN] Failed to load usearch native module:', err);
}

const FULL_DIMS = 1024;
const MRL_DIMS = 256;
/** Active ANN dimensionality — 256 when MRL flag is on, else 1024. */
let DIMS = FULL_DIMS;
const CONNECTIVITY = 48;
const EF_CONSTRUCTION = 256;
/** Higher ef_search for distance-gated top‑K (Oracle keeps ≤500 neighbors). */
const EF_SEARCH = 800;

function resolveDimsFromSettings(): number {
  try {
    return settingsStore.getOllamaSettings().embeddingMrl256Enabled ? MRL_DIMS : FULL_DIMS;
  } catch {
    return FULL_DIMS;
  }
}

/** Sync DIMS from settings; releases the in-memory index when dims change. */
export function syncAnnDimsFromSettings(): number {
  const next = resolveDimsFromSettings();
  if (next !== DIMS) {
    logger.log(`[ANN] Dims ${DIMS} → ${next} (MRL flag)`);
    DIMS = next;
    // Drop in-memory index so load/rebuild uses the new dimensionality.
    releaseIndex();
  }
  return DIMS;
}

export function getAnnDims(): number {
  return DIMS;
}

/**
 * Validate + convert one input vector. Accepts exactly DIMS values, or a
 * full-length (1024) vector when MRL truncation is active (prefix + L2
 * renorm). Rejects non-finite values and zero vectors (cosine NaN).
 */
function prepareAnnVector(vector: ArrayLike<number> | null | undefined): Float32Array | null {
  if (!vector || typeof (vector as { length?: unknown }).length !== 'number') return null;
  const len = vector.length;
  if (len !== DIMS && !(DIMS < FULL_DIMS && len === FULL_DIMS)) return null;
  const out = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = v;
    norm += v * v;
  }
  if (!(norm > 1e-12)) return null;
  if (len !== DIMS) {
    // MRL: prefix was taken above — L2-renorm it
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < DIMS; i++) out[i] *= inv;
  }
  return out;
}

/** Tests only — main always uses Electron's userData directory. */
let userDataDirOverride: string | null = null;

function userDataDir(): string {
  return userDataDirOverride ?? app.getPath('userData');
}

function getIndexPath(): string {
  return path.join(userDataDir(), 'ann-hnsw.usearch');
}

function getMetaPath(): string {
  return path.join(userDataDir(), 'ann-hnsw-meta.json');
}

/**
 * On-disk ANN id map.
 *
 * Id kinds (prefix convention — no separate idKinds field required):
 * - Pooled game ids: no `::` (e.g. `steam-730`, `epic-ns:offer`)
 * - Chunk ids: `lib:{gameId}::{kind}#{seq}` or `cat:{gameId}::{kind}#{seq}`
 *   Filter with `id.includes('::')` / `isChunkAnnId` from ann-max-sim.
 */
interface IndexMeta {
  gameIds: string[];
  vectorCount: number;
  builtAt: number;
  /**
   * Layout generation of the vectors this file was built from (src/services/embedding-layout.ts
   * EMBEDDING_LAYOUT_GENERATION — mirrored below; a unit test pins the two together). Files written
   * before this field existed have none and are read as generation 1.
   */
  layoutGeneration?: number;
  /** Ollama embedding model tag the vectors came from (informational — never discards an index). */
  modelTag?: string;
}

/**
 * Mirror of EMBEDDING_LAYOUT_GENERATION (the main process cannot import from src/). A persisted index built
 * under a different generation holds vectors that are not comparable with new ones, so it is discarded on load
 * (and the renderer's backfill rebuilds it) instead of being served as "ready".
 */
export const ANN_LAYOUT_GENERATION = 1;

let annModelTag = '';

/** Set once at startup from the resolved embedding model tag (ARK_EMBEDDING_MODEL_TAG may override the default). */
export function setAnnModelTag(tag: string): void {
  annModelTag = tag || '';
}

let index: InstanceType<typeof Index> | null = null;
let idMap: string[] = [];
let reverseMap = new Map<string, number>();
/** Bumped whenever the in-memory index is replaced/dropped — lets a yielding addVectors bail. */
let indexGeneration = 0;
/**
 * True when the in-memory index (possibly empty) reflects every cached vector:
 * loaded from disk, or a renderer backfill finished (`save({ complete: true })`).
 * False after clear / dims change / boot-without-load. Never persisted while false.
 */
let coherent = false;

// ─── Save throttling ─────────────────────────────────────────────────────────
// `index.save()` is a synchronous native call that serialises the whole HNSW
// graph (hundreds of MB for a full catalog) on the MAIN process, freezing
// every window while it runs. The re-chunk job used to request it every 25
// games. Saves are now: skipped when nothing changed, coalesced to at most one
// per SAVE_MIN_INTERVAL_MS (a deferred save covers requests inside the window),
// written atomically (temp file + rename), and flushed once on quit.
const SAVE_MIN_INTERVAL_MS = 60_000;
/** Vectors added per slice before yielding the main-process event loop. */
const ADD_SLICE = 64;
let dirty = false;
let lastSaveAt = 0;
let deferredSaveTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Native memory release ───────────────────────────────────────────────────
let gcFn: (() => void) | null | undefined;

/**
 * usearch 2.21 exposes no free()/close(): the native graph is released only
 * when V8 finalizes the wrapper, and V8 doesn't know how big it is. Ask for a
 * full GC after dropping an index so the multi-GB allocation is actually
 * returned before a replacement is built.
 */
function collectGarbage(): void {
  try {
    if (gcFn === undefined) {
      const g = (globalThis as { gc?: () => void }).gc;
      if (typeof g === 'function') {
        gcFn = g;
      } else {
        const v8 = require('v8');
        const vm = require('vm');
        v8.setFlagsFromString('--expose_gc');
        gcFn = vm.runInNewContext('gc') as () => void;
      }
    }
    gcFn?.();
  } catch {
    gcFn = null; // unavailable — rely on V8's own schedule
  }
}

/** Drop the in-memory index (and request a GC) — never keep two native graphs alive. */
function releaseIndex(): void {
  const old = index;
  let hadVectors = false;
  try { hadVectors = !!old && Number(old.size()) > 0; } catch { hadVectors = !!old; }
  index = null;
  idMap = [];
  reverseMap.clear();
  indexGeneration++;
  dirty = false;
  coherent = false;
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
  if (hadVectors) collectGarbage();
}

function newNativeIndex(): any {
  return new Index(DIMS, MetricKind.Cos, ScalarKind.F32, CONNECTIVITY, EF_CONSTRUCTION, EF_SEARCH);
}

/** Create the single module-level instance. Callers must have released any previous one. */
function createIndex(): void {
  if (!Index) return;
  if (index) return; // never stack a second native graph
  index = newNativeIndex();
}

function rebuildReverseMap(): void {
  reverseMap.clear();
  for (let i = 0; i < idMap.length; i++) {
    if (idMap[i]) reverseMap.set(idMap[i], i);
  }
}

/** Move a corrupt index + meta aside (`*.corrupt`) so the next pass rebuilds instead of re-loading it. */
function quarantinePersistedIndex(reason: string): void {
  logger.warn(`[ANN] Persisted index unusable (${reason}) — quarantining as *.corrupt; a rebuild will run`);
  for (const p of [getIndexPath(), getMetaPath()]) {
    try {
      if (!fs.existsSync(p)) continue;
      const dest = p + '.corrupt';
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
      fs.renameSync(p, dest);
    } catch (err) {
      logger.error(`[ANN] Failed to quarantine ${p}:`, err);
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

function deletePersistedIndex(): void {
  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch { /* ignore cleanup errors */ }
}

/**
 * Load the persisted index. A no-op (returns current readiness) when an index
 * is already in memory — every renderer reload calls this, and building a
 * second multi-GB copy next to the live one is what ran main out of memory.
 */
export function loadIndex(): boolean {
  if (!Index) return false;
  syncAnnDimsFromSettings();
  if (index) return reverseMap.size > 0;

  const indexPath = getIndexPath();
  const metaPath = getMetaPath();
  if (!fs.existsSync(indexPath) || !fs.existsSync(metaPath)) {
    logger.log('[ANN] No persisted index found');
    return false;
  }

  let meta: IndexMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (err) {
    quarantinePersistedIndex(`meta unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!meta || !Array.isArray(meta.gameIds) || meta.gameIds.length === 0) return false;

  // Stale generation / different model: do not even load the (multi-GB) native index.
  const metaGeneration = typeof meta.layoutGeneration === 'number' ? meta.layoutGeneration : 1;
  if (metaGeneration !== ANN_LAYOUT_GENERATION) {
    logger.warn(`[ANN] Index generation ${metaGeneration} != current ${ANN_LAYOUT_GENERATION} — discarding for rebuild`);
    deletePersistedIndex();
    return false;
  }
  // modelTag is informational only: a rebuild would come from the SAME cached vectors, so discarding on a tag change
  // (e.g. 'x' vs 'x:latest') would cost a multi-hour rebuild for nothing. Model changes are the renderer's
  // migration record's job (it re-embeds), and the generation bump above is what discards an index.

  let fresh: any = null;
  try {
    fresh = newNativeIndex();
    fresh.load(indexPath);
  } catch (err) {
    fresh = null;
    collectGarbage();
    quarantinePersistedIndex(`load failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  try {
    // A persisted index from a previous embedding model / MRL setting has the
    // wrong dimension — discard it so vectors for the current dims can be added.
    const loadedDims = Number(fresh.dimensions());
    if (loadedDims !== DIMS) {
      logger.warn(`[ANN] Dimension mismatch: index has ${loadedDims}D, expected ${DIMS}D — rebuilding`);
      fresh = null;
      collectGarbage();
      deletePersistedIndex();
      return false;
    }

    // Consistency: every live id must have a vector, and no vector may sit at a
    // slot past the id map (a later add at that slot would hit a duplicate key).
    let live = 0;
    for (const id of meta.gameIds) if (id) live++;
    const size = Number(fresh.size());
    if (size < live || size > meta.gameIds.length) {
      fresh = null;
      collectGarbage();
      quarantinePersistedIndex(`size ${size} vs ${live} live ids / ${meta.gameIds.length} slots`);
      return false;
    }

    index = fresh;
    idMap = meta.gameIds;
    rebuildReverseMap();
    indexGeneration++;
    dirty = false;
    coherent = true;

    logger.log(`[ANN] Index loaded: ${idMap.length} vectors (built ${new Date(meta.builtAt).toISOString()})`);
    return true;
  } catch (err) {
    logger.error('[ANN] Failed to validate loaded index:', err);
    fresh = null;
    releaseIndex();
    quarantinePersistedIndex(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Serialise index + id map to disk atomically. Synchronous — callers throttle. */
function writeIndexNow(): boolean {
  if (!index || idMap.length === 0 || !coherent) return false;
  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();
    const tmpIndexPath = indexPath + '.tmp';

    // Index first (temp + rename), then meta. A crash between the two renames
    // leaves a NEWER index with an OLDER (shorter) id map — loadIndex detects
    // that (vectors past the map) and quarantines it so a rebuild runs.
    index.save(tmpIndexPath);
    try {
      fs.renameSync(tmpIndexPath, indexPath);
    } catch (err) {
      try { fs.unlinkSync(tmpIndexPath); } catch { /* ignore */ }
      throw err;
    }

    const meta: IndexMeta = {
      gameIds: idMap,
      vectorCount: reverseMap.size,
      builtAt: Date.now(),
      layoutGeneration: ANN_LAYOUT_GENERATION,
      ...(annModelTag ? { modelTag: annModelTag } : {}),
    };
    atomicWriteFileSync(metaPath, JSON.stringify(meta));

    dirty = false;
    lastSaveAt = Date.now();
    logger.log(`[ANN] Index saved: ${idMap.length} vectors`);
    return true;
  } catch (err) {
    logger.error('[ANN] Failed to save index:', err);
    return false;
  }
}

export interface SaveIndexOptions {
  /** Write now instead of within the 60 s window (caller writes a watermark next). */
  force?: boolean;
  /**
   * The caller just finished a full backfill from cache: the in-memory index is
   * now coherent and may be persisted. Implies `force`.
   */
  complete?: boolean;
}

/**
 * Request a save. Returns true when the index is (or will shortly be)
 * persisted: a no-op when nothing changed since the last save, an immediate
 * write when the last one is older than SAVE_MIN_INTERVAL_MS, otherwise a
 * deferred write at the end of that window. Pending changes are also flushed
 * on app quit (`flushAnnIndexSync`). Refused (false) while the index is not
 * coherent — a cleared / half-rebuilt index is never persisted.
 */
export function saveIndex(opts: SaveIndexOptions = {}): boolean {
  if (opts.complete) {
    coherent = true;
    if (!index || idMap.length === 0) return true; // empty cache — nothing to write
  }
  if (!coherent) {
    logger.log('[ANN] Save skipped — index is partial (rebuild/backfill not complete)');
    return false;
  }
  if (!index || idMap.length === 0) return false;
  if (!dirty) return true;
  const sinceLast = Date.now() - lastSaveAt;
  if (opts.force || opts.complete || sinceLast >= SAVE_MIN_INTERVAL_MS) {
    if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
    return writeIndexNow();
  }
  if (!deferredSaveTimer) {
    deferredSaveTimer = setTimeout(() => {
      deferredSaveTimer = null;
      if (dirty && coherent) writeIndexNow();
    }, SAVE_MIN_INTERVAL_MS - sinceLast);
    deferredSaveTimer.unref?.();
  }
  return true;
}

/** Write any unsaved changes immediately (app quit). Never persists a partial index. */
export function flushAnnIndexSync(): void {
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
  if (dirty && coherent) writeIndexNow();
}

try {
  app?.on?.('before-quit', () => {
    try { flushAnnIndexSync(); } catch (err) { logger.error('[ANN] Flush on quit failed:', err); }
  });
} catch { /* not running under Electron (tests) */ }

type UpsertResult = 'added' | 'replaced' | 'invalid' | 'failed';

/**
 * Insert or replace one vector. The id maps are committed only after the
 * native `add` succeeded, so a throwing add (duplicate key, OOM reserve) can
 * never leave a map entry pointing at a missing or foreign vector.
 * Single-vector adds pass threads=1: the binding's default (0 = hardware
 * concurrency) spun up a full worker pool for every one-vector add.
 */
function upsertOne(entry: { id: string; vector: ArrayLike<number> }): UpsertResult {
  if (!index) return 'failed';
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return 'invalid';
  const prepared = prepareAnnVector(entry.vector);
  if (!prepared) return 'invalid';

  const existingSlot = reverseMap.get(entry.id);
  if (existingSlot !== undefined) {
    let removed = false;
    try { index.remove(BigInt(existingSlot)); removed = true; } catch { /* usearch version without remove */ }
    if (removed) {
      try {
        index.add(BigInt(existingSlot), prepared, 1);
      } catch (err) {
        // The old vector is already gone — vacate the slot so the maps never
        // reference a key the native index no longer holds.
        idMap[existingSlot] = '';
        reverseMap.delete(entry.id);
        dirty = true;
        logger.warn(`[ANN] Re-add failed for ${entry.id} (slot ${existingSlot}) — dropped:`, err);
        return 'failed';
      }
      dirty = true;
      return 'replaced';
    }
    // remove() unavailable — append at a fresh slot, then vacate the old one
    // (only once the add succeeded) so queries never return the stale vector.
    const newSlot = idMap.length;
    try {
      index.add(BigInt(newSlot), prepared, 1);
    } catch (err) {
      logger.warn(`[ANN] Add failed for ${entry.id} (slot ${newSlot}):`, err);
      return 'failed';
    }
    idMap[existingSlot] = '';
    idMap.push(entry.id);
    reverseMap.set(entry.id, newSlot);
    dirty = true;
    return 'replaced';
  }

  const slot = idMap.length;
  try {
    index.add(BigInt(slot), prepared, 1);
  } catch (err) {
    // If the slot key already exists natively, burn it so the next add can't collide again.
    try {
      if (index.contains(BigInt(slot))) { idMap.push(''); dirty = true; }
    } catch { /* ignore */ }
    logger.warn(`[ANN] Add failed for ${entry.id} (slot ${slot}):`, err);
    return 'failed';
  }
  idMap.push(entry.id);
  reverseMap.set(entry.id, slot);
  dirty = true;
  return 'added';
}

export interface AddVectorsResult {
  /** NEW ids inserted (replacements not counted — matches the old numeric return). */
  added: number;
  /** Replaced existing ids. */
  replaced: number;
  /** Rejected (bad id / wrong length / non-finite) or failed native adds. */
  failed: number;
  /** True when the index was cleared/replaced mid-call — the rest of `entries` was NOT applied. */
  aborted: boolean;
}

/**
 * Add/replace vectors in slices of ADD_SLICE, yielding the main-process event
 * loop (setImmediate) between slices so a large backfill batch never blocks
 * window input / other IPC for its whole duration. Stops early (aborted) if
 * the index is cleared or rebuilt (dims change) while it is yielding.
 */
export async function addVectors(
  entries: Array<{ id: string; vector: ArrayLike<number> }>,
): Promise<AddVectorsResult> {
  const result: AddVectorsResult = { added: 0, replaced: 0, failed: 0, aborted: false };
  if (!Index || !Array.isArray(entries) || entries.length === 0) return result;
  if (!index) {
    // A write can reach main before the renderer's ann:load (safe mode skips it entirely).
    // Load the persisted index first — creating an empty one here meant the file was never
    // loaded and the next pass rebuilt hundreds of thousands of vectors from cache.
    if (!loadIndex() && !index) {
      syncAnnDimsFromSettings();
      createIndex(); // implicitly created ⇒ not coherent until a backfill completes
    }
  }
  const gen = indexGeneration;

  for (let i = 0; i < entries.length; i += ADD_SLICE) {
    if (gen !== indexGeneration || !index) { result.aborted = true; break; }
    const end = Math.min(i + ADD_SLICE, entries.length);
    for (let j = i; j < end; j++) {
      let r: UpsertResult;
      try { r = upsertOne(entries[j]); } catch { r = 'failed'; }
      if (r === 'added') result.added++;
      else if (r === 'replaced') result.replaced++;
      else result.failed++;
    }
    if (end < entries.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  if (result.failed > 0) {
    logger.warn(`[ANN] addVectors: ${result.failed}/${entries.length} vectors rejected or failed`);
  }
  return result;
}

export function query(
  centroid: ArrayLike<number>,
  k: number,
  excludeId?: string,
): Array<{ id: string; distance: number }> {
  if (!index || idMap.length === 0 || !Index) return [];

  const effectiveK = Math.min(k + (excludeId ? 1 : 0), idMap.length);
  if (effectiveK <= 0) return [];

  const prepared = prepareAnnVector(centroid);
  if (!prepared) return [];
  const result = index.search(prepared, effectiveK);

  const results: Array<{ id: string; distance: number }> = [];
  for (let i = 0; i < result.keys.length; i++) {
    const slot = Number(result.keys[i]);
    if (slot >= 0 && slot < idMap.length && idMap[slot]) {
      const id = idMap[slot];
      if (excludeId && id === excludeId) continue;
      results.push({ id, distance: result.distances[i] });
      if (results.length >= k) break;
    }
  }

  return results;
}

export function getStatus(): {
  ready: boolean; vectorCount: number; dims: number; partial: boolean; layoutGeneration: number; modelTag: string;
} {
  return {
    ready: index !== null && reverseMap.size > 0,
    vectorCount: reverseMap.size,
    dims: DIMS,
    layoutGeneration: ANN_LAYOUT_GENERATION,
    modelTag: annModelTag,
    // Renderer runs a backfill when this is true (cleared / half-built / never loaded).
    partial: !coherent,
  };
}

/**
 * Batch query: for each given vector, find K nearest neighbors.
 * Returns results keyed by the provided game IDs.
 */
export function queryBatch(
  entries: Array<{ id: string; vector: ArrayLike<number> }>,
  k: number,
): Record<string, Array<{ id: string; distance: number }>> {
  if (!index || idMap.length === 0 || !Index) return {};

  const effectiveK = Math.min(k + 1, idMap.length);
  const results: Record<string, Array<{ id: string; distance: number }>> = {};

  for (const entry of entries) {
    const prepared = prepareAnnVector(entry.vector);
    if (!prepared) continue;
    const searchResult = index.search(prepared, effectiveK);

    const neighbors: Array<{ id: string; distance: number }> = [];
    for (let i = 0; i < searchResult.keys.length; i++) {
      const slot = Number(searchResult.keys[i]);
      if (slot >= 0 && slot < idMap.length && idMap[slot]) {
        const neighborId = idMap[slot];
        if (neighborId !== entry.id) {
          neighbors.push({ id: neighborId, distance: searchResult.distances[i] });
        }
      }
    }
    results[entry.id] = neighbors;
  }

  return results;
}

/** Drop the in-memory index (releasing native memory first) and delete the persisted files. */
export function clearIndex(): void {
  releaseIndex();
  deletePersistedIndex();
}

/** Test-only: reset module state and inject a fake usearch implementation. */
export function __resetAnnIndexForTests(
  fake?: { Index: any; MetricKind?: any; ScalarKind?: any; userDataDir?: string },
): void {
  annModelTag = '';
  userDataDirOverride = fake?.userDataDir ?? null;
  if (fake) {
    Index = fake.Index;
    MetricKind = fake.MetricKind ?? { Cos: 'cos' };
    ScalarKind = fake.ScalarKind ?? { F32: 'f32' };
  }
  index = null;
  idMap = [];
  reverseMap = new Map();
  indexGeneration++;
  dirty = false;
  coherent = false;
  lastSaveAt = 0;
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
}
