/**
 * 1.0.98 perf: vectors cross the ANN IPC as tight Float32Arrays.
 *
 * A `number[]` of 1024 doubles is walked element by element by the context bridge and by the structured clone: a 500-vector
 * backfill batch froze the renderer for 150-500 ms (measured as the renderer long task during Oracle / Upcoming / Settings
 * whenever a background ANN backfill overlapped). A typed array that is a view into a bigger buffer would drag that whole
 * buffer across, so views are copied first.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { annIndex, toIpcEntries, toIpcVector } from '@/services/ann-index';

describe('toIpcVector', () => {
  it('keeps a tight Float32Array as it is (no copy)', () => {
    const v = new Float32Array([0.5, 1, 2]);
    expect(toIpcVector(v)).toBe(v);
  });

  it('copies a view into a larger buffer so the whole buffer is not cloned', () => {
    const big = new Float32Array(4096).fill(0.25);
    const view = big.subarray(1024, 2048);
    const out = toIpcVector(view);
    expect(out).not.toBe(view);
    expect(out.length).toBe(1024);
    expect(out.buffer.byteLength).toBe(1024 * 4);
    expect(out[0]).toBe(0.25);
  });

  it('copies a view that starts at offset 0 but is shorter than its buffer', () => {
    const big = new Float32Array(2048).fill(1);
    const out = toIpcVector(big.subarray(0, 1024));
    expect(out.buffer.byteLength).toBe(1024 * 4);
  });

  it('turns a plain number[] into a Float32Array with the same values', () => {
    const out = toIpcVector([0.1, -2, 3]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual(Array.from(new Float32Array([0.1, -2, 3])));
  });

  it('keeps non-finite values non-finite so the main process still rejects the vector', () => {
    const out = toIpcVector([1, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('toIpcEntries', () => {
  it('maps ids through and leaves the inputs untouched', () => {
    const a = { id: 'a', vector: [1, 2, 3] };
    const out = toIpcEntries([a]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(a.vector).toEqual([1, 2, 3]);
    expect(out[0].vector).toBeInstanceOf(Float32Array);
  });
});

describe('annIndex wire format', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'ann');
  });

  it('addVectors sends Float32Arrays, and the resend after an aborted call sends the same ones', async () => {
    const calls: Array<Array<{ id: string; vector: unknown }>> = [];
    let n = 0;
    const api = {
      load: vi.fn(async () => true),
      save: vi.fn(async () => true),
      addVectors: vi.fn(async (entries: Array<{ id: string; vector: unknown }>) => {
        calls.push(entries);
        return n++ === 0 ? { added: 0, replaced: 0, failed: 0, aborted: true } : { added: entries.length, replaced: 0, failed: 0, aborted: false };
      }),
      query: vi.fn(async () => []),
      queryBatch: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ready: true, vectorCount: 1, dims: 1024, partial: false })),
      clear: vi.fn(async () => true),
    };
    Object.defineProperty(window, 'ann', { value: api, writable: true, configurable: true });

    const added = await annIndex.addVectors([{ id: 'g1', vector: [0.5, 0.25] }, { id: 'g2', vector: new Float32Array([1, 2]) }]);

    expect(added).toBe(2);
    expect(calls).toHaveLength(2);
    for (const entries of calls) for (const e of entries) expect(e.vector).toBeInstanceOf(Float32Array);
    expect(calls[1]).toBe(calls[0]);
  });
});
