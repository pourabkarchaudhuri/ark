import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'ark-status-history';
const MIGRATION_FLAG_KEY = 'ark-status-history-migrated-v1';
const LEVEL_NAMESPACE = 'status-history';
const LEVEL_DATA_KEY = 'data';

/**
 * The status history store is a singleton created at module import time, so
 * every scenario re-imports the module in isolation. `vi.resetModules()` gives
 * us a fresh singleton per test.
 */
async function loadFreshStore() {
  vi.resetModules();
  const mod = await import('@/services/status-history-store');
  return mod.statusHistoryStore;
}

interface FakeStoreState {
  rows: Map<string, Map<string, unknown>>;
}

function makeFakeStore(): { state: FakeStoreState; api: StoreAPI } {
  const state: FakeStoreState = { rows: new Map() };
  const api: StoreAPI = {
    get: vi.fn(async <T,>(ns: string, key: string) => {
      const bucket = state.rows.get(ns);
      const value = bucket?.get(key);
      return { value: (value ?? null) as T | null };
    }),
    getAll: vi.fn(async <T,>(ns: string) => {
      const bucket = state.rows.get(ns);
      if (!bucket) return { rows: [] };
      return { rows: [...bucket.entries()].map(([k, v]) => ({ key: k, value: v as T })) };
    }),
    put: vi.fn(async (ns: string, key: string, value: unknown) => {
      let bucket = state.rows.get(ns);
      if (!bucket) {
        bucket = new Map();
        state.rows.set(ns, bucket);
      }
      // Simulate JSON serialisation the way LevelDB does.
      bucket.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    }),
    del: vi.fn(async (ns: string, key: string) => {
      state.rows.get(ns)?.delete(key);
      return { ok: true };
    }),
    batch: vi.fn(async (ops) => {
      for (const op of ops) {
        if (op.type === 'put') await api.put(op.namespace, op.key, op.value);
        else await api.del(op.namespace, op.key);
      }
      return { ok: true };
    }),
    has: vi.fn(async (ns: string) => ({ value: (state.rows.get(ns)?.size ?? 0) > 0 })),
    clearNamespace: vi.fn(async (ns: string) => {
      state.rows.delete(ns);
      return { ok: true };
    }),
  };
  return { state, api };
}

function installStore(api: StoreAPI | undefined) {
  Object.defineProperty(window, 'store', { value: api, configurable: true, writable: true });
}

// Each loadFreshStore() creates a new singleton whose 300ms debounced save can
// otherwise fire during the NEXT test (rewriting localStorage / window.store).
// Every instance registers a beforeunload flush, so firing it settles them all.
afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
});

describe('StatusHistoryStore — public API on localStorage fallback', () => {
  beforeEach(() => {
    localStorage.clear();
    installStore(undefined);
  });

  it('records and reads entries synchronously without a LevelDB bridge', async () => {
    const store = await loadFreshStore();
    store.record('steam-1', 'Game A', null, 'Playing');
    store.record('steam-1', 'Game A', 'Playing', 'Completed');

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].newStatus).toBe('Playing');
    expect(all[1].newStatus).toBe('Completed');
  });

  it('exposes the same query helpers as before', async () => {
    const store = await loadFreshStore();
    store.record('steam-1', 'A', null, 'Playing');
    store.record('steam-2', 'B', null, 'Playing Now');

    expect(store.getForGame('steam-1')).toHaveLength(1);
    expect(store.getRecent(1)).toHaveLength(1);
    expect(store.getSize()).toBe(2);
    const ts1 = store.getFirstPlayingTransition('steam-1');
    expect(typeof ts1).toBe('number');
    expect(ts1).toBeGreaterThan(0);
    expect(store.getFirstPlayingTransition('steam-unknown')).toBeNull();
  });

  it('imports and exports entries deterministically', async () => {
    const store = await loadFreshStore();
    const seed = [
      { gameId: 'steam-1', title: 'A', previousStatus: null, newStatus: 'Playing', timestamp: '2026-01-01T00:00:00Z' },
      { gameId: 'steam-1', title: 'A', previousStatus: 'Playing', newStatus: 'Completed', timestamp: '2026-02-01T00:00:00Z' },
    ] as any;
    const first = store.importData(seed);
    expect(first).toEqual({ added: 2, skipped: 0 });
    const second = store.importData(seed);
    expect(second).toEqual({ added: 0, skipped: 2 });
    expect(store.exportData()).toHaveLength(2);
  });
});

describe('StatusHistoryStore — LevelDB migration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    installStore(undefined);
  });

  it('copies existing localStorage entries into LevelDB on first init', async () => {
    // Seed localStorage as if we booted from a pre-v1.0.61 build.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [
          { gameId: 'steam-1', title: 'A', previousStatus: null, newStatus: 'Playing', timestamp: '2026-01-01T00:00:00Z' },
        ],
        lastUpdated: '2026-01-01T00:00:00Z',
      }),
    );
    expect(localStorage.getItem(MIGRATION_FLAG_KEY)).toBeNull();

    const { state, api } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    // Sync read must already work off the localStorage snapshot.
    expect(store.getSize()).toBe(1);

    await store.ready();

    // Migration flag stamped.
    expect(localStorage.getItem(MIGRATION_FLAG_KEY)).toBe('yes');
    // Original localStorage key preserved for rollback.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    // LevelDB now has the payload.
    expect(api.put).toHaveBeenCalledWith(LEVEL_NAMESPACE, LEVEL_DATA_KEY, expect.any(Object));
    const persisted = state.rows.get(LEVEL_NAMESPACE)?.get(LEVEL_DATA_KEY) as any;
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0].gameId).toBe('steam-1');
  });

  it('hydrates from LevelDB when the migration flag is already set', async () => {
    // Simulate a post-migration boot: flag set, localStorage stale, LevelDB
    // holds the real data.
    localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: [], lastUpdated: '' }),
    );

    const { state, api } = makeFakeStore();
    state.rows.set(
      LEVEL_NAMESPACE,
      new Map<string, unknown>([
        [
          LEVEL_DATA_KEY,
          {
            version: 2,
            entries: [
              { gameId: 'steam-42', title: 'From LevelDB', previousStatus: null, newStatus: 'Completed', timestamp: '2026-03-01T00:00:00Z' },
            ],
            lastUpdated: '2026-03-01T00:00:00Z',
          },
        ],
      ]),
    );
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    // Post-hydrate the LevelDB data is authoritative — the stale (empty)
    // localStorage snapshot was overwritten by the LevelDB payload.
    expect(store.getSize()).toBe(1);
    expect(store.getAll()[0].gameId).toBe('steam-42');
    // The bridge was consulted for the hydrate read.
    expect(api.get).toHaveBeenCalledWith(LEVEL_NAMESPACE, LEVEL_DATA_KEY);
  });

  it('debounced record persists a single LevelDB put per burst', async () => {
    vi.useFakeTimers();
    try {
      // No pre-existing data — start with an empty migrated store.
      localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
      const { api } = makeFakeStore();
      installStore(api);

      const store = await loadFreshStore();
      await store.ready();

      const putsBefore = (api.put as any).mock.calls.length;

      store.record('steam-1', 'A', null, 'Playing');
      store.record('steam-1', 'A', 'Playing', 'Completed');
      store.record('steam-1', 'A', 'Completed', 'On Hold');

      // Debounce window hasn't elapsed yet.
      expect((api.put as any).mock.calls.length).toBe(putsBefore);

      await vi.advanceTimersByTimeAsync(320);
      // Exactly one persist call for the burst.
      expect((api.put as any).mock.calls.length).toBe(putsBefore + 1);

      const [ns, key, payload] = (api.put as any).mock.calls.at(-1);
      expect(ns).toBe(LEVEL_NAMESPACE);
      expect(key).toBe(LEVEL_DATA_KEY);
      expect(payload.entries).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() wipes the LevelDB namespace and the legacy key', async () => {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, entries: [], lastUpdated: '' }));

    const { state, api } = makeFakeStore();
    state.rows.set(
      LEVEL_NAMESPACE,
      new Map<string, unknown>([
        [
          LEVEL_DATA_KEY,
          {
            version: 2,
            entries: [
              { gameId: 'steam-1', title: 'A', previousStatus: null, newStatus: 'Playing', timestamp: '2026-01-01T00:00:00Z' },
            ],
            lastUpdated: '',
          },
        ],
      ]),
    );
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();
    expect(store.getSize()).toBe(1);

    store.clear();
    // Give the fire-and-forget clearNamespace a tick to resolve.
    await Promise.resolve();

    expect(store.getSize()).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(api.clearNamespace).toHaveBeenCalledWith(LEVEL_NAMESPACE);
  });
});

describe('StatusHistoryStore — hydration safety (audit item 4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    installStore(undefined);
  });

  it('merges records made before the async LevelDB hydrate instead of replacing them', async () => {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
    const { state, api } = makeFakeStore();
    state.rows.set(
      LEVEL_NAMESPACE,
      new Map<string, unknown>([
        [
          LEVEL_DATA_KEY,
          {
            version: 2,
            entries: [
              { gameId: 'steam-42', title: 'Persisted', previousStatus: null, newStatus: 'Playing', timestamp: '2026-03-01T00:00:00Z' },
            ],
            lastUpdated: '2026-03-01T00:00:00Z',
          },
        ],
      ]),
    );
    // Slow hydrate read so the record below lands while it is in flight.
    const realGet = api.get;
    (api as any).get = vi.fn(async (ns: string, key: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return realGet(ns, key);
    });
    installStore(api);

    const store = await loadFreshStore();
    // e.g. the startup auto-On-Hold sweep / cross-store sync
    store.record('merge-probe-early', 'Early', 'Playing', 'On Hold');
    await store.ready();

    const ids = store.getAll().map((e) => e.gameId).sort();
    expect(ids).toEqual(['merge-probe-early', 'steam-42']);
    // The merged set is persisted back to LevelDB (not to localStorage).
    // (Inspect our own put calls — vitest's isolate:false lets other files'
    // store instances write to whatever window.store is current.)
    await new Promise((r) => setTimeout(r, 20));
    const mergedPut = (api.put as any).mock.calls.some(([, , payload]: any[]) => {
      const gids = (payload?.entries ?? []).map((e: any) => e.gameId);
      return gids.includes('merge-probe-early') && gids.includes('steam-42');
    });
    expect(mergedPut).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('merge-probe-early');
    // Let the record()'s debounced save settle so it can't leak into the next test.
    await new Promise((r) => setTimeout(r, 350));
  });

  it('ignores the frozen legacy localStorage snapshot once migrated', async () => {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [{ gameId: 'stale', title: 'Stale', previousStatus: null, newStatus: 'Playing', timestamp: '2025-01-01T00:00:00Z' }],
        lastUpdated: '',
      }),
    );
    const { api } = makeFakeStore();
    installStore(api);
    const store = await loadFreshStore();
    expect(store.getForGame('stale')).toHaveLength(0);
    await store.ready();
    expect(store.getForGame('stale')).toHaveLength(0);
  });

  it('a failed hydrate retries, then goes read-only instead of silently writing localStorage', async () => {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'yes');
    const { api } = makeFakeStore();
    (api as any).get = vi.fn(async () => ({ error: 'IO error' }));
    installStore(api);

    vi.resetModules();
    const health = await import('@/services/storage-health');
    health.__setStorageRetryDelaysForTests([0, 0]);
    const mod = await import('@/services/status-history-store');
    const store = mod.statusHistoryStore;
    await store.ready();

    expect((api as any).get).toHaveBeenCalledTimes(3);
    expect(store.isReadOnly()).toBe(true);
    expect(health.getStorageHealth().failures.map((f) => f.store)).toContain('status-history');

    store.record('readonly-probe', 'A', null, 'Playing');
    await new Promise((r) => setTimeout(r, 350));
    const wroteProbe = (api.put as any).mock.calls.some(([, , payload]: any[]) =>
      (payload?.entries ?? []).some((e: any) => e.gameId === 'readonly-probe'));
    expect(wroteProbe).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('readonly-probe');
  });
});
