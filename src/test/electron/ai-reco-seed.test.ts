/**
 * AI chat getGameRecommendations (1.0.97 B06): the seed is the most played / highest rated
 * Steam game rather than whichever library entry happens to be first, and the result cache key
 * does not depend on library order.
 */
import { describe, it, expect } from 'vitest';
import { pickRecommendationSeed, librarySignature, steamAppIdOf } from '../../../electron/ai-reco-seed';

const entry = (gameId: string, extra: Partial<{ hoursPlayed: number; rating: number; status: string; priority: string; addedAt: string }> = {}) => ({
  gameId, status: 'Want to Play', priority: 'Low', ...extra,
});

describe('steamAppIdOf', () => {
  it('parses steam-N and legacy N, rejects other stores', () => {
    expect(steamAppIdOf('steam-730')).toBe(730);
    expect(steamAppIdOf('570')).toBe(570);
    expect(steamAppIdOf('epic-ns:offer')).toBeNull();
    expect(steamAppIdOf('custom-1')).toBeNull();
  });
});

describe('pickRecommendationSeed', () => {
  it('prefers the most played Steam game over the first entry', () => {
    expect(pickRecommendationSeed([
      entry('steam-10'),
      entry('epic-x:y', { hoursPlayed: 900 }),
      entry('steam-20', { hoursPlayed: 120 }),
      entry('steam-30', { hoursPlayed: 5, rating: 5 }),
    ])).toBe(20);
  });

  it('falls back to rating, then status, then most recently added', () => {
    expect(pickRecommendationSeed([entry('steam-1', { rating: 3 }), entry('steam-2', { rating: 5 })])).toBe(2);
    expect(pickRecommendationSeed([entry('steam-1'), entry('steam-2', { status: 'Playing' })])).toBe(2);
    expect(pickRecommendationSeed([
      entry('steam-1', { addedAt: '2024-01-01T00:00:00Z' }),
      entry('steam-2', { addedAt: '2025-01-01T00:00:00Z' }),
    ])).toBe(2);
  });

  it('returns null when there is no Steam game', () => {
    expect(pickRecommendationSeed([entry('epic-a:b')])).toBeNull();
    expect(pickRecommendationSeed([])).toBeNull();
  });
});

describe('librarySignature', () => {
  it('ignores library order but not seed or limit', () => {
    expect(librarySignature([3, 1, 2], 1, 10)).toBe(librarySignature([1, 2, 3], 1, 10));
    expect(librarySignature([1, 2, 3], 1, 10)).not.toBe(librarySignature([1, 2, 3], 2, 10));
    expect(librarySignature([1, 2, 3], 1, 10)).not.toBe(librarySignature([1, 2, 3], 1, 5));
  });
});
