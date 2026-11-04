/**
 * Catalog sync when there is no network (1.0.97 perf gate: offline retry loops).
 *
 * The first pass used to try every batch (~780 at 200 ids) one after another, each a failing IPC call
 * with two attempts in the main process, and an empty catalog never cooled down, so every Oracle
 * visit started the whole pass again. Now 8 connection failures in a row with no success stop the
 * pass, the attempt is remembered, and the next sync inside the cooldown does nothing.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';
const OFFLINE_ERR = "Error invoking remote method 'steam:fetchCatalogBatch': Error: net::ERR_NAME_NOT_RESOLVED";

function installFakeStore() {
  const db = new Map<string, unknown>();
  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getMany: async (ns: string, keys: string[]) => ({ values: keys.map((k) => db.get(`${ns}::${k}`) ?? null) }),
    countExisting: async (ns: string, keys: string[]) => ({ count: keys.filter((k) => db.has(`${ns}::${k}`)).length }),
    getChunk: async () => ({ rows: [], done: true }),
    put: async (ns: string, key: string, value: unknown) => { db.set(`${ns}::${key}`, value); return { ok: true }; },
    batch: async (ops: any[]) => {
      for (const op of ops) if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
      return { ok: true };
    },
    has: async () => ({ value: false }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return db;
}

function installSteam(failWith: string) {
  const steam = {
    getAppList: vi.fn(async () => Array.from({ length: 3000 }, (_, i) => ({ appid: i + 1, name: `Game ${i + 1}` }))),
    getTagList: vi.fn(async () => [{ tagid: 19, name: 'Action' }]),
    fetchCatalogBatch: vi.fn(async () => { throw new Error(failWith); }),
  };
  Object.defineProperty(window, 'steam', { value: steam, writable: true, configurable: true });
  return steam;
}

async function loadStore() {
  vi.resetModules();
  const mod = await import('@/services/catalog-store');
  return { store: new mod.CatalogStore(), mod };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(MIGRATION_MARKER, 'yes');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'steam', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('CatalogStore offline', () => {
  it('stops the pass after a few connection failures instead of trying every batch', async () => {
    const db = installFakeStore();
    const steam = installSteam(OFFLINE_ERR);
    const { store } = await loadStore();

    await store.sync();

    // 15 batches exist; 8 failures in a row stop the queue (4 workers, so a few extra are already in flight)
    expect(steam.fetchCatalogBatch.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(steam.fetchCatalogBatch.mock.calls.length).toBeLessThanOrEqual(8 + 3);
    expect(store.syncProgress.stage).toBe('error');
    expect(store.syncProgress.error).toMatch(/reach Steam/i);

    const state = db.get('catalog-meta::sync-state') as { lastAttemptOffline?: boolean; pendingAppIds?: number[]; totalEntries: number };
    expect(state.lastAttemptOffline).toBe(true);
    expect(state.totalEntries).toBe(0);
    // the 3,000 ids are not persisted as a pending list when nothing was reachable
    expect(state.pendingAppIds ?? []).toHaveLength(0);
  });

  it('a second sync inside the cooldown does not touch the network, even with an empty catalog', async () => {
    installFakeStore();
    const steam = installSteam(OFFLINE_ERR);
    const { store } = await loadStore();

    await store.sync();
    steam.getAppList.mockClear();
    steam.fetchCatalogBatch.mockClear();
    await store.sync();

    expect(steam.getAppList).not.toHaveBeenCalled();
    expect(steam.fetchCatalogBatch).not.toHaveBeenCalled();
    expect(store.syncProgress.error).toMatch(/retrying in \d+ min/);
  });

  it('a forced sync still runs inside the cooldown (manual "sync now")', async () => {
    installFakeStore();
    const steam = installSteam(OFFLINE_ERR);
    const { store } = await loadStore();
    await store.sync();
    steam.fetchCatalogBatch.mockClear();
    await store.sync(true);
    expect(steam.fetchCatalogBatch).toHaveBeenCalled();
  });

  it('server-side failures (not connection failures) still try every batch', async () => {
    installFakeStore();
    const steam = installSteam('IStoreBrowseService 503');
    const { store } = await loadStore();

    await store.sync();

    expect(steam.fetchCatalogBatch.mock.calls.length).toBe(15);
  });

  it('classifies connection errors', async () => {
    const { mod } = await loadStore();
    expect(mod.isNetworkDownError(OFFLINE_ERR)).toBe(true);
    expect(mod.isNetworkDownError('net::ERR_INTERNET_DISCONNECTED')).toBe(true);
    expect(mod.isNetworkDownError('IStoreBrowseService 429')).toBe(false);
    expect(mod.isNetworkDownError('IStoreBrowseService 503')).toBe(false);
  });
});
