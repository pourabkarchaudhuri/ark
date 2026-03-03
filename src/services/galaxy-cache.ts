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

import { loadProjectedEmbeddingsForGraph, getEmbeddingCount, embeddingService, EMBEDDING_TEXT_VERSION } from '@/services/embedding-service';
import { journeyStore } from '@/services/journey-store';
import { libraryStore } from '@/services/library-store';
import { catalogStore } from '@/services/catalog-store';
import { epicCatalogStore, type EpicCatalogEntry } from '@/services/epic-catalog-store';
import type { CatalogEntry } from '@/types/catalog';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  title: string;
  genres: string[];
  themes: string[];
  developer: string;
  publisher: string;
  coverUrl?: string;
  isLibrary: boolean;
  hoursPlayed: number;
  reviewCount: number;
  /** Aggregated quality score 0–1 used for star luminance in the galaxy. */
  luminance: number;
  /** Release year (e.g. 2023). 0 if unknown. */
  releaseYear: number;
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

// ─── Luminance computation ──────────────────────────────────────────────────

/**
 * Aggregate all available review/quality signals into a 0–1 luminance value.
 * Each signal is normalized to 0–1, then they are combined via weighted average.
 * Games with zero data get a neutral 0.5.
 */
export function computeLuminance(opts: {
  metacritic?: number | null;
  steamPositivity?: number;
  steamReviewCount?: number;
  userRating?: number;
  mlRecRate?: number;
}): number {
  const signals: { value: number; weight: number }[] = [];

  if (opts.metacritic != null && opts.metacritic > 0) {
    signals.push({ value: opts.metacritic / 100, weight: 1.0 });
  }

  if (
    opts.steamPositivity != null &&
    opts.steamPositivity > 0 &&
    (opts.steamReviewCount ?? 0) > 0
  ) {
    // Review count drives confidence — 5 reviews at 100% is less trustworthy
    // than 50 000 at 92%. log10(count+1)/5 caps at ~1.0 around 100k reviews.
    const confidence = Math.min(1, Math.log10((opts.steamReviewCount ?? 1) + 1) / 5);
    const adjusted = opts.steamPositivity * (0.6 + 0.4 * confidence);
    signals.push({ value: adjusted, weight: 1.2 });
  }

  if (opts.userRating != null && opts.userRating > 0) {
    signals.push({ value: opts.userRating / 5, weight: 1.5 });
  }

  // ML model game recommendation rate (from 41M Kaggle reviews)
  if (opts.mlRecRate != null && opts.mlRecRate > 0 && Number.isFinite(opts.mlRecRate)) {
    signals.push({ value: Math.min(opts.mlRecRate, 1), weight: 1.3 });
  }

  if (signals.length === 0) return 0.5;

  let totalWeight = 0;
  let sum = 0;
  for (const s of signals) {
    sum += s.value * s.weight;
    totalWeight += s.weight;
  }
  return Math.max(0, Math.min(1, sum / totalWeight));
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

export const GENRE_MAP: Record<string, number> = {
  action: 0, 'action-adventure': 0, shooter: 0, fighting: 0, fps: 0,
  'first person': 0, 'hack and slash': 0, 'arena shooter': 0, stealth: 0,
  soulslike: 0, 'souls-like': 0, roguelike: 0, 'rogue-lite': 0,
  adventure: 1, platformer: 1, 'visual novel': 1, exploration: 1,
  narration: 1, metroidvania: 1, '2d platformer': 1, 'point & click': 1,
  rpg: 2, 'role-playing': 2, jrpg: 2, 'action rpg': 2, 'dungeon crawler': 2,
  strategy: 3, 'real-time strategy': 3, rts: 3, 'turn-based': 3,
  'city builder': 3, 'tower defense': 3, tactical: 3, 'turn-based strategy': 3,
  simulation: 4, management: 4, building: 4,
  indie: 5,
  casual: 6, 'card game': 6, 'board game': 6, party: 6,
  sports: 7, sport: 7, racing: 7,
  puzzle: 8,
  horror: 9, 'psychological horror': 9,
  mmo: 10, mmorpg: 10, 'massively multiplayer': 10,
  survival: 11, sandbox: 11,
  'action roguelike': 0, 'looter shooter': 0,
  'base building': 3, 'resource management': 3,
};

export const CANONICAL_GENRE_LABELS: string[] = [
  'Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Indie',
  'Casual', 'Sports / Racing', 'Puzzle', 'Horror', 'MMO', 'Survival',
];

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

  let device: GPUDevice | null = null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;

    const requiredSize = n * d * 4;
    const maxBuf = adapter.limits.maxStorageBufferBindingSize;
    if (requiredSize > maxBuf) {
      console.log(`[PCA-GPU] Data ${(requiredSize / 1e6).toFixed(0)}MB > limit ${(maxBuf / 1e6).toFixed(0)}MB, falling back`);
      return null;
    }

    device = await adapter.requestDevice({
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

    if (!validatePositions(positions, n)) {
      console.warn('[PCA-GPU] Output positions degenerate, falling back to CPU');
      return null;
    }

    console.log(`[PCA-GPU] Completed for ${n} vectors`);
    return positions;
  } catch (err) {
    console.warn('[PCA-GPU] Failed, falling back to CPU:', err);
    return null;
  } finally {
    device?.destroy();
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

// ─── Worker-based projection (PCA or UMAP, non-blocking) ────────────────────

type WorkerResultMsg =
  | { type: 'progress'; stage: string; epoch?: number; totalEpochs?: number }
  | { type: 'result'; positions: Float32Array; valid: boolean; method: string }
  | { type: 'error'; error: string }
  | { positions: Float32Array; valid: boolean };

let _activeProjectionWorker: Worker | null = null;

function cancelActiveProjectionWorker(): void {
  if (_activeProjectionWorker) {
    try { _activeProjectionWorker.postMessage({ type: 'cancel' }); } catch { /* already dead */ }
    _activeProjectionWorker.terminate();
    _activeProjectionWorker = null;
  }
}

function runProjectionWorker(
  data: Float32Array,
  n: number,
  d: number,
  spread: number,
  method: 'pca' | 'umap' = 'pca',
  onProgress?: (stage: string, epoch?: number, totalEpochs?: number) => void,
  preProjected = false,
): Promise<{ positions: Float32Array; method: string }> {
  cancelActiveProjectionWorker();

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/pca.worker.ts', import.meta.url),
      { type: 'module', name: 'Ark Projection Worker' },
    );
    _activeProjectionWorker = worker;

    worker.onmessage = (e: MessageEvent<WorkerResultMsg>) => {
      const msg = e.data;
      if ('type' in msg) {
        if (msg.type === 'progress') {
          onProgress?.(msg.stage, msg.epoch, msg.totalEpochs);
        } else if (msg.type === 'result') {
          _activeProjectionWorker = null;
          worker.terminate();
          if (!msg.valid) console.warn('[Projection Worker] Output positions degenerate');
          resolve({ positions: msg.positions, method: msg.method });
        } else if (msg.type === 'error') {
          _activeProjectionWorker = null;
          worker.terminate();
          reject(new Error(msg.error));
        }
      } else {
        _activeProjectionWorker = null;
        worker.terminate();
        if (!msg.valid) console.warn('[PCA Worker] Output positions degenerate');
        resolve({ positions: msg.positions, method: 'pca' });
      }
    };

    worker.onerror = (err) => {
      _activeProjectionWorker = null;
      worker.terminate();
      reject(new Error(`Projection Worker failed: ${err.message}`));
    };

    console.log(`[Galaxy Cache] Sending ${(data.byteLength / 1048576).toFixed(1)} MB to worker (preProjected=${preProjected})`);
    worker.postMessage({ data, n, d, spread, method, preProjected }, [data.buffer]);
  });
}

/**
 * Compute 3D positions from pre-projected 100D embeddings.
 *
 * Fallback chain (used only when the main PCA path in buildGalaxyData fails):
 *   1. Try UMAP in worker — best local clustering, slower (~30-60s).
 *   2. WebGPU PCA — fast GPU-accelerated path.
 *   3. CPU PCA — main-thread fallback.
 */
export async function computeProjection(
  data: Float32Array,
  n: number,
  d: number,
  spread: number,
  onProgress?: (stage: string, epoch?: number, totalEpochs?: number) => void,
  preProjected = false,
): Promise<{ positions: Float32Array; method: string }> {
  // Primary: UMAP via worker (buffer is transferred — zero-copy).
  // The worker has an internal PCA fallback if UMAP fails, so this path
  // covers both UMAP and PCA-in-worker. If the worker itself crashes,
  // the buffer is gone and we must reload data for main-thread fallback.
  try {
    return await runProjectionWorker(data, n, d, spread, 'umap', onProgress, preProjected);
  } catch (err) {
    console.warn('[Projection] Worker failed, trying main-thread fallbacks:', err);
  }

  // Buffer was transferred to the (now-dead) worker — reload projected data.
  // This path is rare: only hit when the worker process itself crashes.
  let fallbackData: Float32Array;
  let fallbackDim: number;
  if (data.buffer.byteLength === 0) {
    console.log('[Projection] Buffer detached, reloading projected embeddings for fallback...');
    const reloaded = await loadProjectedEmbeddingsForGraph();
    fallbackData = reloaded.projected;
    fallbackDim = reloaded.projDim;
  } else {
    fallbackData = data;
    fallbackDim = d;
  }

  // WebGPU PCA fallback
  if (navigator.gpu) {
    const centered = centerData(fallbackData, n, fallbackDim);
    const gpuResult = await computePCA_WebGPU(centered, n, fallbackDim);
    if (gpuResult) {
      normalizePositions(gpuResult, n, spread);
      return { positions: gpuResult, method: 'PCA (WebGPU)' };
    }
  }

  // Main-thread PCA fallback (last resort)
  const centered = centerData(fallbackData, n, fallbackDim);
  const positions = computePCA_CPU(centered, n, fallbackDim);
  normalizePositions(positions, n, spread);
  return { positions, method: 'PCA (CPU)' };
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
  'Projecting to 3D (PCA)',
  'Building galaxy map',
];

let _buildGeneration = 0;

export async function buildGalaxyData(
  onStep?: GalaxyStepReporter,
): Promise<{ nodes: GraphNode[]; allGenres: string[]; projectionMethod: string }> {
  const myGen = ++_buildGeneration;
  const cancelled = () => _buildGeneration !== myGen;
  const report = onStep ?? (() => {});

  report(0, 'running');
  let embResult: { ids: string[]; projected: Float32Array; projDim: number } | null =
    await loadProjectedEmbeddingsForGraph((count: number, store: string) => {
      report(0, 'running', `${count.toLocaleString()} from ${store}`);
    });
  const ids = embResult!.ids;
  const projDim = embResult!.projDim;
  let data: Float32Array | null = embResult!.projected;
  embResult = null;
  const n = ids.length;
  console.log(`[Galaxy Cache] Loaded ${n.toLocaleString()} vectors → ${projDim}D (${(data.byteLength / 1048576).toFixed(1)} MB)`);
  if (n === 0 || cancelled()) {
    report(0, 'done', cancelled() ? 'cancelled' : '0 vectors');
    return { nodes: [], allGenres: [], projectionMethod: cancelled() ? 'cancelled' : 'none' };
  }
  report(0, 'done', `${n.toLocaleString()} vectors (projected to ${projDim}D)`);

  report(1, 'running');
  const libraryIds = new Set(journeyStore.getAllEntries().map(e => e.gameId));
  // Fetch catalog data for ALL steam IDs (library included) so we have
  // review scores for luminance even on owned games.
  const catalogAppIds: number[] = [];
  for (const id of ids) {
    const m = id.match(/^steam-(\d+)$/);
    if (m) catalogAppIds.push(Number(m[1]));
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
  // Fetch Epic catalog metadata for epic-* IDs (title, genres, developer, cover)
  const epicMetaMap = new Map<string, EpicCatalogEntry>();
  const epicIds = ids.filter(id => id.startsWith('epic-'));
  if (epicIds.length > 0) {
    const epicIdSet = new Set(epicIds.map(id => id.slice(5))); // strip "epic-" prefix
    await epicCatalogStore.getAllEntries((batch) => {
      for (const entry of batch) {
        if (epicIdSet.has(entry.epicId)) epicMetaMap.set(entry.epicId, entry);
      }
    });
    report(1, 'running', `+ ${epicMetaMap.size.toLocaleString()} Epic entries`);
  }

  // Fetch ML game profiles (g_rec_rate) for luminance enhancement
  let mlRecRates: Record<string, number> = {};
  try {
    if (window.ml) {
      const mlStatus = await window.ml.status();
      if (!mlStatus.loaded) await window.ml.load();
      report(1, 'running', 'loading ML game profiles...');
      const ML_BATCH = 10000;
      for (let i = 0; i < ids.length; i += ML_BATCH) {
        const batch = ids.slice(i, i + ML_BATCH);
        const rates = await window.ml.getGameRecRates(batch);
        Object.assign(mlRecRates, rates);
      }
    }
  } catch { /* ML not available — non-fatal */ }

  report(1, 'done', `${libraryIds.size} library + ${catalogMetaMap.size.toLocaleString()} catalog`);
  if (cancelled()) return { nodes: [], allGenres: [], projectionMethod: 'cancelled' };
  await new Promise(r => setTimeout(r, 30));

  report(2, 'running');
  report(2, 'running', 'initializing...');
  await new Promise(r => setTimeout(r, 50));
  console.log(`[Galaxy Cache] Projecting ${n.toLocaleString()} × ${projDim}D → 3D via PCA...`);
  let projectionMethod = 'PCA';

  // PCA on 100D pre-projected data: fast (~2-5s), no OOM risk.
  // Try WebGPU first (instant for 100K+ points); fall back to CPU.
  report(2, 'running', 'Running PCA...');
  const centered = centerData(data!, n, projDim);
  data = null;
  let positions: Float32Array | null = null;
  if (navigator.gpu) {
    positions = await computePCA_WebGPU(centered, n, projDim);
    if (positions) {
      projectionMethod = 'PCA (WebGPU)';
      normalizePositions(positions, n, 400);
    }
  }
  if (!positions) {
    positions = computePCA_CPU(centered, n, projDim);
    normalizePositions(positions, n, 400);
  }
  console.log(`[Galaxy Cache] ${projectionMethod} done — ${n.toLocaleString()} points positioned`);
  report(2, 'done', projectionMethod);
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
    let themes: string[] = [];
    let developer = '';
    let publisher = '';
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
      if (!publisher && meta.publisher) publisher = meta.publisher;
    }

    // Look up catalog entry for any steam-prefixed ID (review data + metadata fallback)
    const steamMatch = id.match(/^steam-(\d+)$/);
    const cat = steamMatch ? catalogMetaMap.get(Number(steamMatch[1])) : undefined;

    // Look up Epic catalog entry
    const epicMatch = id.startsWith('epic-') ? id.slice(5) : null;
    const epicCat = epicMatch ? epicMetaMap.get(epicMatch) : undefined;

    // Non-library Steam games: fill in title/genre/developer/publisher from catalog
    if (!isLib && cat) {
      if (title === id) title = cat.name;
      if (genres.length === 0) genres = cat.genres;
      if (themes.length === 0) themes = cat.themes;
      if (!developer) developer = cat.developer;
      if (!publisher) publisher = cat.publisher;
    }
    // Non-library Epic games: fill from Epic catalog
    if (!isLib && epicCat) {
      if (title === id) title = epicCat.name;
      if (genres.length === 0) genres = epicCat.genres;
      if (themes.length === 0) themes = epicCat.themes;
      if (!developer) developer = epicCat.developer;
      if (!publisher) publisher = epicCat.publisher;
    }
    // Library games: fill gaps from catalog if cachedMeta was incomplete
    if (isLib && cat) {
      if (!developer) developer = cat.developer;
      if (!publisher) publisher = cat.publisher;
      if (themes.length === 0) themes = cat.themes;
    }
    if (isLib && epicCat) {
      if (!developer) developer = epicCat.developer;
      if (!publisher) publisher = epicCat.publisher;
      if (themes.length === 0) themes = epicCat.themes;
    }

    // Cover URL fallback from Steam CDN for any steam-prefixed ID
    if (!coverUrl && steamMatch) {
      coverUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${steamMatch[1]}/header.jpg`;
    }

    // Epic cover URL fallback from Epic catalog entry or library store
    if (!coverUrl && epicCat?.coverUrl) {
      coverUrl = epicCat.coverUrl;
    }
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

    // ── Luminance from aggregated review signals ──
    const userRating = journey?.rating ?? libEntry?.rating ?? 0;
    const luminance = computeLuminance({
      metacritic: meta?.metacriticScore,
      steamPositivity: cat?.reviewPositivity,
      steamReviewCount: cat?.reviewCount,
      userRating,
      mlRecRate: mlRecRates[id],
    });

    // ── Release year from catalog (Unix timestamp → year) or Epic (epoch ms) ──
    let releaseYear = 0;
    if (cat?.releaseDate) {
      releaseYear = new Date(cat.releaseDate * 1000).getFullYear();
    } else if (epicCat?.releaseDate) {
      releaseYear = new Date(epicCat.releaseDate).getFullYear();
    }

    genres.forEach(g => allGenresSet.add(g));

    nodes.push({
      id,
      title,
      genres,
      themes,
      developer,
      publisher,
      coverUrl,
      isLibrary: isLib,
      hoursPlayed: journey?.hoursPlayed ?? 0,
      reviewCount: cat?.reviewCount ?? -1,
      luminance,
      releaseYear,
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2],
      colorIdx: genreToColorIdx(genres),
    });
  }

  report(3, 'done', `${nodes.length.toLocaleString()} nodes`);
  return { nodes, allGenres: [...allGenresSet].sort(), projectionMethod };
}

// ─── IDB Cache ──────────────────────────────────────────────────────────────

interface CachedGalaxy {
  nodes: GraphNode[];
  allGenres: string[];
  embeddingCount: number;
  embeddingTextVersion?: number;
  timestamp: number;
  projectionMethod?: string;
}

const CACHE_DB = 'galaxy-cache';
const CACHE_STORE = 'data';
const CACHE_KEY = 'galaxy-v13';

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
export async function loadCachedGalaxyIfFresh(): Promise<{ nodes: GraphNode[]; allGenres: string[]; projectionMethod: string } | null> {
  const cached = await getCachedGalaxy();
  if (!cached || cached.nodes.length === 0) return null;

  if (cached.embeddingTextVersion !== EMBEDDING_TEXT_VERSION) {
    console.log(`[Galaxy Cache] Stale — embedding text version ${cached.embeddingTextVersion ?? '?'} vs current ${EMBEDDING_TEXT_VERSION}`);
    return null;
  }

  const currentCount = await getEmbeddingCount();
  const ageMs = Date.now() - cached.timestamp;
  const RECENT_THRESHOLD_MS = 5 * 60_000;
  if (currentCount !== cached.embeddingCount) {
    // If the cache was built very recently (e.g. background precompute during
    // splash) and the catalog embedding pipeline is still generating more
    // vectors, accept the cache to avoid a wasteful full rebuild.
    const countGrowth = currentCount > cached.embeddingCount
      ? (currentCount - cached.embeddingCount) / cached.embeddingCount
      : 0;
    if (ageMs < RECENT_THRESHOLD_MS && countGrowth < 0.05) {
      console.log(`[Galaxy Cache] Near-fresh — cached ${cached.embeddingCount} vs current ${currentCount} (${(countGrowth * 100).toFixed(1)}% growth, ${(ageMs / 1000).toFixed(0)}s old) — accepting`);
    } else {
      console.log(`[Galaxy Cache] Stale — cached ${cached.embeddingCount} vs current ${currentCount}`);
      return null;
    }
  }

  console.log(`[Galaxy Cache] Hit — ${cached.nodes.length} nodes from ${new Date(cached.timestamp).toLocaleTimeString()}`);
  _setBuildStage('done', cached.nodes.length);
  return { nodes: cached.nodes, allGenres: cached.allGenres, projectionMethod: cached.projectionMethod ?? 'PCA' };
}

/**
 * Build fresh galaxy data and persist to cache.
 */
export async function buildAndCacheGalaxy(
  onStep?: GalaxyStepReporter,
): Promise<{ nodes: GraphNode[]; allGenres: string[]; projectionMethod: string }> {
  const result = await buildGalaxyData(onStep);
  if (result.nodes.length > 0) {
    const embCount = await getEmbeddingCount();
    await saveCachedGalaxy({
      nodes: result.nodes,
      allGenres: result.allGenres,
      embeddingCount: embCount,
      embeddingTextVersion: EMBEDDING_TEXT_VERSION,
      timestamp: Date.now(),
      projectionMethod: result.projectionMethod,
    });
    console.log(`[Galaxy Cache] Saved ${result.nodes.length} nodes (${result.projectionMethod})`);
  }
  return result;
}

// ─── Observable build status ────────────────────────────────────────────────

export type GalaxyBuildStage = 'idle' | 'scheduled' | 'waiting' | 'running' | 'done';

let _buildStage: GalaxyBuildStage = 'idle';
let _buildNodeCount = 0;
let _buildStepIndex = -1;
let _buildStepDetail = '';
const _listeners = new Set<() => void>();

function _setBuildStage(stage: GalaxyBuildStage, nodeCount?: number) {
  _buildStage = stage;
  if (nodeCount !== undefined) _buildNodeCount = nodeCount;
  if (stage !== 'running') { _buildStepIndex = -1; _buildStepDetail = ''; }
  _listeners.forEach(fn => fn());
}

function _setBuildStep(stepIndex: number, detail?: string) {
  _buildStepIndex = stepIndex;
  _buildStepDetail = detail ?? '';
  _listeners.forEach(fn => fn());
}

export function getBuildStage(): GalaxyBuildStage { return _buildStage; }
export function getBuildNodeCount(): number { return _buildNodeCount; }
export function getBuildStepIndex(): number { return _buildStepIndex; }
export function getBuildStepDetail(): string { return _buildStepDetail; }

export function subscribeGalaxy(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── Background precomputation ──────────────────────────────────────────────

let _bgScheduled = false;
let _bgBuildPromise: Promise<{ nodes: GraphNode[]; allGenres: string[]; projectionMethod: string }> | null = null;

export function isBackgroundRunning(): boolean { return _bgBuildPromise !== null; }
export { cancelActiveProjectionWorker };

/**
 * If a background build is in progress, return its promise so callers can
 * await the same result instead of starting a duplicate computation.
 */
export function getBackgroundBuildPromise(): Promise<{ nodes: GraphNode[]; allGenres: string[]; projectionMethod: string }> | null {
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

  setTimeout(() => void _runBackgroundPrecompute(), delayMs);
}

async function _runBackgroundPrecompute(): Promise<void> {
  _setBuildStage('waiting');
  const MAX_WAIT_MS = 3 * 60_000;
  const POLL_INTERVAL = 3_000;
  const waitStart = Date.now();

  // Wait for one of three exit conditions:
  //   1. Embeddings already exist in IDB (from a previous session)
  //   2. Ollama availability check completed (available or not)
  //   3. Timeout reached
  while (Date.now() - waitStart < MAX_WAIT_MS) {
    const count = await getEmbeddingCount();
    if (count > 0) {
      console.log(`[Galaxy Cache] Background: ${count} embeddings cached, proceeding`);
      break;
    }
    if (embeddingService.isOllamaUnavailable) {
      console.log('[Galaxy Cache] Background: Ollama unavailable, cannot build galaxy — will retry when embeddings appear');
      _bgScheduled = false;
      _setBuildStage('idle');
      _scheduleRetryWhenEmbeddingsAppear();
      return;
    }
    if (embeddingService.isCatalogRunning) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // If catalog embeddings are actively running, wait for completion (with timeout)
  if (embeddingService.isCatalogRunning) {
    console.log('[Galaxy Cache] Background: waiting for catalog embeddings to finish...');
    await new Promise<void>(resolve => {
      if (!embeddingService.isCatalogRunning) { resolve(); return; }
      const timeout = setTimeout(() => { unsub(); resolve(); }, 5 * 60_000);
      const unsub = embeddingService.subscribe(() => {
        if (!embeddingService.isCatalogRunning) { clearTimeout(timeout); unsub(); resolve(); }
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

  // Check if we have any embeddings at all
  const finalCount = await getEmbeddingCount();
  if (finalCount === 0) {
    console.log('[Galaxy Cache] Background: 0 embeddings available, deferring galaxy build');
    _bgScheduled = false;
    _setBuildStage('idle');
    _scheduleRetryWhenEmbeddingsAppear();
    return;
  }

  // Memory-pressure gate: defer if the renderer is already under heavy load.
  // The galaxy build allocates ~300 MB for embedding data + worker projection.
  // Starting when memory is already high risks an OOM crash.
  const mem = (performance as any).memory;
  if (mem && mem.usedJSHeapSize && mem.jsHeapSizeLimit) {
    const usageRatio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
    if (usageRatio > 0.60) {
      console.log(`[Galaxy Cache] Memory pressure high (${(usageRatio * 100).toFixed(0)}%) — deferring galaxy build by 30s`);
      _bgScheduled = false;
      _setBuildStage('scheduled');
      setTimeout(() => {
        _bgScheduled = false;
        scheduleBackgroundPrecompute(0);
      }, 30_000);
      return;
    }
  }

  console.log('[Galaxy Cache] Background precompute starting...');
  _setBuildStage('running');
  _bgBuildPromise = buildAndCacheGalaxy((stepIndex, _status, detail) => {
    _setBuildStep(stepIndex, detail);
  });
  try {
    const result = await _bgBuildPromise;
    if (result.nodes.length === 0) {
      console.warn('[Galaxy Cache] Background: built 0 nodes, deferring');
      _setBuildStage('idle');
      _scheduleRetryWhenEmbeddingsAppear();
    } else {
      _setBuildStage('done', result.nodes.length);
    }
  } catch (err) {
    console.warn('[Galaxy Cache] Background precompute failed:', err);
    _setBuildStage('idle');
    _scheduleRetryWhenEmbeddingsAppear();
  } finally {
    _bgBuildPromise = null;
    _bgScheduled = false;
  }
}

let _retryUnsub: (() => void) | null = null;

/**
 * Subscribe to embedding service changes and auto-retry the galaxy build
 * once embeddings become available.
 */
function _scheduleRetryWhenEmbeddingsAppear(): void {
  if (_retryUnsub) return;
  _retryUnsub = embeddingService.subscribe(() => {
    if (embeddingService.loadedCount > 0 || embeddingService.isCatalogRunning) {
      _retryUnsub?.();
      _retryUnsub = null;
      if (!_bgScheduled && !_bgBuildPromise) {
        console.log('[Galaxy Cache] Embeddings detected — scheduling galaxy build');
        scheduleBackgroundPrecompute(5_000);
      }
    }
  });
}
