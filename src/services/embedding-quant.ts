/**
 * Int8 quantization for embedding vectors (Phase A storage format).
 * In-memory / ANN / IPC paths always use dequantized f32.
 */

export const EMBEDDING_DIM = 1024;

/**
 * Symmetric abs-max quantization into Int8Array + scale.
 * Reconstruct: float[i] ≈ q[i] * scale
 */
export function quantizeEmbedding(vec: ArrayLike<number>): { q: Int8Array; scale: number } {
  const n = vec.length;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const inv = 1 / scale;
  const q = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * inv)));
  }
  return { q, scale };
}

export function dequantizeEmbedding(q: Int8Array, scale: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
  return out;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}
