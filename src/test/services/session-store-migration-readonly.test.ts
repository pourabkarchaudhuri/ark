import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFakeLevelStore, installFakeLevelStore } from './fake-level-store';

const STORAGE_KEY = 'ark-session-history';
const MIGRATION_MARKER_KEY = 'ark-session-history-migrated-v1';
const NS = 'session';

async function loadFresh() {
  vi.resetModules();
  const health = await import('@/services/storage-health');
  health.__setStorageRetryDelaysForTests([]);
  const mod = await import('@/services/session-store');
  await mod.sessionStore.ready;
  return mod.sessionStore;
}

function session(id: string) {
  return {
    id,
    gameId: 'steam-1',
    executablePath: 'C:/g.exe',
    startTime: '2025-01-01T10:00:00.000Z',
    endTime: '2025-01-01T11:00:00.000Z',
    durationMinutes: 60,
    idleMinutes: 0,
  };
}

let api: any;

describe('SessionStore — failed localStorage migration', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, entries: [session('s-old')], lastUpdated: '' }));
    api = makeFakeLevelStore();
    installFakeLevelStore(api);
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
    installFakeLevelStore(undefined);
  });

  it('goes read-only with the legacy log visible, writes nothing, and retries next boot', async () => {
    api.batch.mockImplementation(async () => ({ error: 'IO error' }));
    const store = await loadFresh();
    expect(store.isReadOnly()).toBe(true);
    expect(store.has('s-old')).toBe(true);

    const calls = api.batch.mock.calls.length;
    store.record(session('s-new'));
    await store.persistNow();
    expect(api.batch.mock.calls.length).toBe(calls);
    expect(store.isPersisted('s-new')).toBe(false);

    api.batch.mockImplementation(async (ops: any[]) => api.applyBatch(ops));
    const next = await loadFresh();
    expect(next.isReadOnly()).toBe(false);
    expect(api.data.get(NS)?.has('s-old')).toBe(true);
    expect(localStorage.getItem(MIGRATION_MARKER_KEY)).toBe('yes');
  });
});
