/**
 * Steam Catalog Store — sync robustness (v1.0.73).
 *  - getEntries uses one bulk `store.getMany` round trip (no rate-limited fan-out)
 *  - concurrent sync() callers share one run
 *  - failed batches get one retry round; a run that still misses batches is not stamped fresh
 *  - an empty tag list (GetTagList failure) is never cached
 *  - a migration that keeps failing falls back to IDB for the session instead of re-streaming per call
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';

function installFakeStore(opts: { failBatch?: boolean; withGetMany?: boolean } = {}) {
  const db = new Map<string, unknown>();
  const calls = { get: 0, getMany: 0, batch: 0 };
  const fake: Record<string, unknown> = {
    get: async (ns: string, key: string) => { calls.get++; return { value: db.get(`${ns}::${key}`) ?? null }; },
    getChunk: async () => ({ rows: [], done: true }),
    put: async (ns: string, key: string, value: unknown) => { db.set(`${ns}::${key}`, value); return { ok: true }; },
    batch: async (ops: any[]) => {
      calls.batch++;
      if (opts.failBatch) return { error: 'simulated_failure' };
      for (const op of ops) if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
      return { ok: true };
    },
    has: async () => ({ value: false }),
  };
  if (opts.withGetMany !== false) {
    fake.getMany = async (ns: string, keys: string[]) => {
      calls.getMany++;
      return { values: keys.map((k) => db.get(`${ns}::${k}`) ?? null) };
    };
  }
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, calls };
}

const item = (appid: number) => ({ appid, success: 1, visible: true, name: `Game ${appid}`, tags: [{ tagid: 19 }] });

function installSteam(fetchCatalogBatch: (ids: number[]) => Promise<unknown[]>, tags = [{ tagid: 19, name: 'Action' }]) {
  const steam = {
    getAppList: vi.fn(async () => Array.from({ length: 600 }, (_, i) => ({ appid: i + 1, name: `g${i + 1}` }))),
    getTagList: vi.fn(async () => tags),
    fetchCatalogBatch: vi.fn(fetchCatalogBatch),
  };
  Object.defineProperty(window, 'steam', { value: steam, writable: true, configurable: true });
  return steam;
}

async function loadStore() {
  vi.resetModules(); // fresh module state (tag-map cache, session migration latch)
  const mod = await import('./catalog-store');
  return new mod.CatalogStore();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(MIGRATION_MARKER, 'yes');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'steam', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('CatalogStore.getEntries', () => {
  it('reads all ids in one getMany round trip', async () => {
    const { db, calls } = installFakeStore();
    for (const id of [1, 2, 3]) db.set(`catalog-entries::${id}`, { appid: id, name: `G${id}` });
    const store = await loadStore();
    const found = await store.getEntries(Array.from({ length: 1500 }, (_, i) => i + 1));
    expect(found.map((e) => e.appid)).toEqual([1, 2, 3]);
    expect(calls.getMany).toBe(1);
    expect(calls.get).toBe(0);
  });
});

describe('CatalogStore.sync', () => {
  it('shares one run between concurrent callers', async () => {
    installFakeStore();
    const steam = installSteam(async (ids) => ids.map(item));
    const store = await loadStore();
    await Promise.all([store.sync(), store.sync()]);
    expect(steam.getAppList).toHaveBeenCalledTimes(1);
    expect(await store.isFresh()).toBe(true);
    expect(await store.getEntryCount()).toBe(600);
  });

  it('retries a failed batch once and stamps fresh when it recovers', async () => {
    vi.useFakeTimers();
    installFakeStore();
    let failedOnce = false;
    installSteam(async (ids) => {
      if (ids[0] === 1 && !failedOnce) { failedOnce = true; throw new Error('IStoreBrowseService 429'); }
      return ids.map(item);
    });
    const store = await loadStore();
    const p = store.sync();
    await vi.runAllTimersAsync();
    await p;
    expect(await store.isFresh()).toBe(true);
    expect(await store.getEntryCount()).toBe(600);
  });

  it('does not stamp a run with persistent batch failures as fresh', async () => {
    vi.useFakeTimers();
    installFakeStore();
    installSteam(async (ids) => {
      if (ids[0] !== 1) throw new Error('IStoreBrowseService 429');
      return ids.map(item);
    });
    const store = await loadStore();
    const p = store.sync();
    await vi.runAllTimersAsync();
    await p;
    expect(await store.isFresh()).toBe(false);
    expect(await store.getLastSyncTimestamp()).toBe(0);
    expect(store.syncProgress.error).toMatch(/2 of 3 batches failed/);
  });

  it('never caches an empty tag list', async () => {
    const { db } = installFakeStore();
    const steam = installSteam(async (ids) => ids.map(item), []);
    const store = await loadStore();
    await store.sync();
    expect(db.has('catalog-meta::tag-name-map')).toBe(false);
    await store.sync(true);
    expect(steam.getTagList).toHaveBeenCalledTimes(2);
  });
});

describe('CatalogStore migration — session fallback', () => {
  it('stops re-running a failing migration after two attempts', async () => {
    localStorage.removeItem(MIGRATION_MARKER);
    // Seed IDB so the migration has rows to copy (and fails writing them).
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ark-steam-catalog', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('entries', { keyPath: 'appid' }); req.result.createObjectStore('meta'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve) => {
      const tx = idb.transaction('entries', 'readwrite');
      tx.objectStore('entries').put({ appid: 1, name: 'A' });
      tx.oncomplete = () => resolve();
    });
    idb.close();
    const { calls } = installFakeStore({ failBatch: true });
    const store = await loadStore();
    await store.getEntryCount();
    await store.getEntryCount();
    const batchesAfterTwo = calls.batch;
    expect(batchesAfterTwo).toBe(2);
    await store.getEntryCount();
    await store.isFresh();
    expect(calls.batch).toBe(batchesAfterTwo);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
