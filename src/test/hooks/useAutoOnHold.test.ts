/**
 * Auto On-Hold sweep (audit item 2): a game the user JUST switched to
 * "Playing" must not be flipped back to "On Hold" just because its last play
 * (or addedAt) is more than 4 weeks old. v1.0.88: 28-day threshold, live games, custom games,
 * import grace, Undo and auto-resume.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// vitest runs with isolate:false, so module singletons can leak between test
// files (and other files call vi.resetModules()). Import the hook and the
// stores it reads from ONE fresh registry so they share the same instances.
let runAutoOnHoldSweep: typeof import('@/hooks/useAutoOnHold').runAutoOnHoldSweep;
let libraryStore: typeof import('@/services/library-store').libraryStore;
let statusHistoryStore: typeof import('@/services/status-history-store').statusHistoryStore;
let customGameStore: typeof import('@/services/custom-game-store').customGameStore;
let mod: typeof import('@/hooks/useAutoOnHold');

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
  // The previous test's store may still hold a 300 ms debounced save; flush it now so it cannot land
  // after the clear below and leak that test's games into this one.
  window.dispatchEvent(new Event('beforeunload'));
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  vi.resetModules();
  mod = await import('@/hooks/useAutoOnHold');
  ({ runAutoOnHoldSweep } = mod);
  ({ customGameStore } = await import('@/services/custom-game-store'));
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

  it('still flips a Playing game once 4+ weeks pass after the switch', async () => {
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

describe('runAutoOnHoldSweep notifications (1.0.97 perf gate)', () => {
  it('notifies library subscribers once for a sweep that moves many games', async () => {
    for (let i = 0; i < 40; i++) add(`steam-${9000 + i}`, 'Playing');
    const { journeyStore } = await import('@/services/journey-store');
    const listener = vi.fn();
    const journeyListener = vi.fn();
    const unsub = libraryStore.subscribe(listener);
    const unsubJourney = journeyStore.subscribe(journeyListener);
    const versionBefore = libraryStore.getVersion();

    const moved = await runAutoOnHoldSweep(Date.now() + 40 * DAY);
    unsub();
    unsubJourney();

    expect(moved).toHaveLength(40);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(journeyListener.mock.calls.length).toBeLessThanOrEqual(1);
    expect(libraryStore.getVersion()).toBe(versionBefore + 1);
    expect(libraryStore.getEntry('steam-9000')?.status).toBe('On Hold');
  });

  it('runBatched nests, notifies once, and still notifies when the callback throws', () => {
    add('steam-9100', 'Playing');
    add('steam-9101', 'Playing');
    const listener = vi.fn();
    const unsub = libraryStore.subscribe(listener);
    libraryStore.runBatched(() => {
      libraryStore.updateEntry('steam-9100', { rating: 4 });
      libraryStore.runBatched(() => libraryStore.updateEntry('steam-9101', { rating: 3 }));
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    expect(() => libraryStore.runBatched(() => {
      libraryStore.updateEntry('steam-9100', { rating: 5 });
      throw new Error('boom');
    })).toThrow('boom');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(libraryStore.getEntry('steam-9100')?.rating).toBe(5);

    listener.mockClear();
    libraryStore.runBatched(() => undefined);
    expect(listener).not.toHaveBeenCalled(); // nothing changed, nobody is told
    unsub();
  });
});

describe('runAutoOnHoldSweep (v1.0.88)', () => {
  it('flips at 28 days, not at 27', async () => {
    add('steam-10', 'Want to Play');
    libraryStore.updateEntry('steam-10', { status: 'Playing' });
    expect((await runAutoOnHoldSweep(Date.now() + 27 * DAY)).map(m => m.gameId)).not.toContain('steam-10');
    expect(libraryStore.getEntry('steam-10')?.status).toBe('Playing');
    const moved = await runAutoOnHoldSweep(Date.now() + 28 * DAY + 1000);
    expect(moved.map(m => m.gameId)).toContain('steam-10');
    expect(libraryStore.getEntry('steam-10')?.status).toBe('On Hold');
    const last = statusHistoryStore.getForGame('steam-10').at(-1)!;
    expect([last.newStatus, last.source]).toEqual(['On Hold', 'auto-hold']);
  });

  it('never touches a game that is running right now', async () => {
    add('steam-11', 'Want to Play');
    libraryStore.updateEntry('steam-11', { status: 'Playing' });
    const moved = await runAutoOnHoldSweep(Date.now() + 60 * DAY, { isLive: (id) => id === 'steam-11' });
    expect(moved.map(m => m.gameId)).not.toContain('steam-11');
    expect(libraryStore.getEntry('steam-11')?.status).toBe('Playing');
  });

  it('treats a stored "Playing Now" that is not running as Playing', async () => {
    add('steam-12', 'Want to Play');
    libraryStore.updateEntry('steam-12', { status: 'Playing Now' });
    await runAutoOnHoldSweep(Date.now() + 60 * DAY);
    expect(libraryStore.getEntry('steam-12')?.status).toBe('On Hold');
  });

  it('gives imported games a fresh 4 weeks', async () => {
    add('steam-13', 'Playing');
    localStorage.setItem(mod.LIBRARY_IMPORTED_AT_LS_KEY, new Date(Date.now() + 25 * DAY).toISOString());
    expect((await runAutoOnHoldSweep(Date.now() + 40 * DAY)).map(m => m.gameId)).not.toContain('steam-13');
    expect(libraryStore.getEntry('steam-13')?.status).toBe('Playing');
  });

  it('is switched off by the Settings toggle', async () => {
    add('steam-14', 'Want to Play');
    libraryStore.updateEntry('steam-14', { status: 'Playing' });
    localStorage.setItem('ark:autoOnHoldTransition', 'false');
    expect(await runAutoOnHoldSweep(Date.now() + 60 * DAY)).toEqual([]);
    expect(libraryStore.getEntry('steam-14')?.status).toBe('Playing');
  });

  it('includes custom games', async () => {
    const g = customGameStore.addGame({ title: 'Homebrew', platform: ['Windows'], status: 'Playing' });
    const moved = await runAutoOnHoldSweep(Date.now() + 60 * DAY);
    expect(moved).toContainEqual({ gameId: g.id, title: 'Homebrew', custom: true });
    expect(customGameStore.getGame(g.id)?.status).toBe('On Hold');
    expect(statusHistoryStore.getForGame(g.id).at(-1)?.source).toBe('auto-hold');
  });

  it('Undo puts the games back to Playing (tagged undo)', async () => {
    add('steam-15', 'Want to Play');
    libraryStore.updateEntry('steam-15', { status: 'Playing' });
    const moved = await runAutoOnHoldSweep(Date.now() + 60 * DAY);
    expect(mod.undoAutoHold(moved.filter(m => m.gameId === 'steam-15'))).toBe(1);
    expect(libraryStore.getEntry('steam-15')?.status).toBe('Playing');
    expect(statusHistoryStore.getForGame('steam-15').at(-1)?.source).toBe('undo');
  });

  it('playing an auto-held game again resumes it; a game the user put On Hold stays', async () => {
    add('steam-16', 'Want to Play');
    libraryStore.updateEntry('steam-16', { status: 'Playing' });
    await runAutoOnHoldSweep(Date.now() + 60 * DAY);
    expect(await mod.maybeResumeAutoHeld('steam-16')).toBe(true);
    expect(libraryStore.getEntry('steam-16')?.status).toBe('Playing');

    add('steam-17', 'Want to Play');
    libraryStore.updateEntry('steam-17', { status: 'On Hold' });
    expect(await mod.maybeResumeAutoHeld('steam-17')).toBe(false);
    expect(libraryStore.getEntry('steam-17')?.status).toBe('On Hold');
  });
});

describe('auto-hold fixes (1.0.97 B10)', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'sessionTracker', { value: undefined, writable: true, configurable: true });
  });

  it('turning Auto On Hold off still resumes games it already held (hooks#15)', async () => {
    add('steam-30', 'Want to Play');
    libraryStore.updateEntry('steam-30', { status: 'Playing' });
    await runAutoOnHoldSweep(Date.now() + 60 * DAY);
    expect(libraryStore.getEntry('steam-30')?.status).toBe('On Hold');

    localStorage.setItem('ark:autoOnHoldTransition', 'false');
    expect(await mod.maybeResumeAutoHeld('steam-30')).toBe(true);
    expect(libraryStore.getEntry('steam-30')?.status).toBe('Playing');
    expect(statusHistoryStore.getForGame('steam-30').at(-1)?.source).toBe('auto-promote');

    // A hold the user made themselves is never reverted, switch on or off.
    add('steam-31', 'Want to Play');
    libraryStore.updateEntry('steam-31', { status: 'On Hold' });
    expect(await mod.maybeResumeAutoHeld('steam-31')).toBe(false);
    expect(libraryStore.getEntry('steam-31')?.status).toBe('On Hold');
  });

  it('a pre-1.0.87 custom game with no history uses updatedAt as its status floor', async () => {
    const g = customGameStore.addGame({ title: 'Old Homebrew', platform: ['Windows'], status: 'Playing' });
    customGameStore.updateGame(g.id, { addedAt: longAgo, lastPlayedAt: longAgo.toISOString() } as never);
    statusHistoryStore.clear(); // written before status history existed for custom games
    expect(statusHistoryStore.getForGame(g.id)).toHaveLength(0);

    expect((await runAutoOnHoldSweep(Date.now() + 20 * DAY)).map((m) => m.gameId)).not.toContain(g.id);
    expect(customGameStore.getGame(g.id)?.status).toBe('Playing');
    // Still held once 4 weeks pass after that last save.
    expect((await runAutoOnHoldSweep(Date.now() + 60 * DAY)).map((m) => m.gameId)).toContain(g.id);
  });

  function installTracker(active: Array<{ gameId: string | number }>) {
    const tracker = {
      getActiveSessions: vi.fn(async () => active.map((a) => ({ ...a, startTime: '', elapsedMinutes: 1 }))),
    };
    Object.defineProperty(window, 'sessionTracker', { value: tracker, writable: true, configurable: true });
    return tracker;
  }

  it('the startup sweep waits for the tracker and skips games it reports running (hooks#14)', async () => {
    add('steam-40', 'Playing'); // running right now, reported by main as a numeric id
    add('steam-41', 'Playing'); // not running
    const tracker = installTracker([{ gameId: 40 }]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * DAY);

    renderHook(() => mod.useAutoOnHold({ current: new Set() }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(libraryStore.getEntry('steam-41')?.status).toBe('Playing'); // nothing at mount
    expect(tracker.getActiveSessions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(mod.FIRST_SWEEP_DELAY_MS);
    await vi.waitFor(() => expect(libraryStore.getEntry('steam-41')?.status).toBe('On Hold'));
    expect(tracker.getActiveSessions).toHaveBeenCalled();
    expect(libraryStore.getEntry('steam-40')?.status).toBe('Playing');
  });

  it('the first sweep also waits for the ready gate (crash-recovered sessions)', async () => {
    add('steam-42', 'Playing');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * DAY);
    let release!: () => void;
    const ready = new Promise<void>((r) => { release = r; });

    renderHook(() => mod.useAutoOnHold({ current: new Set() }, { ready }));
    await vi.advanceTimersByTimeAsync(mod.FIRST_SWEEP_DELAY_MS + 1_000);
    expect(libraryStore.getEntry('steam-42')?.status).toBe('Playing');

    release();
    await vi.waitFor(() => expect(libraryStore.getEntry('steam-42')?.status).toBe('On Hold'));
  });
});
