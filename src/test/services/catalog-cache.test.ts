/**
 * Steam app-list cache layout (1.0.97 perf gate): the 155k-app list is stored as a few dozen chunk rows,
 * not one IndexedDB row per app (155k `put` calls blocked the renderer for ~6 s on every launch that had
 * to rewrite the cache). Rows written by older builds are still read.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { setCachedCatalog, getCachedCatalog, clearCatalogCache, isCatalogStale } from '@/services/catalog-cache';

const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ appid: i + 1, name: `Game ${n - i}` }));

function rowCount(): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('ark-catalog-cache', 1);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('appList', 'readonly').objectStore('appList').count();
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('catalog-cache', () => {
  beforeEach(async () => {
    await clearCatalogCache();
  });

  it('round-trips a list larger than one chunk, in order', async () => {
    const list = apps(12_345);
    await setCachedCatalog(list);
    const back = await getCachedCatalog();
    expect(back).toHaveLength(12_345);
    expect(back[0]).toEqual(list[0]);
    expect(back[12_344]).toEqual(list[12_344]);
    expect(await isCatalogStale()).toBe(false);
  });

  it('stores chunk rows, not one row per app', async () => {
    await setCachedCatalog(apps(12_345));
    expect(await rowCount()).toBe(3); // 5000 + 5000 + 2345
  });

  it('replaces the previous list on a second write', async () => {
    await setCachedCatalog(apps(7000));
    await setCachedCatalog(apps(10));
    expect(await getCachedCatalog()).toHaveLength(10);
    expect(await rowCount()).toBe(1);
  });

  it('sorts A-Z on request', async () => {
    await setCachedCatalog(apps(20));
    const sorted = await getCachedCatalog({ sorted: true });
    expect(sorted.map((a) => a.name)).toEqual([...sorted.map((a) => a.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it('is stale and empty when nothing was stored', async () => {
    expect(await isCatalogStale()).toBe(true);
    expect(await getCachedCatalog()).toEqual([]);
  });

  it('still reads one-app-per-row data written by older builds', async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('ark-catalog-cache', 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('appList', 'readwrite');
        const store = tx.objectStore('appList');
        store.clear();
        for (const a of apps(50)) store.put(a);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const back = await getCachedCatalog();
    expect(back).toHaveLength(50);
    expect(back[0]).toEqual({ appid: 1, name: 'Game 50' });
  });
});
