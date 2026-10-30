import { describe, it, expect, beforeEach } from 'vitest';
import { journeyStore } from '@/services/journey-store';

// Memoized Voyage cards compare entry objects by identity, so a mutation that should change what a
// card shows has to replace the row, not edit it in place.
function seed(gameId = 'steam-730', title = 'Counter-Strike 2') {
  journeyStore.record({
    gameId,
    title,
    genre: ['Action'],
    platform: ['Windows'],
    status: 'Playing',
    hoursPlayed: 10,
    rating: 3,
    addedAt: '2025-01-01T00:00:00.000Z',
  });
  return journeyStore.getEntry(gameId)!;
}

describe('journeyStore copy-on-write', () => {
  beforeEach(() => {
    localStorage.clear();
    journeyStore.clear();
  });

  it('replaces the row on markRemoved', () => {
    const before = seed();
    journeyStore.markRemoved('steam-730');
    const after = journeyStore.getEntry('steam-730')!;
    expect(after).not.toBe(before);
    expect(after.removedAt).toBeTruthy();
    expect(before.removedAt).toBeUndefined();
  });

  it('replaces the row on a status change through syncProgress', () => {
    const before = seed();
    journeyStore.syncProgress('steam-730', { status: 'Completed' });
    const after = journeyStore.getEntry('steam-730')!;
    expect(after).not.toBe(before);
    expect(after.status).toBe('Completed');
    expect(before.status).toBe('Playing');
  });

  it('replaces the row when status and hours change together', () => {
    const before = seed();
    journeyStore.syncProgress('steam-730', { status: 'On Hold', hoursPlayed: 12 });
    const after = journeyStore.getEntry('steam-730')!;
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ status: 'On Hold', hoursPlayed: 12 });
  });

  it('keeps the row (and the sorted cache) on an hours-only tick', () => {
    const before = seed();
    const sorted = journeyStore.getAllEntries();
    journeyStore.syncProgress('steam-730', { hoursPlayed: 11 });
    expect(journeyStore.getEntry('steam-730')).toBe(before);
    expect(journeyStore.getAllEntries()).toBe(sorted);
    expect(before.hoursPlayed).toBe(11);
  });

  it('getAllEntries returns the new row after a general change', () => {
    seed();
    journeyStore.getAllEntries();
    journeyStore.syncProgress('steam-730', { rating: 5 });
    const after = journeyStore.getEntry('steam-730')!;
    expect(journeyStore.getAllEntries()).toContain(after);
  });

  it('replaces the row on title syncs', () => {
    const placeholder = seed('steam-1', 'Unknown');
    journeyStore.syncTitleIfPlaceholder('steam-1', 'Hades');
    const renamed = journeyStore.getEntry('steam-1')!;
    expect(renamed).not.toBe(placeholder);
    expect(renamed.title).toBe('Hades');

    journeyStore.syncJourneyTitle('steam-1', 'Hades II');
    const renamedAgain = journeyStore.getEntry('steam-1')!;
    expect(renamedAgain).not.toBe(renamed);
    expect(renamedAgain.title).toBe('Hades II');
  });
});
