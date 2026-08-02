/**
 * Transmissions history store — LevelDB migration + persistence tests (v1.0.61).
 *
 * The store is a module-level singleton created at import time, so every
 * scenario re-imports the module in isolation via `vi.resetModules()` and
 * installs a fresh fake `window.store` bridge beforehand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'ark-transmissions-decoded';
const MIGRATION_MARKER = 'ark-transmissions-decoded-migrated-v1';
const LEVEL_NAMESPACE = 'transmissions-history';

async function loadFreshStore() {
  vi.resetModules();
  const mod = await import('@/services/transmissions-history-store');
  return mod.transmissionsHistoryStore;
}

interface FakeStoreState {
  rows: Map<string, Map<string, unknown>>;
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

function makeFakeStore(opts: { getAllError?: string } = {}): {
  state: FakeStoreState;
  api: StoreAPI;
  calls: FakeStoreCalls;
} {
  const state: FakeStoreState = { rows: new Map() };
  const calls: FakeStoreCalls = { getAll: 0, batch: [], clearNamespace: 0 };
  const api: StoreAPI = {
    get: vi.fn(async <T,>(ns: string, key: string) => {
      const bucket = state.rows.get(ns);
      const value = bucket?.get(key);
      return { value: (value ?? null) as T | null };
    }),
    getAll: vi.fn(async <T,>(ns: string) => {
      calls.getAll++;
      if (opts.getAllError) return { error: opts.getAllError };
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
      bucket.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    }),
    del: vi.fn(async (ns: string, key: string) => {
      state.rows.get(ns)?.delete(key);
      return { ok: true };
    }),
    batch: vi.fn(async (ops: any[]) => {
      calls.batch.push(ops);
      for (const op of ops) {
        if (op.type === 'put') {
          let bucket = state.rows.get(op.namespace);
          if (!bucket) {
            bucket = new Map();
            state.rows.set(op.namespace, bucket);
          }
          bucket.set(op.key, JSON.parse(JSON.stringify(op.value)));
        } else if (op.type === 'del') {
          state.rows.get(op.namespace)?.delete(op.key);
        }
      }
      return { ok: true };
    }),
    has: vi.fn(async (ns: string) => ({ value: (state.rows.get(ns)?.size ?? 0) > 0 })),
    clearNamespace: vi.fn(async (ns: string) => {
      calls.clearNamespace++;
      state.rows.delete(ns);
      return { ok: true };
    }),
  };
  return { state, api, calls };
}

function installStore(api: StoreAPI | undefined) {
  Object.defineProperty(window, 'store', { value: api, configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  installStore(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  installStore(undefined);
});

describe('transmissionsHistoryStore — localStorage fallback (no window.store)', () => {
  it('reads decoded ids synchronously from localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']));

    const store = await loadFreshStore();

    expect(store.hasDecoded('a')).toBe(true);
    expect(store.hasDecoded('z')).toBe(false);
    expect(store.getDecodedIds()).toEqual(new Set(['a', 'b', 'c']));
  });

  it('persists new markDecoded writes back to localStorage', async () => {
    const store = await loadFreshStore();
    store.markDecoded('x1');
    store.markDecoded('x2');

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual(['x1', 'x2']);
  });
});

describe('transmissionsHistoryStore — LevelDB hydration', () => {
  it('hydrates the in-memory cache from window.store.getAll rows', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('h1', 1);
    bucket.set('h2', 1);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.getAll).toBe(1);
    expect(store.hasDecoded('h1')).toBe(true);
    expect(store.hasDecoded('h2')).toBe(true);
    expect(store.getDecodedIds()).toEqual(new Set(['h1', 'h2']));
  });

  it('falls back to localStorage when getAll IPC returns an error envelope', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['fb-1']));
    const { api } = makeFakeStore({ getAllError: 'rate_limited' });
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(store.hasDecoded('fb-1')).toBe(true);
  });
});

describe('transmissionsHistoryStore — one-shot migration', () => {
  it('copies localStorage payload into LevelDB when namespace is empty', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['m1', 'm2', 'm3']));
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['m1', 'm2', 'm3']));

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    // Legacy key preserved for one-release rollback.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    // LevelDB backing store now contains the rows.
    expect(state.rows.get(LEVEL_NAMESPACE)?.size).toBe(3);
    // In-memory cache hydrated.
    expect(store.getDecodedIds()).toEqual(new Set(['m1', 'm2', 'm3']));
  });

  it('skips migration when marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['skip-me']));
    const { api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(0);
    expect(store.hasDecoded('skip-me')).toBe(false);
  });

  it('skips migration when LevelDB namespace already has rows', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['ls-only']));
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('existing', 1);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(0);
    expect(store.getDecodedIds()).toEqual(new Set(['existing']));
  });

  it('stamps the marker even when the localStorage payload is missing', async () => {
    const { api } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getDecodedIds().size).toBe(0);
  });
});

describe('transmissionsHistoryStore — write path', () => {
  it('batch-puts new markDecoded ids into LevelDB', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    calls.batch.length = 0;
    store.markDecoded('w1');
    // Fire-and-forget — give the microtask a couple of ticks.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops).toEqual([{ type: 'put', namespace: LEVEL_NAMESPACE, key: 'w1', value: 1 }]);
    expect(state.rows.get(LEVEL_NAMESPACE)?.has('w1')).toBe(true);
  });
});

describe('transmissionsHistoryStore — clear()', () => {
  it('wipes the LevelDB namespace and resets the migration marker', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('c1', 1);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['c1']));
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();
    expect(store.hasDecoded('c1')).toBe(true);

    store.clear();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(state.rows.get(LEVEL_NAMESPACE)?.size ?? 0).toBe(0);
    expect(store.getDecodedIds().size).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
