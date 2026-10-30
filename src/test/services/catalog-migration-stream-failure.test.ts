/**
 * Catalog IDB → LevelDB migration stream settles when a batch write fails
 * (1.0.97 B19, renderer-stores#4).
 *
 * Both catalog stores streamed the legacy IndexedDB with a cursor that chains
 * LevelDB batch writes on a `pending` promise. When a write failed while the
 * cursor was still reading, the stream stopped reading but never resolved or
 * rejected: the migration promise stayed pending, so isFresh / getEntryCount
 * / sync / queryForCandidates (Oracle, release calendar, Epic browse) waited
 * forever, and the rethrown rejection went unhandled. Uses a real (fake)
 * IndexedDB so the actual cursor path runs.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idbStreamStoreBatches } from '@/services/idb-stream';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

async function seedIdb(dbName: string, keyPath: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('entries', 'readwrite');
      for (const r of rows) tx.objectStore('entries').put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** window.store whose Nth `batch` call (1-based) reports an error. */
function installStoreFailingBatch(failOn: number) {
  let batchCalls = 0;
  const fake = {
    get: async () => ({ value: null }),
    put: async () => ({ ok: true }),
    getChunk: async () => ({ rows: [], done: true }),
    batch: vi.fn(async () => {
      batchCalls++;
      return batchCalls === failOn ? { error: 'disk full' } : { ok: true };
    }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return fake;
}

/** Resolves to 'timeout' if `p` hasn't settled within `ms` (the old behaviour: never). */
function settleWithin<T>(p: Promise<T>, ms = 3000): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

beforeEach(() => {
  localStorage.clear();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  await deleteDb('ark-steam-catalog');
  await deleteDb('ark-epic-catalog');
  await deleteDb('b19-stream');
  localStorage.clear();
});

describe('idbStreamStoreBatches', () => {
  it('rejects (once) when the 2nd of 3+ batches fails, without reading further batches', async () => {
    await seedIdb('b19-stream', 'id', Array.from({ length: 1700 }, (_, i) => ({ id: i })));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('b19-stream', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    let calls = 0;
    const onBatch = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('write failed');
    });
    const result = await settleWithin(
      idbStreamStoreBatches(db, 'entries', onBatch, 500, '[test]').then(() => 'resolved', (e) => e as Error),
    );
    db.close();
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('write failed');
    expect(onBatch).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it('streams every row and resolves the count when all writes succeed', async () => {
    await seedIdb('b19-stream', 'id', Array.from({ length: 1201 }, (_, i) => ({ id: i })));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('b19-stream', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const sizes: number[] = [];
    const count = await idbStreamStoreBatches<{ id: number }>(db, 'entries', async (rows) => { sizes.push(rows.length); }, 500, '[test]');
    db.close();
    expect(count).toBe(1201);
    expect(sizes).toEqual([500, 500, 201]);
  });
});

describe('CatalogStore (Steam) migration with a failing batch write', () => {
  it('settles, clears the in-flight migration, counts the attempt and leaves the marker unset', async () => {
    await seedIdb('ark-steam-catalog', 'appid', Array.from({ length: 1600 }, (_, i) => ({ appid: i + 1, name: `G${i}` })));
    const fake = installStoreFailingBatch(2);
    const { CatalogStore, __resetCatalogStoreSessionState } = await import('@/services/catalog-store');
    __resetCatalogStoreSessionState();
    const store = new CatalogStore();

    const result = await settleWithin(store.getEntryCount());
    expect(result).not.toBe('timeout');
    expect(fake.batch).toHaveBeenCalledTimes(2);
    expect((store as any)._migrationPromise).toBeNull();
    expect((store as any)._migrationAttempts).toBe(1);
    expect((store as any)._migrationChecked).toBe(false);
    expect(localStorage.getItem('ark-steam-catalog-migrated-v1')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });
});

describe('EpicCatalogStore migration with a failing batch write', () => {
  it('settles, clears the in-flight migration, counts the attempt and leaves the marker unset', async () => {
    await seedIdb('ark-epic-catalog', 'epicId', Array.from({ length: 1600 }, (_, i) => ({ epicId: `ns:${String(i).padStart(5, '0')}`, name: `E${i}` })));
    const fake = installStoreFailingBatch(2);
    const { EpicCatalogStore, __resetEpicCatalogStoreSessionState } = await import('@/services/epic-catalog-store');
    __resetEpicCatalogStoreSessionState();
    const store = new EpicCatalogStore();

    const result = await settleWithin(store.getEntryCount());
    expect(result).not.toBe('timeout');
    expect(fake.batch).toHaveBeenCalledTimes(2);
    expect((store as any)._migrationPromise).toBeNull();
    expect((store as any)._migrationAttempts).toBe(1);
    expect((store as any)._migrationChecked).toBe(false);
    expect(localStorage.getItem('ark-epic-catalog-migrated-v1')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });
});
