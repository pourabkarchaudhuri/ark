import { describe, it, expect } from 'vitest';
import {
  countEvidenceLibrary,
  computeEngagementWeight,
  computeNegativeWeight,
  UNPLAYED_ENGAGEMENT_WEIGHT,
} from '@/services/engagement-weight';

describe('engagement-weight signed taste (R4)', () => {
  const base = { hoursPlayed: 80, rating: 0, status: 'Playing' };

  it('a 1- or 2-star game contributes nothing to positive taste, however long it was played', () => {
    expect(computeEngagementWeight({ ...base, rating: 1 })).toBe(0);
    expect(computeEngagementWeight({ ...base, rating: 2 })).toBe(0);
    expect(computeEngagementWeight({ ...base, rating: 3 })).toBeGreaterThan(0);
  });

  it('removed games and abandoned On Hold games carry no positive weight', () => {
    expect(computeEngagementWeight({ hoursPlayed: 1, rating: 0, status: 'Playing', removedAt: '2026-01-01T00:00:00Z' })).toBe(0);
    expect(computeEngagementWeight({ hoursPlayed: 1, rating: 0, status: 'On Hold' })).toBe(0);
    // On Hold after real play is still a (weaker) positive.
    expect(computeEngagementWeight({ hoursPlayed: 30, rating: 0, status: 'On Hold' })).toBeGreaterThan(0.5);
  });

  it('unplayed unrated entries get a small fixed weight, not the baseline 1', () => {
    expect(computeEngagementWeight({ hoursPlayed: 0, rating: 0, status: 'Want to Play' })).toBe(UNPLAYED_ENGAGEMENT_WEIGHT);
    expect(computeEngagementWeight({ hoursPlayed: 0, rating: 0, status: 'Playing' })).toBe(UNPLAYED_ENGAGEMENT_WEIGHT);
    expect(UNPLAYED_ENGAGEMENT_WEIGHT).toBeLessThan(0.5);
  });

  it('good evidence keeps its previous weight', () => {
    // 1 + min(40/20,3) + 5/5*2 + 1 (Completed)
    expect(computeEngagementWeight({ hoursPlayed: 40, rating: 5, status: 'Completed' })).toBeCloseTo(6, 6);
  });

  it('negative weight covers low ratings, removal and abandonment', () => {
    expect(computeNegativeWeight({ hoursPlayed: 80, rating: 1, status: 'On Hold' })).toBeGreaterThan(
      computeNegativeWeight({ hoursPlayed: 80, rating: 2, status: 'On Hold' }),
    );
    expect(computeNegativeWeight({ hoursPlayed: 1, rating: 0, status: 'Playing', removedAt: '2026-01-01T00:00:00Z' })).toBeGreaterThan(0);
    expect(computeNegativeWeight({ hoursPlayed: 1, rating: 0, status: 'On Hold' })).toBeGreaterThan(0);
    expect(computeNegativeWeight({ hoursPlayed: 40, rating: 5, status: 'Completed' })).toBe(0);
    expect(computeNegativeWeight({ hoursPlayed: 0, rating: 0, status: 'Want to Play' })).toBe(0);
  });

  it('a loved game that was later removed keeps half its weight and is not a negative', () => {
    const loved = { hoursPlayed: 200, rating: 5, status: 'Completed', removedAt: '2026-01-01T00:00:00Z' };
    expect(computeEngagementWeight(loved)).toBeCloseTo(0.5 * computeEngagementWeight({ ...loved, removedAt: undefined }), 6);
    expect(computeNegativeWeight(loved)).toBe(0);
    // A thin, unrated, barely played removal is still a rejection.
    expect(computeEngagementWeight({ hoursPlayed: 1, rating: 0, status: 'Playing', removedAt: '2026-01-01T00:00:00Z' })).toBe(0);
  });

  it('evidence count excludes rejected games', () => {
    expect(countEvidenceLibrary([
      { hoursPlayed: 40, status: 'Completed', rating: 2 },
      { hoursPlayed: 40, status: 'Completed', rating: 1 },
      { hoursPlayed: 1, status: 'Playing', rating: 0, removedAt: '2026-01-01T00:00:00Z' },
      { hoursPlayed: 20, status: 'Playing', rating: 4 },
    ])).toBe(1);
  });
});
