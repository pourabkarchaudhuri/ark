/**
 * Badge unlock timestamps — LevelDB migration + persistence tests (v1.0.61).
 *
 * The module exposes top-level functions backed by module-level state, so
 * each scenario re-imports via `vi.resetModules()` and installs a fresh fake
 * `window.store` bridge beforehand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'ark-badge-unlock-timestamps';
const MIGRATION_MARKER = 'ark-badge-unlock-timestamps-migrated-v1';
const LEVEL_NAMESPACE = 'badge-unlock-timestamps';

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import('@/services/badge-unlock-timestamps');
  return mod;
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

describe('badge-unlock-timestamps — localStorage fallback (no window.store)', () => {
  it('reads unlock timestamps synchronously from localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 1: 1700000000000, 2: 1710000000000 }));

    const mod = await loadFreshModule();

    expect(mod.getBadgeUnlockedAt(1)).toBe(1700000000000);
    expect(mod.getBadgeUnlockedAt(2)).toBe(1710000000000);
    expect(mod.getBadgeUnlockedAt(99)).toBeUndefined();
  });

  it('ensureUnlockedAt returns existing timestamp and persists new ones to localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 5: 500 }));
    const mod = await loadFreshModule();

    expect(mod.ensureUnlockedAt(5)).toBe(500);
    const before = Date.now();
    const ts = mod.ensureUnlockedAt(7);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[5]).toBe(500);
    expect(parsed[7]).toBe(ts);
  });

  it('setBadgeUnlockedAt is a no-op when a timestamp already exists', async () => {
    const mod = await loadFreshModule();
    mod.setBadgeUnlockedAt(11, 111);
    mod.setBadgeUnlockedAt(11, 222); // must not overwrite
    expect(mod.getBadgeUnlockedAt(11)).toBe(111);
  });
});

describe('badge-unlock-timestamps — LevelDB hydration', () => {
  it('hydrates the in-memory cache from window.store.getAll rows', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('1', 1000);
    bucket.set('2', 2000);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(calls.getAll).toBe(1);
    expect(mod.getBadgeUnlockedAt(1)).toBe(1000);
    expect(mod.getBadgeUnlockedAt(2)).toBe(2000);
  });

  it('falls back to localStorage when getAll returns an error envelope', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 42: 424242 }));
    const { api } = makeFakeStore({ getAllError: 'io_error' });
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(mod.getBadgeUnlockedAt(42)).toBe(424242);
  });
});

describe('badge-unlock-timestamps — one-shot migration', () => {
  it('copies localStorage payload into LevelDB when namespace is empty', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 3: 300, 4: 400 }));
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string; value: unknown }>;
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['3', '4']));

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    // Legacy key preserved.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    // Backing store has the rows.
    expect(state.rows.get(LEVEL_NAMESPACE)?.get('3')).toBe(300);
    expect(state.rows.get(LEVEL_NAMESPACE)?.get('4')).toBe(400);
    // In-memory cache hydrated.
    expect(mod.getBadgeUnlockedAt(3)).toBe(300);
    expect(mod.getBadgeUnlockedAt(4)).toBe(400);
  });

  it('skips migration when marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 9: 900 }));
    const { api, calls } = makeFakeStore();
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(calls.batch.length).toBe(0);
    expect(mod.getBadgeUnlockedAt(9)).toBeUndefined();
  });

  it('skips migration when LevelDB namespace already has rows', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 99: 9999 }));
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('100', 1234);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(calls.batch.length).toBe(0);
    expect(mod.getBadgeUnlockedAt(100)).toBe(1234);
    expect(mod.getBadgeUnlockedAt(99)).toBeUndefined();
  });

  it('stamps the marker even when localStorage is empty', async () => {
    const { api } = makeFakeStore();
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(mod.getBadgeUnlockedAt(1)).toBeUndefined();
  });
});

describe('badge-unlock-timestamps — write path', () => {
  it('batch-puts on ensureUnlockedAt / setBadgeUnlockedAt', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const { state, api, calls } = makeFakeStore();
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();

    calls.batch.length = 0;
    mod.setBadgeUnlockedAt(21, 2100);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string; value: unknown }>;
    expect(ops).toEqual([
      { type: 'put', namespace: LEVEL_NAMESPACE, key: '21', value: 2100 },
    ]);
    expect(state.rows.get(LEVEL_NAMESPACE)?.get('21')).toBe(2100);
  });
});

describe('badge-unlock-timestamps — clearBadgeUnlockTimestamps()', () => {
  it('wipes the LevelDB namespace and resets the migration marker', async () => {
    const { state, api, calls } = makeFakeStore();
    const bucket = new Map<string, unknown>();
    bucket.set('1', 111);
    state.rows.set(LEVEL_NAMESPACE, bucket);
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 1: 111 }));
    installStore(api);

    const mod = await loadFreshModule();
    await mod.badgeUnlockTimestampsReady();
    expect(mod.getBadgeUnlockedAt(1)).toBe(111);

    mod.clearBadgeUnlockTimestamps();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(state.rows.get(LEVEL_NAMESPACE)?.size ?? 0).toBe(0);
    expect(mod.getBadgeUnlockedAt(1)).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
