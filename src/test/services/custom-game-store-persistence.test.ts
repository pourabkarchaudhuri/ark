import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore, batchesFor } from './fake-level-store';

vi.mock('@/services/journey-store', () => ({
  journeyStore: {
    record: vi.fn(),
    markRemoved: vi.fn(),
    syncProgress: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn().mockReturnValue(true),
  },
}));
vi.mock('@/services/session-store', () => ({
  sessionStore: {
    getTotalHours: vi.fn().mockReturnValue(0),
    getFirstSessionStart: vi.fn().mockReturnValue(0),
  },
}));
vi.mock('@/services/status-history-store', () => ({
  statusHistoryStore: {
    record: vi.fn(),
    getFirstPlayingTransition: vi.fn().mockReturnValue(null),
  },
}));

const STORAGE_KEY = 'ark-custom-games';
const MIGRATION_MARKER_KEY = 'ark-custom-games-migrated-v1';
const NS = 'custom-game';

async function loadFresh() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([]);
  const mod = await import('@/services/custom-game-store');
  await mod.customGameStore.ready;
  return mod.customGameStore;
}

const input = { title: 'Homebrew', platform: ['PC'], status: 'Playing' as const };

let api: any;

describe('CustomGameStore — LevelDB save retry', () => {
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

  it('a failed save is persisted by the retry (entry + counter)', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    const added = store.addGame(input as any);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.data.get(NS)?.has(`e:${added.id}`)).toBeFalsy();
    await vi.advanceTimersByTimeAsync(2000);
    const keys = [...(api.data.get(NS)?.keys() ?? [])];
    expect(keys.some((k: string) => k.endsWith(added.id))).toBe(true);
    expect(api.data.get(NS)?.get('m:nextCounter')).toEqual({ nextCounter: 2 });
  });

  it('retries exactly 3 times when every save fails', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    store.addGame(input as any);
    await vi.advanceTimersByTimeAsync(300 + 2000 + 5000 + 15000 + 60_000);
    expect(batchesFor(api, NS)).toHaveLength(4);
  });

  it('beforeunload after a failed save writes the change', async () => {
    const store = await loadFresh();
    vi.useFakeTimers();
    api.batch.mockImplementationOnce(async () => ({ error: 'IO error' }));
    const added = store.addGame(input as any);
    await vi.advanceTimersByTimeAsync(300);
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(0);
    const keys = [...(api.data.get(NS)?.keys() ?? [])];
    expect(keys.some((k: string) => k.endsWith(added.id))).toBe(true);
  });
});

describe('CustomGameStore — failed localStorage migration', () => {
  beforeEach(() => {
    localStorage.clear();
    const now = '2025-01-01T00:00:00.000Z';
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        nextCounter: 2,
        entries: [{ id: 'custom-1', title: 'Old', platform: ['PC'], status: 'Completed', addedAt: now, updatedAt: now }],
      }),
    );
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(() => {
    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    window.dispatchEvent(new Event('beforeunload'));
    installFakeLevelStore(undefined);
  });

  it('goes read-only with the legacy games visible and retries next boot', async () => {
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadFresh();
    expect(store.isReadOnly()).toBe(true);
    expect(store.getGame('custom-1')?.title).toBe('Old');

    const calls = api.batch.mock.calls.length;
    store.addGame(input as any);
    await new Promise((r) => setTimeout(r, 350));
    await store.whenPersisted();
    expect(api.batch.mock.calls.length).toBe(calls);

    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    const next = await loadFresh();
    expect(next.isReadOnly()).toBe(false);
    expect(next.getGame('custom-1')?.title).toBe('Old');
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBe('yes');
  });
});
