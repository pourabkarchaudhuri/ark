/**
 * level-stream — chunked LevelDB walks report incomplete scans (1.0.97 B19).
 *
 * The stream helpers used to `break` on the first failed getChunk hop and
 * return the partial count as if the namespace had ended. A hop is now
 * retried once; a second failure ends the walk with `complete: false`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getChunkWithRetry, levelStreamNamespace } from '@/services/level-stream';
import { storeCountExisting } from '@/services/store-bulk';

type Row = { key: string; value: number };

/** getChunk over `n` numeric rows, with an optional failure plan per call index. */
function installChunkStore(n: number, fail: (call: number, startAfter?: string) => 'error' | 'throw' | null) {
  const keys = Array.from({ length: n }, (_, i) => String(i).padStart(4, '0'));
  let call = 0;
  const getChunk = vi.fn(async (_ns: string, { startAfter, limit }: { startAfter?: string; limit: number }) => {
    const mode = fail(call++, startAfter);
    if (mode === 'throw') throw new Error('ipc down');
    if (mode === 'error') return { error: 'rate_limited' };
    const start = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
    const eff = start < 0 ? keys.length : start;
    const rows: Row[] = keys.slice(eff, eff + limit).map((k) => ({ key: k, value: Number(k) }));
    return { rows, nextKey: rows.length ? rows[rows.length - 1].key : undefined, done: rows.length < limit };
  });
  Object.defineProperty(window, 'store', { value: { getChunk }, writable: true, configurable: true });
  return getChunk;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getChunkWithRetry', () => {
  it('retries a failed hop once and returns the second answer', async () => {
    const getChunk = installChunkStore(3, (call) => (call === 0 ? 'error' : null));
    const page = await getChunkWithRetry<number>('ns', { limit: 10 }, '[t]');
    expect(page?.rows.map((r) => r.value)).toEqual([0, 1, 2]);
    expect(getChunk).toHaveBeenCalledTimes(2);
  });

  it('returns null after two failures (error envelope, then a throw)', async () => {
    const getChunk = installChunkStore(3, (call) => (call === 0 ? 'error' : 'throw'));
    expect(await getChunkWithRetry('ns', { limit: 10 }, '[t]')).toBeNull();
    expect(getChunk).toHaveBeenCalledTimes(2);
  });
});

describe('levelStreamNamespace', () => {
  it('walks every page and reports complete', async () => {
    installChunkStore(25, () => null);
    const seen: number[] = [];
    const res = await levelStreamNamespace<number>('ns', (r) => { seen.push(r.value); }, { pageSize: 10, label: '[t]' });
    expect(res).toEqual({ count: 25, complete: true });
    expect(seen).toHaveLength(25);
  });

  it('a transient failure mid-walk is retried and the walk still completes', async () => {
    installChunkStore(25, (call) => (call === 1 ? 'error' : null));
    const res = await levelStreamNamespace<number>('ns', () => {}, { pageSize: 10, label: '[t]' });
    expect(res).toEqual({ count: 25, complete: true });
  });

  it('a persistent failure stops the walk with complete:false and the partial count', async () => {
    installChunkStore(25, (_call, startAfter) => (startAfter === '0009' ? 'error' : null));
    const res = await levelStreamNamespace<number>('ns', () => {}, { pageSize: 10, label: '[t]' });
    expect(res).toEqual({ count: 10, complete: false });
  });
});

describe('storeCountExisting', () => {
  it('uses the count-only channel and sums across 10k-key calls', async () => {
    const countExisting = vi.fn(async (_ns: string, keys: string[]) => ({ count: Math.floor(keys.length / 2) }));
    const getMany = vi.fn();
    Object.defineProperty(window, 'store', { value: { countExisting, getMany }, writable: true, configurable: true });
    const keys = Array.from({ length: 12_000 }, (_, i) => String(i));
    expect(await storeCountExisting('catalog-entries', keys)).toBe(5000 + 1000);
    expect(countExisting).toHaveBeenCalledTimes(2);
    expect(getMany).not.toHaveBeenCalled();
  });

  it('falls back to getMany slices on an older preload', async () => {
    const getMany = vi.fn(async (_ns: string, keys: string[]) => ({ values: keys.map((k) => (Number(k) % 3 === 0 ? { k } : null)) }));
    Object.defineProperty(window, 'store', { value: { getMany }, writable: true, configurable: true });
    const keys = Array.from({ length: 4500 }, (_, i) => String(i));
    expect(await storeCountExisting('catalog-entries', keys)).toBe(1500);
    expect(getMany).toHaveBeenCalledTimes(3); // 2000-key slices
  });

  it('throws when the channel reports an error (callers must not read it as 0 stored)', async () => {
    const countExisting = vi.fn(async () => ({ error: 'rate_limited' }));
    Object.defineProperty(window, 'store', { value: { countExisting }, writable: true, configurable: true });
    await expect(storeCountExisting('catalog-entries', ['1'])).rejects.toThrow(/rate_limited/);
  });
});
