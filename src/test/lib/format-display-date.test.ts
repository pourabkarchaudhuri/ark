import { describe, it, expect } from 'vitest';
import { formatDisplayDate } from '@/lib/utils';

describe('formatDisplayDate', () => {
  it('formats an ISO date as "Mon D, YYYY" (same as toLocaleDateString en-US short)', () => {
    const iso = '2025-01-18T12:00:00';
    const expected = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    expect(formatDisplayDate(iso)).toBe(expected);
    expect(formatDisplayDate(iso)).toBe('Jan 18, 2025');
  });

  it('accepts a Date or epoch milliseconds', () => {
    const d = new Date(2024, 5, 1, 12);
    expect(formatDisplayDate(d)).toBe('Jun 1, 2024');
    expect(formatDisplayDate(d.getTime())).toBe('Jun 1, 2024');
  });

  it('returns the raw string for an unparseable date and empty for empty input', () => {
    expect(formatDisplayDate('Coming soon')).toBe('Coming soon');
    expect(formatDisplayDate('')).toBe('');
    expect(formatDisplayDate(Number.NaN)).toBe('');
  });
});
