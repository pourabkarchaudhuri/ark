/**
 * useDeferredFilterSort — tests for getAdjustedRatingForSort (Bayesian-style rating sort).
 */

import { describe, it, expect } from 'vitest';
import { getAdjustedRatingForSort } from '@/hooks/useDeferredFilterSort';
import type { Game } from '@/types/game';

function makeGame(overrides: Partial<Game> & { metacriticScore: number | null; recommendations?: number }): Game {
  return {
    id: 'steam-1',
    title: 'Test',
    developer: '',
    publisher: '',
    genre: [],
    platform: [],
    metacriticScore: null,
    releaseDate: '',
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Game;
}

describe('getAdjustedRatingForSort', () => {
  it('returns 0 when metacriticScore is null or 0', () => {
    expect(getAdjustedRatingForSort(makeGame({ metacriticScore: null }))).toBe(0);
    expect(getAdjustedRatingForSort(makeGame({ metacriticScore: 0 }))).toBe(0);
  });

  it('pulls low-review games toward prior (70)', () => {
    const highScoreFewReviews = makeGame({ metacriticScore: 95, recommendations: 2 });
    const lowerScoreManyReviews = makeGame({ metacriticScore: 88, recommendations: 10000 });
    const adjFew = getAdjustedRatingForSort(highScoreFewReviews);
    const adjMany = getAdjustedRatingForSort(lowerScoreManyReviews);
    expect(adjFew).toBeLessThan(95);
    expect(adjFew).toBeGreaterThan(70);
    expect(adjMany).toBeGreaterThan(87);
    expect(adjMany).toBeLessThan(89);
    expect(adjMany).toBeGreaterThan(adjFew);
  });

  it('games with 0 recommendations get prior (70) so they sort below well-reviewed titles', () => {
    const noReviews = makeGame({ metacriticScore: 95, recommendations: 0 });
    const manyReviews = makeGame({ metacriticScore: 85, recommendations: 5000 });
    expect(getAdjustedRatingForSort(noReviews)).toBe(70);
    expect(getAdjustedRatingForSort(manyReviews)).toBeGreaterThan(84);
    expect(getAdjustedRatingForSort(manyReviews)).toBeGreaterThan(getAdjustedRatingForSort(noReviews));
  });

  it('high score with many reviews stays near raw score', () => {
    const g = makeGame({ metacriticScore: 92, recommendations: 50000 });
    const adj = getAdjustedRatingForSort(g);
    expect(adj).toBeGreaterThan(91.5);
    expect(adj).toBeLessThanOrEqual(92);
  });
});
