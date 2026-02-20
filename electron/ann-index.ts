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

const DIMS = 768;
const CONNECTIVITY = 16;
const EF_CONSTRUCTION = 200;
const EF_SEARCH = 128;

function getIndexPath(): string {
  return path.join(app.getPath('userData'), 'ann-hnsw.usearch');
}

function getMetaPath(): string {
  return path.join(app.getPath('userData'), 'ann-hnsw-meta.json');
}

interface IndexMeta {
  gameIds: string[];
  vectorCount: number;
  builtAt: number;
}

let index: InstanceType<typeof Index> | null = null;
let idMap: string[] = [];
let reverseMap = new Map<string, number>();

function createIndex(): void {
  if (!Index) return;
  index = new Index(DIMS, MetricKind.Cos, ScalarKind.F32, CONNECTIVITY, EF_CONSTRUCTION, EF_SEARCH);
}

function rebuildReverseMap(): void {
  reverseMap.clear();
  for (let i = 0; i < idMap.length; i++) {
    reverseMap.set(idMap[i], i);
  }
}

export function loadIndex(): boolean {
  if (!Index) return false;
  try {
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
    idMap = meta.gameIds;
    rebuildReverseMap();

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

export function saveIndex(): boolean {
  if (!index || idMap.length === 0) return false;
  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();

    index.save(indexPath);

    const meta: IndexMeta = {
      gameIds: idMap,
      vectorCount: idMap.length,
      builtAt: Date.now(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

    logger.log(`[ANN] Index saved: ${idMap.length} vectors`);
    return true;
  } catch (err) {
    logger.error('[ANN] Failed to save index:', err);
    return false;
  }
}

export function addVectors(entries: Array<{ id: string; vector: number[] }>): number {
  if (!Index) return 0;
  if (!index) createIndex();

  let added = 0;
  for (const entry of entries) {
    if (entry.vector.length !== DIMS) continue;

    const existingSlot = reverseMap.get(entry.id);
    if (existingSlot !== undefined) {
      try { index!.remove(BigInt(existingSlot)); } catch { /* usearch version without remove */ }
      index!.add(BigInt(existingSlot), new Float32Array(entry.vector));
      continue;
    }

    const slot = idMap.length;
    idMap.push(entry.id);
    reverseMap.set(entry.id, slot);
    index!.add(BigInt(slot), new Float32Array(entry.vector));
    added++;
  }

  return added;
}

export function query(centroid: number[], k: number): Array<{ id: string; distance: number }> {
  if (!index || idMap.length === 0 || !Index) return [];

  const effectiveK = Math.min(k, idMap.length);
  if (effectiveK <= 0) return [];

  const vec = new Float32Array(centroid);
  const result = index.search(vec, effectiveK, 0);

  const results: Array<{ id: string; distance: number }> = [];
  for (let i = 0; i < result.keys.length; i++) {
    const slot = Number(result.keys[i]);
    if (slot >= 0 && slot < idMap.length) {
      results.push({ id: idMap[slot], distance: result.distances[i] });
    }
  }

  return results;
}

export function getStatus(): { ready: boolean; vectorCount: number; dims: number } {
  return {
    ready: index !== null && idMap.length > 0,
    vectorCount: idMap.length,
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
    if (entry.vector.length !== DIMS) continue;
    const vec = new Float32Array(entry.vector);
    const searchResult = index.search(vec, effectiveK, 0);

    const neighbors: Array<{ id: string; distance: number }> = [];
    for (let i = 0; i < searchResult.keys.length; i++) {
      const slot = Number(searchResult.keys[i]);
      if (slot >= 0 && slot < idMap.length) {
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

  try {
    const indexPath = getIndexPath();
    const metaPath = getMetaPath();
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch { /* ignore cleanup errors */ }
}
