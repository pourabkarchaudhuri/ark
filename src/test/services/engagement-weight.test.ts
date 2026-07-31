import { describe, it, expect } from 'vitest';
import {
  clampActiveToIdleRatio,
  computeEngagementWeight,
  heroEvidenceSortKey,
  countEvidenceLibrary,
} from '@/services/engagement-weight';

describe('engagement-weight', () => {
  it('caps Want-to-Play below Completed / high-hours evidence', () => {
    const wtp = computeEngagementWeight({
      hoursPlayed: 0,
      rating: 0,
      status: 'Want to Play',
      activeToIdleRatio: 1,
    });
    const completed = computeEngagementWeight({
      hoursPlayed: 40,
      rating: 5,
      status: 'Completed',
      activeToIdleRatio: 1,
    });
    expect(wtp).toBeLessThanOrEqual(0.85);
    expect(completed).toBeGreaterThan(wtp);
  });

  it('does not apply the old 1.5 Want-to-Play floor', () => {
    const w = computeEngagementWeight({
      hoursPlayed: 0,
      rating: 0,
      status: 'Want to Play',
    });
    expect(w).toBeLessThan(1.5);
  });

  it('reduces weight when activeToIdleRatio is low (F7)', () => {
    const base = {
      hoursPlayed: 30,
      rating: 4,
      status: 'Playing' as const,
    };
    const full = computeEngagementWeight({ ...base, activeToIdleRatio: 1 });
    const idle = computeEngagementWeight({ ...base, activeToIdleRatio: 0.2 });
    expect(idle).toBeLessThan(full);
    expect(idle / full).toBeCloseTo(0.35, 5);
  });

  it('clamps activeToIdleRatio into [0.35, 1]', () => {
    expect(clampActiveToIdleRatio(0)).toBe(0.35);
    expect(clampActiveToIdleRatio(2)).toBe(1);
    expect(clampActiveToIdleRatio(undefined)).toBe(1);
  });
});

describe('engagement-weight intent/evidence (F2/F9)', () => {
  it('heroEvidenceSortKey boosts evidence alignment', () => {
    expect(heroEvidenceSortKey(1, 1)).toBeCloseTo(1.0, 5);
    expect(heroEvidenceSortKey(1, 0)).toBeCloseTo(0.7, 5);
  });

  it('countEvidenceLibrary uses Completed or hours ≥ 2', () => {
    expect(countEvidenceLibrary([
      { status: 'Completed', hoursPlayed: 0 },
      { status: 'Playing', hoursPlayed: 2 },
      { status: 'Want to Play', hoursPlayed: 0 },
    ])).toBe(2);
  });
});
