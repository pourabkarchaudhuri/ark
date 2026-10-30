import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore, batchesFor } from './fake-level-store';

vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getTotalHours: vi.fn().mockReturnValue(0),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
    getForGame: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    getFirstPlayingTransition: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
  },
}));

const STORAGE_KEY = 'ark-journey-history';
const MIGRATION_MARKER_KEY = 'ark-journey-history-migrated-v1';
const NS = 'journey';

async function loadFresh() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([]);
  const mod = await import('@/services/journey-store');
  await mod.journeyStore.ready;
  return mod.journeyStore;
}

function entry(gameId: string) {
  return { gameId, title: gameId, genre: [], platform: ['PC'], status: 'Playing' as const, hoursPlayed: 1, rating: 0 };
}

let api: any;

describe('JourneyStore — LevelDB save retry', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(async () => {
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    window.dispatchEvent(new Event('beforeunload'));
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    vi.useRealTimers();
    installFakeLevelStore(undefined);
  });

  it('a failed save is persisted by the retry', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    store.record(entry('steam-1'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.data.get(NS)?.has('steam-1')).toBeFalsy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.data.get(NS)?.has('steam-1')).toBe(true);
  });

  it('retries exactly 3 times when every save fails', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    store.record(entry('steam-2'));
    await vi.advanceTimersByTimeAsync(300 + 2000 + 5000 + 15000 + 60_000);
    expect(batchesFor(api, NS)).toHaveLength(4);
  });

  it('beforeunload after a failed save writes the change', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    store.record(entry('steam-3'));
    await vi.advanceTimersByTimeAsync(300);
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.data.get(NS)?.has('steam-3')).toBe(true);
  });
});

describe('JourneyStore — failed localStorage migration', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, entries: [{ ...entry('steam-7'), addedAt: '2025-01-01T00:00:00.000Z' }], lastUpdated: '' }),
    );
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(() => {
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    window.dispatchEvent(new Event('beforeunload'));
    installFakeLevelStore(undefined);
  });

  it('goes read-only with the legacy journey visible and retries next boot', async () => {
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadFresh();
    expect(store.isReadOnly()).toBe(true);
    expect(store.has('steam-7')).toBe(true);

    const calls = api.batch.mock.calls.length;
    store.record(entry('steam-8'));
    await new Promise((r) => setTimeout(r, 350));
    await store.whenPersisted();
    expect(api.batch.mock.calls.length).toBe(calls);

    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    const next = await loadFresh();
    expect(next.isReadOnly()).toBe(false);
    expect(api.data.get(NS)?.has('steam-7')).toBe(true);
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBe('yes');
  });
});
