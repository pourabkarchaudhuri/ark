/**
 * Journey Store — LevelDB migration + persistence tests (v1.0.61).
 *
 * Covers:
 *  - Fallback path: `window.store` absent -> legacy localStorage read/write.
 *  - Hydration from LevelDB rows on init (per-entry rows keyed by gameId).
 *  - One-shot migration: localStorage payload -> LevelDB namespace, marker
 *    stamped, original localStorage key preserved for rollback.
 *  - Migration is a no-op when the marker is already present.
 *  - Migration is a no-op when the LevelDB namespace is already non-empty.
 *  - Debounced write coalesces multiple record()s into one batch.
 *  - clear() nukes the LevelDB namespace + legacy key + migration marker.
 *
 * The tests instantiate `JourneyStore` directly (not the module-scoped
 * singleton) so state resets cleanly between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JourneyStore } from './journey-store';
import { JourneyEntry } from '@/types/game';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ark-journey-history';
const MIGRATION_MARKER = 'ark-journey-history-migrated-v1';
const LEVEL_NAMESPACE = 'journey';

function makeEntry(overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    gameId: overrides.gameId ?? 'steam-730',
    title: overrides.title ?? 'Test Game',
    coverUrl: overrides.coverUrl,
    genre: overrides.genre ?? ['Action'],
    platform: overrides.platform ?? ['Steam'],
    releaseDate: overrides.releaseDate,
    status: overrides.status ?? 'Playing',
    hoursPlayed: overrides.hoursPlayed ?? 5,
    rating: overrides.rating ?? 0,
    firstPlayedAt: overrides.firstPlayedAt,
    lastPlayedAt: overrides.lastPlayedAt,
    addedAt: overrides.addedAt ?? new Date('2026-01-01T00:00:00Z').toISOString(),
    removedAt: overrides.removedAt,
  };
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seed?: JourneyEntry[];
  getAllError?: string;
}

/**
 * Build a fake `window.store` implementation backed by an in-memory Map
 * keyed by `${namespace}::${key}`. Enough of the real IPC surface for this
 * test suite; unrelated methods still resolve so misuse only shows up in
 * the assertions we make.
 */
function installFakeStore(opts: FakeStoreOpts = {}): {
  restore: () => void;
  calls: FakeStoreCalls;
  db: Map<string, unknown>;
} {
  const db = new Map<string, unknown>();
  for (const e of opts.seed ?? []) db.set(`${LEVEL_NAMESPACE}::${e.gameId}`, e);
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
  // Ensure a clean gate for each test.
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

describe('JourneyStore — localStorage fallback (no window.store)', () => {
  it('reads from localStorage synchronously when window.store is undefined', () => {
    const seed = [makeEntry({ gameId: 'steam-1', title: 'Alpha' })];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: seed, lastUpdated: 'x' }),
    );

    const store = new JourneyStore();

    expect(store.getSize()).toBe(1);
    expect(store.has('steam-1')).toBe(true);
    expect(store.getEntry('steam-1')?.title).toBe('Alpha');
  });

  it('does not attempt LevelDB IPC when the surface is missing', async () => {
    // No store installed -> constructor must not throw and must resolve ready.
    const store = new JourneyStore();
    expect(store.getSize()).toBe(0);
    await store.ready;
  });

  it('writes back to localStorage on the debounced save path', async () => {
    vi.useFakeTimers();
    try {
      const store = new JourneyStore();
      await store.ready;

      store.record({
        gameId: 'steam-42',
        title: 'B',
        genre: [],
        platform: ['Steam'],
        status: 'Playing',
        hoursPlayed: 1,
        rating: 0,
      });

      // Debounce still open.
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      await vi.advanceTimersByTimeAsync(320);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.version).toBe(2);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].gameId).toBe('steam-42');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JourneyStore — LevelDB hydration', () => {
  it('hydrates the in-memory cache from window.store.getAll rows', async () => {
    const seed: JourneyEntry[] = [
      makeEntry({ gameId: 'steam-1', title: 'One', addedAt: '2026-01-15T00:00:00Z' }),
      makeEntry({ gameId: 'steam-2', title: 'Two', addedAt: '2026-02-01T00:00:00Z' }),
    ];
    const { calls } = installFakeStore({ seed });

    const store = new JourneyStore();
    await store.ready;

    expect(calls.getAll).toBe(1);
    expect(store.getSize()).toBe(2);
    // Sorted newest-first by addedAt.
    expect(store.getAllEntries().map((e) => e.gameId)).toEqual(['steam-2', 'steam-1']);
  });

  it('notifies subscribers once hydration finishes', async () => {
    const seed = [makeEntry({ gameId: 'sub-1' })];
    installFakeStore({ seed });

    const store = new JourneyStore();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.ready;

    expect(listener).toHaveBeenCalled();
  });

  it('falls back to localStorage when the getAll IPC returns an error', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ gameId: 'steam-9', title: 'Fallback' })],
        lastUpdated: 'x',
      }),
    );
    installFakeStore({ getAllError: 'rate_limited' });

    const store = new JourneyStore();
    await store.ready;

    expect(store.getSize()).toBe(1);
    expect(store.getEntry('steam-9')?.title).toBe('Fallback');
  });
});

describe('JourneyStore — one-shot migration', () => {
  it('copies localStorage payload into LevelDB when namespace is empty', async () => {
    const seed: JourneyEntry[] = [
      makeEntry({ gameId: 'steam-1', title: 'One' }),
      makeEntry({ gameId: 'steam-2', title: 'Two' }),
    ];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: seed, lastUpdated: 'x' }),
    );
    const { calls, db } = installFakeStore();

    const store = new JourneyStore();
    await store.ready;

    // Migration batch must have put both rows.
    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops.length).toBe(2);
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['steam-1', 'steam-2']));

    // LevelDB backing store now contains both rows keyed by gameId.
    expect(db.has(`${LEVEL_NAMESPACE}::steam-1`)).toBe(true);
    expect(db.has(`${LEVEL_NAMESPACE}::steam-2`)).toBe(true);

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');

    // Original localStorage key preserved for one-release rollback.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // In-memory cache is hydrated.
    expect(store.getSize()).toBe(2);
  });

  it('skips migration when marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ gameId: 'never-migrated' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore();

    const store = new JourneyStore();
    await store.ready;

    expect(calls.batch.length).toBe(0);
    expect(store.getSize()).toBe(0);
  });

  it('skips migration when LevelDB namespace already has rows', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeEntry({ gameId: 'ls-only' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore({
      seed: [makeEntry({ gameId: 'existing', title: 'Already in LevelDB' })],
    });

    const store = new JourneyStore();
    await store.ready;

    // No migration attempted because LevelDB was non-empty.
    expect(calls.batch.length).toBe(0);
    expect(store.getSize()).toBe(1);
    expect(store.has('existing')).toBe(true);
    expect(store.has('ls-only')).toBe(false);
    // Marker NOT stamped (migration path was never entered).
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });

  it('stamps the marker even when localStorage payload is empty/missing', async () => {
    // localStorage empty, LevelDB empty. No migration but marker stamped
    // to avoid retrying every boot.
    installFakeStore();
    const store = new JourneyStore();
    await store.ready;

    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getSize()).toBe(0);
  });

  it('preserves the legacy localStorage key across the migration (rollback insurance)', async () => {
    const seed = [makeEntry({ gameId: 'preserve-me', title: 'Preserved' })];
    const rawPayload = JSON.stringify({ version: 2, entries: seed, lastUpdated: 'x' });
    localStorage.setItem(STORAGE_KEY, rawPayload);
    installFakeStore();

    const store = new JourneyStore();
    await store.ready;

    // Byte-identical preservation of the legacy blob.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(rawPayload);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getEntry('preserve-me')?.title).toBe('Preserved');
  });
});

describe('JourneyStore — debounced save writes to LevelDB', () => {
  it('batches recorded entries ~300ms after the last record()', async () => {
    vi.useFakeTimers();
    try {
      const { calls, db } = installFakeStore();

      const store = new JourneyStore();
      await store.ready;
      // Reset batch calls left over from the empty-migration path.
      calls.batch.length = 0;

      store.record({
        gameId: 'a1',
        title: 'A',
        genre: [],
        platform: ['Steam'],
        status: 'Playing',
        hoursPlayed: 1,
        rating: 0,
      });
      store.record({
        gameId: 'a2',
        title: 'B',
        genre: [],
        platform: ['Steam'],
        status: 'Playing',
        hoursPlayed: 1,
        rating: 0,
      });
      store.record({
        gameId: 'a3',
        title: 'C',
        genre: [],
        platform: ['Steam'],
        status: 'Playing',
        hoursPlayed: 1,
        rating: 0,
      });

      // Nothing written yet — debounce window still open.
      expect(calls.batch.length).toBe(0);

      await vi.advanceTimersByTimeAsync(310);

      expect(calls.batch.length).toBe(1);
      const ops = calls.batch[0] as Array<{ type: string; key: string }>;
      expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['a1', 'a2', 'a3']));
      expect(db.has(`${LEVEL_NAMESPACE}::a1`)).toBe(true);
      expect(db.has(`${LEVEL_NAMESPACE}::a2`)).toBe(true);
      expect(db.has(`${LEVEL_NAMESPACE}::a3`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits del ops for entries removed via deleteEntry()', async () => {
    vi.useFakeTimers();
    try {
      const seed: JourneyEntry[] = [
        makeEntry({ gameId: 'keep' }),
        makeEntry({ gameId: 'drop' }),
      ];
      const { calls, db } = installFakeStore({ seed });

      const store = new JourneyStore();
      await store.ready;
      calls.batch.length = 0;

      expect(store.deleteEntry('drop')).toBe(true);
      await vi.advanceTimersByTimeAsync(320);

      expect(calls.batch.length).toBe(1);
      const ops = calls.batch[0] as Array<{ type: string; key: string; namespace: string }>;
      const delOps = ops.filter((o) => o.type === 'del');
      expect(delOps.map((o) => o.key)).toContain('drop');
      expect(db.has(`${LEVEL_NAMESPACE}::drop`)).toBe(false);
      expect(db.has(`${LEVEL_NAMESPACE}::keep`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JourneyStore — clear()', () => {
  it('wipes the LevelDB namespace, the legacy key, and the migration marker', async () => {
    const { calls, db } = installFakeStore({
      seed: [makeEntry({ gameId: 'x1' })],
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: [], lastUpdated: 'x' }),
    );

    const store = new JourneyStore();
    await store.ready;
    expect(store.getSize()).toBe(1);

    store.clear();
    // clearNamespace is fire-and-forget; give the microtask a tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.getSize()).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
