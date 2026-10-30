/**
 * LevelStore getChunk / countExisting / namespaceStats (1.0.97 B19).
 *
 *  - getChunk used to decode every row in one loop, so a single corrupt row
 *    threw for the whole chunk and every full walk stopped there on every
 *    scan. Rows are now decoded one by one and reported as `skipped`.
 *  - countExisting answers "how many of these keys exist" without decoding or
 *    returning rows (the catalog sync resume used to fetch ~155k rows).
 *  - namespaceStats feeds the storage panel with live LevelDB numbers.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  collectChunkLenient,
  countExistingWith,
  namespaceStatsWith,
  type LevelHandleLike,
} from '../../../electron/storage/level-store';

async function* iterate(rows: Array<[string, string]>): AsyncGenerator<[string, string]> {
  for (const r of rows) yield r;
}

describe('collectChunkLenient (getChunk decode)', () => {
  it('returns the healthy rows of a chunk with one corrupt row, plus the skipped key', async () => {
    const res = await collectChunkLenient<{ n: number }>('catalog-entries', iterate([
      ['catalog-entries::1', JSON.stringify({ n: 1 })],
      ['catalog-entries::2', '{broken'],
      ['catalog-entries::3', JSON.stringify({ n: 3 })],
    ]), 10);
    expect(res.rows).toEqual([
      { key: '1', value: { n: 1 } },
      { key: '3', value: { n: 3 } },
    ]);
    expect(res.skipped).toEqual(['2']);
    expect(res.done).toBe(true);
  });

  it('advances nextKey past a trailing corrupt row and keeps a full page "not done"', async () => {
    const res = await collectChunkLenient<{ n: number }>('ns', iterate([
      ['ns::a', JSON.stringify({ n: 1 })],
      ['ns::b', 'nope'],
    ]), 2);
    // The page was full (2 raw rows for limit 2): the walk must continue after 'b',
    // not stop (done) or re-read from 'a' (nextKey).
    expect(res.done).toBe(false);
    expect(res.nextKey).toBe('b');
    expect(res.rows).toHaveLength(1);
  });

  it('an empty slice is done with no nextKey', async () => {
    const res = await collectChunkLenient('ns', iterate([]), 5);
    expect(res).toEqual({ rows: [], nextKey: undefined, done: true, skipped: [] });
  });
});

function fakeHandle(entries: Record<string, string>, sizes: Record<string, number> = {}): LevelHandleLike & { getManyCalls: string[][] } {
  const getManyCalls: string[][] = [];
  return {
    getManyCalls,
    async getMany(keys) {
      getManyCalls.push(keys);
      return keys.map((k) => entries[k]);
    },
    iterator(opts) {
      const gte = String(opts.gte);
      const lt = String(opts.lt);
      const keys = Object.keys(entries).filter((k) => k >= gte && k < lt).sort();
      return {
        async *[Symbol.asyncIterator]() { for (const k of keys) yield k; },
        close: async () => {},
      } as AsyncIterable<unknown> & { close(): Promise<void> };
    },
    approximateSize: async (start) => sizes[start] ?? 0,
  };
}

describe('countExistingWith', () => {
  it('counts present keys among a mix of present and missing, without decoding values', async () => {
    const db = fakeHandle({
      'catalog-entries::10': '{"appid":10}',
      'catalog-entries::30': 'not even json',
    });
    const n = await countExistingWith(db, 'catalog-entries', ['10', '20', '30', '40']);
    expect(n).toBe(2); // the corrupt row still exists — it is counted, never parsed
    expect(db.getManyCalls).toEqual([[
      'catalog-entries::10', 'catalog-entries::20', 'catalog-entries::30', 'catalog-entries::40',
    ]]);
  });

  it('returns 0 for no keys without touching the db', async () => {
    const db = fakeHandle({});
    expect(await countExistingWith(db, 'catalog-entries', [])).toBe(0);
    expect(db.getManyCalls).toHaveLength(0);
  });
});

describe('namespaceStatsWith', () => {
  it('counts keys per namespace and reports approximateSize over its range', async () => {
    const db = fakeHandle({
      'catalog-entries::1': '{}',
      'catalog-entries::2': '{}',
      'catalog-meta::sync-state': '{}',
      'catalog-entriesx::9': '{}', // different namespace sharing a prefix
    }, { 'catalog-entries::': 4096, 'catalog-meta::': 128 });
    const stats = await namespaceStatsWith(db, ['catalog-entries', 'catalog-meta', 'embed-library']);
    expect(stats).toEqual([
      { namespace: 'catalog-entries', count: 2, sizeBytes: 4096 },
      { namespace: 'catalog-meta', count: 1, sizeBytes: 128 },
      { namespace: 'embed-library', count: 0, sizeBytes: 0 },
    ]);
  });
});
