/**
 * Automatic status changes (idle On Hold, cross-store sync, undo) do not count as the user's activity,
 * and an automatic hold is not a "bounced off" signal for recommendations.
 */
import { describe, it, expect } from 'vitest';
import { isAutoHeld, isBookkeepingStatusChange } from '@/lib/status-source';
import { computeNegativeWeight } from '@/services/engagement-weight';
import type { StatusChangeEntry } from '@/types/game';

const row = (newStatus: StatusChangeEntry['newStatus'], source?: StatusChangeEntry['source']): StatusChangeEntry =>
  ({ gameId: 'g', title: 'G', previousStatus: 'Playing', newStatus, timestamp: '2026-01-01T00:00:00.000Z', ...(source ? { source } : {}) });

describe('status-change provenance', () => {
  it('bookkeeping rows are auto-hold, sync and undo; old rows without a source always count', () => {
    expect(isBookkeepingStatusChange(row('On Hold', 'auto-hold'))).toBe(true);
    expect(isBookkeepingStatusChange(row('Playing', 'sync'))).toBe(true);
    expect(isBookkeepingStatusChange(row('Playing', 'undo'))).toBe(true);
    expect(isBookkeepingStatusChange(row('Playing', 'auto-promote'))).toBe(false);
    expect(isBookkeepingStatusChange(row('Playing', 'user'))).toBe(false);
    expect(isBookkeepingStatusChange(row('Playing'))).toBe(false);
  });

  it('isAutoHeld looks at the latest move into On Hold', () => {
    expect(isAutoHeld([row('On Hold', 'auto-hold')])).toBe(true);
    expect(isAutoHeld([row('On Hold', 'auto-hold'), row('Playing', 'undo'), row('On Hold')])).toBe(false);
    expect(isAutoHeld([row('On Hold'), row('Playing'), row('On Hold', 'auto-hold')])).toBe(true);
    expect(isAutoHeld([])).toBe(false);
  });

  it('an automatic hold carries no negative taste weight; a user hold after <2h does', () => {
    const base = { hoursPlayed: 1, rating: 0, status: 'On Hold' };
    expect(computeNegativeWeight({ ...base, autoHeld: true })).toBe(0);
    expect(computeNegativeWeight(base)).toBeCloseTo(0.7);
  });
});
