/**
 * Epic Catalog Store — migration regression tests (v1.0.65 hotfix).
 * Mirrors catalog-store-migration.test.ts; same bug class, same fixes.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EpicCatalogStore, type EpicCatalogEntry } from './epic-catalog-store';

const ENTRIES_NS = 'epic-catalog-entries';
const MIGRATION_MARKER = 'ark-epic-catalog-migrated-v1';
const IDB_NAME = 'ark-epic-catalog';

function makeEntry(n: number): EpicCatalogEntry {
  return {
    epicId: `ns:${n}`,
    namespace: 'ns',
    offerId: String(n),
    name: `Epic Game ${n}`,
    genres: ['Game'],
    themes: [],
    modes: [],
    developer: 'Dev',
    publisher: 'Pub',
    description: '',
    longDescription: '',
    releaseDate: 0,
    coverUrl: '',
    isFree: false,
  } as EpicCatalogEntry;
}

async function seedIdb(entries: EpicCatalogEntry[], meta: Record<string, unknown> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'epicId' });
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

function installFakeStore(initial: Record<string, unknown> = {}) {
  const db = new Map<string, unknown>(Object.entries(initial));
  const calls = { batch: 0 };
  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
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
    put: async (ns: string, key: string, value: unknown) => { db.set(`${ns}::${key}`, value); return { ok: true }; },
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

describe('EpicCatalogStore migration — has()-true no longer proves completion', () => {
  it('completes the full migration even when LevelDB already has partial rows', async () => {
    await seedIdb(Array.from({ length: 8 }, (_, i) => makeEntry(i + 1)));
    const { db } = installFakeStore({
      [`${ENTRIES_NS}::ns:1`]: makeEntry(1),
    });

    const store = new EpicCatalogStore();
    const count = await store.getEntryCount();

    expect(count).toBe(8);
    let entryRows = 0;
    for (const k of db.keys()) if (k.startsWith(`${ENTRIES_NS}::`)) entryRows++;
    expect(entryRows).toBe(8);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('EpicCatalogStore migration — missing sync-state no longer skips real data', () => {
  it('migrates existing entries even without a legacy sync-state row', async () => {
    await seedIdb(Array.from({ length: 4 }, (_, i) => makeEntry(100 + i)));
    installFakeStore();

    const store = new EpicCatalogStore();
    const count = await store.getEntryCount();
    expect(count).toBe(4);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('EpicCatalogStore migration — retry after failure', () => {
  it('retries on a later call after a transient failure', async () => {
    await seedIdb([makeEntry(1), makeEntry(2)]);
    installFakeStore();

    const store = new EpicCatalogStore();
    const originalBatch = (window as any).store.batch;
    let failOnce = true;
    (window as any).store.batch = async (ops: any[]) => {
      if (failOnce) { failOnce = false; return { error: 'simulated_failure' }; }
      return originalBatch(ops);
    };

    const first = await store.getEntryCount();
    expect(first).toBe(0);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();

    const second = await store.getEntryCount();
    expect(second).toBe(2);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('EpicCatalogStore migration — concurrent callers share one attempt', () => {
  it('two concurrent calls both see the complete result from a single migration pass', async () => {
    await seedIdb(Array.from({ length: 15 }, (_, i) => makeEntry(i + 1)));
    const { calls } = installFakeStore();

    const store = new EpicCatalogStore();
    const [a, b] = await Promise.all([store.getEntryCount(), store.getEntryCount()]);
    expect(a).toBe(15);
    expect(b).toBe(15);
    expect(calls.batch).toBe(1);
  });
});
