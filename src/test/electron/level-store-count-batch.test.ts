/**
 * LevelStore count + batch cap (1.0.97).
 *
 * Counting a pooled embedding namespace used to page every ~4 KB vector row
 * through JSON.parse and structured clone on the main process. `count` walks
 * a keys-only iterator instead. `batch` refuses more than STORE_BATCH_MAX_OPS
 * ops (the preload splits larger writes, see store-preload-batch.test).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  STORE_BATCH_MAX_OPS,
  __setLevelDbForTests,
  getLevelStore,
} from '../../../electron/storage/level-store';

/** Sorted in-memory stand-in for classic-level: honours gte/lt/gt/limit/values. */
function fakeDb(rows: Record<string, string>) {
  const iteratorOpts: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];
  const db = {
    iterator(opts: { gte?: string; gt?: string; lt?: string; limit?: number; values?: boolean }) {
      iteratorOpts.push(opts);
      const keys = Object.keys(rows).sort().filter((k) =>
        (opts.gte === undefined || k >= opts.gte) &&
        (opts.gt === undefined || k > opts.gt) &&
        (opts.lt === undefined || k < opts.lt));
      const picked = typeof opts.limit === 'number' ? keys.slice(0, opts.limit) : keys;
      return {
        async *[Symbol.asyncIterator]() {
          for (const k of picked) yield [k, opts.values === false ? undefined : rows[k]];
        },
        async close() {},
      };
    },
    async batch(ops: unknown[]) { batches.push(ops); },
  };
  return { db, iteratorOpts, batches };
}

function vectorRow(): string {
  return JSON.stringify({ q: Array.from({ length: 1024 }, (_, i) => i % 127) });
}

afterEach(() => {
  __setLevelDbForTests(null);
  vi.restoreAllMocks();
});

describe('count', () => {
  it('matches the namespace row count without decoding a single value', async () => {
    const { db, iteratorOpts } = fakeDb({
      'embed-catalog::steam-1': vectorRow(),
      'embed-catalog::steam-2': vectorRow(),
      'embed-catalog::epic-3': vectorRow(),
      'embed-library::steam-1': vectorRow(),
      'embed-catalogue::x': vectorRow(),
    });
    __setLevelDbForTests(db);
    const parse = vi.spyOn(JSON, 'parse');
    const res = await getLevelStore().count('embed-catalog');
    expect(res.count).toBe(3);
    expect(res.keys).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(iteratorOpts[0]).toMatchObject({ values: false });
  });

  it('optionally returns the keys (for the renderer key index), still keys-only', async () => {
    const { db } = fakeDb({ 'ns::b': vectorRow(), 'ns::a': vectorRow() });
    __setLevelDbForTests(db);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await getLevelStore().count('ns', { keys: true })).toEqual({ count: 2, keys: ['a', 'b'] });
    expect(parse).not.toHaveBeenCalled();
  });

  it('is 0 for an empty namespace and rejects bad namespaces', async () => {
    __setLevelDbForTests(fakeDb({}).db);
    expect((await getLevelStore().count('empty')).count).toBe(0);
    await expect(getLevelStore().count('a::b')).rejects.toThrow(/Namespace/);
  });
});

describe('batch cap', () => {
  const put = (i: number) => ({ type: 'put' as const, namespace: 'ns', key: `k${i}`, value: i });

  it('the cap is 5k ops', () => {
    expect(STORE_BATCH_MAX_OPS).toBe(5000);
  });

  it(`accepts ${STORE_BATCH_MAX_OPS} ops`, async () => {
    const { db, batches } = fakeDb({});
    __setLevelDbForTests(db);
    await getLevelStore().batch(Array.from({ length: STORE_BATCH_MAX_OPS }, (_, i) => put(i)));
    expect(batches).toHaveLength(1);
  });

  it(`rejects ${STORE_BATCH_MAX_OPS + 1} ops without writing anything`, async () => {
    const { db, batches } = fakeDb({});
    __setLevelDbForTests(db);
    await expect(getLevelStore().batch(Array.from({ length: STORE_BATCH_MAX_OPS + 1 }, (_, i) => put(i))))
      .rejects.toThrow(/capped at 5000/);
    expect(batches).toHaveLength(0);
  });
});
