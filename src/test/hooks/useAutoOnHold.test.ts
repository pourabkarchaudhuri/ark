/**
 * Auto On-Hold sweep (audit item 2): a game the user JUST switched to
 * "Playing" must not be flipped back to "On Hold" just because its last play
 * (or addedAt) is more than 4 weeks old. v1.0.88: 28-day threshold, live games, custom games,
 * import grace, Undo and auto-resume.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
