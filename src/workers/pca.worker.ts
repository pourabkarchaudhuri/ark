/**
 * PCA Web Worker — offloads the heavy CPU-bound PCA pipeline off the main
 * thread so the UI stays responsive while the galaxy map computes.
 *
 * Pipeline: center data → power-iteration PCA (768D → 3D) → normalize.
 *
 * Communication:
 *   IN  — { data: Float32Array, n, d, spread }  (data buffer is transferred)
 *   OUT — { positions: Float32Array, valid }     (positions buffer transferred)
 */

// ─── centerData ──────────────────────────────────────────────────────────────

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

// ─── Power-iteration PCA (3 principal components) ────────────────────────────

function computePCA(centered: Float32Array, n: number, d: number): Float32Array {
  const PCs: Float32Array[] = [];
  const ITERS = 30;
  const w = new Float32Array(n);

  for (let pc = 0; pc < 3; pc++) {
    const v = new Float32Array(d);
    for (let j = 0; j < d; j++) v[j] = Math.random() - 0.5;

    for (let iter = 0; iter < ITERS; iter++) {
      // Forward: w = X·v
      for (let i = 0; i < n; i++) {
        let s = 0;
        const off = i * d;
        for (let j = 0; j < d; j++) s += centered[off + j] * v[j];
        w[i] = s;
      }
      // Backward: v = Xᵀ·w
      v.fill(0);
      for (let i = 0; i < n; i++) {
        const wi = w[i];
        const off = i * d;
        for (let j = 0; j < d; j++) v[j] += centered[off + j] * wi;
      }
      // Deflate: remove previously found components
      for (const prev of PCs) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += v[j] * prev[j];
        for (let j = 0; j < d; j++) v[j] -= dot * prev[j];
      }
      // Normalize
      let mag = 0;
      for (let j = 0; j < d; j++) mag += v[j] * v[j];
      mag = Math.sqrt(mag);
      if (mag > 0) for (let j = 0; j < d; j++) v[j] /= mag;
    }
    PCs.push(new Float32Array(v));
  }

  // Project data onto the 3 principal components
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

  return positions;
}

// ─── Normalize positions to [-spread, +spread] ──────────────────────────────

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

// ─── Validation ──────────────────────────────────────────────────────────────

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

// ─── Message handler ─────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<{ data: Float32Array; n: number; d: number; spread: number }>) => {
  const { data, n, d, spread } = e.data;
  console.log(`[PCA Worker] Starting: ${n.toLocaleString()} vectors × ${d}D`);
  const t0 = performance.now();

  const centered = centerData(data, n, d);
  const positions = computePCA(centered, n, d);
  normalizePositions(positions, n, spread);
  const valid = validatePositions(positions, n);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[PCA Worker] Done in ${elapsed}s — ${valid ? 'valid' : 'DEGENERATE'}`);

  postMessage({ positions, valid }, { transfer: [positions.buffer] });
};
