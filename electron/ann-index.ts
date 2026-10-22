/**
 * ANN Index Manager (Main Process)
 *
 * Manages an HNSW approximate nearest-neighbor index via usearch.
 * Persists the index + ID mapping to disk in the app's userData directory.
 * Exposed to the renderer via IPC handlers in ann-handlers.ts.
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

/** Sync DIMS from settings; clears in-memory index when dims change. */
export function syncAnnDimsFromSettings(): number {
  const next = resolveDimsFromSettings();
  if (next !== DIMS) {
    logger.log(`[ANN] Dims ${DIMS} → ${next} (MRL flag)`);
    DIMS = next;
    // Drop in-memory index so load/rebuild uses the new dimensionality.
    index = null;
    idMap = [];
    reverseMap.clear();
    indexGeneration++;
    dirty = false;
  } else {
    DIMS = next;
  }
  return DIMS;
}

export function getAnnDims(): number {
  return DIMS;
}

function prepareAnnVector(vector: number[]): Float32Array | null {
  if (vector.length < DIMS) return null;
  if (vector.length === DIMS) return new Float32Array(vector);
  // MRL: take prefix and L2-renorm
  const out = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    out[i] = vector[i];
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    const inv = 1 / norm;
    for (let i = 0; i < DIMS; i++) out[i] *= inv;
  }
  return out;
}

function getIndexPath(): string {
  return path.join(app.getPath('userData'), 'ann-hnsw.usearch');
}

function getMetaPath(): string {
  return path.join(app.getPath('userData'), 'ann-hnsw-meta.json');
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
}

let index: InstanceType<typeof Index> | null = null;
let idMap: string[] = [];
let reverseMap = new Map<string, number>();
/** Bumped whenever the in-memory index is replaced/dropped — lets a yielding addVectors bail. */
let indexGeneration = 0;

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

function createIndex(): void {
  if (!Index) return;
  index = new Index(DIMS, MetricKind.Cos, ScalarKind.F32, CONNECTIVITY, EF_CONSTRUCTION, EF_SEARCH);
}

function rebuildReverseMap(): void {
  reverseMap.clear();
  for (let i = 0; i < idMap.length; i++) {
    if (idMap[i]) reverseMap.set(idMap[i], i);
  }
}

export function loadIndex(): boolean {
  if (!Index) return false;
  try {
    syncAnnDimsFromSettings();
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();

    if (!fs.existsSync(indexPath) || !fs.existsSync(metaPath)) {
      logger.log('[ANN] No persisted index found');
      return false;
    }

    const meta: IndexMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (!meta.gameIds || meta.gameIds.length === 0) return false;

    createIndex();
    index!.load(indexPath);

    // Verify the loaded index has the expected dimension. A persisted index
    // from a previous embedding model (e.g. nomic 768-dim) will have the
    // wrong dimension — discard it so vectors from the current model can be added.
    const loadedDims = Number(index!.dimensions());
    if (loadedDims !== DIMS) {
      logger.warn(`[ANN] Dimension mismatch: index has ${loadedDims}D, expected ${DIMS}D — rebuilding`);
      clearIndex();
      return false;
    }

    idMap = meta.gameIds;
    rebuildReverseMap();
    indexGeneration++;
    dirty = false;

    logger.log(`[ANN] Index loaded: ${idMap.length} vectors (built ${new Date(meta.builtAt).toISOString()})`);
    return true;
  } catch (err) {
    logger.error('[ANN] Failed to load index:', err);
    index = null;
    idMap = [];
    reverseMap.clear();
    return false;
  }
}

/** Serialise index + id map to disk atomically. Synchronous — callers throttle. */
function writeIndexNow(): boolean {
  if (!index || idMap.length === 0) return false;
  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();
    const tmpIndexPath = indexPath + '.tmp';

    // Index first (temp + rename), then meta. A crash between the two renames
    // leaves a NEWER index with an OLDER (shorter) id map — harmless, since
    // query() ignores slots past idMap.length. The reverse order could leave
    // meta pointing at slots the on-disk index doesn't have.
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

/**
 * Request a save. Returns true when the index is (or will shortly be)
 * persisted: a no-op when nothing changed since the last save, an immediate
 * write when the last one is older than SAVE_MIN_INTERVAL_MS, otherwise a
 * deferred write at the end of that window. Pending changes are also flushed
 * on app quit (`flushAnnIndexSync`).
 */
export function saveIndex(opts: { force?: boolean } = {}): boolean {
  if (!index || idMap.length === 0) return false;
  if (!dirty) return true;
  const sinceLast = Date.now() - lastSaveAt;
  // `force`: end of an embedding pass — the caller writes a watermark next, so the vectors must
  // be on disk first (a crash inside the deferral window would otherwise lose them for good).
  if (opts.force || sinceLast >= SAVE_MIN_INTERVAL_MS) {
    if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
    return writeIndexNow();
  }
  if (!deferredSaveTimer) {
    deferredSaveTimer = setTimeout(() => {
      deferredSaveTimer = null;
      if (dirty) writeIndexNow();
    }, SAVE_MIN_INTERVAL_MS - sinceLast);
    deferredSaveTimer.unref?.();
  }
  return true;
}

/** Write any unsaved changes immediately (app quit). */
export function flushAnnIndexSync(): void {
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
  if (dirty) writeIndexNow();
}

try {
  app?.on?.('before-quit', () => {
    try { flushAnnIndexSync(); } catch (err) { logger.error('[ANN] Flush on quit failed:', err); }
  });
} catch { /* not running under Electron (tests) */ }

/** Insert or replace one vector. Returns true when a NEW id was added. */
function upsertOne(entry: { id: string; vector: number[] }): boolean {
  const prepared = prepareAnnVector(entry.vector);
  if (!prepared) return false;

  const existingSlot = reverseMap.get(entry.id);
  if (existingSlot !== undefined) {
    let removed = false;
    try { index!.remove(BigInt(existingSlot)); removed = true; } catch { /* usearch version without remove */ }
    if (removed) {
      index!.add(BigInt(existingSlot), prepared);
    } else {
      // remove() unavailable — append at a fresh slot and vacate the old one
      // so query results don't return the stale vector under the old slot
      idMap[existingSlot] = '';
      const newSlot = idMap.length;
      idMap.push(entry.id);
      reverseMap.set(entry.id, newSlot);
      index!.add(BigInt(newSlot), prepared);
    }
    dirty = true;
    return false;
  }

  const slot = idMap.length;
  idMap.push(entry.id);
  reverseMap.set(entry.id, slot);
  index!.add(BigInt(slot), prepared);
  dirty = true;
  return true;
}

/**
 * Add/replace vectors in slices of ADD_SLICE, yielding the main-process event
 * loop (setImmediate) between slices so a large backfill batch never blocks
 * window input / other IPC for its whole duration. Stops early if the index
 * is cleared or rebuilt (dims change) while it is yielding.
 */
export async function addVectors(entries: Array<{ id: string; vector: number[] }>): Promise<number> {
  if (!Index) return 0;
  if (!index) {
    syncAnnDimsFromSettings();
    createIndex();
  }
  const gen = indexGeneration;

  let added = 0;
  for (let i = 0; i < entries.length; i += ADD_SLICE) {
    if (gen !== indexGeneration || !index) break;
    const end = Math.min(i + ADD_SLICE, entries.length);
    for (let j = i; j < end; j++) {
      if (upsertOne(entries[j])) added++;
    }
    if (end < entries.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return added;
}

export function query(
  centroid: number[],
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

export function getStatus(): { ready: boolean; vectorCount: number; dims: number } {
  return {
    ready: index !== null && reverseMap.size > 0,
    vectorCount: reverseMap.size,
    dims: DIMS,
  };
}

/**
 * Batch query: for each given vector, find K nearest neighbors.
 * Returns results keyed by the provided game IDs.
 */
export function queryBatch(
  entries: Array<{ id: string; vector: number[] }>,
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

export function clearIndex(): void {
  index = null;
  idMap = [];
  reverseMap.clear();
  indexGeneration++;
  dirty = false;
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }

  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch { /* ignore cleanup errors */ }
}
