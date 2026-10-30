/**
 * Catalog sync resume counts already-stored pending games without reading
 * them (1.0.97 B19, renderer-stores#29).
 *
 * Resuming an incomplete sync loaded and cloned the full rows of every
 * pending id (up to ~155k) over IPC only to use `.length`, every 15 minutes
 * while the catalog stayed incomplete. It now asks `store:countExisting`.
 * A failed count used to read as "0 stored" (`.catch(() => [])`), inflating
 * totalEntries by every pending game; it now falls back to the non-resume
 * arithmetic instead.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';
const DAY = 24 * 60 * 60 * 1000;

function installFakeStore(opts: { countFails?: boolean } = {}) {
  const db = new Map<string, unknown>();
  const countExisting = vi.fn(async (ns: string, keys: string[]) => {
    if (opts.countFails) return { error: 'rate_limited' };
    return { count: keys.filter((k) => db.has(`${ns}::${k}`)).length };
  });
  const getMany = vi.fn(async (ns: string, keys: string[]) => ({ values: keys.map((k) => db.get(`${ns}::${k}`) ?? null) }));
  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getMany,
    countExisting,
    getChunk: async () => ({ rows: [], done: true }),
    put: async (ns: string, key: string, value: unknown) => { db.set(`${ns}::${key}`, value); return { ok: true }; },
    batch: async (ops: any[]) => {
      for (const op of ops) if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
      return { ok: true };
    },
    has: async () => ({ value: false }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, countExisting, getMany };
}

const item = (appid: number) => ({ appid, success: 1, visible: true, name: `Game ${appid}`, tags: [{ tagid: 19 }] });

function installSteam() {
  const steam = {
    getAppList: vi.fn(async () => []),
    getTagList: vi.fn(async () => [{ tagid: 19, name: 'Action' }]),
    fetchCatalogBatch: vi.fn(async (ids: number[]) => ids.map(item)),
  };
  Object.defineProperty(window, 'steam', { value: steam, writable: true, configurable: true });
  return steam;
}

/** An incomplete earlier run: 400 pending ids, 100 of them already stored by an older full sync. */
function seedIncompleteRun(db: Map<string, unknown>) {
  const pending = Array.from({ length: 400 }, (_, i) => i + 1);
  for (const id of pending.slice(0, 100)) db.set(`catalog-entries::${id}`, { appid: id, name: `old ${id}` });
  db.set('catalog-meta::sync-state', {
    lastSyncTimestamp: Date.now() - 2 * DAY,
    totalEntries: 1000,
    batchesCompleted: 5,
    batchesTotal: 7,
    inProgress: false,
    pendingAppIds: pending,
    lastAttemptTimestamp: Date.now() - 20 * 60 * 1000, // past the 15-min cooldown
  });
}

async function loadStore() {
  vi.resetModules();
  const mod = await import('@/services/catalog-store');
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
  vi.restoreAllMocks();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'steam', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('CatalogStore resume — pending-row count', () => {
  it('counts already-stored pending games via countExisting and never reads their rows', async () => {
    const { db, countExisting, getMany } = installFakeStore();
    seedIncompleteRun(db);
    const steam = installSteam();
    const store = await loadStore();

    await store.sync();

    expect(steam.getAppList).not.toHaveBeenCalled(); // resume path
    expect(countExisting).toHaveBeenCalledTimes(1);
    expect(getMany).not.toHaveBeenCalled();
    // 400 fetched, 100 of them were already stored → only 300 new rows
    expect(await store.getEntryCount()).toBe(1300);
  });

  it('a count failure falls back to max(prevTotal, stored) instead of treating it as 0 stored', async () => {
    const { db } = installFakeStore({ countFails: true });
    seedIncompleteRun(db);
    installSteam();
    const store = await loadStore();

    await store.sync();

    // Old behaviour: 1000 + 400 = 1400 (inflated by the 100 already-stored games)
    expect(await store.getEntryCount()).toBe(1000);
  });
});
