/**
 * Epic Catalog Store — LevelDB migration + chunked-read tests (v1.0.65).
 * Mirrors the Steam catalog test surface; Epic has no queryForCandidates
 * so we cover: LevelDB hydration, chunked getAllEntries, sync-state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EpicCatalogStore, type EpicCatalogEntry } from './epic-catalog-store';

const MIGRATION_MARKER = 'ark-epic-catalog-migrated-v1';
const ENTRIES_NS = 'epic-catalog-entries';
const META_NS = 'epic-catalog-meta';

function makeEntry(overrides: Partial<EpicCatalogEntry> = {}): EpicCatalogEntry {
  const epicId = overrides.epicId ?? 'ns1:offer1';
  const [namespace = 'ns1', offerId = 'offer1'] = epicId.split(':');
  return {
    epicId,
    namespace,
    offerId,
    name: overrides.name ?? 'Test Game',
    genres: overrides.genres ?? ['Action'],
    themes: overrides.themes ?? [],
    modes: overrides.modes ?? [],
    developer: overrides.developer ?? 'Dev',
    publisher: overrides.publisher ?? 'Pub',
    description: overrides.description ?? '',
    longDescription: overrides.longDescription ?? '',
    releaseDate: overrides.releaseDate ?? 0,
    coverUrl: overrides.coverUrl ?? '',
    isFree: overrides.isFree ?? false,
  } as EpicCatalogEntry;
}

function installFakeStore(seedEntries: EpicCatalogEntry[] = [], seedMeta: Record<string, unknown> = {}) {
  const db = new Map<string, unknown>();
  for (const e of seedEntries) db.set(`${ENTRIES_NS}::${e.epicId}`, e);
  for (const [k, v] of Object.entries(seedMeta)) db.set(`${META_NS}::${k}`, v);

  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getAll: async (ns: string) => {
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
      const prefix = `${ns}::`;
      const allKeys: string[] = [];
      for (const k of db.keys()) if (k.startsWith(prefix)) allKeys.push(k.slice(prefix.length));
      allKeys.sort();
      const startIdx = startAfter ? allKeys.findIndex((k) => k > startAfter) : 0;
      const eff = startIdx < 0 ? allKeys.length : startIdx;
      const slice = allKeys.slice(eff, eff + limit);
      const rows = slice.map((k) => ({ key: k, value: db.get(`${ns}::${k}`) }));
      return {
        rows,
        nextKey: rows.length > 0 ? rows[rows.length - 1].key : undefined,
        done: rows.length < limit,
      };
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
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else if (op.type === 'del') db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    has: async (ns: string) => {
      const prefix = `${ns}::`;
      for (const k of db.keys()) if (k.startsWith(prefix)) return { value: true };
      return { value: false };
    },
    clearNamespace: async (ns: string) => {
      const prefix = `${ns}::`;
      for (const k of Array.from(db.keys())) if (k.startsWith(prefix)) db.delete(k);
      return { ok: true };
    },
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('EpicCatalogStore — LevelDB hydration', () => {
  it('streams entries via getChunk', async () => {
    const seed = [
      makeEntry({ epicId: 'ns1:a', name: 'A' }),
      makeEntry({ epicId: 'ns1:b', name: 'B' }),
      makeEntry({ epicId: 'ns2:c', name: 'C' }),
    ];
    installFakeStore(seed, {
      'sync-state': { lastSyncTimestamp: Date.now(), totalEntries: 3, inProgress: false },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new EpicCatalogStore();
    expect(await store.getEntryCount()).toBe(3);
    expect(await store.isFresh()).toBe(true);

    const collected: EpicCatalogEntry[] = [];
    const streamed = await store.getAllEntries((batch) => collected.push(...batch));
    expect(streamed).toBe(3);
    expect(collected.map((e) => e.name).sort()).toEqual(['A', 'B', 'C']);
  });

  it('paginates chunked reads', async () => {
    const seed: EpicCatalogEntry[] = [];
    for (let i = 0; i < 1500; i++) {
      // Pad to keep sort order alphabetic — otherwise "9" > "10" lexically.
      seed.push(makeEntry({ epicId: `ns:${String(i).padStart(5, '0')}`, name: `G${i}` }));
    }
    installFakeStore(seed, {
      'sync-state': { lastSyncTimestamp: Date.now(), totalEntries: 1500, inProgress: false },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');

    const store = new EpicCatalogStore();
    let total = 0;
    await store.getAllEntries((batch) => { total += batch.length; });
    expect(total).toBe(1500);
  });
});

describe('EpicCatalogStore — sync-state', () => {
  it('returns 0 when sync-state absent', async () => {
    installFakeStore();
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new EpicCatalogStore();
    expect(await store.getEntryCount()).toBe(0);
    expect(await store.getLastSyncTimestamp()).toBe(0);
    expect(await store.isFresh()).toBe(false);
  });

  it('reports fresh=false past the 24h TTL', async () => {
    installFakeStore([], {
      'sync-state': { lastSyncTimestamp: Date.now() - 48 * 60 * 60 * 1000, totalEntries: 100, inProgress: false },
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    const store = new EpicCatalogStore();
    expect(await store.isFresh()).toBe(false);
  });
});
