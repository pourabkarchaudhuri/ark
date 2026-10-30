/**
 * Random projection math for the galaxy precompute (1024D pooled vectors →
 * 100D, L2-normalised first). Pure — shared by the main-thread fallback in
 * embedding-service.ts and galaxy-projection.worker.ts.
 *
 * Int8 rows are projected straight from `q`: the dequantisation scale
 * cancels under L2 normalisation (only its sign survives), so the old
 * decode-to-Float32Array per row was pure allocation.
 */

export const GALAXY_PROJ_DIM = 100;

export function generateGaussianProjectionMatrix(
  srcDim: number,
  tgtDim: number,
  random: () => number = Math.random,
): Float32Array {
  const scale = 1 / Math.sqrt(tgtDim);
  const R = new Float32Array(tgtDim * srcDim);
  for (let i = 0; i < R.length; i++) {
    const u1 = random() || 1e-10;
    const u2 = random();
    R[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
  }
  return R;
}

/** out[off..off+projDim) = R · (scratch), where scratch already holds the unit vector. */
function projectScratch(
  scratch: Float64Array,
  R: Float32Array,
  srcDim: number,
  projDim: number,
  out: Float32Array,
  outOff: number,
): void {
  for (let k = 0; k < projDim; k++) {
    let s = 0;
    const rOff = k * srcDim;
    for (let j = 0; j < srcDim; j++) s += R[rOff + j] * scratch[j];
    out[outOff + k] = s;
  }
}

/** Project one int8-quantised row (`q`, `scale`) into `out` at `outOff`. `scratch` is reused (length ≥ srcDim). */
export function projectInt8RowInto(
  q: ArrayLike<number>,
  scale: number,
  R: Float32Array,
  srcDim: number,
  projDim: number,
  out: Float32Array,
  outOff: number,
  scratch: Float64Array,
): void {
  const sign = scale > 0 ? 1 : scale < 0 ? -1 : 0;
  let norm = 0;
  for (let j = 0; j < srcDim; j++) norm += q[j] * q[j];
  norm = Math.sqrt(norm);
  // A zero scale dequantises to the zero vector, which the old path projected to zeros.
  const inv = sign !== 0 && norm > 1e-10 ? sign / norm : 0;
  for (let j = 0; j < srcDim; j++) scratch[j] = q[j] * inv;
  projectScratch(scratch, R, srcDim, projDim, out, outOff);
}

/** Project one float row (legacy pooled rows) into `out` at `outOff`. */
export function projectFloatRowInto(
  vec: ArrayLike<number>,
  R: Float32Array,
  srcDim: number,
  projDim: number,
  out: Float32Array,
  outOff: number,
  scratch: Float64Array,
): void {
  let norm = 0;
  for (let j = 0; j < srcDim; j++) norm += vec[j] * vec[j];
  norm = Math.sqrt(norm);
  const inv = norm > 1e-10 ? 1 / norm : 0;
  for (let j = 0; j < srcDim; j++) scratch[j] = vec[j] * inv;
  projectScratch(scratch, R, srcDim, projDim, out, outOff);
}

/** Project `count` int8 rows packed back to back in `q` (row i = q[i*srcDim ..]). */
export function projectInt8Page(
  q: Int8Array,
  scales: Float32Array,
  count: number,
  R: Float32Array,
  srcDim: number,
  projDim: number,
): Float32Array {
  const out = new Float32Array(count * projDim);
  const scratch = new Float64Array(srcDim);
  for (let i = 0; i < count; i++) {
    projectInt8RowInto(q.subarray(i * srcDim, (i + 1) * srcDim), scales[i], R, srcDim, projDim, out, i * projDim, scratch);
  }
  return out;
}

// ─── Worker protocol ────────────────────────────────────────────────────────

export type GalaxyProjectionWorkerInput =
  | { type: 'init'; R: Float32Array; srcDim: number; projDim: number }
  | { type: 'page'; id: number; q: Int8Array; scales: Float32Array; count: number };

export type GalaxyProjectionWorkerOutput =
  | { type: 'page'; id: number; out: Float32Array }
  | { type: 'error'; id: number; error: string };
