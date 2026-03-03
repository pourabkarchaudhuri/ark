/**
 * Projection Web Worker — offloads CPU-bound dimensionality reduction so the
 * UI stays responsive while the galaxy map computes.
 *
 * Supports two methods:
 *   'pca'  — power-iteration PCA (1024D → 3D), fast (~3-5s for 60K points)
 *   'umap' — L2-norm + center + random projection (1024D → 100D) + UMAP (100D → 3D)
 *            with cosine distance. Produces genre-coherent clustering.
 *
 * For large datasets (>18K vectors), UMAP runs on a 15K landmark subsample
 * and remaining points are interpolated from their nearest landmarks in the
 * projected space. This keeps peak memory under ~300 MB regardless of dataset
 * size, preventing renderer OOM on 70K+ embedding collections.
 *
 * Communication:
 *   IN  — { data: Float32Array, n, d, spread, method? }
 *   OUT — { type: 'progress', stage, epoch?, totalEpochs? }
 *   OUT — { type: 'result', positions: Float32Array, valid, method }
 *   OUT — (legacy) { positions: Float32Array, valid }          (PCA compat)
 */

import { UMAP } from 'umap-js';

// ─── Constants ───────────────────────────────────────────────────────────────

const UMAP_DIRECT_MAX = 18_000;
const LANDMARK_COUNT  = 5_000;
const PRE_DIM         = 100;

const INTERP_CANDIDATES = 500;
const INTERP_K          = 8;

// ─── Distance ────────────────────────────────────────────────────────────────
// cosineDistance was removed — UMAP now uses default Euclidean distance,
// which enables the optimized NNDescent O(n log n) path in umap-js.

// ─── Data preprocessing ─────────────────────────────────────────────────────

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

function centerDataInPlace(data: Float32Array, n: number, d: number): void {
  const mean = new Float32Array(d);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < d; j++) mean[j] += data[i * d + j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < d; j++) data[i * d + j] -= mean[j];
}

// ─── Power-iteration PCA (k principal components) ────────────────────────────

function computePCA(centered: Float32Array, n: number, d: number, k: number = 3): Float32Array {
  const PCs: Float32Array[] = [];
  const ITERS = 30;
  const w = new Float32Array(n);

  for (let pc = 0; pc < k; pc++) {
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

  const positions = new Float32Array(n * k);
  for (let c = 0; c < k; c++) {
    const pcv = PCs[c];
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += centered[off + j] * pcv[j];
      positions[i * k + c] = s;
    }
  }

  return positions;
}

// ─── Normalize positions to [-spread, +spread] ──────────────────────────────

function normalizePositions(pos: Float32Array, n: number, dims: number, spread: number): void {
  const mins = new Array(dims).fill(Infinity);
  const maxs = new Array(dims).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < dims; a++) {
      const v = pos[i * dims + a];
      if (v < mins[a]) mins[a] = v;
      if (v > maxs[a]) maxs[a] = v;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < dims; a++) {
      const range = maxs[a] - mins[a];
      pos[i * dims + a] = range > 0
        ? ((pos[i * dims + a] - mins[a]) / range - 0.5) * 2 * spread
        : 0;
    }
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validatePositions(pos: Float32Array, n: number, dims: number = 3): boolean {
  if (n < 2) return n > 0;
  let hasVariance = false;
  const first: number[] = [];
  for (let a = 0; a < dims; a++) first.push(pos[a]);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < dims; a++) {
      const v = pos[i * dims + a];
      if (!isFinite(v)) return false;
      if (Math.abs(v - first[a]) > 1e-6) hasVariance = true;
    }
  }
  return hasVariance;
}

// ─── L2-normalize each row in-place ──────────────────────────────────────────

function l2Normalize(data: Float32Array, n: number, d: number): void {
  for (let i = 0; i < n; i++) {
    const off = i * d;
    let norm = 0;
    for (let j = 0; j < d; j++) norm += data[off + j] * data[off + j];
    norm = Math.sqrt(norm);
    if (norm > 1e-10) {
      for (let j = 0; j < d; j++) data[off + j] /= norm;
    }
  }
}

// ─── Random Gaussian projection → flat Float32Array ──────────────────────────

function randomProjectFlat(
  data: Float32Array, n: number, d: number, targetDim: number,
): Float32Array {
  const scale = 1 / Math.sqrt(targetDim);
  const R = new Float32Array(targetDim * d);
  for (let i = 0; i < R.length; i++) {
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    R[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
  }

  const flat = new Float32Array(n * targetDim);
  for (let i = 0; i < n; i++) {
    const srcOff = i * d;
    const dstOff = i * targetDim;
    for (let k = 0; k < targetDim; k++) {
      let s = 0;
      const rOff = k * d;
      for (let j = 0; j < d; j++) s += data[srcOff + j] * R[rOff + j];
      flat[dstOff + k] = s;
    }
  }
  return flat;
}

// ─── Helpers for subsampled UMAP ─────────────────────────────────────────────

function extractRows(
  flat: Float32Array, indices: Uint32Array, dim: number,
): number[][] {
  const result: number[][] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const off = indices[i] * dim;
    const row = new Array(dim);
    for (let j = 0; j < dim; j++) row[j] = flat[off + j];
    result[i] = row;
  }
  return result;
}

function flatToAllRows(flat: Float32Array, n: number, dim: number): number[][] {
  const result: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    const row = new Array(dim);
    for (let j = 0; j < dim; j++) row[j] = flat[off + j];
    result[i] = row;
  }
  return result;
}

function selectLandmarkIndices(n: number, count: number): Uint32Array {
  const all = new Uint32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
  }
  return all.slice(0, count);
}

async function interpolateFromLandmarks(
  flat: Float32Array,
  dim: number,
  landmarkIdxs: Uint32Array,
  landmarkPos3D: Float32Array,
  landmarkSet: Set<number>,
  n: number,
  positions: Float32Array,
): Promise<void> {
  const nLandmarks = landmarkIdxs.length;
  const candidates = Math.min(INTERP_CANDIDATES, nLandmarks);
  const topDists = new Float32Array(INTERP_K);
  const topIdxs  = new Uint32Array(INTERP_K);
  const post = (self as unknown as Worker).postMessage.bind(self);

  let done = 0;
  const total = n - nLandmarks;

  for (let idx = 0; idx < n; idx++) {
    if (landmarkSet.has(idx)) continue;
    if (_cancelled) throw new Error('Interpolation cancelled');

    topDists.fill(Infinity);
    const candStart = Math.floor(Math.random() * nLandmarks);
    const srcOff = idx * dim;

    for (let c = 0; c < candidates; c++) {
      const ci = (candStart + c) % nLandmarks;
      const lOff = landmarkIdxs[ci] * dim;
      let dist = 0;
      for (let j = 0; j < dim; j++) {
        const diff = flat[srcOff + j] - flat[lOff + j];
        dist += diff * diff;
      }
      if (dist < topDists[INTERP_K - 1]) {
        topDists[INTERP_K - 1] = dist;
        topIdxs[INTERP_K - 1] = ci;
        for (let s = INTERP_K - 2; s >= 0; s--) {
          if (topDists[s + 1] < topDists[s]) {
            const td = topDists[s]; topDists[s] = topDists[s + 1]; topDists[s + 1] = td;
            const ti = topIdxs[s];  topIdxs[s]  = topIdxs[s + 1];  topIdxs[s + 1] = ti;
          } else break;
        }
      }
    }

    let wx = 0, wy = 0, wz = 0, totalW = 0;
    for (let k = 0; k < INTERP_K; k++) {
      if (topDists[k] === Infinity) break;
      const w = 1 / (Math.sqrt(topDists[k]) + 1e-6);
      const lp = topIdxs[k] * 3;
      wx += w * landmarkPos3D[lp];
      wy += w * landmarkPos3D[lp + 1];
      wz += w * landmarkPos3D[lp + 2];
      totalW += w;
    }
    if (totalW > 0) {
      positions[idx * 3]     = wx / totalW;
      positions[idx * 3 + 1] = wy / totalW;
      positions[idx * 3 + 2] = wz / totalW;
    }

    done++;
    if (done % 5000 === 0) {
      post({ type: 'progress', stage: `Placing remaining points... (${done.toLocaleString()}/${total.toLocaleString()})` });
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

// ─── UMAP pipeline ──────────────────────────────────────────────────────────

async function runUMAP(
  dataRef: { buf: Float32Array | null },
  n: number, d: number, spread: number,
  preProjected = false,
): Promise<Float32Array> {
  const post = (msg: object) => (self as unknown as Worker).postMessage(msg);
  const subsample = n > UMAP_DIRECT_MAX;

  let flat: Float32Array | null;
  let projDim: number;

  if (preProjected) {
    flat = dataRef.buf!;
    dataRef.buf = null;
    projDim = d;
    post({ type: 'progress', stage: `Using pre-projected ${d}D data (${n.toLocaleString()} vectors)` });
  } else {
    const data = dataRef.buf!;
    post({ type: 'progress', stage: 'Preprocessing embeddings...' });
    l2Normalize(data, n, d);
    centerDataInPlace(data, n, d);

    post({ type: 'progress', stage: 'Reducing dimensions for neighbor search...' });
    flat = randomProjectFlat(data, n, d, PRE_DIM);
    dataRef.buf = null;
    projDim = PRE_DIM;
  }

  // ── 3. Prepare UMAP input
  let landmarkIdxs: Uint32Array | null = null;
  let umapInput: number[][] | null;
  let nUmap: number;

  if (subsample) {
    const lmCount = Math.min(LANDMARK_COUNT, n);
    landmarkIdxs = selectLandmarkIndices(n, lmCount);
    umapInput = extractRows(flat, landmarkIdxs, projDim);
    nUmap = lmCount;
    post({ type: 'progress', stage: `Selected ${lmCount.toLocaleString()} landmarks from ${n.toLocaleString()} points` });
  } else {
    umapInput = flatToAllRows(flat!, n, projDim);
    flat = null;
    nUmap = n;
  }

  // ── 4. Build NN graph + UMAP optimization
  post({ type: 'progress', stage: 'Building neighborhood graph...' });
  const requestedEpochs = Math.min(500, Math.max(300, Math.round(1200 / Math.log10(nUmap + 1))));

  // Data is L2-normalized, so Euclidean distance ∝ cosine distance.
  // Using the default Euclidean allows umap-js to use its optimized
  // random projection tree NN search (O(n log n)) instead of the
  // O(n²) brute-force fallback used for custom distance functions.
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: 30,
    minDist: 0.05,
    spread: 1.0,
    nEpochs: requestedEpochs,
  });

  const totalEpochs = umap.initializeFit(umapInput);
  umapInput = null;

  post({ type: 'progress', stage: 'Optimizing layout...', epoch: 0, totalEpochs });

  const BATCH = 2;
  const YIELD_MS = 20;
  for (let epoch = 0; epoch < totalEpochs; epoch++) {
    if (_cancelled) throw new Error('UMAP cancelled by user');
    umap.step();
    if ((epoch + 1) % BATCH === 0 || epoch === totalEpochs - 1) {
      post({ type: 'progress', stage: 'Optimizing layout...', epoch: epoch + 1, totalEpochs });
      await new Promise(r => setTimeout(r, YIELD_MS));
    }
  }

  const embedding = umap.getEmbedding();
  if (embedding.length !== nUmap) {
    throw new Error(`UMAP returned ${embedding.length} points but expected ${nUmap}`);
  }

  // ── 5. Build final positions
  const positions = new Float32Array(n * 3);

  if (!subsample) {
    for (let i = 0; i < n; i++) {
      const row = embedding[i];
      if (!row || row.length < 3) throw new Error(`UMAP point ${i} has ${row?.length ?? 0} dims, expected 3`);
      positions[i * 3]     = row[0];
      positions[i * 3 + 1] = row[1];
      positions[i * 3 + 2] = row[2];
    }
  } else {
    const landmarkPos3D = new Float32Array(landmarkIdxs!.length * 3);
    for (let i = 0; i < landmarkIdxs!.length; i++) {
      const row = embedding[i];
      const origIdx = landmarkIdxs![i];
      landmarkPos3D[i * 3]     = row[0];
      landmarkPos3D[i * 3 + 1] = row[1];
      landmarkPos3D[i * 3 + 2] = row[2];
      positions[origIdx * 3]     = row[0];
      positions[origIdx * 3 + 1] = row[1];
      positions[origIdx * 3 + 2] = row[2];
    }

    post({ type: 'progress', stage: 'Placing remaining points...' });
    const landmarkSet = new Set<number>();
    for (const li of landmarkIdxs!) landmarkSet.add(li);

    await interpolateFromLandmarks(
      flat!, projDim, landmarkIdxs!, landmarkPos3D, landmarkSet, n, positions,
    );
    flat = null;
  }

  normalizePositions(positions, n, 3, spread);
  return positions;
}

// ─── PCA pipeline ───────────────────────────────────────────────────────────

function runPCA(data: Float32Array, n: number, d: number, spread: number): Float32Array {
  (self as unknown as Worker).postMessage({ type: 'progress', stage: 'Running PCA...' });
  const centered = centerData(data, n, d);
  const positions = computePCA(centered, n, d, 3);
  normalizePositions(positions, n, 3, spread);
  return positions;
}

// ─── Message handler ─────────────────────────────────────────────────────────

let _cancelled = false;

self.onmessage = async (e: MessageEvent<{
  type?: string;
  data: Float32Array; n: number; d: number; spread: number;
  method?: 'pca' | 'umap'; preProjected?: boolean;
}>) => {
  if (e.data.type === 'cancel') { _cancelled = true; return; }
  _cancelled = false;

  const { n, d, spread, method = 'pca', preProjected = false } = e.data;
  const dataRef: { buf: Float32Array | null } = { buf: e.data.data };
  (e as any).data = undefined;

  const useUMAP = method === 'umap' && n >= 50;
  const tag = preProjected ? ' (pre-projected)' : '';
  console.log(`[Projection Worker] Starting ${useUMAP ? 'UMAP' : 'PCA'}: ${n.toLocaleString()} vectors × ${d}D${tag}`);
  const t0 = performance.now();

  try {
    let positions: Float32Array;

    if (useUMAP) {
      positions = await runUMAP(dataRef, n, d, spread, preProjected);
    } else {
      positions = runPCA(dataRef.buf!, n, d, spread);
      dataRef.buf = null;
    }

    const valid = validatePositions(positions, n, 3);
    const label = useUMAP ? 'UMAP' : 'PCA';
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[Projection Worker] ${label} done in ${elapsed}s — ${valid ? 'valid' : 'DEGENERATE'}`);

    (self as unknown as Worker).postMessage(
      { type: 'result', positions, valid, method: label },
      { transfer: [positions.buffer] },
    );
  } catch (err) {
    console.error('[Projection Worker] Failed:', err);
    if (useUMAP) {
      console.log('[Projection Worker] UMAP failed, falling back to PCA...');
      try {
        if (!dataRef.buf || dataRef.buf.byteLength === 0) {
          throw new Error('Data buffer already consumed by UMAP preprocessing');
        }
        const positions = runPCA(dataRef.buf, n, d, spread);
        dataRef.buf = null;
        const valid = validatePositions(positions, n, 3);
        (self as unknown as Worker).postMessage(
          { type: 'result', positions, valid, method: 'PCA' },
          { transfer: [positions.buffer] },
        );
        return;
      } catch (pcaErr) {
        console.error('[Projection Worker] PCA fallback also failed:', pcaErr);
        (self as unknown as Worker).postMessage(
          { type: 'error', error: `UMAP failed: ${err}; PCA fallback also failed: ${pcaErr}` },
        );
        return;
      }
    }
    (self as unknown as Worker).postMessage(
      { type: 'error', error: String(err) },
    );
  }
};
