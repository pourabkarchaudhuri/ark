import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore, batchesFor } from './fake-level-store';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    exportData: vi.fn().mockReturnValue([]),
    importData: vi.fn().mockReturnValue({ added: 0, updated: 0, skipped: 0 }),
    clear: vi.fn(),
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
  },
}));
vi.mock('@/services/reco-history-store', () => ({
  recoHistoryStore: { recordLibraryAdd: vi.fn(), recordPlay: vi.fn(), recordRating: vi.fn(), isDismissed: vi.fn() },
}));
vi.mock('@/services/oracle-event-log', () => ({
  oracleEventLog: { record: vi.fn(), log: vi.fn(), append: vi.fn() },
}));

const STORAGE_KEY = 'ark-library-data';
const MIGRATION_MARKER_KEY = 'ark-library-data-migrated-v1';
const NS = 'library';

async function loadFresh() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([]);
  const mod = await import('@/services/library-store');
  await mod.libraryStore.ready;
  return mod.libraryStore;
}

function legacyPayload() {
  const now = new Date('2025-01-01T00:00:00Z').toISOString();
  return JSON.stringify({
    version: 5,
    entries: [
      { gameId: 'steam-1', status: 'Playing', priority: 'High', hoursPlayed: 3, rating: 0, addedAt: now, updatedAt: now },
      { gameId: 'steam-2', status: 'Completed', priority: 'Low', hoursPlayed: 9, rating: 4, addedAt: now, updatedAt: now },
    ],
    lastUpdated: now,
  });
}

let api: any;

describe('LibraryStore — LevelDB save retry', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(async () => {
    // Settle every store instance created by this test so none carries a
    // failed-save flag into the next one.
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    window.dispatchEvent(new Event('beforeunload'));
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    vi.useRealTimers();
    installFakeLevelStore(undefined);
  });

  it('a failed save is persisted by the retry with no further edit', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    store.addToLibrary({ gameId: 'steam-10', status: 'Playing', priority: 'High' } as any);
    await vi.advanceTimersByTimeAsync(300); // debounce -> failing batch
    expect(batchesFor(api, NS)).toHaveLength(1);
    expect(api.data.get(NS)?.has('steam-10')).toBeFalsy();

    await vi.advanceTimersByTimeAsync(2000); // first retry
    expect(batchesFor(api, NS)).toHaveLength(2);
    expect(api.data.get(NS)?.has('steam-10')).toBe(true);

    // Success resets the streak: nothing further is retried.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(batchesFor(api, NS)).toHaveLength(2);
  });

  it('retries exactly 3 times when every save fails', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    store.addToLibrary({ gameId: 'steam-11', status: 'Playing', priority: 'High' } as any);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(2000 + 5000 + 15000 + 60_000);
    expect(batchesFor(api, NS)).toHaveLength(4); // 1 save + 3 retries
  });

  it('beforeunload after a failed save writes the change', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    store.addToLibrary({ gameId: 'steam-12', status: 'Playing', priority: 'High' } as any);
    await vi.advanceTimersByTimeAsync(300);
    expect(batchesFor(api, NS)).toHaveLength(1);

    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(0);
    expect(batchesFor(api, NS)).toHaveLength(2);
    expect(api.data.get(NS)?.has('steam-12')).toBe(true);
  });
});

describe('LibraryStore — failed localStorage migration', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, legacyPayload());
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(() => {
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    window.dispatchEvent(new Event('beforeunload'));
    installFakeLevelStore(undefined);
  });

  it('goes read-only with the legacy entries visible, writes nothing, and retries next boot', async () => {
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadFresh();
    expect(store.isReadOnly()).toBe(true);
    expect(store.getAllGameIds().sort()).toEqual(['steam-1', 'steam-2']);
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBeNull();

    const callsAfterBoot = api.batch.mock.calls.length;
    store.addToLibrary({ gameId: 'steam-99', status: 'Playing', priority: 'High' } as any);
    await new Promise((r) => setTimeout(r, 350));
    await store.whenPersisted();
    expect(api.batch.mock.calls.length).toBe(callsAfterBoot);
    expect(api.data.get(NS)?.size ?? 0).toBe(0);

    // Next boot: LevelDB still empty, so the migration runs again.
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    const next = await loadFresh();
    expect(next.isReadOnly()).toBe(false);
    expect(api.data.get(NS)?.size).toBe(2);
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBe('yes');
  });
});
