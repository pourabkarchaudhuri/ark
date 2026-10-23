/**
 * Ark Wrapped season — pure helpers that decide WHEN the year-in-review is
 * surfaced (in-app banner + one desktop notification) and WHICH year it covers.
 *
 * Season window (local time, inclusive):
 *   Dec 15 00:00:00.000  →  Jan 2 23:59:59.999 of the following year.
 *
 *   "Until the new year is over" is read as: New Year's Eve, New Year's Day and
 *   the day after (Jan 2) — many people are still on holiday on Jan 2, so the
 *   banner stays up through it and disappears on Jan 3.
 *
 * Year mapping:
 *   December 15–31  → that calendar year          (Dec 20 2026 → 2026)
 *   January 1–2     → the year that just ended    (Jan 1 2027  → 2026)
 *
 * Testing before the real date (dev override):
 *   localStorage.setItem('ark-wrapped-force-season', '1')
 *       Pretend we're in season. The "already seen / already notified" gating
 *       still applies, so you see exactly what a user sees on first launch.
 *   localStorage.setItem('ark-wrapped-force-season', 'always')
 *       Pretend we're in season AND ignore the seen/notified flags, so the
 *       banner and the desktop notification appear on every launch.
 *   Query param `?wrappedSeason=1` / `?wrappedSeason=always` does the same
 *   (handy for the Vite dev server: http://localhost:5173/?wrappedSeason=always).
 *   Remove the key (or set it to '0') to go back to the real calendar.
 *   Outside the real window the forced season covers the default year
 *   (current year, or the previous year during January).
 *
 * Every function takes an injectable `now` / storage so it is fully unit-testable.
 */

export const WRAPPED_FORCE_SEASON_KEY = 'ark-wrapped-force-season';
export const WRAPPED_SEASON_QUERY_PARAM = 'wrappedSeason';

/** Legacy key from the first Wrapped snackbar: stored the year string once launched. */
export const WRAPPED_LEGACY_VIEWED_KEY = 'ark-wrapped-viewed';
/** Per-year flag: user opened Wrapped or dismissed the banner for that season. */
export const wrappedSeenKey = (year: number) => `ark-wrapped-seen:${year}`;
/** Per-year flag: the desktop notification was already shown (or permanently refused). */
export const wrappedNotifiedKey = (year: number) => `ark-wrapped-notified:${year}`;

/** Window event fired when Wrapped is marked seen, so other surfaces (banner) can react. */
export const WRAPPED_SEEN_EVENT = 'ark-wrapped-seen';

/** First day of the season (December, local time). */
export const SEASON_START_DAY = 15;
/** Last day of the season (January, inclusive, local time). */
export const SEASON_END_DAY = 2;

export interface WrappedSeason {
  /** The calendar year the recap covers. */
  year: number;
  /** Inclusive start (local). */
  start: Date;
  /** Inclusive end (local, last millisecond of the day). */
  end: Date;
  /** True when the season comes from the dev override rather than the calendar. */
  forced: boolean;
}

export type ForceMode = 'off' | 'season' | 'always';

/** Season window for the recap of `year` (Dec 15 of `year` → Jan 2 of `year + 1`). */
export function getSeasonWindow(year: number): { start: Date; end: Date } {
  return {
    start: new Date(year, 11, SEASON_START_DAY, 0, 0, 0, 0),
    end: new Date(year + 1, 0, SEASON_END_DAY, 23, 59, 59, 999),
  };
}

/** The real-calendar season containing `now`, or null when out of season. */
export function getWrappedSeason(now: Date = new Date()): WrappedSeason | null {
  const y = now.getFullYear();
  const t = now.getTime();
  if (Number.isNaN(t)) return null;
  // December side: season for this year.
  const dec = getSeasonWindow(y);
  if (t >= dec.start.getTime() && t <= dec.end.getTime()) return { year: y, ...dec, forced: false };
  // January side: season for last year.
  const jan = getSeasonWindow(y - 1);
  if (t >= jan.start.getTime() && t <= jan.end.getTime()) return { year: y - 1, ...jan, forced: false };
  return null;
}

export function isWrappedSeason(now: Date = new Date()): boolean {
  return getWrappedSeason(now) !== null;
}

/**
 * Which year Wrapped should open on by default.
 *  - In season → the season's year.
 *  - January (after the season) → the year that just ended (the current one is ~empty).
 *  - Otherwise → the current year (year-to-date recap).
 */
export function defaultWrappedYear(now: Date = new Date()): number {
  const season = getWrappedSeason(now);
  if (season) return season.year;
  if (now.getMonth() === 0) return now.getFullYear() - 1;
  return now.getFullYear();
}

/** Parse the dev override from localStorage value and/or a URL query string. */
export function parseForceMode(storageValue: string | null | undefined, search?: string | null): ForceMode {
  const norm = (v: string | null | undefined): ForceMode => {
    if (!v) return 'off';
    const s = v.trim().toLowerCase();
    if (s === 'always') return 'always';
    if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return 'season';
    return 'off';
  };
  let fromQuery: ForceMode = 'off';
  if (search) {
    try {
      fromQuery = norm(new URLSearchParams(search).get(WRAPPED_SEASON_QUERY_PARAM));
    } catch { /* malformed query */ }
  }
  const fromStorage = norm(storageValue);
  if (fromQuery === 'always' || fromStorage === 'always') return 'always';
  if (fromQuery === 'season' || fromStorage === 'season') return 'season';
  return 'off';
}

/** Read the dev override from the live environment (safe in tests / without window). */
export function readForceMode(): ForceMode {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(WRAPPED_FORCE_SEASON_KEY) : null;
    const search = typeof window !== 'undefined' ? window.location?.search : '';
    return parseForceMode(stored, search);
  } catch {
    return 'off';
  }
}

/** Real season, or a synthetic one when the dev override is on. */
export function resolveWrappedSeason(now: Date = new Date(), force: ForceMode = 'off'): WrappedSeason | null {
  const real = getWrappedSeason(now);
  if (real) return real;
  if (force === 'off') return null;
  const year = defaultWrappedYear(now);
  return { year, ...getSeasonWindow(year), forced: true };
}

// ─── Seen / notified bookkeeping ─────────────────────────────────────────────

/** Minimal storage surface so tests can pass a Map-backed fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeGet(storage: KeyValueStorage | null | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}
function safeSet(storage: KeyValueStorage | null | undefined, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* quota / disabled storage */ }
}

export function defaultStorage(): KeyValueStorage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function hasSeenWrapped(year: number, storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (safeGet(storage, wrappedSeenKey(year)) === '1') return true;
  return safeGet(storage, WRAPPED_LEGACY_VIEWED_KEY) === String(year);
}

export function markWrappedSeen(year: number, storage: KeyValueStorage | null = defaultStorage()): void {
  safeSet(storage, wrappedSeenKey(year), '1');
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WRAPPED_SEEN_EVENT, { detail: { year } }));
    }
  } catch { /* non-DOM env */ }
}

export function hasNotifiedWrapped(year: number, storage: KeyValueStorage | null = defaultStorage()): boolean {
  return safeGet(storage, wrappedNotifiedKey(year)) === '1';
}

export function markWrappedNotified(year: number, storage: KeyValueStorage | null = defaultStorage()): void {
  safeSet(storage, wrappedNotifiedKey(year), '1');
}

/** Year the in-app banner should promote right now, or null. */
export function bannerYear(
  now: Date,
  storage: KeyValueStorage | null,
  force: ForceMode = 'off',
): number | null {
  const season = resolveWrappedSeason(now, force);
  if (!season) return null;
  if (force !== 'always' && hasSeenWrapped(season.year, storage)) return null;
  return season.year;
}

export type NotificationPermissionLike = 'granted' | 'denied' | 'default' | 'unsupported';

/**
 * Year the desktop notification should be sent for right now, or null.
 * Never when the OS/user denied notifications, never twice per season, and not
 * once the user has already opened Wrapped (or dismissed the banner) this season.
 */
export function notificationYear(
  now: Date,
  storage: KeyValueStorage | null,
  permission: NotificationPermissionLike,
  force: ForceMode = 'off',
): number | null {
  if (permission === 'denied' || permission === 'unsupported') return null;
  const season = resolveWrappedSeason(now, force);
  if (!season) return null;
  if (force === 'always') return season.year;
  if (hasNotifiedWrapped(season.year, storage)) return null;
  if (hasSeenWrapped(season.year, storage)) return null;
  return season.year;
}
