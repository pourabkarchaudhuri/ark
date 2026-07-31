import { describe, it, expect } from 'vitest';
import { isComingSoonForShelf } from '@/services/reco-shelf-rules';

describe('isComingSoonForShelf', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');

  it('does not treat empty date as upcoming', () => {
    expect(isComingSoonForShelf('', false, now)).toBe(false);
    expect(isComingSoonForShelf('   ', undefined, now)).toBe(false);
  });

  it('honors comingSoon === true even without a date', () => {
    expect(isComingSoonForShelf('', true, now)).toBe(true);
  });

  it('admits parseable future dates', () => {
    expect(isComingSoonForShelf('2027-01-15', false, now)).toBe(true);
    expect(isComingSoonForShelf('2020-01-01', false, now)).toBe(false);
  });
});
