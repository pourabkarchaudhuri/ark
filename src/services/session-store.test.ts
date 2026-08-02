/**
 * Session Store — LevelDB migration + persistence tests (v1.0.61).
 *
 * Covers:
 *  - useLevelDB gate flip: `window.store` absent  -> localStorage path
 *  - useLevelDB gate flip: `window.store` present -> LevelDB path
 *  - Hydration from LevelDB rows on init
 *  - One-shot migration from localStorage -> LevelDB (marker stamped)
 *  - Migration is a no-op when the marker is already present
 *  - Migration is a no-op when LevelDB namespace already has rows
 *  - Debounced save writes a batch of `put` ops
 *  - clear() nukes the LevelDB namespace + resets the marker
 *
 * The tests instantiate `SessionStore` directly (not the module-scoped
 * singleton) so state resets cleanly between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore } from './session-store';
import { GameSession } from '@/types/game';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ark-session-history';
const MIGRATION_MARKER = 'ark-session-history-migrated-v1';

function makeSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: overrides.id ?? `sess-${Math.random().toString(36).slice(2)}`,
    gameId: overrides.gameId ?? 'steam-730',
    executablePath: overrides.executablePath ?? 'C:/Games/csgo.exe',
    startTime: overrides.startTime ?? new Date('2026-01-01T10:00:00Z').toISOString(),
    endTime: overrides.endTime ?? new Date('2026-01-01T11:00:00Z').toISOString(),
    durationMinutes: overrides.durationMinutes ?? 60,
    idleMinutes: overrides.idleMinutes ?? 0,
  };
}

interface FakeStoreCalls {
  getAll: number;
  batch: Array<Array<unknown>>;
  clearNamespace: number;
}

interface FakeStoreOpts {
  seed?: GameSession[];
  getAllError?: string;
}

/**
 * Build a fake `window.store` implementation backed by an in-memory Map
 * keyed by `${namespace}::${key}`. Enough of the real IPC surface for
 * this test suite; unrelated methods throw so misuse is caught.
 */
function installFakeStore(opts: FakeStoreOpts = {}): {
  restore: () => void;
  calls: FakeStoreCalls;
  db: Map<string, unknown>;
} {
  const db = new Map<string, unknown>();
  for (const s of opts.seed ?? []) db.set(`session::${s.id}`, s);
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
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionStore — localStorage fallback (no window.store)', () => {
  it('reads from localStorage synchronously when window.store is undefined', () => {
    const seed = [makeSession({ id: 'a1', gameId: 'steam-1', durationMinutes: 30 })];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: seed, lastUpdated: 'x' }),
    );

    const store = new SessionStore();

    expect(store.getAll()).toHaveLength(1);
    expect(store.getForGame('steam-1')).toHaveLength(1);
    expect(store.getTotalHours('steam-1')).toBe(0.5);
  });

  it('does not attempt LevelDB IPC when the surface is missing', () => {
    // No store installed -> constructor must not throw and must resolve ready.
    const store = new SessionStore();
    expect(store.getAll()).toEqual([]);
    return store.ready;
  });
});

describe('SessionStore — LevelDB hydration', () => {
  it('hydrates the in-memory cache from window.store.getAll rows', async () => {
    const seed: GameSession[] = [
      makeSession({
        id: 'b1',
        gameId: 'steam-1',
        startTime: '2026-02-01T00:00:00Z',
        durationMinutes: 120,
      }),
      makeSession({
        id: 'b2',
        gameId: 'steam-1',
        startTime: '2026-01-15T00:00:00Z',
        durationMinutes: 30,
      }),
    ];
    const { calls } = installFakeStore({ seed });

    const store = new SessionStore();
    await store.ready;

    expect(calls.getAll).toBe(1);
    expect(store.getAll()).toHaveLength(2);
    // Sorted chronologically after hydrate.
    expect(store.getAll()[0].id).toBe('b2');
    expect(store.getTotalHours('steam-1')).toBe(2.5);
  });

  it('notifies subscribers once hydration finishes', async () => {
    const seed = [makeSession({ id: 'c1' })];
    installFakeStore({ seed });

    const store = new SessionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.ready;

    // At least one notification (hydrate). The empty-migration path also
    // notifies, so we just assert notification happens.
    expect(listener).toHaveBeenCalled();
  });

  it('falls back to localStorage when the getAll IPC returns an error', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeSession({ id: 'd1', gameId: 'steam-9' })],
        lastUpdated: 'x',
      }),
    );
    installFakeStore({ getAllError: 'rate_limited' });

    const store = new SessionStore();
    await store.ready;

    expect(store.getForGame('steam-9')).toHaveLength(1);
  });
});

describe('SessionStore — one-shot migration', () => {
  it('copies localStorage payload into LevelDB when namespace is empty', async () => {
    const seed: GameSession[] = [
      makeSession({ id: 'm1', gameId: 'steam-1' }),
      makeSession({ id: 'm2', gameId: 'steam-2' }),
    ];
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: seed, lastUpdated: 'x' }),
    );
    const { calls, db } = installFakeStore();

    const store = new SessionStore();
    await store.ready;

    // Migration batch must have put both rows.
    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(ops.length).toBe(2);
    expect(ops.every((o) => o.type === 'put')).toBe(true);
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['m1', 'm2']));

    // LevelDB backing store now contains both rows.
    expect(db.has('session::m1')).toBe(true);
    expect(db.has('session::m2')).toBe(true);

    // Marker stamped.
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');

    // Original localStorage key preserved for one-release rollback.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // In-memory cache is hydrated.
    expect(store.getAll()).toHaveLength(2);
  });

  it('skips migration when marker is already present', async () => {
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeSession({ id: 'n1' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore();

    const store = new SessionStore();
    await store.ready;

    expect(calls.batch.length).toBe(0);
    expect(store.getAll()).toHaveLength(0);
  });

  it('skips migration when LevelDB namespace already has rows', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        entries: [makeSession({ id: 'ls-only' })],
        lastUpdated: 'x',
      }),
    );
    const { calls } = installFakeStore({
      seed: [makeSession({ id: 'existing', gameId: 'steam-existing' })],
    });

    const store = new SessionStore();
    await store.ready;

    // No migration attempted because LevelDB was non-empty.
    expect(calls.batch.length).toBe(0);
    expect(store.getAll().map((s) => s.id)).toEqual(['existing']);
  });

  it('stamps the marker even when localStorage payload is empty/missing', async () => {
    // localStorage empty, LevelDB empty. No migration but marker stamped
    // to avoid retrying every boot.
    installFakeStore();
    const store = new SessionStore();
    await store.ready;

    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(store.getAll()).toEqual([]);
  });
});

describe('SessionStore — debounced save writes to LevelDB', () => {
  it('batches recorded sessions ~300ms after the last record()', async () => {
    vi.useFakeTimers();
    const { calls, db } = installFakeStore();

    const store = new SessionStore();
    await store.ready;
    // Reset batch calls from the empty-migration path (there are none in
    // this scenario, but clearing keeps the assertion focused).
    calls.batch.length = 0;

    store.record(makeSession({ id: 'w1', gameId: 'steam-42' }));
    store.record(makeSession({ id: 'w2', gameId: 'steam-42' }));

    // Nothing written yet — debounce window still open.
    expect(calls.batch.length).toBe(0);

    await vi.advanceTimersByTimeAsync(310);

    expect(calls.batch.length).toBe(1);
    const ops = calls.batch[0] as Array<{ type: string; key: string }>;
    expect(new Set(ops.map((o) => o.key))).toEqual(new Set(['w1', 'w2']));
    expect(db.has('session::w1')).toBe(true);
    expect(db.has('session::w2')).toBe(true);

    vi.useRealTimers();
  });
});

describe('SessionStore — clear()', () => {
  it('wipes the LevelDB namespace and resets the migration marker', async () => {
    const { calls, db } = installFakeStore({
      seed: [makeSession({ id: 'x1' })],
    });
    localStorage.setItem(MIGRATION_MARKER, 'yes');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: [], lastUpdated: 'x' }),
    );

    const store = new SessionStore();
    await store.ready;

    store.clear();
    // clearNamespace is fire-and-forget; give the microtask a tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.clearNamespace).toBe(1);
    expect(db.size).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});
