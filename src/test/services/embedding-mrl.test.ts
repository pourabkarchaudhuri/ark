import { describe, it, expect } from 'vitest';
import {
  FULL_EMBEDDING_DIM,
  MRL_ANN_DIM,
  truncateAndRenorm,
  annDimsForMrlFlag,
  prepareVectorForAnn,
} from '@/services/embedding-mrl';

describe('embedding-mrl', () => {
  it('annDimsForMrlFlag toggles 1024 ↔ 256', () => {
    expect(annDimsForMrlFlag(false)).toBe(FULL_EMBEDDING_DIM);
    expect(annDimsForMrlFlag(true)).toBe(MRL_ANN_DIM);
  });

  it('truncateAndRenorm keeps prefix and unit-norms', () => {
    const vec = new Array(FULL_EMBEDDING_DIM).fill(0);
    vec[0] = 3;
    vec[1] = 4;
    vec[255] = 1;
    vec[256] = 100; // must be dropped
    const out = truncateAndRenorm(vec, MRL_ANN_DIM);
    expect(out).toHaveLength(MRL_ANN_DIM);
    expect(out[256]).toBeUndefined();
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('prepareVectorForAnn truncates oversized and rejects undersized', () => {
    const full = new Array(FULL_EMBEDDING_DIM).fill(0.01);
    const prepared = prepareVectorForAnn(full, MRL_ANN_DIM);
    expect(prepared).toHaveLength(MRL_ANN_DIM);

    expect(prepareVectorForAnn(new Array(128).fill(0.1), MRL_ANN_DIM)).toBeNull();

    const exact = new Array(MRL_ANN_DIM).fill(0.02);
    expect(prepareVectorForAnn(exact, MRL_ANN_DIM)).toHaveLength(MRL_ANN_DIM);
  });
});
