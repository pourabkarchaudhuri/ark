import { describe, expect, it } from 'vitest';
import {
  WRAPPED_LEGACY_VIEWED_KEY,
  bannerYear,
  defaultWrappedYear,
  getSeasonWindow,
  getWrappedSeason,
  hasNotifiedWrapped,
  hasSeenWrapped,
  isWrappedSeason,
  markWrappedNotified,
  markWrappedSeen,
  notificationYear,
  parseForceMode,
  resolveWrappedSeason,
  type KeyValueStorage,
} from '@/lib/wrapped-season';

function memStorage(init: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v); },
  };
}

// Local-time constructor helper: month is 1-based for readability.
const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, min, s, ms);

describe('wrapped-season window', () => {
  it('is closed on Dec 14 (any time) and opens at Dec 15 00:00 local', () => {
    expect(isWrappedSeason(at(2026, 12, 14, 0))).toBe(false);
    expect(isWrappedSeason(at(2026, 12, 14, 23, 59, 59, 999))).toBe(false);
    expect(isWrappedSeason(at(2026, 12, 15, 0, 0, 0, 0))).toBe(true);
    expect(isWrappedSeason(at(2026, 12, 15, 9))).toBe(true);
  });

  it('stays open through Dec 31 and New Year', () => {
    expect(getWrappedSeason(at(2026, 12, 31, 23, 59, 59, 999))?.year).toBe(2026);
    expect(getWrappedSeason(at(2027, 1, 1, 0))?.year).toBe(2026);
    expect(getWrappedSeason(at(2027, 1, 1, 23, 59))?.year).toBe(2026);
  });

  it('includes all of Jan 2 and closes on Jan 3', () => {
    expect(getWrappedSeason(at(2027, 1, 2, 23, 59, 59, 999))?.year).toBe(2026);
    expect(isWrappedSeason(at(2027, 1, 3, 0, 0, 0, 0))).toBe(false);
    expect(isWrappedSeason(at(2027, 1, 3, 12))).toBe(false);
  });

  it('is closed mid-year', () => {
    expect(getWrappedSeason(at(2026, 10, 23))).toBeNull();
    expect(getWrappedSeason(at(2026, 6, 1))).toBeNull();
  });

  it('season window boundaries', () => {
    const w = getSeasonWindow(2026);
    expect(w.start).toEqual(at(2026, 12, 15, 0));
    expect(w.end).toEqual(at(2027, 1, 2, 23, 59, 59, 999));
  });

  it('handles invalid dates', () => {
    expect(getWrappedSeason(new Date('nope'))).toBeNull();
  });
});

describe('defaultWrappedYear', () => {
  it('maps December to the current year and January to the previous year', () => {
    expect(defaultWrappedYear(at(2026, 12, 20))).toBe(2026);
    expect(defaultWrappedYear(at(2027, 1, 1))).toBe(2026);
    expect(defaultWrappedYear(at(2027, 1, 2))).toBe(2026);
    // After the season, January still opens on last year (this year is ~empty).
    expect(defaultWrappedYear(at(2027, 1, 20))).toBe(2026);
    // Rest of the year: year-to-date.
    expect(defaultWrappedYear(at(2026, 10, 23))).toBe(2026);
    expect(defaultWrappedYear(at(2026, 12, 1))).toBe(2026);
  });
});

describe('dev override', () => {
  it('parses storage and query values', () => {
    expect(parseForceMode(null)).toBe('off');
    expect(parseForceMode('0')).toBe('off');
    expect(parseForceMode('1')).toBe('season');
    expect(parseForceMode('true')).toBe('season');
    expect(parseForceMode('always')).toBe('always');
    expect(parseForceMode(null, '?wrappedSeason=1')).toBe('season');
    expect(parseForceMode(null, '?foo=bar&wrappedSeason=always')).toBe('always');
    expect(parseForceMode('1', '?wrappedSeason=always')).toBe('always');
    expect(parseForceMode(null, '?other=1')).toBe('off');
  });

  it('forces a season out of the real window', () => {
    const oct = at(2026, 10, 23);
    expect(resolveWrappedSeason(oct, 'off')).toBeNull();
    const forced = resolveWrappedSeason(oct, 'season');
    expect(forced?.year).toBe(2026);
    expect(forced?.forced).toBe(true);
    expect(resolveWrappedSeason(at(2027, 1, 20), 'season')?.year).toBe(2026);
  });

  it('prefers the real season when in it', () => {
    const real = resolveWrappedSeason(at(2026, 12, 20), 'always');
    expect(real?.forced).toBe(false);
    expect(real?.year).toBe(2026);
  });
});

describe('banner + notification gating', () => {
  const dec20 = at(2026, 12, 20);

  it('shows the banner in season until seen, keyed by year', () => {
    const st = memStorage();
    expect(bannerYear(dec20, st)).toBe(2026);
    markWrappedSeen(2026, st);
    expect(hasSeenWrapped(2026, st)).toBe(true);
    expect(bannerYear(dec20, st)).toBeNull();
    expect(bannerYear(at(2027, 1, 1), st)).toBeNull(); // same season
    // Next season is a new year → shows again.
    expect(bannerYear(at(2027, 12, 16), st)).toBe(2027);
  });

  it('honours the legacy viewed key', () => {
    const st = memStorage({ [WRAPPED_LEGACY_VIEWED_KEY]: '2026' });
    expect(hasSeenWrapped(2026, st)).toBe(true);
    expect(bannerYear(dec20, st)).toBeNull();
  });

  it('never shows out of season unless forced', () => {
    const st = memStorage();
    expect(bannerYear(at(2026, 10, 23), st)).toBeNull();
    expect(bannerYear(at(2026, 10, 23), st, 'season')).toBe(2026);
    markWrappedSeen(2026, st);
    expect(bannerYear(at(2026, 10, 23), st, 'season')).toBeNull();
    expect(bannerYear(at(2026, 10, 23), st, 'always')).toBe(2026);
  });

  it('notifies once per season and respects permission', () => {
    const st = memStorage();
    expect(notificationYear(dec20, st, 'denied')).toBeNull();
    expect(notificationYear(dec20, st, 'unsupported')).toBeNull();
    expect(notificationYear(dec20, st, 'default')).toBe(2026);
    expect(notificationYear(dec20, st, 'granted')).toBe(2026);
    markWrappedNotified(2026, st);
    expect(hasNotifiedWrapped(2026, st)).toBe(true);
    expect(notificationYear(at(2026, 12, 28), st, 'granted')).toBeNull();
    expect(notificationYear(at(2027, 12, 15, 0), st, 'granted')).toBe(2027);
  });

  it('does not notify after the user already opened Wrapped this season', () => {
    const st = memStorage();
    markWrappedSeen(2026, st);
    expect(notificationYear(dec20, st, 'granted')).toBeNull();
  });

  it('does not notify out of season', () => {
    expect(notificationYear(at(2027, 1, 3), memStorage(), 'granted')).toBeNull();
  });

  it('survives a throwing storage', () => {
    const bad: KeyValueStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(bannerYear(dec20, bad)).toBe(2026);
    expect(() => markWrappedSeen(2026, bad)).not.toThrow();
  });
});
