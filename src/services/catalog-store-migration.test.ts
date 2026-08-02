/**
 * Steam Catalog Store — migration regression tests (v1.0.65 hotfix).
 *
 * These target the 6 confirmed bugs found by adversarial review of the
 * initial v1.0.65 migration implementation, using a REAL (fake) IndexedDB
 * so the actual `idbStreamAllEntries` cursor path runs, not a mock:
 *
 *  1. `store.has()`-true no longer short-circuits migration as "complete" —
 *     partial LevelDB rows from a crashed prior attempt must not cause the
 *     marker to be prematurely stamped.
 *  2. A missing/zero legacy `sync-state` no longer skips migration outright —
 *     the store now always attempts the real IDB stream, which correctly
 *     migrates rows that exist despite absent/stale meta.
 *  3./4. `idbStreamAllEntries`'s cursor `onerror` now rejects (not silently
 *     resolves with a partial count), and the migration marker is only
 *     stamped on real success.
 *  5. A failed migration attempt does NOT set `_migrationChecked`, so a
 *     later call retries.
 *  6. Concurrent callers share one in-flight migration (verified via the
 *     LevelDB write count staying consistent with a single full pass).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CatalogEntry } from '@/types/catalog';
import { CatalogStore } from './catalog-store';

const ENTRIES_NS = 'catalog-entries';
const META_NS = 'catalog-meta';
const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';
const IDB_NAME = 'ark-steam-catalog';

function makeEntry(appid: number): CatalogEntry {
  return {
    appid,
    name: `Game ${appid}`,
    genres: ['Action'],
    themes: [],
    modes: [],
    developer: 'Dev',
    publisher: 'Pub',
    shortDescription: '',
    releaseDate: 0,
    reviewScore: 8,
    reviewCount: 100,
    reviewPositivity: 0.8,
    windows: true,
    mac: false,
    linux: false,
    steamDeckCompat: 0,
    isFree: false,
    tagIds: [],
  } as CatalogEntry;
}

/** Seed the real (fake) IndexedDB database with entries + optional meta rows. */
async function seedIdb(entries: CatalogEntry[], meta: Record<string, unknown> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'appid' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['entries', 'meta'], 'readwrite');
      const entriesStore = tx.objectStore('entries');
      const metaStore = tx.objectStore('meta');
      for (const e of entries) entriesStore.put(e);
      for (const [k, v] of Object.entries(meta)) metaStore.put({ key: k, value: v });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function installFakeStore(initialEntries: Record<string, unknown> = {}) {
  const db = new Map<string, unknown>(Object.entries(initialEntries));
  const calls = { batch: 0, has: 0, get: 0, put: 0 };

  const fake = {
    get: async (ns: string, key: string) => {
      calls.get++;
      return { value: db.get(`${ns}::${key}`) ?? null };
    },
    getAll: async (ns: string) => {
      const rows: Array<{ key: string; value: unknown }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      return { rows };
    },
    getChunk: async (ns: string, { startAfter, limit }: { startAfter?: string; limit: number }) => {
      const prefix = `${ns}::`;
      const keys: string[] = [];
      for (const k of db.keys()) if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      keys.sort();
      const startIdx = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
      const eff = startIdx < 0 ? keys.length : startIdx;
      const slice = keys.slice(eff, eff + limit);
      const rows = slice.map((k) => ({ key: k, value: db.get(`${ns}::${k}`) }));
      return { rows, nextKey: rows.length > 0 ? rows[rows.length - 1].key : undefined, done: rows.length < limit };
    },
    put: async (ns: string, key: string, value: unknown) => {
      calls.put++;
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns: string, key: string) => { db.delete(`${ns}::${key}`); return { ok: true }; },
    batch: async (ops: any[]) => {
      calls.batch++;
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else if (op.type === 'del') db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    has: async (ns: string) => {
      calls.has++;
      const prefix = `${ns}::`;
      for (const k of db.keys()) if (k.startsWith(prefix)) return { value: true };
      return { value: false };
    },
    clearNamespace: async (ns: string) => {
      const prefix = `${ns}::`;
      for (const k of Array.from(db.keys())) if (k.startsWith(prefix)) db.delete(k);
      return { ok: true };
    },
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, calls };
}

async function deleteIdbDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
  await deleteIdbDatabase();
});

describe('CatalogStore migration — has()-true no longer proves completion', () => {
  it('does not stamp the marker just because LevelDB has some rows from a crashed prior attempt', async () => {
    // Real IDB has 10 legacy entries; LevelDB already has 2 of them (as if
    // a previous migration attempt crashed after writing only 2 batches),
    // but the marker was never stamped.
    await seedIdb(
      Array.from({ length: 10 }, (_, i) => makeEntry(i + 1)),
      { 'sync-state': { lastSyncTimestamp: Date.now(), totalEntries: 10, batchesCompleted: 1, batchesTotal: 1, inProgress: false } },
    );
    const { db } = installFakeStore({
      [`${ENTRIES_NS}::1`]: makeEntry(1),
      [`${ENTRIES_NS}::2`]: makeEntry(2),
    });

    const store = new CatalogStore();
    const count = await store.getEntryCount();

    // The old buggy behavior: has()===true -> stamp marker immediately,
    // leaving only 2/10 entries migrated. The fix must complete the full
    // migration regardless of pre-existing partial rows.
    expect(count).toBe(10);
    let entryRows = 0;
    for (const k of db.keys()) if (k.startsWith(`${ENTRIES_NS}::`)) entryRows++;
    expect(entryRows).toBe(10);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('CatalogStore migration — absent/stale legacy sync-state no longer skips real data', () => {
  it('migrates existing IDB entries even when sync-state meta is missing', async () => {
    // 5 real entries in IDB but NO sync-state meta row at all (simulates a
    // crash before the legacy app ever wrote its trailing meta write).
    await seedIdb(Array.from({ length: 5 }, (_, i) => makeEntry(100 + i)));
    installFakeStore();

    const store = new CatalogStore();
    const count = await store.getEntryCount();

    // Old buggy behavior: !legacySync -> stamp marker, skip migration,
    // orphaning all 5 real rows. Fixed behavior: always stream IDB.
    expect(count).toBe(5);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });

  it('stamps the marker with zero entries when IDB genuinely has nothing', async () => {
    await deleteIdbDatabase(); // ensure truly empty / no legacy DB at all
    installFakeStore();

    const store = new CatalogStore();
    const count = await store.getEntryCount();
    expect(count).toBe(0);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('CatalogStore migration — sync-state uses actual migrated count, not legacy meta', () => {
  it('persists the real streamed count even if legacy meta claimed a different number', async () => {
    // Legacy meta over-claims 999 entries but IDB actually only has 3.
    await seedIdb(
      [makeEntry(1), makeEntry(2), makeEntry(3)],
      { 'sync-state': { lastSyncTimestamp: Date.now(), totalEntries: 999, batchesCompleted: 1, batchesTotal: 1, inProgress: false } },
    );
    installFakeStore();

    const store = new CatalogStore();
    const count = await store.getEntryCount();
    expect(count).toBe(3); // real count, not the stale 999 claim
  });
});

describe('CatalogStore migration — retry after failure', () => {
  it('does not permanently lock out migration when the first attempt fails', async () => {
    await seedIdb([makeEntry(1), makeEntry(2)]);
    const { calls } = installFakeStore();

    const store = new CatalogStore();
    // Force the first migration attempt's batch write to fail.
    const originalBatch = (window as any).store.batch;
    let failOnce = true;
    (window as any).store.batch = async (ops: any[]) => {
      if (failOnce) {
        failOnce = false;
        return { error: 'simulated_transient_failure' };
      }
      return originalBatch(ops);
    };

    // First call: migration should fail internally (batch put throws) and
    // NOT mark the store as migrated.
    const countAfterFailedAttempt = await store.getEntryCount();
    expect(countAfterFailedAttempt).toBe(0);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();

    // Second call on the SAME instance: must retry (not permanently
    // disabled by a stuck _migrationChecked flag) and succeed this time.
    const countAfterRetry = await store.getEntryCount();
    expect(countAfterRetry).toBe(2);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('CatalogStore migration — concurrent callers share one attempt', () => {
  it('two callers invoked back-to-back both see the fully migrated result, and only one migration pass runs', async () => {
    await seedIdb(Array.from({ length: 20 }, (_, i) => makeEntry(i + 1)));
    const { calls } = installFakeStore();

    const store = new CatalogStore();
    // Fire two public methods concurrently before either's migration can
    // possibly finish — both must await the SAME in-flight migration.
    const [countA, countB] = await Promise.all([
      store.getEntryCount(),
      store.getEntryCount(),
    ]);
    expect(countA).toBe(20);
    expect(countB).toBe(20);

    // Batch calls should reflect one full migration pass (20 entries in a
    // single batch of size <=500 => exactly 1 batch call), not two
    // independent full passes (which would be 2 batch calls of 20 each).
    expect(calls.batch).toBe(1);
  });
});
