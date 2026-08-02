/**
 * Library Store — LevelDB migration + persistence tests (v1.0.63).
 * Follows session-store.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LibraryStore } from './library-store';
import { LibraryGameEntry } from '@/types/game';

const STORAGE_KEY = 'ark-library-data';
const MIGRATION_MARKER = 'ark-library-data-migrated-v1';

function makeEntry(overrides: Partial<LibraryGameEntry> = {}): LibraryGameEntry {
  return {
    gameId: overrides.gameId ?? 'steam-730',
    status: overrides.status ?? 'Want to Play',
    priority: overrides.priority ?? 'Medium',
    publicReviews: overrides.publicReviews ?? '',
    recommendationSource: overrides.recommendationSource ?? '',
    hoursPlayed: overrides.hoursPlayed ?? 0,
    rating: overrides.rating ?? 0,
    addedAt: overrides.addedAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as LibraryGameEntry;
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seed?: LibraryGameEntry[];
  getAllError?: string;
}

function installFakeStore(opts: FakeStoreOpts = {}) {
  const db = new Map<string, unknown>();
  for (const e of opts.seed ?? []) db.set(`library::${e.gameId}`, e);
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

  Object.defineProperty(window, 'store', {
    value: fake,
    writable: true,
    configurable: true,
  });
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

describe('LibraryStore — localStorage fallback', () => {
  it('reads localStorage when window.store is undefined', async () => {
    const seed = [makeEntry({ gameId: 'steam-1', status: 'Playing' })];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 5, entries: seed, lastUpdated: 'x' }),
    );
    const store = new LibraryStore();
    await store.ready;
    expect(store.getSize()).toBe(1);
    expect(store.getEntry('steam-1')?.status).toBe('Playing');
  });

  it('does not throw when localStorage empty and no window.store', async () => {
    const store = new LibraryStore();
    await store.ready;
    expect(store.getAllEntries()).toEqual([]);
  });
});

describe('LibraryStore — LevelDB hydration', () => {
  it('hydrates from window.store.getAll', async () => {
    const seed = [
      makeEntry({ gameId: 'steam-1' }),
      makeEntry({ gameId: 'epic-abc', status: 'Completed' }),
    ];
    const { calls } = installFakeStore({ seed });
    const store = new LibraryStore();
    await store.ready;
    expect(calls.getAll).toBe(1);
    expect(store.getSize()).toBe(2);
    expect(store.getEntry('epic-abc')?.status).toBe('Completed');
  });

  it('falls back to localStorage on getAll IPC error', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        entries: [makeEntry({ gameId: 'steam-9' })],
        lastUpdated: 'x',
      }),
    );
    installFakeStore({ getAllError: 'rate_limited' });
    const store = new LibraryStore();
    await store.ready;
    expect(store.isInLibrary('steam-9')).toBe(true);
  });

  it('migrates Dropped→On Hold on hydrate and re-persists', async () => {
    const seed = [makeEntry({ gameId: 'steam-1', status: 'Dropped' as any })];
    const { calls } = installFakeStore({ seed });
    const store = new LibraryStore();
    await store.ready;
    // Debounced save fires — advance a tick for the setTimeout to schedule.
    await new Promise((r) => setTimeout(r, 350));
    expect(store.getEntry('steam-1')?.status).toBe('On Hold');
    // At least one batch should have re-put the entry post-migration.
    expect(calls.batch.length).toBeGreaterThan(0);
  });
});

describe('LibraryStore — one-shot migration', () => {
  it('copies localStorage payload into LevelDB', async () => {
    const seed = [
      makeEntry({ gameId: 'steam-1' }),
      makeEntry({ gameId: 'steam-2', status: 'Playing' }),
    ];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 5, entries: seed, lastUpdated: 'x' }),
    );
    const { calls, db } = installFakeStore();
    const store = new LibraryStore();
    await store.ready;

    expect(calls.batch.length).toBeGreaterThanOrEqual(1);
    expect(db.has('library::steam-1')).toBe(true);
    expect(db.has('library::steam-2')).toBe(true);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(store.getSize()).toBe(2);
  });

  it('skips migration when marker is set', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        entries: [makeEntry({ gameId: 'steam-1' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore();
    const store = new LibraryStore();
    await store.ready;
    expect(calls.batch.length).toBe(0);
    expect(store.getSize()).toBe(0);
  });

  it('skips migration when LevelDB already has rows', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 5,
        entries: [makeEntry({ gameId: 'ls-only' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore({ seed: [makeEntry({ gameId: 'existing' })] });
    const store = new LibraryStore();
    await store.ready;
    expect(calls.batch.length).toBe(0);
    expect(store.isInLibrary('existing')).toBe(true);
    expect(store.isInLibrary('ls-only')).toBe(false);
  });

  it('stamps marker when payload is empty', async () => {
    installFakeStore();
    const store = new LibraryStore();
    await store.ready;
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getSize()).toBe(0);
  });
});

describe('LibraryStore — clear()', () => {
  it('wipes LevelDB namespace + marker', async () => {
    const { calls, db } = installFakeStore({ seed: [makeEntry({ gameId: 'x1' })] });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new LibraryStore();
    await store.ready;
    store.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.getSize()).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
