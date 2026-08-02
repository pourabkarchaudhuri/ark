/**
 * Custom Game Store — LevelDB migration + persistence tests (v1.0.63).
 * Meta row for nextCounter shares the namespace with entry rows via
 * key prefixes: `e:{id}` for entries, `m:nextCounter` for meta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CustomGameStore } from './custom-game-store';
import { CustomGameEntry } from '@/types/game';

const STORAGE_KEY = 'ark-custom-games';
const MIGRATION_MARKER = 'ark-custom-games-migrated-v1';

function makeEntry(overrides: Partial<CustomGameEntry> = {}): CustomGameEntry {
  return {
    id: overrides.id ?? 'custom-1',
    title: overrides.title ?? 'Test Game',
    platform: overrides.platform ?? ['Windows'],
    status: overrides.status ?? 'Want to Play',
    addedAt: overrides.addedAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as CustomGameEntry;
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seedEntries?: CustomGameEntry[];
  seedCounter?: number;
  getAllError?: string;
}

function installFakeStore(opts: FakeStoreOpts = {}) {
  const db = new Map<string, unknown>();
  for (const e of opts.seedEntries ?? []) db.set(`custom-game::e:${e.id}`, e);
  if (opts.seedCounter !== undefined) {
    db.set(`custom-game::m:nextCounter`, { nextCounter: opts.seedCounter });
  }
  const calls: FakeStoreCalls = { getAll: 0, batch: [], clearNamespace: 0 };

  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getAll: async (ns: string) => {
      calls.getAll++;
      if (opts.getAllError) return { error: opts.getAllError };
      const rows: Array<{ key: string; value: unknown }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) {
        if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      }
      return { rows };
    },
    put: async (ns: string, key: string, value: unknown) => {
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns: string, key: string) => {
      db.delete(`${ns}::${key}`);
      return { ok: true };
    },
    batch: async (ops: any[]) => {
      calls.batch.push(ops);
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else if (op.type === 'del') db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    has: async () => ({ value: false }),
    clearNamespace: async (ns: string) => {
      calls.clearNamespace++;
      const prefix = `${ns}::`;
      for (const k of Array.from(db.keys())) if (k.startsWith(prefix)) db.delete(k);
      return { ok: true };
    },
  };

  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { calls, db };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'store', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

describe('CustomGameStore — localStorage fallback', () => {
  it('reads from localStorage when window.store is undefined', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ id: 'custom-3', title: 'A' })],
        nextCounter: 4,
        lastUpdated: 'x',
      }),
    );
    const store = new CustomGameStore();
    await store.ready;
    expect(store.getCount()).toBe(1);
    expect(store.getGame('custom-3')?.title).toBe('A');
  });
});

describe('CustomGameStore — LevelDB hydration', () => {
  it('hydrates entries + preserves stored nextCounter', async () => {
    const { calls } = installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-7' })],
      seedCounter: 12,
    });
    const store = new CustomGameStore();
    await store.ready;
    expect(calls.getAll).toBe(1);
    expect(store.getCount()).toBe(1);
    // Add a new game — should use counter 12
    const created = store.addGame({
      title: 'Next',
      platform: ['Windows'],
      status: 'Want to Play',
    });
    expect(created.id).toBe('custom-12');
  });

  it('falls back to recompute when meta row missing', async () => {
    installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-5' }), makeEntry({ id: 'custom-8' })],
    });
    const store = new CustomGameStore();
    await store.ready;
    // Recomputed counter = max(5,8) + 1 = 9
    const created = store.addGame({
      title: 'X',
      platform: ['Windows'],
      status: 'Want to Play',
    });
    expect(created.id).toBe('custom-9');
  });

  it('falls back to localStorage on getAll IPC error', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ id: 'custom-2' })],
        nextCounter: 3,
        lastUpdated: 'x',
      }),
    );
    installFakeStore({ getAllError: 'rate_limited' });
    const store = new CustomGameStore();
    await store.ready;
    expect(store.getCount()).toBe(1);
  });
});

describe('CustomGameStore — one-shot migration', () => {
  it('copies localStorage payload + counter into LevelDB', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ id: 'custom-1' }), makeEntry({ id: 'custom-2' })],
        nextCounter: 3,
        lastUpdated: 'x',
      }),
    );
    const { calls, db } = installFakeStore();
    const store = new CustomGameStore();
    await store.ready;
    expect(calls.batch.length).toBeGreaterThanOrEqual(1);
    expect(db.has('custom-game::e:custom-1')).toBe(true);
    expect(db.has('custom-game::e:custom-2')).toBe(true);
    expect((db.get('custom-game::m:nextCounter') as any)?.nextCounter).toBe(3);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getCount()).toBe(2);
  });

  it('skips migration when marker is set', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ id: 'custom-1' })],
        nextCounter: 2,
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore();
    const store = new CustomGameStore();
    await store.ready;
    expect(calls.batch.length).toBe(0);
    expect(store.getCount()).toBe(0);
  });

  it('skips migration when LevelDB already has entries', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ id: 'custom-9' })],
        nextCounter: 10,
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-3' })],
      seedCounter: 5,
    });
    const store = new CustomGameStore();
    await store.ready;
    expect(calls.batch.length).toBe(0);
    expect(store.getGame('custom-3')).toBeDefined();
    expect(store.getGame('custom-9')).toBeUndefined();
  });

  it('stamps marker when payload empty', async () => {
    installFakeStore();
    const store = new CustomGameStore();
    await store.ready;
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getCount()).toBe(0);
  });
});

describe('CustomGameStore — clear()', () => {
  it('wipes LevelDB namespace + resets counter + clears marker', async () => {
    const { calls, db } = installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-1' })],
      seedCounter: 2,
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new CustomGameStore();
    await store.ready;
    store.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.getCount()).toBe(0);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
    // Next add uses fresh counter starting at 1
    const created = store.addGame({
      title: 'Fresh',
      platform: ['Windows'],
      status: 'Want to Play',
    });
    expect(created.id).toBe('custom-1');
  });
});
