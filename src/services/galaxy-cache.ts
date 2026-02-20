/**
 * Galaxy Cache — persistent cache + background precomputation for
 * the Embedding Space visualization.
 *
 * Stores PCA-projected positions and node metadata in IndexedDB so
 * repeat visits to Embedding Space load instantly. A background
 * precompute runs once ~20 s after app startup to keep the cache warm.
 * On subsequent opens, only incremental changes (new embeddings) trigger
 * a recompute.
 */

import { loadAllEmbeddingsForGraph, getEmbeddingCount, embeddingService } from '@/services/embedding-service';
import { journeyStore } from '@/services/journey-store';
import { libraryStore } from '@/services/library-store';
import { catalogStore } from '@/services/catalog-store';
import type { CatalogEntry } from '@/types/catalog';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  genres: string[];
  developer: string;
  coverUrl?: string;
  isLibrary: boolean;
  hoursPlayed: number;
  x: number;
  y: number;
  z: number;
  colorIdx: number;
}

export interface NeighborInfo {
  id: string;
  distance: number;
  node?: GraphNode;
}

// ─── Genre → color palette (NMS-style warm/cool star colors) ────────────────

export const GENRE_PALETTE: [number, number, number][] = [
  [1.0, 0.35, 0.22],   // 0: Action — warm red-orange
  [1.0, 0.72, 0.18],   // 1: Adventure — gold
  [0.72, 0.28, 1.0],   // 2: RPG — violet
  [0.25, 0.55, 1.0],   // 3: Strategy — blue
  [0.22, 0.92, 0.45],  // 4: Simulation — green
  [0.35, 0.95, 0.85],  // 5: Indie — teal
  [1.0, 0.50, 0.72],   // 6: Casual — pink
  [0.95, 0.62, 0.12],  // 7: Sports/Racing — orange
  [0.45, 0.72, 1.0],   // 8: Puzzle — light blue
  [0.85, 0.15, 0.25],  // 9: Horror — crimson
  [0.55, 0.35, 0.95],  // 10: MMO — indigo
  [0.65, 0.85, 0.25],  // 11: Survival — lime
  [0.88, 0.75, 0.50],  // 12: default — warm amber
];

const GENRE_MAP: Record<string, number> = {
  action: 0, shooter: 0, fighting: 0,
  adventure: 1, platformer: 1, 'visual novel': 1,
  rpg: 2, 'role-playing': 2, jrpg: 2,
  strategy: 3, 'real-time strategy': 3, 'turn-based': 3, 'city builder': 3, 'tower defense': 3,
  simulation: 4, management: 4, building: 4,
  indie: 5,
  casual: 6,
  sports: 7, racing: 7,
  puzzle: 8,
  horror: 9, 'psychological horror': 9,
  mmo: 10, mmorpg: 10, 'massively multiplayer': 10,
  survival: 11, sandbox: 11, 'open world': 11,
};

export function genreToColorIdx(genres: string[]): number {
  for (const g of genres) {
    const idx = GENRE_MAP[g.toLowerCase()];
    if (idx !== undefined) return idx;
  }
  return 12;
}

// ─── PCA: WebGPU-accelerated with CPU fallback ─────────────────────────────

function centerData(data: Float32Array, n: number, d: number): Float32Array {
  const mean = new Float32Array(d);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < d; j++) mean[j] += data[i * d + j];
  for (let j = 0; j < d; j++) mean[j] /= n;

  const centered = new Float32Array(n * d);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < d; j++) centered[i * d + j] = data[i * d + j] - mean[j];
  return centered;
}

function validatePositions(pos: Float32Array, n: number): boolean {
  if (n < 2) return n > 0;
  let hasVariance = false;
  const first = [pos[0], pos[1], pos[2]];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a];
      if (!isFinite(v)) return false;
      if (Math.abs(v - first[a]) > 1e-6) hasVariance = true;
    }
  }
  return hasVariance;
}

async function computePCA_WebGPU(
  centered: Float32Array,
  n: number,
  d: number,
): Promise<Float32Array | null> {
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;

    const requiredSize = n * d * 4;
    const maxBuf = adapter.limits.maxStorageBufferBindingSize;
    if (requiredSize > maxBuf) {
      console.log(`[PCA-GPU] Data ${(requiredSize / 1e6).toFixed(0)}MB > limit ${(maxBuf / 1e6).toFixed(0)}MB, falling back`);
      return null;
    }

    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: Math.min(requiredSize + 4096, maxBuf) },
    });

    let gpuLost = false;
    device.lost.then(() => { gpuLost = true; });

    const dataBuf = device.createBuffer({ size: centered.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(dataBuf, 0, centered.buffer, centered.byteOffset, centered.byteLength);

    const vecBuf = device.createBuffer({ size: d * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outForward = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const wBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBackward = device.createBuffer({ size: d * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: d * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const readForward = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const WG = 256;

    const fwdShader = device.createShaderModule({ code: /* wgsl */ `
      @group(0) @binding(0) var<storage,read> matrix: array<f32>;
      @group(0) @binding(1) var<storage,read> vec: array<f32>;
      @group(0) @binding(2) var<storage,read_write> out: array<f32>;
      @compute @workgroup_size(${WG})
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let row = gid.x;
        if (row >= ${n}u) { return; }
        var s: f32 = 0.0;
        let off = row * ${d}u;
        for (var j = 0u; j < ${d}u; j = j + 1u) { s = s + matrix[off + j] * vec[j]; }
        out[row] = s;
      }
    ` });

    const bwdShader = device.createShaderModule({ code: /* wgsl */ `
      @group(0) @binding(0) var<storage,read> matrix: array<f32>;
      @group(0) @binding(1) var<storage,read> w: array<f32>;
      @group(0) @binding(2) var<storage,read_write> out: array<f32>;
      var<workgroup> shared_mem: array<f32, ${WG}>;
      @compute @workgroup_size(${WG})
      fn main(@builtin(local_invocation_id) lid: vec3<u32>,
              @builtin(workgroup_id) wid: vec3<u32>) {
        let col = wid.x;
        if (col >= ${d}u) { return; }
        let tid = lid.x;
        var s: f32 = 0.0;
        for (var i = tid; i < ${n}u; i = i + ${WG}u) {
          s = s + matrix[i * ${d}u + col] * w[i];
        }
        shared_mem[tid] = s;
        workgroupBarrier();
        var stride: u32 = ${WG / 2}u;
        loop {
          if (stride == 0u) { break; }
          if (tid < stride) { shared_mem[tid] = shared_mem[tid] + shared_mem[tid + stride]; }
          workgroupBarrier();
          stride = stride / 2u;
        }
        if (tid == 0u) { out[col] = shared_mem[0]; }
      }
    ` });

    const fwdInfo = await fwdShader.getCompilationInfo();
    const bwdInfo = await bwdShader.getCompilationInfo();
    const hasShaderError = [...fwdInfo.messages, ...bwdInfo.messages].some(m => m.type === 'error');
    if (hasShaderError) {
      console.warn('[PCA-GPU] Shader compilation errors, falling back to CPU');
      device.destroy();
      return null;
    }

    const fwdLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });

    const fwdPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [fwdLayout] }), compute: { module: fwdShader, entryPoint: 'main' } });
    const bwdPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [fwdLayout] }), compute: { module: bwdShader, entryPoint: 'main' } });

    const fwdBG = device.createBindGroup({ layout: fwdLayout, entries: [
      { binding: 0, resource: { buffer: dataBuf } },
      { binding: 1, resource: { buffer: vecBuf } },
      { binding: 2, resource: { buffer: outForward } },
    ] });
    const bwdBG = device.createBindGroup({ layout: fwdLayout, entries: [
      { binding: 0, resource: { buffer: dataBuf } },
      { binding: 1, resource: { buffer: wBuf } },
      { binding: 2, resource: { buffer: outBackward } },
    ] });

    const PCs: Float32Array[] = [];
    const ITERS = 30;

    for (let pc = 0; pc < 3; pc++) {
      let v = new Float32Array(d);
      for (let j = 0; j < d; j++) v[j] = Math.random() - 0.5;

      for (let iter = 0; iter < ITERS; iter++) {
        if (gpuLost) throw new Error('GPU device lost');

        device.queue.writeBuffer(vecBuf, 0, v.buffer, v.byteOffset, v.byteLength);
        let enc = device.createCommandEncoder();
        let pass = enc.beginComputePass();
        pass.setPipeline(fwdPipeline);
        pass.setBindGroup(0, fwdBG);
        pass.dispatchWorkgroups(Math.ceil(n / WG));
        pass.end();
        enc.copyBufferToBuffer(outForward, 0, wBuf, 0, n * 4);
        device.queue.submit([enc.finish()]);

        enc = device.createCommandEncoder();
        pass = enc.beginComputePass();
        pass.setPipeline(bwdPipeline);
        pass.setBindGroup(0, bwdBG);
        pass.dispatchWorkgroups(d);
        pass.end();
        enc.copyBufferToBuffer(outBackward, 0, readBuf, 0, d * 4);
        device.queue.submit([enc.finish()]);

        await readBuf.mapAsync(GPUMapMode.READ);
        v = new Float32Array(readBuf.getMappedRange().slice(0));
        readBuf.unmap();

        for (const prev of PCs) {
          let dot = 0;
          for (let j = 0; j < d; j++) dot += v[j] * prev[j];
          for (let j = 0; j < d; j++) v[j] -= dot * prev[j];
        }

        let mag = 0;
        for (let j = 0; j < d; j++) mag += v[j] * v[j];
        mag = Math.sqrt(mag);
        if (mag > 0) for (let j = 0; j < d; j++) v[j] /= mag;
      }
      PCs.push(v);
    }

    const positions = new Float32Array(n * 3);
    for (let c = 0; c < 3; c++) {
      const pcVec = PCs[c];
      device.queue.writeBuffer(vecBuf, 0, pcVec.buffer, pcVec.byteOffset, pcVec.byteLength);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(fwdPipeline);
      pass.setBindGroup(0, fwdBG);
      pass.dispatchWorkgroups(Math.ceil(n / WG));
      pass.end();
      enc.copyBufferToBuffer(outForward, 0, readForward, 0, n * 4);
      device.queue.submit([enc.finish()]);

      await readForward.mapAsync(GPUMapMode.READ);
      const proj = new Float32Array(readForward.getMappedRange().slice(0));
      readForward.unmap();

      for (let i = 0; i < n; i++) positions[i * 3 + c] = proj[i];
    }

    device.destroy();

    if (!validatePositions(positions, n)) {
      console.warn('[PCA-GPU] Output positions degenerate, falling back to CPU');
      return null;
    }

    console.log(`[PCA-GPU] Completed for ${n} vectors`);
    return positions;
  } catch (err) {
    console.warn('[PCA-GPU] Failed, falling back to CPU:', err);
    return null;
  }
}

function computePCA_CPU(centered: Float32Array, n: number, d: number): Float32Array {
  const PCs: Float32Array[] = [];
  const ITERS = 30;
  const w = new Float32Array(n);

  for (let pc = 0; pc < 3; pc++) {
    const v = new Float32Array(d);
    for (let j = 0; j < d; j++) v[j] = Math.random() - 0.5;

    for (let iter = 0; iter < ITERS; iter++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        const off = i * d;
        for (let j = 0; j < d; j++) s += centered[off + j] * v[j];
        w[i] = s;
      }
      v.fill(0);
      for (let i = 0; i < n; i++) {
        const wi = w[i];
        const off = i * d;
        for (let j = 0; j < d; j++) v[j] += centered[off + j] * wi;
      }
      for (const prev of PCs) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += v[j] * prev[j];
        for (let j = 0; j < d; j++) v[j] -= dot * prev[j];
      }
      let mag = 0;
      for (let j = 0; j < d; j++) mag += v[j] * v[j];
      mag = Math.sqrt(mag);
      if (mag > 0) for (let j = 0; j < d; j++) v[j] /= mag;
    }
    PCs.push(new Float32Array(v));
  }

  const positions = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const pcv = PCs[c];
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += centered[off + j] * pcv[j];
      positions[i * 3 + c] = s;
    }
  }

  console.log(`[PCA-CPU] Completed for ${n} vectors`);
  return positions;
}

// ─── Worker-based CPU PCA (non-blocking) ────────────────────────────────────

function runPCAWorker(
  data: Float32Array,
  n: number,
  d: number,
  spread: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/pca.worker.ts', import.meta.url),
      { type: 'module', name: 'Ark PCA Worker' },
    );

    worker.onmessage = (e: MessageEvent<{ positions: Float32Array; valid: boolean }>) => {
      worker.terminate();
      if (!e.data.valid) {
        console.warn('[PCA Worker] Output positions degenerate');
      }
      resolve(e.data.positions);
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(`PCA Worker failed: ${err.message}`));
    };

    worker.postMessage({ data, n, d, spread });
  });
}

/**
 * Run PCA on the embedding data.
 *
 * Strategy:
 *   1. If WebGPU is available, center data on main thread and run GPU PCA
 *      (async — GPU does the heavy lifting, main thread stays responsive).
 *   2. Otherwise, offload the entire pipeline (center + PCA + normalize) to
 *      a dedicated Web Worker so the UI never freezes.
 *   3. Last resort: if the worker fails, run synchronously on main thread.
 */
async function computePCA(
  data: Float32Array,
  n: number,
  d: number,
  spread: number,
): Promise<Float32Array> {
  // WebGPU path — centering is synchronous but fast, PCA is async on GPU
  if (navigator.gpu) {
    const centered = centerData(data, n, d);
    const gpuResult = await computePCA_WebGPU(centered, n, d);
    if (gpuResult) {
      normalizePositions(gpuResult, n, spread);
      return gpuResult;
    }
  }

  // CPU fallback via Web Worker (non-blocking)
  try {
    return await runPCAWorker(data, n, d, spread);
  } catch (err) {
    console.warn('[PCA] Worker failed, falling back to main thread:', err);
    const centered = centerData(data, n, d);
    const positions = computePCA_CPU(centered, n, d);
    normalizePositions(positions, n, spread);
    return positions;
  }
}

function normalizePositions(pos: Float32Array, n: number, spread: number): void {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a];
      if (v < mins[a]) mins[a] = v;
      if (v > maxs[a]) maxs[a] = v;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const range = maxs[a] - mins[a];
      pos[i * 3 + a] = range > 0
        ? ((pos[i * 3 + a] - mins[a]) / range - 0.5) * 2 * spread
        : 0;
    }
  }
}

// ─── Galaxy data building ───────────────────────────────────────────────────

export type GalaxyStepReporter = (
  stepIndex: number,
  status: 'running' | 'done' | 'waiting',
  detail?: string,
) => void;

export const GALAXY_STEP_LABELS = [
  'Loading all embedding vectors',
  'Loading game metadata',
  'Reducing dimensions (PCA 768D → 3D)',
  'Building galaxy map',
];

export async function buildGalaxyData(
  onStep?: GalaxyStepReporter,
): Promise<{ nodes: GraphNode[]; allGenres: string[] }> {
  const report = onStep ?? (() => {});

  report(0, 'running');
  const { ids, data, dim } = await loadAllEmbeddingsForGraph((count, store) => {
    report(0, 'running', `${count.toLocaleString()} from ${store}`);
  });
  const n = ids.length;
  if (n === 0) {
    report(0, 'done', '0 vectors');
    return { nodes: [], allGenres: [] };
  }
  report(0, 'done', `${n.toLocaleString()} vectors`);

  report(1, 'running');
  const libraryIds = new Set(journeyStore.getAllEntries().map(e => e.gameId));
  const catalogAppIds: number[] = [];
  for (const id of ids) {
    if (!libraryIds.has(id)) {
      const m = id.match(/^steam-(\d+)$/);
      if (m) catalogAppIds.push(Number(m[1]));
    }
  }
  const catalogMetaMap = new Map<number, CatalogEntry>();
  if (catalogAppIds.length > 0) {
    const CHUNK = 5000;
    for (let i = 0; i < catalogAppIds.length; i += CHUNK) {
      const chunk = catalogAppIds.slice(i, i + CHUNK);
      const entries = await catalogStore.getEntries(chunk);
      for (const e of entries) catalogMetaMap.set(e.appid, e);
      report(1, 'running', `${Math.min(i + CHUNK, catalogAppIds.length).toLocaleString()} / ${catalogAppIds.length.toLocaleString()}`);
    }
  }
  report(1, 'done', `${libraryIds.size} library + ${catalogMetaMap.size.toLocaleString()} catalog`);
  await new Promise(r => setTimeout(r, 30));

  report(2, 'running');
  const hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  const pcaMethod = hasGPU ? 'WebGPU' : 'CPU (Worker)';
  report(2, 'running', pcaMethod);
  await new Promise(r => setTimeout(r, 50));
  const positions = await computePCA(data, n, dim, 400);
  report(2, 'done', pcaMethod);
  await new Promise(r => setTimeout(r, 0));

  report(3, 'running');
  const allGenresSet = new Set<string>();
  const nodes: GraphNode[] = [];

  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const isLib = libraryIds.has(id);
    const journey = isLib ? journeyStore.getEntry(id) : null;
    // Always check the library store — a game might have cachedMeta even
    // without a journey entry (e.g. removed from library, or journey creation
    // failed but the library entry still exists).
    const libEntry = libraryStore.getEntry(id);

    let title = id;
    let genres: string[] = [];
    let developer = '';
    let coverUrl: string | undefined;

    if (journey) {
      title = journey.title ?? id;
      genres = journey.genre ?? [];
      coverUrl = journey.coverUrl;
    }

    const meta = libEntry?.cachedMeta;
    if (meta) {
      if (title === id && meta.title) title = meta.title;
      if (genres.length === 0 && meta.genre?.length) genres = meta.genre;
      if (!coverUrl && meta.coverUrl) coverUrl = meta.coverUrl;
      if (!coverUrl && meta.headerImage) coverUrl = meta.headerImage;
      if (!developer && meta.developer) developer = meta.developer;
    }

    // Non-library Steam games: look up from the catalog
    const steamMatch = id.match(/^steam-(\d+)$/);
    if (!isLib && steamMatch) {
      const appid = Number(steamMatch[1]);
      const cat = catalogMetaMap.get(appid);
      if (cat) {
        if (title === id) title = cat.name;
        if (genres.length === 0) genres = cat.genres;
        if (!developer) developer = cat.developer;
      }
    }

    // Cover URL fallback from Steam CDN for any steam-prefixed ID
    if (!coverUrl && steamMatch) {
      coverUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${steamMatch[1]}/header.jpg`;
    }

    // Epic cover URL fallback from library store screenshots/header
    if (!coverUrl && id.startsWith('epic-') && meta) {
      if (meta.headerImage) coverUrl = meta.headerImage;
    }

    // Clean up remaining stub titles (no metadata found anywhere)
    if (title === id) {
      if (steamMatch) {
        title = `Unknown Game (${steamMatch[1]})`;
      } else if (id.startsWith('epic-')) {
        title = `Unknown Game (Epic)`;
      }
    }

    genres.forEach(g => allGenresSet.add(g));

    nodes.push({
      id,
      title,
      genres,
      developer,
      coverUrl,
      isLibrary: isLib,
      hoursPlayed: journey?.hoursPlayed ?? 0,
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2],
      colorIdx: genreToColorIdx(genres),
    });
  }

  report(3, 'done', `${nodes.length.toLocaleString()} nodes`);
  return { nodes, allGenres: [...allGenresSet].sort() };
}

// ─── IDB Cache ──────────────────────────────────────────────────────────────

interface CachedGalaxy {
  nodes: GraphNode[];
  allGenres: string[];
  embeddingCount: number;
  timestamp: number;
}

const CACHE_DB = 'galaxy-cache';
const CACHE_STORE = 'data';
const CACHE_KEY = 'galaxy-v2';

let _cacheDB: IDBDatabase | null = null;
let _cacheDBPromise: Promise<IDBDatabase> | null = null;

function openCacheDB(): Promise<IDBDatabase> {
  if (_cacheDB) return Promise.resolve(_cacheDB);
  if (_cacheDBPromise) return _cacheDBPromise;

  _cacheDBPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(CACHE_STORE); };
    req.onsuccess = () => {
      _cacheDB = req.result;
      _cacheDB.onclose = () => { _cacheDB = null; _cacheDBPromise = null; };
      resolve(_cacheDB);
    };
    req.onerror = () => {
      _cacheDBPromise = null;
      reject(req.error);
    };
  });
  return _cacheDBPromise;
}

export async function getCachedGalaxy(): Promise<CachedGalaxy | null> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const req = tx.objectStore(CACHE_STORE).get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveCachedGalaxy(entry: CachedGalaxy): Promise<void> {
  try {
    const db = await openCacheDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(entry, CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* non-fatal */ }
}

/**
 * Attempt to load galaxy data from cache. Returns null if the cache is
 * stale (embedding count changed) or missing.
 */
export async function loadCachedGalaxyIfFresh(): Promise<{ nodes: GraphNode[]; allGenres: string[] } | null> {
  const cached = await getCachedGalaxy();
  if (!cached || cached.nodes.length === 0) return null;

  const currentCount = await getEmbeddingCount();
  if (currentCount !== cached.embeddingCount) {
    console.log(`[Galaxy Cache] Stale — cached ${cached.embeddingCount} vs current ${currentCount}`);
    return null;
  }

  console.log(`[Galaxy Cache] Hit — ${cached.nodes.length} nodes from ${new Date(cached.timestamp).toLocaleTimeString()}`);
  return { nodes: cached.nodes, allGenres: cached.allGenres };
}

/**
 * Build fresh galaxy data and persist to cache.
 */
export async function buildAndCacheGalaxy(
  onStep?: GalaxyStepReporter,
): Promise<{ nodes: GraphNode[]; allGenres: string[] }> {
  const result = await buildGalaxyData(onStep);
  if (result.nodes.length > 0) {
    const embCount = await getEmbeddingCount();
    await saveCachedGalaxy({
      nodes: result.nodes,
      allGenres: result.allGenres,
      embeddingCount: embCount,
      timestamp: Date.now(),
    });
    console.log(`[Galaxy Cache] Saved ${result.nodes.length} nodes`);
  }
  return result;
}

// ─── Observable build status ────────────────────────────────────────────────

export type GalaxyBuildStage = 'idle' | 'scheduled' | 'waiting' | 'running' | 'done';

let _buildStage: GalaxyBuildStage = 'idle';
let _buildNodeCount = 0;
const _listeners = new Set<() => void>();

function _setBuildStage(stage: GalaxyBuildStage, nodeCount?: number) {
  _buildStage = stage;
  if (nodeCount !== undefined) _buildNodeCount = nodeCount;
  _listeners.forEach(fn => fn());
}

export function getBuildStage(): GalaxyBuildStage { return _buildStage; }
export function getBuildNodeCount(): number { return _buildNodeCount; }

export function subscribeGalaxy(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── Background precomputation ──────────────────────────────────────────────

let _bgScheduled = false;
let _bgBuildPromise: Promise<{ nodes: GraphNode[]; allGenres: string[] }> | null = null;

export function isBackgroundRunning(): boolean { return _bgBuildPromise !== null; }

/**
 * If a background build is in progress, return its promise so callers can
 * await the same result instead of starting a duplicate computation.
 */
export function getBackgroundBuildPromise(): Promise<{ nodes: GraphNode[]; allGenres: string[] }> | null {
  return _bgBuildPromise;
}

/**
 * Schedule a one-time background precompute. Runs after `delayMs` and only
 * if the cache is missing or stale. Safe to call multiple times — only the
 * first invocation takes effect.
 */
export function scheduleBackgroundPrecompute(delayMs = 20_000): void {
  if (_bgBuildPromise || _bgScheduled) return;
  _bgScheduled = true;
  _setBuildStage('scheduled');

  setTimeout(async () => {
    // Wait for catalog embeddings to finish if running — building the galaxy
    // while embeddings are being written to IDB causes transaction contention.
    if (embeddingService.isCatalogRunning) {
      _setBuildStage('waiting');
      console.log('[Galaxy Cache] Background: waiting for catalog embeddings to finish...');
      await new Promise<void>(resolve => {
        if (!embeddingService.isCatalogRunning) { resolve(); return; }
        const unsub = embeddingService.subscribe(() => {
          if (!embeddingService.isCatalogRunning) { unsub(); resolve(); }
        });
      });
    }

    const existing = await loadCachedGalaxyIfFresh();
    if (existing) {
      console.log('[Galaxy Cache] Background: cache already fresh, skipping');
      _bgScheduled = false;
      _setBuildStage('done', existing.nodes.length);
      return;
    }

    console.log('[Galaxy Cache] Background precompute starting...');
    _setBuildStage('running');
    _bgBuildPromise = buildAndCacheGalaxy();
    try {
      const result = await _bgBuildPromise;
      _setBuildStage('done', result.nodes.length);
    } catch (err) {
      console.warn('[Galaxy Cache] Background precompute failed:', err);
      _setBuildStage('idle');
    } finally {
      _bgBuildPromise = null;
      _bgScheduled = false;
    }
  }, delayMs);
}
