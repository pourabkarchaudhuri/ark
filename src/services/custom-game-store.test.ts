/**
 * Custom Game Store — LevelDB migration + persistence tests (v1.0.63).
 * Meta row for nextCounter shares the namespace with entry rows via
 * key prefixes: `e:{id}` for entries, `m:nextCounter` for meta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CustomGameStore } from './custom-game-store';
import { CustomGameEntry } from '@/types/game';
import { sessionStore } from './session-store';
import { statusHistoryStore } from './status-history-store';
import { journeyStore } from './journey-store';

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
  // addGame bumps the counter past ids in these shared stores (v1.0.97) — start each test clean.
  sessionStore.clear();
  statusHistoryStore.clear();
  journeyStore.clear();
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
  it('wipes LevelDB entries + keeps the counter + clears marker', async () => {
    const { calls, db } = installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-1' })],
      seedCounter: 2,
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new CustomGameStore();
    await store.ready;
    store.clear();
    await store.whenPersisted();
    expect(calls.clearNamespace).toBe(1);
    // Only the counter meta row survives the wipe (v1.0.97: ids are never reused).
    expect(Array.from(db.keys())).toEqual(['custom-game::m:nextCounter']);
    expect(store.getCount()).toBe(0);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
    const created = store.addGame({
      title: 'Fresh',
      platform: ['Windows'],
      status: 'Want to Play',
    });
    expect(created.id).toBe('custom-2');
  });
});

describe('CustomGameStore — counter survives clear + restart (v1.0.97)', () => {
  it('a re-initialised store after clear() keeps handing out new ids', async () => {
    const { db } = installFakeStore({
      seedEntries: [makeEntry({ id: 'custom-1' }), makeEntry({ id: 'custom-2' })],
      seedCounter: 3,
    });
    const store = new CustomGameStore();
    await store.ready;
    store.clear();
    await store.whenPersisted();
    expect(db.get('custom-game::m:nextCounter')).toEqual({ nextCounter: 3 });

    // Restart: a fresh store hydrating from the same LevelDB.
    const restarted = new CustomGameStore();
    await restarted.ready;
    expect(restarted.getCount()).toBe(0);
    const created = restarted.addGame({ title: 'After restart', platform: ['Windows'], status: 'Want to Play' });
    expect(created.id).toBe('custom-3');
  });

  it('ensureCounterAbove moves the counter past the highest custom-N only', async () => {
    const store = new CustomGameStore();
    await store.ready;
    expect(store.ensureCounterAbove(['steam-9', 'custom-5', 'custom-x', 'custom-2'])).toBe(true);
    expect(store.ensureCounterAbove(['custom-3'])).toBe(false);
    const created = store.addGame({ title: 'N', platform: ['Windows'], status: 'Want to Play' });
    expect(created.id).toBe('custom-6');
  });
});

describe('CustomGameStore — importData (v1.0.97)', () => {
  it('replaces entries, keeps ids, and never moves the counter backwards', async () => {
    const { db } = installFakeStore({ seedEntries: [makeEntry({ id: 'custom-9', title: 'Old' })], seedCounter: 10 });
    const store = new CustomGameStore();
    await store.ready;
    const res = store.importData(
      [makeEntry({ id: 'custom-1', title: 'A' }), makeEntry({ id: 'custom-4', title: 'B' })],
      2,
    );
    expect(res).toEqual({ success: true, count: 2 });
    await store.whenPersisted();
    expect(store.getAllGames().map((g) => g.id).sort()).toEqual(['custom-1', 'custom-4']);
    expect(db.has('custom-game::e:custom-9')).toBe(false);
    expect(db.has('custom-game::e:custom-4')).toBe(true);
    // max(payload 2, highest id + 1 = 5, current 10)
    expect(store.addGame({ title: 'C', platform: ['Windows'], status: 'Want to Play' }).id).toBe('custom-10');
  });
});
