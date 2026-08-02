/**
 * RecoHistoryStore — LevelDB migration + persistence tests (v1.0.61).
 *
 * Covers:
 *  - Fallback: `window.store` absent -> localStorage path stays intact
 *  - Hydration: LevelDB rows replace the sync localStorage cache
 *  - One-shot migration: current in-memory state batch-put into LevelDB;
 *    both migration markers stamped; both legacy localStorage keys
 *    preserved for one-release rollback
 *  - Marker-skip: never migrate twice
 *  - Non-empty-namespace skip: existing LevelDB rows short-circuit migration
 *  - Debounce batch: bursts of writes are coalesced into a single batch()
 *  - reset() wipes the LevelDB namespace + both markers + both legacy keys
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const LS_DISMISSED_KEY = 'ark-reco-dismissed-v1';
const LS_HISTORY_KEY = 'ark-reco-history-v1';
const MIGRATION_MARKER_DISMISSED = 'ark-reco-dismissed-v1-migrated-v1';
const MIGRATION_MARKER_HISTORY = 'ark-reco-history-v1-migrated-v1';
const LEVEL_NAMESPACE = 'reco-history';

/**
 * The reco-history-store singleton is created at module import time, so
 * every scenario re-imports the module in isolation. `vi.resetModules()`
 * gives us a fresh singleton per test.
 */
async function loadFreshStore() {
  vi.resetModules();
  const mod = await import('@/services/reco-history-store');
  return mod.recoHistoryStore;
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seed?: Array<{ key: string; value: unknown }>;
  getAllError?: string;
}

/**
 * Build a fake `window.store` implementation backed by an in-memory Map
 * keyed by `${namespace}::${key}`. Matches the real IPC envelope shape.
 */
function installFakeStore(opts: FakeStoreOpts = {}): {
  restore: () => void;
  calls: FakeStoreCalls;
  db: Map<string, unknown>;
} {
  const db = new Map<string, unknown>();
  for (const s of opts.seed ?? []) db.set(`${LEVEL_NAMESPACE}::${s.key}`, s.value);
  const calls: FakeStoreCalls = { getAll: 0, batch: [], clearNamespace: 0 };

  const fake: StoreAPI = {
    get: async (ns, key) => ({ value: (db.get(`${ns}::${key}`) ?? null) as any }),
    getAll: async (ns) => {
      calls.getAll++;
      if (opts.getAllError) return { error: opts.getAllError };
      const rows: Array<{ key: string; value: any }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) {
        if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      }
      return { rows };
    },
    put: async (ns, key, value) => {
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns, key) => {
      db.delete(`${ns}::${key}`);
      return { ok: true };
    },
    batch: async (ops) => {
      calls.batch.push(ops as any);
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else if (op.type === 'del') db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    has: async (ns) => {
      const prefix = `${ns}::`;
      for (const k of db.keys()) if (k.startsWith(prefix)) return { value: true };
      return { value: false };
    },
    clearNamespace: async (ns) => {
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

describe('RecoHistoryStore — localStorage fallback (no window.store)', () => {
  it('reads from localStorage synchronously when window.store is undefined', async () => {
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([
        { gameId: 'steam-1', at: 100, title: 'Doomed' },
      ]),
    );
    localStorage.setItem(
      LS_HISTORY_KEY,
      JSON.stringify([
        { gameId: 'steam-2', title: 'Clicked', shelfType: 'hero', clickedAt: 200, converted: false },
      ]),
    );

    const store = await loadFreshStore();

    expect(store.isDismissed('steam-1')).toBe(true);
    expect(store.getDismissedIds()).toEqual(['steam-1']);
    expect(store.getHistorySize()).toBe(1);
    expect(store.getHistory()[0].title).toBe('Clicked');
  });

  it('persists writes to localStorage when window.store is undefined', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadFreshStore();
      store.dismiss('steam-42', { title: 'Nope' });
      await vi.advanceTimersByTimeAsync(320);

      const raw = localStorage.getItem(LS_DISMISSED_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed[0].gameId).toBe('steam-42');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RecoHistoryStore — LevelDB hydration', () => {
  it('replaces the in-memory cache with LevelDB rows when present', async () => {
    // localStorage has a stale entry; LevelDB has the authoritative data.
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([{ gameId: 'stale', at: 1 }]),
    );
    localStorage.setItem(MIGRATION_MARKER_DISMISSED, 'yes');
    localStorage.setItem(MIGRATION_MARKER_HISTORY, 'yes');

    const seed = [
      { key: 'd:steam-A', value: { gameId: 'steam-A', at: 10, title: 'A' } },
      { key: 'd:steam-B', value: { gameId: 'steam-B', at: 20 } },
      {
        key: 'h:steam-C',
        value: {
          gameId: 'steam-C',
          title: 'C',
          shelfType: 'hero',
          clickedAt: 30,
          converted: true,
        },
      },
    ];
    const { calls } = installFakeStore({ seed });

    const store = await loadFreshStore();
    await store.ready;

    expect(calls.getAll).toBe(1);
    // LevelDB rows replaced the localStorage snapshot.
    expect(store.isDismissed('stale')).toBe(false);
    expect(store.getDismissedIds().sort()).toEqual(['steam-A', 'steam-B']);
    expect(store.getHistorySize()).toBe(1);
    expect(store.getHistory()[0].gameId).toBe('steam-C');
  });

  it('falls back to the localStorage-hydrated cache when getAll errors', async () => {
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([{ gameId: 'from-ls', at: 1 }]),
    );
    installFakeStore({ getAllError: 'rate_limited' });

    const store = await loadFreshStore();
    await store.ready;

    // Sync localStorage hydrate survived the IPC failure.
    expect(store.isDismissed('from-ls')).toBe(true);
  });
});

describe('RecoHistoryStore — one-shot migration', () => {
  it('batches current in-memory state into LevelDB and stamps both markers', async () => {
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([
        { gameId: 'steam-1', at: 100, title: 'Dismissed A' },
        { gameId: 'steam-2', at: 200 },
      ]),
    );
    localStorage.setItem(
      LS_HISTORY_KEY,
      JSON.stringify([
        {
          gameId: 'steam-3',
          title: 'Clicked',
          shelfType: 'hero',
          clickedAt: 300,
          converted: false,
        },
      ]),
    );
    const { calls, db } = installFakeStore();

    const store = await loadFreshStore();
    await store.ready;

    // One batch containing all rows.
    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(
      new Set(['d:steam-1', 'd:steam-2', 'h:steam-3']),
    );

    // Both migration markers stamped.
    expect(localStorage.getItem(MIGRATION_MARKER_DISMISSED)).toBe('yes');
    expect(localStorage.getItem(MIGRATION_MARKER_HISTORY)).toBe('yes');

    // Both legacy keys preserved for one-release rollback.
    expect(localStorage.getItem(LS_DISMISSED_KEY)).not.toBeNull();
    expect(localStorage.getItem(LS_HISTORY_KEY)).not.toBeNull();

    // In-memory cache retained.
    expect(store.getDismissedCount()).toBe(2);
    expect(store.getHistorySize()).toBe(1);

    // LevelDB backing store has all rows.
    expect(db.has(`${LEVEL_NAMESPACE}::d:steam-1`)).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::d:steam-2`)).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::h:steam-3`)).toBe(true);
  });

  it('skips migration when both markers are already present', async () => {
    localStorage.setItem(MIGRATION_MARKER_DISMISSED, 'yes');
    localStorage.setItem(MIGRATION_MARKER_HISTORY, 'yes');
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([{ gameId: 'should-not-migrate', at: 1 }]),
    );
    const { calls } = installFakeStore();

    const store = await loadFreshStore();
    await store.ready;

    expect(calls.batch.length).toBe(0);
    // In-memory state comes from localStorage sync hydrate; LevelDB was empty.
    // (The store trusts LevelDB when marker is set, so no override happens.)
    expect(store.isDismissed('should-not-migrate')).toBe(true);
  });

  it('skips migration when the LevelDB namespace already has rows', async () => {
    localStorage.setItem(
      LS_DISMISSED_KEY,
      JSON.stringify([{ gameId: 'ls-only', at: 1 }]),
    );
    const { calls } = installFakeStore({
      seed: [{ key: 'd:existing', value: { gameId: 'existing', at: 42 } }],
    });

    const store = await loadFreshStore();
    await store.ready;

    // No migration attempted because LevelDB was non-empty.
    expect(calls.batch.length).toBe(0);
    // LevelDB rows won.
    expect(store.getDismissedIds()).toEqual(['existing']);
  });

  it('stamps markers even when localStorage state is empty', async () => {
    installFakeStore();
    const store = await loadFreshStore();
    await store.ready;

    expect(localStorage.getItem(MIGRATION_MARKER_DISMISSED)).toBe('yes');
    expect(localStorage.getItem(MIGRATION_MARKER_HISTORY)).toBe('yes');
    expect(store.getDismissedCount()).toBe(0);
    expect(store.getHistorySize()).toBe(0);
  });
});

describe('RecoHistoryStore — debounced save writes to LevelDB', () => {
  it('coalesces bursts of writes into a single batch call', async () => {
    vi.useFakeTimers();
    try {
      // Pre-stamp markers so init doesn't emit its own migration batch.
      localStorage.setItem(MIGRATION_MARKER_DISMISSED, 'yes');
      localStorage.setItem(MIGRATION_MARKER_HISTORY, 'yes');
      const { calls, db } = installFakeStore();

      const store = await loadFreshStore();
      await store.ready;
      calls.batch.length = 0;

      store.dismiss('steam-x', { title: 'X' });
      store.dismiss('steam-y', { title: 'Y' });
      store.recordClick('steam-z', 'Z', 'hero');

      // Debounce window still open.
      expect(calls.batch.length).toBe(0);

      await vi.advanceTimersByTimeAsync(320);

      expect(calls.batch.length).toBe(1);
      const ops = calls.batch[0] as Array<{ type: string; key: string }>;
      const keys = new Set(ops.filter((o) => o.type === 'put').map((o) => o.key));
      expect(keys).toEqual(new Set(['d:steam-x', 'd:steam-y', 'h:steam-z']));
      expect(db.has(`${LEVEL_NAMESPACE}::d:steam-x`)).toBe(true);
      expect(db.has(`${LEVEL_NAMESPACE}::h:steam-z`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits del ops for entries that disappeared since the last save', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = installFakeStore({
        seed: [{ key: 'd:steam-old', value: { gameId: 'steam-old', at: 1 } }],
      });

      const store = await loadFreshStore();
      await store.ready;
      calls.batch.length = 0;

      store.undismiss('steam-old');
      await vi.advanceTimersByTimeAsync(320);

      expect(calls.batch.length).toBe(1);
      const ops = calls.batch[0] as Array<{ type: string; key: string }>;
      const dels = ops.filter((o) => o.type === 'del');
      expect(dels.some((o) => o.key === 'd:steam-old')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RecoHistoryStore — reset()', () => {
  it('wipes the LevelDB namespace, both legacy keys, and both markers', async () => {
    const { calls, db } = installFakeStore({
      seed: [{ key: 'd:steam-1', value: { gameId: 'steam-1', at: 1 } }],
    });
    localStorage.setItem(MIGRATION_MARKER_DISMISSED, 'yes');
    localStorage.setItem(MIGRATION_MARKER_HISTORY, 'yes');
    localStorage.setItem(LS_DISMISSED_KEY, JSON.stringify([]));
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([]));

    const store = await loadFreshStore();
    await store.ready;

    store.reset();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.getDismissedCount()).toBe(0);
    expect(store.getHistorySize()).toBe(0);
    expect(localStorage.getItem(LS_DISMISSED_KEY)).toBeNull();
    expect(localStorage.getItem(LS_HISTORY_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER_DISMISSED)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER_HISTORY)).toBeNull();
  });
});
