import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'ark-status-history';
const MIGRATION_FLAG_KEY = 'ark-status-history-migrated-v1';
const LEVEL_NAMESPACE = 'status-history';
const LEVEL_DATA_KEY = 'data';

/**
 * The migration flag lives in localStorage, so a missing flag does not prove
 * LevelDB is empty. These scenarios boot with LevelDB rows but no flag and
 * check the one-shot migration unions instead of overwriting.
 */
function makeApi(row: unknown) {
  let stored: unknown = row;
  const api: any = {
    get: vi.fn(async () => ({ value: stored ?? null })),
    getAll: vi.fn(async () => ({ rows: [] })),
    put: vi.fn(async (_ns: string, _key: string, value: unknown) => {
      stored = JSON.parse(JSON.stringify(value));
      return { ok: true };
    }),
    del: vi.fn(async () => ({ ok: true })),
    batch: vi.fn(async () => ({ ok: true })),
    has: vi.fn(async () => ({ value: false })),
    clearNamespace: vi.fn(async () => ({ ok: true })),
  };
  return api;
}

function installStore(api: unknown) {
  Object.defineProperty(window, 'store', { value: api, configurable: true, writable: true });
}

async function loadFresh() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([0, 0]);
  const mod = await import('@/services/status-history-store');
  return mod.statusHistoryStore;
}

function fiftyRows() {
  return Array.from({ length: 50 }, (_, i) => ({
    gameId: `steam-${i}`,
    title: `G${i}`,
    previousStatus: null,
    newStatus: 'Playing',
    timestamp: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString(),
  }));
}

describe('StatusHistoryStore — migration with a missing localStorage flag', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
    installStore(undefined);
  });

  it('unions the surviving LevelDB row with pending rows instead of overwriting it', async () => {
    const api = makeApi({ version: 2, entries: fiftyRows(), lastUpdated: '' });
    installStore(api);
    const store = await loadFresh();
    store.record('pending-probe', 'Pending', null, 'Playing');
    await store.ready();

    const ids = store.getAll().map((e) => e.gameId);
    expect(ids).toHaveLength(51);
    expect(ids).toContain('steam-0');
    expect(ids).toContain('steam-49');
    expect(ids).toContain('pending-probe');

    expect(api.get).toHaveBeenCalledWith(LEVEL_NAMESPACE, LEVEL_DATA_KEY);
    const firstPut = api.put.mock.calls[0];
    expect(firstPut[2].entries).toHaveLength(51);
    expect(localStorage.getItem(MIGRATION_FLAG_KEY)).toBe('yes');
    expect(store.isReadOnly()).toBe(false);
  });

  it('dedupes rows present in both the legacy snapshot and LevelDB', async () => {
    const rows = fiftyRows();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, entries: rows.slice(0, 10), lastUpdated: '' }));
    const api = makeApi({ version: 2, entries: rows, lastUpdated: '' });
    installStore(api);
    const store = await loadFresh();
    await store.ready();
    expect(store.getSize()).toBe(50);
    const ts = store.getAll().map((e) => new Date(e.timestamp).getTime());
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('issues no put when the pre-migration read fails', async () => {
    const api = makeApi(null);
    api.get = vi.fn(async () => ({ error: 'IO error' }));
    installStore(api);
    const store = await loadFresh();
    await store.ready();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.put).not.toHaveBeenCalled();
    expect(localStorage.getItem(MIGRATION_FLAG_KEY)).toBeNull();
  });

  it('puts the in-memory payload when LevelDB is empty', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, entries: fiftyRows().slice(0, 3), lastUpdated: '' }));
    const api = makeApi(null);
    installStore(api);
    const store = await loadFresh();
    await store.ready();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][2].entries).toHaveLength(3);
  });
});
