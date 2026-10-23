/**
 * Auto On-Hold sweep (audit item 2): a game the user JUST switched to
 * "Playing" must not be flipped back to "On Hold" just because its last play
 * (or addedAt) is more than 30 days old.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest runs with isolate:false, so module singletons can leak between test
// files (and other files call vi.resetModules()). Import the hook and the
// stores it reads from ONE fresh registry so they share the same instances.
let runAutoOnHoldSweep: typeof import('@/hooks/useAutoOnHold').runAutoOnHoldSweep;
let libraryStore: typeof import('@/services/library-store').libraryStore;
let statusHistoryStore: typeof import('@/services/status-history-store').statusHistoryStore;

const DAY = 24 * 60 * 60 * 1000;
const longAgo = new Date(Date.now() - 200 * DAY);

function add(gameId: string, status: 'Playing' | 'Want to Play') {
  libraryStore.addToLibrary({
    gameId,
    status,
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
  });
  // Old library entry with an old last-play date — the classic false positive.
  libraryStore.updateEntry(gameId, { addedAt: longAgo, lastPlayedAt: longAgo.toISOString() });
}

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  vi.resetModules();
  ({ runAutoOnHoldSweep } = await import('@/hooks/useAutoOnHold'));
  ({ libraryStore } = await import('@/services/library-store'));
  ({ statusHistoryStore } = await import('@/services/status-history-store'));
});

describe('runAutoOnHoldSweep', () => {
  it('does not flip a game the user just switched to Playing (statusChangedAt stamp)', async () => {
    add('steam-1', 'Want to Play');
    libraryStore.updateEntry('steam-1', { status: 'Playing' });

    await runAutoOnHoldSweep(Date.now());

    expect(libraryStore.getEntry('steam-1')?.status).toBe('Playing');
  });

  it('uses the latest status-history transition into Playing when no stamp exists', async () => {
    // addToLibrary(status: Playing) records a null → Playing history row now,
    // but no status *change* happens afterwards, so there's no stamp.
    add('steam-2', 'Playing');
    expect((libraryStore.getEntry('steam-2') as any).statusChangedAt).toBeUndefined();

    await runAutoOnHoldSweep(Date.now());

    expect(libraryStore.getEntry('steam-2')?.status).toBe('Playing');
  });

  it('still flips a Playing game once 30+ days pass after the switch', async () => {
    add('steam-3', 'Want to Play');
    libraryStore.updateEntry('steam-3', { status: 'Playing' });

    await runAutoOnHoldSweep(Date.now() + 31 * DAY);

    const entry = libraryStore.getEntry('steam-3');
    expect(entry?.status).toBe('On Hold');
    // lastPlayedAt is never overwritten by the sweep.
    expect(entry?.lastPlayedAt).toBe(longAgo.toISOString());
  });

  it('respects a recent play even when the status switch was long ago', async () => {
    add('steam-4', 'Playing');
    libraryStore.updateEntry('steam-4', { lastPlayedAt: new Date(Date.now() - 2 * DAY).toISOString() });

    await runAutoOnHoldSweep(Date.now() + 20 * DAY);

    expect(libraryStore.getEntry('steam-4')?.status).toBe('Playing');
  });
});
