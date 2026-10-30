/**
 * 1.0.97 B18 — library status propagation: the startup cross-store sweep waits
 * for hydration and normalises each title once; propagation only ever syncs
 * Steam <-> Epic (never same-store remasters, remakes years apart, or custom
 * games); setCachedMetaBatch notifies once per batch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CachedGameMeta, GameStatus, LibraryGameEntry } from '@/types/game';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    syncTitleIfPlaceholder: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, updated: 0, skipped: 0 }),
    clear: vi.fn(),
    ready: Promise.resolve(),
  },
}));

vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getTotalHours: vi.fn().mockReturnValue(0),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    clear: vi.fn(),
  },
}));

vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    getFirstPlayingTransition: vi.fn().mockReturnValue(null),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, skipped: 0 }),
    clear: vi.fn(),
    ready: vi.fn(() => Promise.resolve()),
  },
}));

// Wrap the real normalizeTitle so the sweep's call count can be measured.
vi.mock('@/services/dedup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/dedup')>();
  return { ...actual, normalizeTitle: vi.fn(actual.normalizeTitle) };
});

import { LibraryStore, libraryStore } from '@/services/library-store';
import { normalizeTitle } from '@/services/dedup';
import { journeyStore } from '@/services/journey-store';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function add(gameId: string, status: GameStatus, cachedMeta?: CachedGameMeta) {
  return libraryStore.addToLibrary({
    gameId,
    status,
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    ...(cachedMeta ? { cachedMeta } : {}),
  });
}

function row(gameId: string, status: GameStatus, title: string, releaseDate = '2020-12-10'): LibraryGameEntry {
  return {
    gameId,
    status,
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    hoursPlayed: 0,
    rating: 0,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    cachedMeta: { title, releaseDate },
  } as LibraryGameEntry;
}

/** window.store fake whose getAll resolves only when `release()` is called. */
function installGatedStore(rows: LibraryGameEntry[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fake = {
    getAll: async () => {
      await gate;
      return { rows: rows.map((value) => ({ key: value.gameId, value })) };
    },
    batch: async () => ({ ok: true }),
    clearNamespace: async () => ({ ok: true }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { release };
}

describe('propagateStatusByTitle store / year guards', () => {
  beforeEach(() => {
    localStorage.clear();
    libraryStore.clear();
  });

  it('does not sync two same-store remasters whose titles normalise alike', async () => {
    add('steam-221380', 'Want to Play', { title: 'Age of Empires II HD', releaseDate: '2013-04-09' });
    add('steam-813780', 'Want to Play', { title: 'Age of Empires II: Definitive Edition', releaseDate: '2019-11-14' });

    libraryStore.updateEntry('steam-221380', { status: 'Completed' });
    await flush();

    expect(libraryStore.getEntry('steam-813780')!.status).toBe('Want to Play');
    expect(libraryStore.getEntry('steam-813780')!.crossStoreSyncedFrom).toBeUndefined();
  });

  it('does not sync a Steam 2008 original with an Epic 2023 remake', async () => {
    add('steam-17470', 'Want to Play', { title: 'Dead Space', releaseDate: '2008-10-20' });
    add('epic-ds:remake', 'Want to Play', { title: 'Dead Space', releaseDate: '2023-01-27' });

    libraryStore.updateEntry('steam-17470', { status: 'Completed' });
    await flush();

    expect(libraryStore.getEntry('epic-ds:remake')!.status).toBe('Want to Play');
  });

  it('still syncs Steam -> Epic for the same game (one-year gap allowed)', async () => {
    add('steam-1091500', 'Want to Play', { title: 'Cyberpunk 2077', releaseDate: '2020-12-10' });
    add('epic-fn:cp', 'Want to Play', { title: 'Cyberpunk 2077: Ultimate Edition', releaseDate: '2021-01-05' });

    libraryStore.updateEntry('steam-1091500', { status: 'Completed' });
    await flush();

    expect(libraryStore.getEntry('epic-fn:cp')!.status).toBe('Completed');
    expect(libraryStore.getEntry('epic-fn:cp')!.crossStoreSyncedFrom).toBe('steam-1091500');
  });

  it('ignores unconfirmed (TBA) dates for the year guard', async () => {
    add('steam-5', 'Want to Play', { title: 'Hollow Knight Silksong', releaseDate: '2019-02-14' });
    add('epic-5', 'Want to Play', { title: 'Hollow Knight Silksong', releaseDate: 'TBA 2025' });

    libraryStore.updateEntry('steam-5', { status: 'Playing' });
    await flush();

    expect(libraryStore.getEntry('epic-5')!.status).toBe('Playing');
  });

  it('never touches a custom-id sibling, even with a store in its cached meta', async () => {
    add('steam-9', 'Want to Play', { title: 'Hades', releaseDate: '2020-09-17' });
    add('custom-3', 'Want to Play', { title: 'Hades', releaseDate: '2020-09-17', store: 'epic' });

    libraryStore.updateEntry('steam-9', { status: 'Completed' });
    await flush();

    expect(libraryStore.getEntry('custom-3')!.status).toBe('Want to Play');
  });
});

describe('syncCrossStoreStatusesOnce', () => {
  afterEach(() => {
    delete (window as { store?: unknown }).store;
  });

  it('waits for hydration, then syncs the pair with a single notify', async () => {
    const { release } = installGatedStore([
      row('steam-1091500', 'Completed', 'Cyberpunk 2077'),
      row('epic-cp', 'Want to Play', 'Cyberpunk 2077'),
    ]);
    const store = new LibraryStore();
    let notifies = 0;
    store.subscribe(() => { notifies++; });

    // Before hydration: empty map, the sweep must not mark itself done.
    expect(store.getAllEntries()).toHaveLength(0);

    release();
    await store.ready;
    await flush();
    notifies = 0;

    const entries = store.getAllEntries();
    expect(entries.find((e) => e.gameId === 'epic-cp')!.status).toBe('Completed');
    expect(store.getEntry('epic-cp')!.crossStoreSyncedFrom).toBe('steam-1091500');
    expect(notifies).toBe(1);

    // Already swept — a second read changes nothing and does not notify.
    store.getAllEntries();
    expect(notifies).toBe(1);
  });

  it('normalises each title about once (not once per bucket) on a 2,000-game library', async () => {
    const rows: LibraryGameEntry[] = [];
    // 200 twin buckets (Steam Completed + Epic Want to Play) ...
    for (let i = 0; i < 200; i++) {
      rows.push(row(`steam-${i}`, 'Completed', `Twin Game ${i}`));
      rows.push(row(`epic-twin-${i}`, 'Want to Play', `Twin Game ${i}`));
    }
    // ... plus 1,600 unique titles.
    for (let i = 0; i < 1600; i++) rows.push(row(`steam-u${i}`, 'Want to Play', `Unique Title ${i}`));
    const { release } = installGatedStore(rows);
    const store = new LibraryStore();
    release();
    await store.ready;
    await flush();

    const spy = vi.mocked(normalizeTitle);
    spy.mockClear();
    let notifies = 0;
    store.subscribe(() => { notifies++; });

    store.getAllEntries();

    expect(spy.mock.calls.length).toBeLessThanOrEqual(rows.length + 10);
    expect(store.getEntry('epic-twin-0')!.status).toBe('Completed');
    expect(store.getEntry('epic-twin-199')!.status).toBe('Completed');
    expect(notifies).toBe(1);
  });
});

describe('setCachedMetaBatch', () => {
  beforeEach(() => {
    localStorage.clear();
    libraryStore.clear();
  });

  it('applies only cachedMeta and notifies once for the batch', () => {
    for (let i = 0; i < 30; i++) add(`steam-${i}`, 'Playing');
    vi.mocked(journeyStore.has).mockImplementation((id: string) => id === 'steam-3');
    let notifies = 0;
    const unsub = libraryStore.subscribe(() => { notifies++; });

    const batch = new Map<string, CachedGameMeta>();
    for (let i = 0; i < 30; i++) batch.set(`steam-${i}`, { title: `Game ${i}` });
    batch.set('steam-missing', { title: 'Not in library' });
    const changed = libraryStore.setCachedMetaBatch(batch);
    unsub();
    vi.mocked(journeyStore.has).mockReturnValue(false);

    expect(changed).toBe(30);
    expect(notifies).toBe(1);
    expect(libraryStore.getEntry('steam-7')!.cachedMeta!.title).toBe('Game 7');
    expect(libraryStore.getEntry('steam-7')!.status).toBe('Playing');
    expect(libraryStore.getEntry('steam-missing')).toBeUndefined();
    expect(journeyStore.syncTitleIfPlaceholder).toHaveBeenCalledWith('steam-3', 'Game 3');
  });

  it('bumps the replace epoch on clear and import', () => {
    const e0 = libraryStore.getReplaceEpoch();
    libraryStore.clear();
    expect(libraryStore.getReplaceEpoch()).toBe(e0 + 1);
    libraryStore.importData(JSON.stringify({ entries: [] }));
    expect(libraryStore.getReplaceEpoch()).toBe(e0 + 2);
  });
});
