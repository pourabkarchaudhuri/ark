/**
 * Wave 3.3 — MRL-256 helpers (Matryoshka Representation Learning truncate).
 * Full Ollama vectors stay 1024-d in IDB; ANN may use a truncated prefix when enabled.
 */

export const FULL_EMBEDDING_DIM = 1024;
export const MRL_ANN_DIM = 256;

/** Truncate to `dims` and L2-renormalize (Matryoshka-safe prefix). */
export function truncateAndRenorm(
  vec: ArrayLike<number>,
  dims: number,
): number[] {
  const n = Math.min(dims, vec.length);
  const out = new Array<number>(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    out[i] = vec[i];
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    const inv = 1 / norm;
    for (let i = 0; i < n; i++) out[i] *= inv;
  }
  return out;
}

export function annDimsForMrlFlag(mrl256Enabled: boolean): number {
  return mrl256Enabled ? MRL_ANN_DIM : FULL_EMBEDDING_DIM;
}

/** Prepare a vector for ANN add/query given the active index dims. */
export function prepareVectorForAnn(
  vec: ArrayLike<number>,
  activeDims: number,
): number[] | null {
  if (vec.length < activeDims) return null;
  if (vec.length === activeDims) {
    return Array.from(vec as ArrayLike<number>);
  }
  return truncateAndRenorm(vec, activeDims);
}
