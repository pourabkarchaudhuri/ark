import { describe, it, expect } from 'vitest';
import {
  computeEngagementWeight,
  applyTemporalDecayMultiplier,
} from '@/services/engagement-weight';

describe('engagement alignment (shared weight × decay)', () => {
  it('WtP + low idle uses shared weight (no floor re-inflate)', () => {
    const shared = computeEngagementWeight({
      hoursPlayed: 0,
      rating: 0,
      status: 'Want to Play',
      activeToIdleRatio: 0.2,
    });
    // Shared already applies WtP cap + idle clamp — never the old 1.5 floor
    expect(shared).toBeLessThanOrEqual(0.85 * 0.35 + 1e-9);

    const decayed = applyTemporalDecayMultiplier(shared, 0.5);
    // Decay multiplies only — never adds a WtP floor like 0.2*decay+0.05
    expect(decayed).toBeCloseTo(shared * 0.5, 5);
    const oldFloorStyle = 0.2 * 0.5 + 0.05; // 0.15 — must not be force-lifted to this when shared*decay is lower
    // With idle clamp, shared*0.5 may be near oldFloorStyle; ensure we did not ADD the floor on top
    expect(decayed).toBeLessThanOrEqual(shared * 0.5 + 1e-9);
    expect(decayed).not.toBeCloseTo(oldFloorStyle + shared * 0.5, 5);
  });

  it('decay is a pure multiplier on shared weight', () => {
    const shared = computeEngagementWeight({
      hoursPlayed: 40,
      rating: 5,
      status: 'Completed',
      activeToIdleRatio: 1,
    });
    expect(applyTemporalDecayMultiplier(shared, 1)).toBeCloseTo(shared, 5);
    expect(applyTemporalDecayMultiplier(shared, 0.25)).toBeCloseTo(shared * 0.25, 5);
  });
});
