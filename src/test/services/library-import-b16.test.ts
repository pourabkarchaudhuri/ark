/**
 * v1.0.97 B16 — library import, export and clear, against the real stores
 * (localStorage path: no window.store, except where a test installs a fake).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { GameSession, LibraryGameEntry, StatusChangeEntry } from '@/types/game';
import { LibraryStore, libraryStore, repairJourneyRemovedFlags } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { journeyStore } from '@/services/journey-store';
import { sessionStore } from '@/services/session-store';
import { statusHistoryStore } from '@/services/status-history-store';

function entry(gameId: string, overrides: Partial<LibraryGameEntry> = {}): LibraryGameEntry {
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

function session(id: string, gameId: unknown, startTime: string, durationMinutes = 60): GameSession {
  return {
    id,
    gameId: gameId as string,
    executablePath: 'C:\\game.exe',
    startTime,
    endTime: startTime,
    durationMinutes,
    idleMinutes: 0,
  };
}

function file(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function resetAll() {
  libraryStore.clear();
  customGameStore.clear();
  journeyStore.clear();
  sessionStore.clear();
  statusHistoryStore.clear();
  localStorage.clear();
}

beforeAll(async () => {
  await Promise.all([libraryStore.ready, customGameStore.ready, journeyStore.ready, sessionStore.ready, statusHistoryStore.ready]);
});

beforeEach(resetAll);

describe('sorted cache and sanitising on import', () => {
  it('getAllEntries / getStats reflect the imported rows, not the cached old library', () => {
    libraryStore.addToLibrary({ gameId: 'steam-1', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    expect(libraryStore.getAllEntries().map((e) => e.gameId)).toEqual(['steam-1']);

    const res = libraryStore.importData(file({
      entries: [entry('steam-2', { status: 'Completed' }), entry('steam-3')],
    }));
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);
    expect(libraryStore.getAllEntries().map((e) => e.gameId).sort()).toEqual(['steam-2', 'steam-3']);
    const stats = libraryStore.getStats();
    expect(stats.total).toBe(2);
    expect(stats.byStatus.Completed).toBe(1);
    expect(stats.byStatus.Playing).toBe(0);
  });

  it('a bad date and legacy Dropped are sanitised, and a later updateEntry does not throw', () => {
    libraryStore.importData(file({
      entries: [entry('steam-5', { addedAt: '2023-13-45' as unknown as Date, status: 'Dropped' as never })],
    }));
    const row = libraryStore.getEntry('steam-5')!;
    expect(Number.isNaN(new Date(row.addedAt).getTime())).toBe(false);
    expect(row.status).toBe('On Hold');
    expect(() => libraryStore.updateEntry('steam-5', { status: 'Playing' })).not.toThrow();
  });
});

describe('pre-hydration reads', () => {
  afterEach(() => {
    Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  });

  it('an early getAllEntries() before LevelDB loads does not pin an empty list', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = {
      getAll: async () => {
        await gate;
        return { rows: [{ key: 'steam-9', value: entry('steam-9') }] };
      },
      batch: async () => ({ ok: true }),
      put: async () => ({ ok: true }),
      clearNamespace: async () => ({ ok: true }),
    };
    Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
    const store = new LibraryStore();
    expect(store.getAllEntries()).toHaveLength(0);
    release();
    await store.ready;
    expect(store.getAllEntries().length).toBeGreaterThan(0);
  });
});

describe('import confirmation plan, partial files and snapshot', () => {
  it('parseImport changes nothing and reports real counts', () => {
    libraryStore.addToLibrary({ gameId: 'steam-1', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    const parsed = libraryStore.parseImport(file({ entries: [entry('steam-2'), entry('steam-3')], sessionHistory: [] }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.plan.counts).toEqual({ currentGames: 1, fileGames: 2, currentCustomGames: 0, fileCustomGames: null });
    expect(parsed.plan.sessionHistory).toEqual([]);
    expect(parsed.plan.journeyHistory).toBeUndefined();
    expect(libraryStore.getAllGameIds()).toEqual(['steam-1']);
  });

  it('a file with entries but no sessionHistory keeps existing sessions', () => {
    sessionStore.record(session('s1', 'steam-1', '2024-01-01T10:00:00Z', 120));
    libraryStore.importData(file({ entries: [entry('steam-1')] }));
    expect(sessionStore.getTotalHours('steam-1')).toBe(2);
  });

  it('writes a snapshot before clearing, and restore round-trips exactly', async () => {
    const puts: Array<{ ns: string; key: string; value: any }> = [];
    Object.defineProperty(window, 'store', {
      value: { put: async (ns: string, key: string, value: unknown) => { puts.push({ ns, key, value }); return { ok: true }; } },
      writable: true,
      configurable: true,
    });
    try {
      libraryStore.addToLibrary({ gameId: 'steam-1', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
      customGameStore.addGame({ title: 'Mine', platform: ['Windows'], status: 'Want to Play' });
      const before = JSON.parse(libraryStore.exportData());

      libraryStore.importData(file({ entries: [entry('steam-2')], customGames: { entries: [], nextCounter: 1 } }));
      expect(libraryStore.getAllGameIds()).toEqual(['steam-2']);
      expect(puts).toHaveLength(1);
      expect(puts[0].ns).toBe('library-import-backup');
      const snap = JSON.parse(puts[0].value.data);
      expect(snap.entries.map((e: LibraryGameEntry) => e.gameId)).toEqual(['steam-1']);
      expect(libraryStore.getLastImportSnapshot()).toBe(puts[0].value.data);

      const restored = libraryStore.restoreLastImportSnapshot();
      expect(restored.success).toBe(true);
      const after = JSON.parse(libraryStore.exportData());
      delete before.exportedAt;
      delete after.exportedAt;
      expect(after).toEqual(before);
      expect(libraryStore.getLastImportSnapshot()).toBeNull();
    } finally {
      Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
    }
  });
});

describe('journey removedAt stays in step with the library', () => {
  it('remove then re-add clears removedAt', () => {
    libraryStore.addToLibrary({ gameId: 'steam-7', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    journeyStore.record({ gameId: 'steam-7', title: 'Seven', genre: [], platform: [], status: 'Playing', hoursPlayed: 5, rating: 0 });
    libraryStore.removeFromLibrary('steam-7');
    expect(journeyStore.getEntry('steam-7')?.removedAt).toBeTruthy();
    libraryStore.addToLibrary({ gameId: 'steam-7', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    expect(journeyStore.getEntry('steam-7')?.removedAt).toBeUndefined();
  });

  it('clearAll flags every cleared id with one shared timestamp, keeps old removedAt, one notify', () => {
    libraryStore.addToLibrary({ gameId: 'steam-1', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    const custom = customGameStore.addGame({ title: 'Mine', platform: ['Windows'], status: 'Playing' });
    journeyStore.record({ gameId: 'steam-1', title: 'One', genre: [], platform: [], status: 'Playing', hoursPlayed: 0, rating: 0 });
    journeyStore.record({ gameId: custom.id, title: 'Mine', genre: [], platform: [], status: 'Playing', hoursPlayed: 0, rating: 0 });
    journeyStore.record({ gameId: 'steam-99', title: 'Gone', genre: [], platform: [], status: 'Playing', hoursPlayed: 0, rating: 0 });
    journeyStore.markRemoved('steam-99');
    const oldRemovedAt = journeyStore.getEntry('steam-99')!.removedAt;

    let notifies = 0;
    const unsub = journeyStore.subscribe(() => { notifies++; });
    const res = libraryStore.clearAll();
    unsub();

    expect(res).toEqual({ libraryCount: 1, customCount: 1 });
    const a = journeyStore.getEntry('steam-1')!.removedAt;
    const b = journeyStore.getEntry(custom.id)!.removedAt;
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(journeyStore.getEntry('steam-99')!.removedAt).toBe(oldRemovedAt);
    expect(notifies).toBe(1);
    expect(libraryStore.getSize()).toBe(0);
    expect(customGameStore.getCount()).toBe(0);
  });

  it('boot repair clears a stuck removedAt for a game that is in the library', async () => {
    libraryStore.addToLibrary({ gameId: 'steam-4', status: 'Playing', priority: 'High', publicReviews: '', recommendationSource: '' });
    journeyStore.record({ gameId: 'steam-4', title: 'Four', genre: [], platform: [], status: 'Playing', hoursPlayed: 0, rating: 0 });
    journeyStore.markRemoved('steam-4'); // the pre-1.0.97 stuck state
    journeyStore.record({ gameId: 'steam-5', title: 'Five', genre: [], platform: [], status: 'Playing', hoursPlayed: 0, rating: 0 });
    journeyStore.markRemoved('steam-5'); // really removed
    expect(await repairJourneyRemovedFlags()).toBe(1);
    expect(journeyStore.getEntry('steam-4')!.removedAt).toBeUndefined();
    expect(journeyStore.getEntry('steam-5')!.removedAt).toBeTruthy();
    // Idempotent: a second call is a no-op.
    expect(await repairJourneyRemovedFlags()).toBe(0);
  });
});

describe('custom games in backups', () => {
  it('export, clear everything, import: custom games come back with their ids', () => {
    const a = customGameStore.addGame({ title: 'A', platform: ['Windows'], status: 'Playing' });
    const b = customGameStore.addGame({ title: 'B', platform: ['Windows'], status: 'Completed' });
    const exported = libraryStore.exportData();
    libraryStore.clearAll();
    expect(customGameStore.getCount()).toBe(0);

    const res = libraryStore.importData(exported);
    expect(res.customCount).toBe(2);
    expect(customGameStore.getAllGames().map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
    const next = customGameStore.addGame({ title: 'C', platform: ['Windows'], status: 'Want to Play' });
    const num = (id: string) => parseInt(id.slice('custom-'.length), 10);
    expect(num(next.id)).toBe(Math.max(num(a.id), num(b.id)) + 1);
  });

  it('an old file without customGames leaves existing custom games alone', () => {
    const a = customGameStore.addGame({ title: 'Keep me', platform: ['Windows'], status: 'Playing' });
    const res = libraryStore.importData(file({ entries: [entry('steam-1')] }));
    expect(res.customCount).toBe(1);
    expect(customGameStore.getGame(a.id)?.title).toBe('Keep me');
  });

  it('an old file still bumps the counter past custom ids its history mentions', () => {
    libraryStore.importData(file({
      entries: [],
      sessionHistory: [session('s-old', 'custom-41', '2024-01-01T10:00:00Z')],
    }));
    const next = customGameStore.addGame({ title: 'New', platform: ['Windows'], status: 'Want to Play' });
    expect(parseInt(next.id.slice('custom-'.length), 10)).toBeGreaterThanOrEqual(42);
  });
});

describe('Clear library keeps the custom-game id counter', () => {
  it('a new custom game after clearing gets a fresh id and no old hours', () => {
    const old = customGameStore.addGame({ title: 'Old', platform: ['Windows'], status: 'Playing' });
    sessionStore.record(session('s1', old.id, '2024-01-01T10:00:00Z', 180));
    libraryStore.clearAll();
    const fresh = customGameStore.addGame({ title: 'Fresh', platform: ['Windows'], status: 'Want to Play' });
    expect(fresh.id).not.toBe(old.id);
    expect(sessionStore.getTotalHours(fresh.id)).toBe(0);
  });

  it('an orphan custom-N session pushes the next id past it', () => {
    const before = customGameStore.addGame({ title: 'X', platform: ['Windows'], status: 'Want to Play' });
    const n = parseInt(before.id.slice('custom-'.length), 10);
    const orphan = `custom-${n + 2}`;
    sessionStore.record(session('s-orphan', orphan, '2024-01-01T10:00:00Z'));
    const next = customGameStore.addGame({ title: 'Y', platform: ['Windows'], status: 'Want to Play' });
    expect(parseInt(next.id.slice('custom-'.length), 10)).toBeGreaterThanOrEqual(n + 3);
  });
});

describe('import order: journey after sessions and status history', () => {
  it('firstPlayedAt comes from the first imported session, not addedAt', () => {
    libraryStore.importData(file({
      entries: [entry('steam-8', { status: 'Playing' })],
      journeyHistory: [{
        gameId: 'steam-8', title: 'Eight', genre: [], platform: [], status: 'Playing',
        hoursPlayed: 3, rating: 0, addedAt: '2023-01-01T00:00:00.000Z',
      }],
      sessionHistory: [session('s8', 'steam-8', '2024-05-01T12:00:00.000Z')],
      statusHistory: [],
    }));
    expect(journeyStore.getEntry('steam-8')!.firstPlayedAt?.slice(0, 10)).toBe('2024-05-01');
  });
});

describe('status-history and session import validation', () => {
  it('migrates numeric gameIds and skips unknown statuses', () => {
    const rows = [
      { gameId: 123, title: 'T', previousStatus: null, newStatus: 'Playing', timestamp: '2024-01-01T00:00:00.000Z' },
      { gameId: 'steam-1', title: 'T', previousStatus: null, newStatus: 'Bogus', timestamp: '2024-01-02T00:00:00.000Z' },
      null,
    ] as unknown as StatusChangeEntry[];
    const res = statusHistoryStore.importData(rows);
    expect(res).toEqual({ added: 1, skipped: 2 });
    const all = statusHistoryStore.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].gameId).toBe('steam-123');
  });

  it('a session with a numeric gameId counts for steam-N; bad rows are skipped', () => {
    const res = sessionStore.importData([
      session('a', 123, '2024-01-01T10:00:00.000Z', 90),
      session('b', 'steam-1', 'not a date', 30),
      session('c', 'steam-1', '2024-01-01T10:00:00.000Z', Number.NaN),
      null as unknown as GameSession,
    ]);
    expect(res).toEqual({ added: 1, skipped: 3 });
    expect(sessionStore.getTotalHours('steam-123')).toBe(1.5);
  });

  it('journey import skips non-object rows', () => {
    const res = journeyStore.importData([null as never, { gameId: 'steam-2', title: 'Two', genre: [], platform: [], status: 'Want to Play', hoursPlayed: 0, rating: 0, addedAt: '2024-01-01T00:00:00.000Z' }]);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
  });
});
