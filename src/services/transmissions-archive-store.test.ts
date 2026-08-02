/**
 * Transmissions archive store — LevelDB migration + persistence tests (v1.0.61).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SavedTransmission } from '@/services/transmissions-archive-store';

const STORAGE_KEY = 'ark-transmissions-archive';
const MIGRATION_MARKER = 'ark-transmissions-archive-migrated-v1';
const LEVEL_NAMESPACE = 'transmissions-archive';

async function loadFreshStore() {
  vi.resetModules();
  const mod = await import('@/services/transmissions-archive-store');
  return mod.transmissionsArchiveStore;
}

function makeTransmission(overrides: Partial<SavedTransmission> = {}): SavedTransmission {
  return {
    id: overrides.id ?? `t-${Math.random().toString(36).slice(2)}`,
    url: overrides.url ?? 'https://example.com/a',
    title: overrides.title ?? 'Example',
    source: overrides.source ?? 'ExampleSource',
    publishedAt: overrides.publishedAt ?? Date.now(),
    summary: overrides.summary,
    imageUrl: overrides.imageUrl,
  };
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

describe('transmissionsArchiveStore — localStorage fallback (no window.store)', () => {
  it('reads archived items synchronously from localStorage', async () => {
    const seed = [makeTransmission({ id: 'a1' }), makeTransmission({ id: 'a2' })];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));

    const store = await loadFreshStore();

    expect(store.getAll()).toHaveLength(2);
    expect(store.has('a1')).toBe(true);
    expect(store.has('missing')).toBe(false);
  });

  it('add/remove persist back to localStorage', async () => {
    const store = await loadFreshStore();
    store.add(makeTransmission({ id: 'p1' }));
    store.add(makeTransmission({ id: 'p2' }));
    store.remove('p1');

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as SavedTransmission[];
    expect(parsed.map((i) => i.id)).toEqual(['p2']);
  });
});

describe('transmissionsArchiveStore — LevelDB hydration', () => {
  it('hydrates from window.store.getAll rows', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    const t1 = makeTransmission({ id: 'h1' });
    const t2 = makeTransmission({ id: 'h2' });
    bucket.set('h1', t1);
    bucket.set('h2', t2);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.getAll).toBe(1);
    expect(store.getAll()).toHaveLength(2);
    expect(store.has('h1')).toBe(true);
  });

  it('notifies subscribers on state changes after hydration', async () => {
    const { api } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    const listener = vi.fn();
    store.subscribe(listener);
    store.add(makeTransmission({ id: 'notify-1' }));
    expect(listener).toHaveBeenCalled();
  });

  it('falls back to localStorage when getAll returns an error envelope', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([makeTransmission({ id: 'fb-1' })]));
    const { api } = makeFakeStore({ getAllError: 'io_error' });
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(store.has('fb-1')).toBe(true);
  });
});

describe('transmissionsArchiveStore — one-shot migration', () => {
  it('copies localStorage payload into LevelDB when namespace is empty', async () => {
    const seed = [makeTransmission({ id: 'm1' }), makeTransmission({ id: 'm2' })];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['m1', 'm2']));

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    // Legacy key preserved.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    // LevelDB contains the rows.
    expect(state.rows.get(LEVEL_NAMESPACE)?.size).toBe(2);
    // Cache is hydrated.
    expect(store.getAll()).toHaveLength(2);
  });

  it('skips migration when marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify([makeTransmission({ id: 'skip' })]));
    const { api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(0);
    expect(store.has('skip')).toBe(false);
  });

  it('skips migration when LevelDB namespace already has rows', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeTransmission({ id: 'ls-only' })]),
    );
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('existing', makeTransmission({ id: 'existing' }));
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(calls.batch.length).toBe(0);
    expect(store.getAll().map((i) => i.id)).toEqual(['existing']);
  });

  it('stamps the marker even when the localStorage payload is missing', async () => {
    const { api } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getAll()).toEqual([]);
  });
});

describe('transmissionsArchiveStore — write path', () => {
  it('batch-puts on add and emits del on remove', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();

    calls.batch.length = 0;
    store.add(makeTransmission({ id: 'w1' }));
    // Fire-and-forget writes — flush the microtask queue.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // At least one batch put targeting w1 should have landed.
    const allOps = calls.batch.flat() as any[];
    const putOps = allOps.filter((o) => o.type === 'put' && o.key === 'w1');
    expect(putOps.length).toBeGreaterThanOrEqual(1);
    expect(state.rows.get(LEVEL_NAMESPACE)?.has('w1')).toBe(true);

    store.remove('w1');
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // A del op for w1 must have propagated to the LevelDB namespace.
    const allOpsAfter = calls.batch.flat() as any[];
    const delOps = allOpsAfter.filter((o) => o.type === 'del' && o.key === 'w1');
    expect(delOps.length).toBeGreaterThanOrEqual(1);
    expect(state.rows.get(LEVEL_NAMESPACE)?.has('w1')).toBe(false);
  });
});

describe('transmissionsArchiveStore — clear()', () => {
  it('wipes the LevelDB namespace and resets the migration marker', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('c1', makeTransmission({ id: 'c1' }));
    state.rows.set(LEVEL_NAMESPACE, bucket);
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    installStore(api);

    const store = await loadFreshStore();
    await store.ready();
    expect(store.has('c1')).toBe(true);

    store.clear();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(state.rows.get(LEVEL_NAMESPACE)?.size ?? 0).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
