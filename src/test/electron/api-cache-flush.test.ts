/**
 * HLTB and gg.deals disk caches are flushed by the quit path (they used to rely
 * only on the 15 s debounced save, losing the last lookups).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const disk = new Map<string, Record<string, unknown>>();
const instances: FakeCache[] = [];

class FakeCache {
  store = new Map<string, unknown>();
  constructor(public filename: string) { instances.push(this); }
  get<T>(key: string): T | null { return (this.store.get(key) as T) ?? null; }
  set<T>(key: string, data: T): void { this.store.set(key, data); }
  flushSync(): void { disk.set(this.filename, Object.fromEntries(this.store)); }
}

vi.mock('../../../electron/persistent-cache.js', () => ({ PersistentCache: FakeCache }));
vi.mock('../../../electron/settings-store.js', () => ({ settingsStore: { getGgDealsKey: () => '' } }));

import { flushHltbCache, getHltbClient } from '../../../electron/hltb-api';
import { flushGgDealsCache, getGgDealsClient } from '../../../electron/ggdeals-api';

describe('quit-time flush of the HLTB / gg.deals caches', () => {
  beforeEach(() => disk.clear());

  it('is a no-op before either client was created', () => {
    expect(() => { flushHltbCache(); flushGgDealsCache(); }).not.toThrow();
    expect(disk.size).toBe(0);
  });

  it('writes a just-set HLTB entry to disk', async () => {
    await getHltbClient();
    const cache = instances.find((c) => c.filename === 'hltb-cache.json')!;
    cache.set('hltb:elden ring', { main: 60 });
    flushHltbCache();
    expect(disk.get('hltb-cache.json')).toEqual({ 'hltb:elden ring': { main: 60 } });
  });

  it('writes a just-set gg.deals entry to disk', async () => {
    await getGgDealsClient();
    const cache = instances.find((c) => c.filename === 'ggdeals-cache.json')!;
    cache.set('gg:570', { price: 0 });
    flushGgDealsCache();
    expect(disk.get('ggdeals-cache.json')).toEqual({ 'gg:570': { price: 0 } });
  });
});
