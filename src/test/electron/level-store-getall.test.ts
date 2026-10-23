/**
 * LevelStore getAll — per-row decode (reliability audit item 3).
 *
 * A single corrupt LevelDB row used to make getAllImpl throw for the whole
 * namespace, which pushed the renderer stores onto their stale legacy
 * localStorage snapshot. Corrupt rows must now be skipped (and logged) while
 * every healthy row is still returned.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { collectRowsLenient } from '../../../electron/storage/level-store';

async function* iterate(rows: Array<[string, string]>): AsyncGenerator<[string, string]> {
  for (const r of rows) yield r;
}

describe('collectRowsLenient (getAll decode)', () => {
  it('skips a corrupt row and returns the healthy ones', async () => {
    const { rows, corruptKeys } = await collectRowsLenient<{ n: number }>('library', iterate([
      ['library::a', JSON.stringify({ n: 1 })],
      ['library::bad', '{not json'],
      ['library::c', JSON.stringify({ n: 3 })],
    ]));
    expect(rows).toEqual([
      { key: 'a', value: { n: 1 } },
      { key: 'c', value: { n: 3 } },
    ]);
    expect(corruptKeys).toEqual(['bad']);
  });

  it('returns an empty list for an empty namespace', async () => {
    const { rows, corruptKeys } = await collectRowsLenient('session', iterate([]));
    expect(rows).toEqual([]);
    expect(corruptKeys).toEqual([]);
  });
});
