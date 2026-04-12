import { describe, it, expect, beforeEach } from 'vitest';
import { isPlaceholderJourneyTitle, journeyStore } from '@/services/journey-store';
import { resolveJourneyDisplayTitle } from '@/lib/journey-display-title';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';

describe('isPlaceholderJourneyTitle', () => {
  it('treats Unknown variants and blank as placeholder', () => {
    expect(isPlaceholderJourneyTitle(undefined)).toBe(true);
    expect(isPlaceholderJourneyTitle('')).toBe(true);
    expect(isPlaceholderJourneyTitle('   ')).toBe(true);
    expect(isPlaceholderJourneyTitle('Unknown')).toBe(true);
    expect(isPlaceholderJourneyTitle('Unknown Game')).toBe(true);
  });

  it('treats unknown case-insensitively as placeholder', () => {
    expect(isPlaceholderJourneyTitle('UNKNOWN')).toBe(true);
    expect(isPlaceholderJourneyTitle('unknown game')).toBe(true);
  });

  it('treats real titles as non-placeholder', () => {
    expect(isPlaceholderJourneyTitle('Hades')).toBe(false);
    expect(isPlaceholderJourneyTitle('Unknown Worlds')).toBe(false);
  });
});

describe('syncJourneyTitle', () => {
  beforeEach(() => {
    localStorage.clear();
    journeyStore.clear();
  });

  it('updates stored title when it differs', () => {
    journeyStore.record({
      gameId: 'custom-1',
      title: 'Old Name',
      genre: [],
      platform: [],
      status: 'Playing',
      hoursPlayed: 0,
      rating: 0,
      addedAt: new Date().toISOString(),
    });
    journeyStore.syncJourneyTitle('custom-1', 'Renamed Game');
    expect(journeyStore.getEntry('custom-1')?.title).toBe('Renamed Game');
  });

  it('no-ops when title unchanged', () => {
    journeyStore.record({
      gameId: 'custom-2',
      title: 'Same',
      genre: [],
      platform: [],
      status: 'Playing',
      hoursPlayed: 0,
      rating: 0,
      addedAt: new Date().toISOString(),
    });
    journeyStore.syncJourneyTitle('custom-2', 'Same');
    expect(journeyStore.getEntry('custom-2')?.title).toBe('Same');
  });
});

describe('resolveJourneyDisplayTitle', () => {
  beforeEach(() => {
    localStorage.clear();
    journeyStore.clear();
    libraryStore.clear();
    customGameStore.clear();
  });

  it('uses library cachedMeta when journey title is a placeholder', () => {
    libraryStore.addToLibrary({
      gameId: 'steam-999001',
      status: 'Playing',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      cachedMeta: {
        title: 'Resolved From Meta',
        store: 'steam',
      },
    });
    expect(
      resolveJourneyDisplayTitle('steam-999001', 'Unknown'),
    ).toBe('Resolved From Meta');
  });

  it('uses custom game title when journey title is a placeholder', () => {
    customGameStore.addGame({
      title: 'Custom Real Title',
      platform: ['PC'],
      status: 'Want to Play',
    });
    const id = customGameStore.getAllGames()[0]!.id;
    expect(resolveJourneyDisplayTitle(id, 'Unknown')).toBe('Custom Real Title');
  });

  it('keeps non-placeholder journey title', () => {
    expect(resolveJourneyDisplayTitle('steam-1', 'Already Good')).toBe('Already Good');
  });
});
