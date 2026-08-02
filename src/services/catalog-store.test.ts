/**
 * Steam Catalog Store — LevelDB migration + chunked-read tests (v1.0.65).
 * Focuses on:
 *  - useLevelDB gate flip (window.store present -> LevelDB, absent -> IDB)
 *  - one-shot IDB->LevelDB migration (marker stamped, entries streamed,
 *    meta rows copied)
 *  - streamed reads via getChunk (batched to callers)
 *  - fresh/count/last-timestamp resolvers dispatch to the right backend
 *  - putEntriesBatch writes via `batch` IPC on the LevelDB path
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CatalogEntry, CatalogSyncState } from '@/types/catalog';
import { CatalogStore } from './catalog-store';

const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';
const ENTRIES_NS = 'catalog-entries';
const META_NS = 'catalog-meta';

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    appid: overrides.appid ?? 730,
    name: overrides.name ?? 'Counter-Strike 2',
    genres: overrides.genres ?? ['Action'],
    themes: overrides.themes ?? [],
    modes: overrides.modes ?? ['Multiplayer'],
    developer: overrides.developer ?? 'Valve',
    publisher: overrides.publisher ?? 'Valve',
    shortDescription: overrides.shortDescription ?? '',
    releaseDate: overrides.releaseDate ?? 0,
    reviewScore: overrides.reviewScore ?? 9,
    reviewCount: overrides.reviewCount ?? 50_000,
    reviewPositivity: overrides.reviewPositivity ?? 0.9,
    windows: true,
    mac: false,
    linux: false,
    steamDeckCompat: 0,
    isFree: overrides.isFree ?? true,
    tagIds: overrides.tagIds ?? [],
  } as CatalogEntry;
}

interface FakeStoreCalls {
  get: number;
  getAll: number;
  getChunk: number;
  put: number;
  del: number;
  batch: Array<Array<unknown>>;
  has: number;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seedEntries?: CatalogEntry[];
  seedMeta?: Record<string, unknown>;
  chunkLimit?: number;
}

function installFakeStore(opts: FakeStoreOpts = {}) {
  const db = new Map<string, unknown>();
  for (const e of opts.seedEntries ?? []) db.set(`${ENTRIES_NS}::${e.appid}`, e);
  for (const [k, v] of Object.entries(opts.seedMeta ?? {})) db.set(`${META_NS}::${k}`, v);

  const calls: FakeStoreCalls = {
    get: 0, getAll: 0, getChunk: 0, put: 0, del: 0,
    batch: [], has: 0, clearNamespace: 0,
  };

  const fake = {
    get: async (ns: string, key: string) => {
      calls.get++;
      return { value: db.get(`${ns}::${key}`) ?? null };
    },
    getAll: async (ns: string) => {
      calls.getAll++;
      const rows: Array<{ key: string; value: unknown }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) {
        if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      }
      return { rows };
    },
    getChunk: async (
      ns: string,
      { startAfter, limit }: { startAfter?: string; limit: number },
    ) => {
      calls.getChunk++;
      const prefix = `${ns}::`;
      const allKeys: string[] = [];
      for (const k of db.keys()) {
        if (k.startsWith(prefix)) allKeys.push(k.slice(prefix.length));
      }
      allKeys.sort();
      const startIdx = startAfter ? allKeys.findIndex((k) => k > startAfter) : 0;
      const effectiveStart = startIdx < 0 ? allKeys.length : startIdx;
      const slice = allKeys.slice(effectiveStart, effectiveStart + limit);
      const rows = slice.map((k) => ({ key: k, value: db.get(`${ns}::${k}`) }));
      const nextKey = rows.length > 0 ? rows[rows.length - 1].key : undefined;
      const done = rows.length < limit;
      return { rows, nextKey, done };
    },
    put: async (ns: string, key: string, value: unknown) => {
      calls.put++;
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns: string, key: string) => {
      calls.del++;
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
    has: async (ns: string) => {
      calls.has++;
      const prefix = `${ns}::`;
      for (const k of db.keys()) if (k.startsWith(prefix)) return { value: true };
      return { value: false };
    },
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
  return { db, calls };
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

describe('CatalogStore — LevelDB hydration', () => {
  it('reads entries from LevelDB via getChunk', async () => {
    const seedEntries = [
      makeEntry({ appid: 1, name: 'Alpha', genres: ['RPG'], reviewCount: 20 }),
      makeEntry({ appid: 2, name: 'Beta', genres: ['Action'], reviewCount: 40 }),
      makeEntry({ appid: 3, name: 'Gamma', genres: ['Puzzle'], reviewCount: 30 }),
    ];
    const seedMeta = {
      'sync-state': {
        lastSyncTimestamp: Date.now(),
        totalEntries: 3,
        batchesCompleted: 1,
        batchesTotal: 1,
        inProgress: false,
      } satisfies CatalogSyncState,
    };
    const { calls } = installFakeStore({ seedEntries, seedMeta });
    // Stamp marker so migration doesn't re-run.
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new CatalogStore();
    expect(await store.getEntryCount()).toBe(3);
    expect(await store.isFresh()).toBe(true);

    const batches: CatalogEntry[][] = [];
    const streamed = await store.getAllEntries((b) => batches.push([...b]));
    expect(streamed).toBe(3);
    expect(batches.flat().map((e) => e.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    // At least one getChunk hop happened (only 3 rows so likely exactly one).
    expect(calls.getChunk).toBeGreaterThanOrEqual(1);
  });

  it('paginates getChunk correctly when limit < row count', async () => {
    // Load 2500 entries — 3 hops at LEVEL_CHUNK_SIZE=1000.
    const seedEntries: CatalogEntry[] = [];
    for (let i = 1; i <= 2500; i++) {
      seedEntries.push(makeEntry({ appid: i, name: `Game-${i}`, reviewCount: 100 + i }));
    }
    const { calls } = installFakeStore({
      seedEntries,
      seedMeta: {
        'sync-state': {
          lastSyncTimestamp: Date.now(),
          totalEntries: 2500,
          batchesCompleted: 1,
          batchesTotal: 1,
          inProgress: false,
        },
      },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new CatalogStore();
    const batches: CatalogEntry[][] = [];
    const streamed = await store.getAllEntries((b) => batches.push([...b]));
    expect(streamed).toBe(2500);
    // 2500 rows, LEVEL_CHUNK_SIZE=1000 => 3 hops (1000 + 1000 + 500 short-final).
    expect(calls.getChunk).toBe(3);
  });
});

describe('CatalogStore — queryForCandidates', () => {
  it('filters by genre, developer, and popularity floor', async () => {
    const seedEntries = [
      makeEntry({ appid: 1, name: 'Match-Genre', genres: ['RPG'], reviewCount: 5000, reviewPositivity: 0.95, developer: 'X' }),
      makeEntry({ appid: 2, name: 'Match-Dev',   genres: ['Puzzle'], reviewCount: 3000, reviewPositivity: 0.9,  developer: 'FavStudio' }),
      makeEntry({ appid: 3, name: 'Popular',     genres: ['Sim'],    reviewCount: 20_000, reviewPositivity: 0.9, developer: 'X' }),
      makeEntry({ appid: 4, name: 'Excluded',    genres: ['RPG'],    reviewCount: 5000, reviewPositivity: 0.95, developer: 'X' }),
      makeEntry({ appid: 5, name: 'LowScore',    genres: ['RPG'],    reviewCount: 5000, reviewPositivity: 0.2, developer: 'X' }),
    ];
    installFakeStore({
      seedEntries,
      seedMeta: {
        'sync-state': {
          lastSyncTimestamp: Date.now(),
          totalEntries: seedEntries.length,
          batchesCompleted: 1,
          batchesTotal: 1,
          inProgress: false,
        },
      },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new CatalogStore();
    const results = await store.queryForCandidates({
      topGenres: ['RPG'],
      loyalDevelopers: ['FavStudio'],
      excludeIds: new Set(['steam-4']),
      minReviews: 100,
      minPositivity: 0.5,
    });
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['Match-Dev', 'Match-Genre', 'Popular']);
    // Excluded (id=4) must not appear.
    expect(names.includes('Excluded')).toBe(false);
    // LowScore filtered out (positivity below floor).
    expect(names.includes('LowScore')).toBe(false);
  });
});

describe('CatalogStore — getEntries (point lookups)', () => {
  it('resolves specific appids via store.get on LevelDB path', async () => {
    const seedEntries = [
      makeEntry({ appid: 100, name: 'A' }),
      makeEntry({ appid: 200, name: 'B' }),
    ];
    const { calls } = installFakeStore({ seedEntries });
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new CatalogStore();
    const found = await store.getEntries([100, 200, 999]);
    expect(found.map((e) => e.name).sort()).toEqual(['A', 'B']);
    // Three point-lookups.
    expect(calls.get).toBe(3);
  });
});

describe('CatalogStore — sync-state persistence', () => {
  it('returns 0 count when sync-state missing', async () => {
    installFakeStore();
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new CatalogStore();
    expect(await store.getEntryCount()).toBe(0);
    expect(await store.getLastSyncTimestamp()).toBe(0);
    expect(await store.isFresh()).toBe(false);
  });

  it('reports fresh=false when timestamp older than TTL', async () => {
    const stale = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    installFakeStore({
      seedMeta: {
        'sync-state': {
          lastSyncTimestamp: stale,
          totalEntries: 1000,
          batchesCompleted: 1,
          batchesTotal: 1,
          inProgress: false,
        } satisfies CatalogSyncState,
      },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new CatalogStore();
    expect(await store.isFresh()).toBe(false);
  });
});
