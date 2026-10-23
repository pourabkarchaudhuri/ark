/**
 * Low-dimensional embedding sketches for MMR diversity (pure).
 *
 * The worker never sees full candidate embeddings (they are stripped before dispatch to avoid cloning
 * ~25 MB of vectors), but MMR needs pairwise similarity between picks. A signed count-sketch of the
 * (normalised) embedding — each input coordinate adds ±x into a few of `outDim` buckets — approximately
 * preserves cosine similarity at ~1/8 the size and O(dim) cost per vector.
 */

export const MMR_SKETCH_DIM = 128;
const SKETCH_COPIES = 3;

function hash32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const tableCache = new Map<string, { bucket: Uint16Array; sign: Int8Array }>();

function tableFor(inDim: number, outDim: number) {
  const key = `${inDim}:${outDim}`;
  let t = tableCache.get(key);
  if (!t) {
    const bucket = new Uint16Array(inDim * SKETCH_COPIES);
    const sign = new Int8Array(inDim * SKETCH_COPIES);
    for (let j = 0; j < inDim; j++) {
      for (let c = 0; c < SKETCH_COPIES; c++) {
        const h = hash32(j * 7919 + c * 104729 + 17);
        bucket[j * SKETCH_COPIES + c] = h % outDim;
        sign[j * SKETCH_COPIES + c] = (h >>> 20) & 1 ? 1 : -1;
      }
    }
    t = { bucket, sign };
    tableCache.set(key, t);
  }
  return t;
}

/** Unit-length sketch of `vec`, or null when the vector is empty/zero. */
export function sketchEmbedding(vec: ArrayLike<number>, outDim: number = MMR_SKETCH_DIM): Float32Array | null {
  const n = vec.length;
  if (n === 0) return null;
  const { bucket, sign } = tableFor(n, outDim);
  const out = new Float32Array(outDim);
  for (let j = 0; j < n; j++) {
    const x = vec[j];
    if (x === 0) continue;
    for (let c = 0; c < SKETCH_COPIES; c++) {
      const k = j * SKETCH_COPIES + c;
      out[bucket[k]] += sign[k] * x;
    }
  }
  let mag = 0;
  for (let i = 0; i < outDim; i++) mag += out[i] * out[i];
  mag = Math.sqrt(mag);
  if (!(mag > 0)) return null;
  for (let i = 0; i < outDim; i++) out[i] /= mag;
  return out;
}

/** Dot product of two equal-length unit vectors (= cosine). */
export function dotUnit(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

/** Embedding cosines sit in a compressed band; map "unrelated" (≤0.4) to 0 and "identical" to 1. */
export function embeddingSimilarityToUnit(cosine: number): number {
  return Math.min(1, Math.max(0, (cosine - 0.4) / 0.6));
}
