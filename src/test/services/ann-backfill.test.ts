import { describe, it, expect } from 'vitest';
import { partitionEmbeddingRowsForAnnBackfill } from '@/services/embedding-service';

describe('partitionEmbeddingRowsForAnnBackfill', () => {
  it('splits rows into flush-sized batches without dropping items', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `g${i}`,
      vector: [i],
    }));
    const batches = partitionEmbeddingRowsForAnnBackfill(rows, 500);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(500);
    expect(batches[1]).toHaveLength(500);
    expect(batches[2]).toHaveLength(200);
    expect(batches.flatMap((b) => b.map((r) => r.id))).toEqual(rows.map((r) => r.id));
  });

  it('returns a single batch when rows fit in batchSize', () => {
    const rows = [
      { id: 'a', vector: [1] },
      { id: 'b', vector: [2] },
    ];
    expect(partitionEmbeddingRowsForAnnBackfill(rows, 500)).toEqual([rows]);
  });

  it('returns empty array for empty input', () => {
    expect(partitionEmbeddingRowsForAnnBackfill([], 500)).toEqual([]);
  });

  it('rejects non-positive batchSize', () => {
    expect(() => partitionEmbeddingRowsForAnnBackfill([{ id: 'x', vector: [0] }], 0)).toThrow(
      /batchSize/,
    );
  });
});
