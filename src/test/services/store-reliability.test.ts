/**
 * Store reliability (audit items 5, 6, 10) — LevelDB write ordering, delta
 * writes and hours-only notification channels for the renderer stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LibraryStore } from '@/services/library-store';
import { JourneyStore } from '@/services/journey-store';
import { SessionStore } from '@/services/session-store';
import { CustomGameStore } from '@/services/custom-game-store';
import { __resetStorageHealthForTests, __setStorageRetryDelaysForTests } from '@/services/storage-health';
import type { GameSession, JourneyEntry, LibraryGameEntry } from '@/types/game';

type Op =
  | { type: 'put'; namespace: string; key: string; value: unknown }
  | { type: 'del'; namespace: string; key: string };

interface FakeOpts {
  /** clearNamespace applies its deletions only after this delay (simulates a slow LevelDB clear). */
  clearDelayMs?: number;
  /** batch resolves (and applies) after this delay. */
  batchDelayMs?: number;
  seed?: Array<[string, unknown]>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function installFakeStore(opts: FakeOpts = {}) {
  const db = new Map<string, unknown>(opts.seed ?? []);
  const log: string[] = [];
  const batches: Op[][] = [];
  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getAll: async (ns: string) => {
      const prefix = `${ns}::`;
      const rows: Array<{ key: string; value: unknown }> = [];
      for (const [k, v] of db.entries()) if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      return { rows };
    },
    put: async (ns: string, key: string, value: unknown) => {
      db.set(`${ns}::${key}`, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    },
    del: async (ns: string, key: string) => {
      db.delete(`${ns}::${key}`);
      return { ok: true };
    },
    batch: async (ops: Op[]) => {
      log.push('batch:start');
      batches.push(ops);
      if (opts.batchDelayMs) await sleep(opts.batchDelayMs);
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, JSON.parse(JSON.stringify(op.value)));
        else db.delete(`${op.namespace}::${op.key}`);
      }
      log.push('batch:end');
      return { ok: true };
    },
    has: async () => ({ value: false }),
    clearNamespace: async (ns: string) => {
      log.push('clear:start');
      if (opts.clearDelayMs) await sleep(opts.clearDelayMs);
      const prefix = `${ns}::`;
      for (const k of Array.from(db.keys())) if (k.startsWith(prefix)) db.delete(k);
      log.push('clear:end');
      return { ok: true };
    },
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, log, batches };
}

function libEntry(gameId: string, overrides: Partial<LibraryGameEntry> = {}): LibraryGameEntry {
  return {
    gameId,
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    hoursPlayed: 0,
    rating: 0,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as LibraryGameEntry;
}

function journeyEntry(gameId: string, overrides: Partial<JourneyEntry> = {}): JourneyEntry {
  return {
    gameId,
    title: `Title ${gameId}`,
    genre: [],
    platform: [],
    status: 'Playing',
    hoursPlayed: 1,
    rating: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as JourneyEntry;
}

function session(id: string, gameId = 'steam-1'): GameSession {
  return {
    id,
    gameId,
    executablePath: 'C:\\g.exe',
    startTime: '2026-02-01T10:00:00.000Z',
    endTime: '2026-02-01T11:00:00.000Z',
    durationMinutes: 60,
    idleMinutes: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
  __setStorageRetryDelaysForTests([0, 0]);
  __resetStorageHealthForTests();
});

afterEach(() => {
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('import awaits clear (item 5)', () => {
  it('JourneyStore: clear() then importData() — the batch lands after the slow clear finished', async () => {
    const { db, log } = installFakeStore({
      clearDelayMs: 40,
      seed: [['journey::old', journeyEntry('old')]],
    });
    const store = new JourneyStore();
    await store.ready;

    store.clear();
    store.importData([journeyEntry('steam-1'), journeyEntry('steam-2')]);
    await store.whenPersisted();
    await sleep(0);

    expect(log.indexOf('clear:end')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('batch:start')).toBeGreaterThan(log.indexOf('clear:end'));
    expect(db.has('journey::steam-1')).toBe(true);
    expect(db.has('journey::steam-2')).toBe(true);
    expect(db.has('journey::old')).toBe(false);
  });

  it('SessionStore: clear() then importData() keeps the imported sessions', async () => {
    const { db, log } = installFakeStore({ clearDelayMs: 40, seed: [['session::old', session('old')]] });
    const store = new SessionStore();
    await store.ready;

    store.clear();
    store.importData([session('a'), session('b')]);
    await store.whenPersisted();

    expect(log.indexOf('batch:start')).toBeGreaterThan(log.indexOf('clear:end'));
    expect(db.has('session::a')).toBe(true);
    expect(db.has('session::b')).toBe(true);
    expect(db.has('session::old')).toBe(false);
  });

  it('LibraryStore: clear() followed by new entries never loses them to the late clear', async () => {
    const { db } = installFakeStore({ clearDelayMs: 40, seed: [['library::old', libEntry('old')]] });
    const store = new LibraryStore();
    await store.ready;

    store.clear();
    store.addToLibrary({ gameId: 'steam-7', status: 'Playing', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    await sleep(350); // debounce
    await store.whenPersisted();

    expect(db.has('library::steam-7')).toBe(true);
    expect(db.has('library::old')).toBe(false);
  });
});

describe('serialized saves (item 10)', () => {
  it('a delete during an in-flight save is not missed (removed game stays removed)', async () => {
    const { db } = installFakeStore({ batchDelayMs: 50 });
    const store = new LibraryStore();
    await store.ready;

    store.addToLibrary({ gameId: 'steam-1', status: 'Playing', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    await sleep(320); // debounced save A starts (in flight for 50ms)
    store.removeFromLibrary('steam-1');
    await sleep(320); // save B scheduled while A is in flight
    await store.whenPersisted();

    expect(db.has('library::steam-1')).toBe(false);
  });
});

describe('delta writes (item 6)', () => {
  it('LibraryStore: an hours tick writes only the changed row', async () => {
    const { batches } = installFakeStore({
      seed: [
        ['library::a', libEntry('a', { status: 'Playing' })],
        ['library::b', libEntry('b')],
        ['library::c', libEntry('c')],
      ],
    });
    const store = new LibraryStore();
    await store.ready;
    batches.length = 0;

    store.updateHoursFromSessions('a', 2);
    await sleep(320);
    await store.whenPersisted();

    expect(batches).toHaveLength(1);
    expect(batches[0].map((o) => o.key)).toEqual(['a']);
  });

  it('JourneyStore: a progress sync writes only that game', async () => {
    const { batches } = installFakeStore({
      seed: [['journey::a', journeyEntry('a')], ['journey::b', journeyEntry('b')]],
    });
    const store = new JourneyStore();
    await store.ready;
    batches.length = 0;

    store.syncProgress('b', { hoursPlayed: 5 });
    await sleep(320);
    await store.whenPersisted();

    expect(batches).toHaveLength(1);
    expect(batches[0].map((o) => o.key)).toEqual(['b']);
  });
});

describe('hours tick does not trigger the full notify (item 6)', () => {
  it('JourneyStore.syncProgress with only hours fires the hours channel, not subscribe()', () => {
    const store = new JourneyStore();
    store.record({ ...journeyEntry('steam-1'), addedAt: undefined } as any);
    const general = vi.fn();
    const hours = vi.fn();
    store.subscribe(general);
    store.subscribeHours(hours);
    const before = store.getAllEntries();

    store.syncProgress('steam-1', { hoursPlayed: 3.25 });

    expect(general).not.toHaveBeenCalled();
    expect(hours).toHaveBeenCalledTimes(1);
    expect(store.getEntry('steam-1')?.hoursPlayed).toBe(3.25);
    // Cached sorted array is reused → useJourneyHistory consumers don't re-render.
    expect(store.getAllEntries()).toBe(before);

    // A real progress change (lastPlayedAt) is still a general mutation.
    store.syncProgress('steam-1', { hoursPlayed: 3.5, lastPlayedAt: '2026-03-01T00:00:00.000Z' });
    expect(general).toHaveBeenCalledTimes(1);

    // No-op sync → no notification at all.
    general.mockClear();
    hours.mockClear();
    store.syncProgress('steam-1', { hoursPlayed: 3.5 });
    expect(general).not.toHaveBeenCalled();
    expect(hours).not.toHaveBeenCalled();
  });

  it('CustomGameStore.updateHoursFromSessions fires only the hours channel (no version bump)', () => {
    const store = new CustomGameStore();
    const game = store.addGame({ title: 'Indie', platform: ['Windows'], status: 'Playing', executablePath: 'C:\\x.exe' });
    const general = vi.fn();
    const hours = vi.fn();
    store.subscribe(general);
    store.subscribeHours(hours);
    const version = store.getVersion();

    store.updateHoursFromSessions(game.id, 1.5);

    expect(general).not.toHaveBeenCalled();
    expect(hours).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(version);
    expect(store.getGame(game.id)?.hoursPlayed).toBe(1.5);
  });

  it('LibraryStore.updateHoursFromSessions keeps using the hours-only channel', () => {
    const store = new LibraryStore();
    store.addToLibrary({ gameId: 'steam-3', status: 'Playing', priority: 'Medium', publicReviews: '', recommendationSource: '' });
    const general = vi.fn();
    const hours = vi.fn();
    store.subscribe(general);
    store.subscribeHours(hours);
    const version = store.getVersion();

    store.updateHoursFromSessions('steam-3', 4);

    expect(general).not.toHaveBeenCalled();
    expect(hours).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(version);
  });
});

describe('session replay is idempotent (item 1)', () => {
  it('recording the same session id twice counts it once', () => {
    const store = new SessionStore();
    expect(store.record(session('dup-1'))).toBe(true);
    expect(store.record(session('dup-1'))).toBe(false);
    expect(store.getForGame('steam-1')).toHaveLength(1);
    expect(store.getTotalHours('steam-1')).toBe(1);
  });

  it('sessions recorded before LevelDB hydration finished are merged, not replaced', async () => {
    installFakeStore({ seed: [['session::persisted', session('persisted')]] });
    const store = new SessionStore();
    store.record(session('early')); // before ready resolves
    await store.ready;
    expect(store.getAll().map((s) => s.id).sort()).toEqual(['early', 'persisted']);
    await store.persistNow(); // don't leave a debounced save behind
  });
});
