import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'ark-status-history';

/**
 * The status history store loads from localStorage in its constructor, so we
 * seed storage and re-import the module fresh for each scenario.
 */
async function loadFreshStore(seed: unknown) {
  localStorage.clear();
  if (seed !== undefined) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  }
  vi.resetModules();
  const mod = await import('@/services/status-history-store');
  return mod.statusHistoryStore;
}

describe('StatusHistoryStore load validation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drops entries with an invalid/unknown status', async () => {
    const store = await loadFreshStore({
      version: 2,
      entries: [
        { gameId: 'steam-1', title: 'Good', newStatus: 'Playing', timestamp: '2026-01-01T00:00:00Z' },
        { gameId: 'steam-2', title: 'Bad', newStatus: 'Bogus', timestamp: '2026-01-02T00:00:00Z' },
      ],
      lastUpdated: '2026-01-02T00:00:00Z',
    });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].gameId).toBe('steam-1');
  });

  it('drops entries with a missing or unparseable timestamp', async () => {
    const store = await loadFreshStore({
      version: 2,
      entries: [
        { gameId: 'steam-1', title: 'NoTs', newStatus: 'Completed' },
        { gameId: 'steam-2', title: 'BadTs', newStatus: 'Completed', timestamp: 'not-a-date' },
        { gameId: 'steam-3', title: 'Ok', newStatus: 'Completed', timestamp: '2026-01-01T00:00:00Z' },
      ],
      lastUpdated: '2026-01-01T00:00:00Z',
    });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].gameId).toBe('steam-3');
  });

  it('keeps all valid entries untouched', async () => {
    const store = await loadFreshStore({
      version: 2,
      entries: [
        { gameId: 'steam-1', title: 'A', newStatus: 'Want to Play', timestamp: '2026-01-01T00:00:00Z' },
        { gameId: 'steam-2', title: 'B', newStatus: 'Playing Now', timestamp: '2026-01-02T00:00:00Z' },
      ],
      lastUpdated: '2026-01-02T00:00:00Z',
    });
    expect(store.getAll()).toHaveLength(2);
  });
});
