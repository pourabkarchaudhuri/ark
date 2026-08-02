/**
 * UserMarks Store — LevelDB migration + persistence tests (v1.0.61).
 *
 * Covers:
 *  - Fallback: legacy localStorage banners read when `window.store` is absent.
 *  - Hydrate: LevelDB rows demuxed by prefix into banners + constellations.
 *  - Migration: legacy banners copied into LevelDB, marker stamped, legacy
 *    key preserved (rollback insurance).
 *  - Marker-skip: pre-stamped marker skips migration.
 *  - Non-empty-namespace-skip: existing LevelDB rows short-circuit migration.
 *  - Write path: setBanner/removeBanner + add/removeConstellation issue a
 *    per-op put/del on the correct namespaced key (no debounce — matches
 *    pre-migration semantics).
 *  - Clear: `window.store.clearNamespace` fires, legacy banner key +
 *    migration marker wiped, cache emptied.
 *
 * The tests instantiate `UserMarksStore` directly (not the module-scoped
 * singleton) so state resets cleanly between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserMarksStore, Banner, Constellation } from './user-marks-store';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const BANNER_KEY = 'ark.userMarks.banners.v1';
const MIGRATION_MARKER = `${BANNER_KEY}-migrated-v1`;
const LEVEL_NAMESPACE = 'user-marks';

function banner(gameId: string, color: Banner['color'] = 'crimson'): Banner {
  return { gameId, color, plantedAt: '2026-01-01T00:00:00Z' };
}

function constellation(id: string, nodeIds: string[] = ['n1', 'n2']): Constellation {
  return { id, name: `C-${id}`, nodeIds, createdAt: '2026-01-01T00:00:00Z' };
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<any>>;
  put: Array<{ ns: string; key: string; value: any }>;
  del: Array<{ ns: string; key: string }>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seedBanners?: Banner[];
  seedConstellations?: Constellation[];
  getAllError?: string;
}

/**
 * Build a fake `window.store` implementation backed by an in-memory Map
 * keyed by `${namespace}::${key}`. Enough of the real IPC surface for
 * this test suite.
 */
function installFakeStore(opts: FakeStoreOpts = {}): {
  restore: () => void;
  calls: FakeStoreCalls;
  db: Map<string, unknown>;
} {
  const db = new Map<string, unknown>();
  for (const b of opts.seedBanners ?? []) {
    db.set(`${LEVEL_NAMESPACE}::banner:${b.gameId}`, b);
  }
  for (const c of opts.seedConstellations ?? []) {
    db.set(`${LEVEL_NAMESPACE}::constellation:${c.id}`, c);
  }
  const calls: FakeStoreCalls = {
    getAll: 0,
    batch: [],
    put: [],
    del: [],
    clearNamespace: 0,
  };

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
      calls.put.push({ ns, key, value });
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns: string, key: string) => {
      calls.del.push({ ns, key });
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

  const restore = () => {
    Object.defineProperty(window, 'store', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  };
  return { restore, calls, db };
}

// Give any fire-and-forget IPC a chance to resolve.
async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UserMarksStore — localStorage fallback (no window.store)', () => {
  it('hydrates banners from the legacy localStorage key on init()', async () => {
    localStorage.setItem(
      BANNER_KEY,
      JSON.stringify([banner('steam-1', 'gold'), banner('steam-2', 'cobalt')]),
    );

    const store = new UserMarksStore();
    await store.init();

    expect(store.banners.size).toBe(2);
    expect(store.banners.get('steam-1')?.color).toBe('gold');
    expect(store.bannersByColor('cobalt').map((b) => b.gameId)).toEqual(['steam-2']);
  });

  it('writes banners back to localStorage synchronously (legacy path)', async () => {
    const store = new UserMarksStore();
    await store.init();

    store.setBanner('steam-9', 'verdant');
    const raw = localStorage.getItem(BANNER_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].gameId).toBe('steam-9');
    expect(parsed[0].color).toBe('verdant');
  });

  it('does not touch LevelDB when the surface is missing', async () => {
    // No store installed — construction must not throw and init() must resolve.
    const store = new UserMarksStore();
    await store.init();
    expect(store.banners.size).toBe(0);
  });
});

describe('UserMarksStore — LevelDB hydration', () => {
  it('hydrates banners + constellations from window.store.getAll rows', async () => {
    const { calls } = installFakeStore({
      seedBanners: [banner('steam-1', 'gold'), banner('steam-2', 'cobalt')],
      seedConstellations: [constellation('c1'), constellation('c2', ['a', 'b', 'c'])],
    });

    const store = new UserMarksStore();
    await store.init();

    expect(calls.getAll).toBe(1);
    expect(store.banners.size).toBe(2);
    expect(store.banners.get('steam-1')?.color).toBe('gold');
    expect(store.constellations.size).toBe(2);
    expect(store.constellations.get('c2')?.nodeIds).toEqual(['a', 'b', 'c']);
  });

  it('notifies subscribers once hydration finishes', async () => {
    installFakeStore({ seedBanners: [banner('steam-1')] });

    const store = new UserMarksStore();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.init();

    expect(listener).toHaveBeenCalled();
  });

  it('falls back to legacy localStorage when getAll IPC returns an error', async () => {
    localStorage.setItem(
      BANNER_KEY,
      JSON.stringify([banner('steam-fallback', 'bone')]),
    );
    installFakeStore({ getAllError: 'transport_error' });

    const store = new UserMarksStore();
    await store.init();

    expect(store.banners.get('steam-fallback')?.color).toBe('bone');
  });
});

describe('UserMarksStore — one-shot migration', () => {
  it('copies legacy banners into LevelDB when namespace is empty', async () => {
    localStorage.setItem(
      BANNER_KEY,
      JSON.stringify([banner('m1', 'crimson'), banner('m2', 'gold')]),
    );
    const { calls, db } = installFakeStore();

    const store = new UserMarksStore();
    await store.init();

    // Migration batch put both banners.
    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0];
    expect(ops.length).toBe(2);
    expect(ops.every((o: any) => o.type === 'put' && o.namespace === LEVEL_NAMESPACE)).toBe(true);
    expect(new Set(ops.map((o: any) => o.key))).toEqual(
      new Set(['banner:m1', 'banner:m2']),
    );

    // LevelDB backing store now has both rows.
    expect(db.has(`${LEVEL_NAMESPACE}::banner:m1`)).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::banner:m2`)).toBe(true);

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    // Legacy key preserved for rollback.
    expect(localStorage.getItem(BANNER_KEY)).not.toBeNull();

    // In-memory cache is hydrated.
    expect(store.banners.size).toBe(2);
    expect(store.banners.get('m1')?.color).toBe('crimson');
  });

  it('skips migration when the marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(BANNER_KEY, JSON.stringify([banner('n1')]));
    const { calls } = installFakeStore();

    const store = new UserMarksStore();
    await store.init();

    expect(calls.batch.length).toBe(0);
    expect(store.banners.size).toBe(0);
  });

  it('skips migration when the LevelDB namespace is non-empty', async () => {
    localStorage.setItem(BANNER_KEY, JSON.stringify([banner('legacy-only')]));
    const { calls } = installFakeStore({
      seedBanners: [banner('already-there', 'gold')],
    });

    const store = new UserMarksStore();
    await store.init();

    expect(calls.batch.length).toBe(0);
    // Cache reflects LevelDB, not localStorage.
    expect(Array.from(store.banners.keys())).toEqual(['already-there']);
  });
});

describe('UserMarksStore — write path (LevelDB per-op puts / dels)', () => {
  it('setBanner issues a put on the namespaced banner key', async () => {
    const { calls, db } = installFakeStore();
    const store = new UserMarksStore();
    await store.init();

    // Ignore any migration-marker put — this scenario has empty legacy.
    const putBefore = calls.put.length;

    store.setBanner('steam-42', 'verdant');

    // Fire-and-forget async; flush the microtask queue.
    await flushMicrotasks();

    expect(calls.put.length).toBe(putBefore + 1);
    const last = calls.put.at(-1)!;
    expect(last.ns).toBe(LEVEL_NAMESPACE);
    expect(last.key).toBe('banner:steam-42');
    expect((last.value as Banner).color).toBe('verdant');
    expect(db.get(`${LEVEL_NAMESPACE}::banner:steam-42`)).toBeDefined();

    // Local cache updated synchronously.
    expect(store.banners.get('steam-42')?.color).toBe('verdant');
  });

  it('removeBanner issues a del on the namespaced banner key', async () => {
    const { calls, db } = installFakeStore({
      seedBanners: [banner('doomed', 'gold')],
    });
    const store = new UserMarksStore();
    await store.init();

    store.removeBanner('doomed');
    await flushMicrotasks();

    expect(calls.del.some((d) => d.ns === LEVEL_NAMESPACE && d.key === 'banner:doomed')).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::banner:doomed`)).toBe(false);
    expect(store.banners.has('doomed')).toBe(false);
  });

  it('addConstellation issues a put on the namespaced constellation key', async () => {
    const { calls, db } = installFakeStore();
    const store = new UserMarksStore();
    await store.init();

    const ok = await store.addConstellation('My Cluster', ['g1', 'g2', 'g3']);
    expect(ok).toBe(true);

    const put = calls.put.find((p) => p.key.startsWith('constellation:'));
    expect(put).toBeDefined();
    expect(put!.ns).toBe(LEVEL_NAMESPACE);
    const stored = db.get(`${LEVEL_NAMESPACE}::${put!.key}`) as Constellation;
    expect(stored.nodeIds).toEqual(['g1', 'g2', 'g3']);
    expect(stored.name).toBe('My Cluster');
  });

  it('removeConstellation issues a del on the namespaced constellation key', async () => {
    const { calls, db } = installFakeStore({
      seedConstellations: [constellation('rm-me')],
    });
    const store = new UserMarksStore();
    await store.init();
    expect(store.constellations.has('rm-me')).toBe(true);

    await store.removeConstellation('rm-me');

    expect(calls.del.some((d) => d.ns === LEVEL_NAMESPACE && d.key === 'constellation:rm-me')).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::constellation:rm-me`)).toBe(false);
    expect(store.constellations.has('rm-me')).toBe(false);
  });

  it('batches multiple rapid writes as individual per-op puts (no debounce)', async () => {
    // The pre-migration store had no debounce; the LevelDB port preserves that
    // — every setBanner is its own put. This test pins the contract.
    const { calls } = installFakeStore();
    const store = new UserMarksStore();
    await store.init();

    const putBefore = calls.put.length;
    store.setBanner('a', 'crimson');
    store.setBanner('b', 'gold');
    store.setBanner('c', 'cobalt');
    await flushMicrotasks();

    // 3 banner puts issued. (No coalescing.)
    const bannerPuts = calls.put
      .slice(putBefore)
      .filter((p) => p.key.startsWith('banner:'));
    expect(bannerPuts.length).toBe(3);
    expect(new Set(bannerPuts.map((p) => p.key))).toEqual(
      new Set(['banner:a', 'banner:b', 'banner:c']),
    );
  });
});

describe('UserMarksStore — clear()', () => {
  it('wipes the LevelDB namespace, cache, legacy key, and migration marker', async () => {
    const { calls, db } = installFakeStore({
      seedBanners: [banner('x1', 'gold')],
      seedConstellations: [constellation('cx1')],
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(BANNER_KEY, JSON.stringify([banner('rollback')]));

    const store = new UserMarksStore();
    await store.init();

    expect(store.banners.size).toBe(1);
    expect(store.constellations.size).toBe(1);

    store.clear();
    await flushMicrotasks();

    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.banners.size).toBe(0);
    expect(store.constellations.size).toBe(0);
    expect(localStorage.getItem(BANNER_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
