/**
 * Ark Wrapped — year statistics.
 *
 * `computeWrappedStats` is a pure function over plain data so it can be unit
 * tested; `computeStats` is the thin store-reading wrapper used by the UI.
 *
 * Rules (all dates are local time, a "year" is [Jan 1 00:00, next Jan 1 00:00)):
 *  - A session belongs to the year its startTime falls in.
 *  - Hours come from tracked sessions. Only when the year has no tracked
 *    sessions at all do we fall back to library hours of games that were
 *    added / first played / last played that year (hoursSource = 'library').
 *  - A game "belongs" to the year when it was added, first/last played, had a
 *    session, or changed status during the year — so a game added in an
 *    earlier year but played this year still counts (the old code missed it).
 *  - Completions come from status-history transitions to Completed within the
 *    year, plus games added that year already Completed with no history.
 *  - Streaks are computed from this year's active days only.
 */

import type { GameSession, JourneyEntry, StatusChangeEntry } from '@/types/game';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_OF_WEEK_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type TimeOfDayIcon = 'moon' | 'sunrise' | 'sun' | 'sunset';

export interface WrappedGameRef {
  gameId: string;
  title: string;
  coverUrl?: string;
}

export interface WrappedStats {
  year: number;
  /** Year still in progress (stats are year-to-date). */
  isPartialYear: boolean;
  /** Days of the year covered so far (365/366 for past years). */
  daysInScope: number;
  /** Anything at all happened this year. */
  hasActivity: boolean;
  hoursSource: 'sessions' | 'library' | 'none';

  totalGamesAdded: number;
  gamesPlayed: number;
  totalHoursPlayed: number;
  totalSessions: number;
  gamesCompleted: number;

  topGame: (WrappedGameRef & { hours: number; sessions: number; genre: string[] }) | null;
  topGamePercentage: number;
  top5Games: (WrappedGameRef & { hours: number; rating: number })[];

  genreBreakdown: { genre: string; count: number; percentage: number }[];
  topGenre: string | null;
  distinctGenres: number;

  gamerTitle: string;
  gamerTagline: string;

  monthlyActivity: { month: string; hours: number; sessions: number; gamesAdded: number }[];
  busiestMonth: { month: string; monthLong: string; index: number; hours: number; sessions: number; gamesAdded: number } | null;

  completionRate: number;
  completedGames: WrappedGameRef[];

  playTimeOfDay: { period: string; percentage: number; icon: TimeOfDayIcon }[];
  hasTimeOfDay: boolean;
  dominantPeriod: TimeOfDayIcon | null;
  isNightOwl: boolean;
  nightPercentage: number;

  platformBreakdown: { platform: string; count: number }[];
  statusChanges: number;
  firstGameAdded: { gameId: string; title: string; date: string } | null;

  longestSession: { gameId: string; gameTitle: string; durationMinutes: number; date: string } | null;
  avgSessionMinutes: number;
  totalActiveDays: number;
  activeDayPercentage: number;
  /** Only meaningful for the current year — 0 otherwise. */
  currentStreak: number;
  longestStreak: number;

  dayOfWeekBreakdown: { day: string; sessions: number; hours: number }[];
  busiestDayOfWeek: string | null;
  busiestDayOfWeekLong: string | null;

  ratingDistribution: { rating: number; count: number }[];
  avgRating: number;
  totalRatings: number;

  /** Minutes played per local day, keyed YYYY-MM-DD. */
  heatmap: Record<string, number>;
  funFacts: string[];
  newGamesPerWeek: number;
}

export interface WrappedInputs {
  journey: JourneyEntry[];
  sessions: GameSession[];
  statusChanges: StatusChangeEntry[];
  /** Optional title/cover resolver for games not present in the journey (e.g. library store). */
  lookupGame?: (gameId: string) => { title?: string; coverUrl?: string } | undefined;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

function toTime(iso: string | undefined | null): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return t;
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isLeap(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysBetween(a: Date, b: Date): number {
  // Calendar-day difference, DST-safe.
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

const GENRE_TITLES: Array<[string, string, string]> = [
  ['rpg', 'The Adventurer', 'Every quest log full, every side path walked.'],
  ['role-playing', 'The Adventurer', 'Every quest log full, every side path walked.'],
  ['strategy', 'The Mastermind', 'Always three moves ahead.'],
  ['simulation', 'The Architect', 'Building worlds one decision at a time.'],
  ['shooter', 'The Sharpshooter', 'Quick reflexes, steady aim.'],
  ['fps', 'The Sharpshooter', 'Quick reflexes, steady aim.'],
  ['action', 'The Action Hero', 'Never one to sit still.'],
  ['adventure', 'The Explorer', 'Drawn to every horizon.'],
  ['puzzle', 'The Problem Solver', 'No riddle left unsolved.'],
  ['racing', 'The Speed Demon', 'Life is better at full throttle.'],
  ['sports', 'The Athlete', 'Always in the game.'],
  ['horror', 'The Fearless', 'Walked into the dark on purpose.'],
  ['indie', 'The Indie Soul', 'Champion of the small and brilliant.'],
  ['casual', 'The Unwinder', 'Games as a well-earned breather.'],
  ['platformer', 'The Jumper', 'Precision, timing, one more try.'],
  ['roguelike', 'The Persistent', 'Die, learn, repeat — and win.'],
  ['survival', 'The Survivor', 'Thrives where others give up.'],
  ['fighting', 'The Contender', 'Frame-perfect and fearless.'],
  ['mmo', 'The Socialite', 'Never adventuring alone.'],
];

export function getGamerTitle(input: {
  hasActivity: boolean;
  totalHours: number;
  gamesCompleted: number;
  completionRate: number;
  latePercentage: number;
  distinctGenres: number;
  topGenre: string | null;
}): { title: string; tagline: string } {
  if (!input.hasActivity) return { title: 'The Newcomer', tagline: 'Every legend starts somewhere.' };
  if (input.totalHours >= 500) return { title: 'The Legend', tagline: 'Hundreds of hours. Zero regrets.' };
  if (input.gamesCompleted >= 3 && input.completionRate >= 60) {
    return { title: 'The Completionist', tagline: 'If you start it, you finish it.' };
  }
  if (input.latePercentage >= 30) return { title: 'The Night Owl', tagline: 'Your best runs happen after midnight.' };
  if (input.distinctGenres >= 8) return { title: 'The Wanderer', tagline: 'No genre can hold you for long.' };
  const genre = (input.topGenre || '').toLowerCase();
  for (const [key, title, tagline] of GENRE_TITLES) {
    if (genre.includes(key)) return { title, tagline };
  }
  return { title: 'The Gamer', tagline: 'Simply here for the love of play.' };
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export function computeWrappedStats(year: number, input: WrappedInputs, now: Date = new Date()): WrappedStats {
  const yearStart = new Date(year, 0, 1).getTime();
  const yearEnd = new Date(year + 1, 0, 1).getTime();
  const inYear = (t: number) => Number.isFinite(t) && t >= yearStart && t < yearEnd;

  const isPartialYear = now.getTime() >= yearStart && now.getTime() < yearEnd;
  const daysInYear = isLeap(year) ? 366 : 365;
  const daysInScope = isPartialYear
    ? Math.max(1, daysBetween(new Date(year, 0, 1), now) + 1)
    : daysInYear;
  const weeksInScope = Math.max(1, daysInScope / 7);

  // Index journey entries (last write wins for duplicate ids).
  const journeyById = new Map<string, JourneyEntry>();
  for (const e of input.journey || []) {
    if (e && e.gameId) journeyById.set(e.gameId, e);
  }
  const statusTitles = new Map<string, string>();
  for (const s of input.statusChanges || []) {
    if (s?.gameId && s.title) statusTitles.set(s.gameId, s.title);
  }
  const titleOf = (gameId: string): string =>
    journeyById.get(gameId)?.title
    || input.lookupGame?.(gameId)?.title
    || statusTitles.get(gameId)
    || 'Unknown game';
  const coverOf = (gameId: string): string | undefined =>
    journeyById.get(gameId)?.coverUrl || input.lookupGame?.(gameId)?.coverUrl;
  const ref = (gameId: string): WrappedGameRef => ({ gameId, title: titleOf(gameId), coverUrl: coverOf(gameId) });

  // ── Sessions in the year ──
  const yearSessions = (input.sessions || []).filter((s) => {
    if (!s || !s.gameId) return false;
    if (!Number.isFinite(s.durationMinutes) || s.durationMinutes < 0) return false;
    return inYear(toTime(s.startTime));
  });

  const sessionMinutesByGame = new Map<string, { minutes: number; sessions: number }>();
  for (const s of yearSessions) {
    const cur = sessionMinutesByGame.get(s.gameId) || { minutes: 0, sessions: 0 };
    cur.minutes += s.durationMinutes;
    cur.sessions += 1;
    sessionMinutesByGame.set(s.gameId, cur);
  }

  // ── Status changes in the year ──
  const yearStatusChanges = (input.statusChanges || []).filter((s) => s && inYear(toTime(s.timestamp)));

  // ── Journey entries touched this year ──
  const addedThisYear = [...journeyById.values()].filter((e) => inYear(toTime(e.addedAt)));
  const touchedIds = new Set<string>();
  for (const e of journeyById.values()) {
    if (inYear(toTime(e.addedAt)) || inYear(toTime(e.firstPlayedAt)) || inYear(toTime(e.lastPlayedAt))) {
      touchedIds.add(e.gameId);
    }
  }
  for (const id of sessionMinutesByGame.keys()) touchedIds.add(id);
  for (const s of yearStatusChanges) touchedIds.add(s.gameId);

  // ── Hours per game ──
  const hoursSource: WrappedStats['hoursSource'] = yearSessions.length > 0
    ? 'sessions'
    : [...touchedIds].some((id) => (journeyById.get(id)?.hoursPlayed || 0) > 0) ? 'library' : 'none';

  const hoursByGame = new Map<string, { hours: number; sessions: number }>();
  if (hoursSource === 'sessions') {
    for (const [id, v] of sessionMinutesByGame) hoursByGame.set(id, { hours: v.minutes / 60, sessions: v.sessions });
  } else if (hoursSource === 'library') {
    for (const id of touchedIds) {
      const e = journeyById.get(id);
      if (!e) continue;
      // Only games actually played (or added) this year — not mere status edits.
      const played = inYear(toTime(e.firstPlayedAt)) || inYear(toTime(e.lastPlayedAt)) || inYear(toTime(e.addedAt));
      if (played && (e.hoursPlayed || 0) > 0) hoursByGame.set(id, { hours: e.hoursPlayed, sessions: 0 });
    }
  }

  const totalHoursPlayed = [...hoursByGame.values()].reduce((s, v) => s + v.hours, 0);

  const gamesPlayedIds = new Set<string>(hoursByGame.keys());
  for (const id of touchedIds) {
    const e = journeyById.get(id);
    if (e && (inYear(toTime(e.firstPlayedAt)) || inYear(toTime(e.lastPlayedAt)))) gamesPlayedIds.add(id);
  }

  const sortedByHours = [...hoursByGame.entries()]
    .filter(([, v]) => v.hours > 0)
    .sort((a, b) => b[1].hours - a[1].hours || b[1].sessions - a[1].sessions);

  const topGame = sortedByHours[0]
    ? {
        ...ref(sortedByHours[0][0]),
        hours: round1(sortedByHours[0][1].hours),
        sessions: sortedByHours[0][1].sessions,
        genre: journeyById.get(sortedByHours[0][0])?.genre || [],
      }
    : null;
  const topGamePercentage = topGame && totalHoursPlayed > 0
    ? Math.round((sortedByHours[0][1].hours / totalHoursPlayed) * 100)
    : 0;

  const top5Games = sortedByHours.slice(0, 5).map(([id, v]) => ({
    ...ref(id),
    hours: round1(v.hours),
    rating: Math.round(journeyById.get(id)?.rating || 0),
  }));

  // ── Completions ──
  const completedIds: string[] = [];
  const completedSet = new Set<string>();
  const everCompletedInHistory = new Set<string>();
  for (const s of input.statusChanges || []) {
    if (s?.newStatus === 'Completed') everCompletedInHistory.add(s.gameId);
  }
  const sortedChanges = [...yearStatusChanges].sort((a, b) => toTime(a.timestamp) - toTime(b.timestamp));
  for (const s of sortedChanges) {
    if (s.newStatus === 'Completed' && !completedSet.has(s.gameId)) {
      completedSet.add(s.gameId);
      completedIds.push(s.gameId);
    }
  }
  for (const e of addedThisYear) {
    if (e.status === 'Completed' && !completedSet.has(e.gameId) && !everCompletedInHistory.has(e.gameId)) {
      completedSet.add(e.gameId);
      completedIds.push(e.gameId);
    }
  }
  const gamesCompleted = completedIds.length;
  const completionBase = Math.max(touchedIds.size, gamesCompleted);
  const completionRate = completionBase > 0 ? Math.min(100, Math.round((gamesCompleted / completionBase) * 100)) : 0;

  // ── Genres & platforms (games touched this year) ──
  const genreCounts = new Map<string, number>();
  const platformCounts = new Map<string, number>();
  for (const id of touchedIds) {
    const e = journeyById.get(id);
    if (!e) continue;
    for (const g of new Set(e.genre || [])) if (g) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    for (const p of new Set(e.platform || [])) if (p) platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
  }
  const totalGenreTags = [...genreCounts.values()].reduce((s, c) => s + c, 0);
  const genreBreakdown = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([genre, count]) => ({ genre, count, percentage: totalGenreTags > 0 ? Math.round((count / totalGenreTags) * 100) : 0 }));
  const topGenre = genreBreakdown[0]?.genre ?? null;
  const platformBreakdown = [...platformCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => ({ platform, count }));

  // ── Months ──
  const monthly = MONTHS.map((month) => ({ month, hours: 0, sessions: 0, gamesAdded: 0 }));
  for (const e of addedThisYear) monthly[new Date(e.addedAt).getMonth()].gamesAdded++;
  for (const s of yearSessions) {
    const m = new Date(s.startTime).getMonth();
    monthly[m].sessions++;
    monthly[m].hours += s.durationMinutes / 60;
  }
  const monthlyActivity = monthly.map((m) => ({ ...m, hours: round1(m.hours) }));
  const monthScore = (m: typeof monthlyActivity[number]) =>
    yearSessions.length > 0 ? m.hours * 1000 + m.sessions : m.gamesAdded;
  let busiestIdx = -1;
  for (let i = 0; i < 12; i++) {
    const score = monthScore(monthlyActivity[i]);
    if (score > 0 && (busiestIdx < 0 || score > monthScore(monthlyActivity[busiestIdx]))) busiestIdx = i;
  }
  const busiestMonth = busiestIdx >= 0
    ? { ...monthlyActivity[busiestIdx], monthLong: MONTHS_LONG[busiestIdx], index: busiestIdx }
    : null;

  // ── Time of day (wall-clock minutes, split across bucket boundaries) ──
  const minuteBuckets = [0, 0, 0, 0]; // night 0-6, morning 6-12, afternoon 12-18, evening 18-24
  const BOUNDARIES = [0, 6, 12, 18, 24];
  const MAX_SPAN_MS = 48 * 3_600_000; // ignore corrupt multi-day spans beyond this
  for (const s of yearSessions) {
    const startMs = toTime(s.startTime);
    let endMs = toTime(s.endTime);
    if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + s.durationMinutes * 60_000;
    if (endMs <= startMs) continue;
    endMs = Math.min(endMs, startMs + MAX_SPAN_MS);
    let cursor = new Date(startMs);
    const end = new Date(endMs);
    let guard = 0;
    while (cursor < end && guard++ < 64) {
      const h = cursor.getHours();
      const idx = h < 6 ? 0 : h < 12 ? 1 : h < 18 ? 2 : 3;
      const next = new Date(cursor);
      if (BOUNDARIES[idx + 1] === 24) {
        next.setDate(next.getDate() + 1);
        next.setHours(0, 0, 0, 0);
      } else {
        next.setHours(BOUNDARIES[idx + 1], 0, 0, 0);
      }
      const segEnd = next < end ? next : end;
      minuteBuckets[idx] += (segEnd.getTime() - cursor.getTime()) / 60_000;
      cursor = segEnd;
    }
  }
  const bucketTotal = minuteBuckets.reduce((s, c) => s + c, 0);
  const pct = (v: number) => (bucketTotal > 0 ? Math.round((v / bucketTotal) * 100) : 0);
  const playTimeOfDay: WrappedStats['playTimeOfDay'] = [
    { period: 'Morning', percentage: pct(minuteBuckets[1]), icon: 'sunrise' },
    { period: 'Afternoon', percentage: pct(minuteBuckets[2]), icon: 'sun' },
    { period: 'Evening', percentage: pct(minuteBuckets[3]), icon: 'sunset' },
    { period: 'Late night', percentage: pct(minuteBuckets[0]), icon: 'moon' },
  ];
  const hasTimeOfDay = bucketTotal > 0;
  const nightPercentage = pct(minuteBuckets[0]) + pct(minuteBuckets[3]);
  const isNightOwl = hasTimeOfDay && nightPercentage > 50;
  const dominant = hasTimeOfDay
    ? playTimeOfDay.reduce((best, p) => (p.percentage > best.percentage ? p : best), playTimeOfDay[0]).icon
    : null;

  // ── First game added ──
  const firstAdded = [...addedThisYear].sort((a, b) => toTime(a.addedAt) - toTime(b.addedAt))[0];
  const firstGameAdded = firstAdded
    ? {
        gameId: firstAdded.gameId,
        title: firstAdded.title || titleOf(firstAdded.gameId),
        date: new Date(firstAdded.addedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
      }
    : null;

  // ── Sessions: longest, average, active days, streaks, weekdays, heatmap ──
  let longestSession: WrappedStats['longestSession'] = null;
  for (const s of yearSessions) {
    if (!longestSession || s.durationMinutes > longestSession.durationMinutes) {
      longestSession = {
        gameId: s.gameId,
        gameTitle: titleOf(s.gameId),
        durationMinutes: Math.round(s.durationMinutes),
        date: new Date(s.startTime).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
      };
    }
  }
  if (longestSession && longestSession.durationMinutes <= 0) longestSession = null;

  const totalSessionMinutes = yearSessions.reduce((s, v) => s + v.durationMinutes, 0);
  const avgSessionMinutes = yearSessions.length > 0 ? Math.round(totalSessionMinutes / yearSessions.length) : 0;

  const heatmap: Record<string, number> = {};
  for (const s of yearSessions) {
    const k = dayKey(new Date(s.startTime));
    heatmap[k] = (heatmap[k] || 0) + s.durationMinutes;
  }
  const activeDays = Object.keys(heatmap).sort();
  const totalActiveDays = activeDays.length;
  const activeDayPercentage = Math.min(100, Math.round((totalActiveDays / daysInScope) * 100));

  let longestStreak = 0;
  {
    let run = 0;
    let prev: Date | null = null;
    for (const k of activeDays) {
      const [y, m, d] = k.split('-').map(Number);
      const cur = new Date(y, m - 1, d);
      run = prev && daysBetween(prev, cur) === 1 ? run + 1 : 1;
      if (run > longestStreak) longestStreak = run;
      prev = cur;
    }
  }
  let currentStreak = 0;
  if (isPartialYear && totalActiveDays > 0) {
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!heatmap[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
    while (cursor.getTime() >= yearStart && heatmap[dayKey(cursor)]) {
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  const dow = DAYS_OF_WEEK.map(() => ({ sessions: 0, minutes: 0 }));
  for (const s of yearSessions) {
    const i = new Date(s.startTime).getDay();
    dow[i].sessions++;
    dow[i].minutes += s.durationMinutes;
  }
  const dayOfWeekBreakdown = DAYS_OF_WEEK.map((day, i) => ({ day, sessions: dow[i].sessions, hours: round1(dow[i].minutes / 60) }));
  let busiestDow = -1;
  for (let i = 0; i < 7; i++) {
    if (dow[i].minutes <= 0 && dow[i].sessions <= 0) continue;
    if (busiestDow < 0 || dow[i].minutes > dow[busiestDow].minutes
      || (dow[i].minutes === dow[busiestDow].minutes && dow[i].sessions > dow[busiestDow].sessions)) busiestDow = i;
  }

  // ── Ratings (games touched this year) ──
  const ratingCounts = [0, 0, 0, 0, 0];
  let ratingSum = 0;
  let totalRatings = 0;
  for (const id of touchedIds) {
    const r = Math.round(journeyById.get(id)?.rating || 0);
    if (r >= 1 && r <= 5) {
      ratingCounts[r - 1]++;
      ratingSum += r;
      totalRatings++;
    }
  }
  const ratingDistribution = ratingCounts.map((count, i) => ({ rating: i + 1, count }));
  const avgRating = totalRatings > 0 ? round1(ratingSum / totalRatings) : 0;

  const hasActivity = touchedIds.size > 0 || yearSessions.length > 0;
  const latePercentage = pct(minuteBuckets[0]);
  const { title: gamerTitle, tagline: gamerTagline } = getGamerTitle({
    hasActivity,
    totalHours: totalHoursPlayed,
    gamesCompleted,
    completionRate,
    latePercentage,
    distinctGenres: genreCounts.size,
    topGenre,
  });

  const newGamesPerWeek = addedThisYear.length > 0 ? round1(addedThisYear.length / weeksInScope) : 0;

  // ── Fun facts (plain-language, only when they're meaningful) ──
  const funFacts: string[] = [];
  const hoursRounded = Math.round(totalHoursPlayed);
  if (hoursRounded >= 4) {
    funFacts.push(`${hoursRounded.toLocaleString('en-US')} hours is about ${Math.round(totalHoursPlayed / 2).toLocaleString('en-US')} feature films back to back.`);
  }
  if (topGame && topGamePercentage >= 20 && sortedByHours.length > 1) {
    funFacts.push(`${topGame.title} took ${topGamePercentage}% of all your playtime.`);
  }
  if (longestSession && longestSession.durationMinutes >= 90) {
    funFacts.push(`Your longest sitting was ${round1(longestSession.durationMinutes / 60)} hours of ${longestSession.gameTitle} on ${longestSession.date}.`);
  }
  if (totalActiveDays >= 5) {
    funFacts.push(`You picked up a controller on ${totalActiveDays} different days — ${activeDayPercentage}% of the year${isPartialYear ? ' so far' : ''}.`);
  }
  if (longestStreak >= 3) funFacts.push(`Your best streak was ${longestStreak} days in a row.`);
  if (genreCounts.size >= 5) funFacts.push(`You dipped into ${genreCounts.size} different genres.`);
  if (newGamesPerWeek >= 1) funFacts.push(`You added roughly ${newGamesPerWeek} new games every week.`);
  if (totalHoursPlayed >= 40) funFacts.push(`That's ${round1(totalHoursPlayed / 40)} full work weeks of play.`);
  if (busiestDow >= 0 && yearSessions.length >= 7) {
    funFacts.push(`${DAYS_OF_WEEK_LONG[busiestDow]}s were your favourite day to play.`);
  }

  return {
    year,
    isPartialYear,
    daysInScope,
    hasActivity,
    hoursSource,
    totalGamesAdded: addedThisYear.length,
    gamesPlayed: gamesPlayedIds.size,
    totalHoursPlayed: round1(totalHoursPlayed),
    totalSessions: yearSessions.length,
    gamesCompleted,
    topGame,
    topGamePercentage,
    top5Games,
    genreBreakdown,
    topGenre,
    distinctGenres: genreCounts.size,
    gamerTitle,
    gamerTagline,
    monthlyActivity,
    busiestMonth,
    completionRate,
    completedGames: completedIds.map(ref),
    playTimeOfDay,
    hasTimeOfDay,
    dominantPeriod: dominant,
    isNightOwl,
    nightPercentage,
    platformBreakdown,
    statusChanges: yearStatusChanges.length,
    firstGameAdded,
    longestSession,
    avgSessionMinutes,
    totalActiveDays,
    activeDayPercentage,
    currentStreak,
    longestStreak,
    dayOfWeekBreakdown,
    busiestDayOfWeek: busiestDow >= 0 ? DAYS_OF_WEEK[busiestDow] : null,
    busiestDayOfWeekLong: busiestDow >= 0 ? DAYS_OF_WEEK_LONG[busiestDow] : null,
    ratingDistribution,
    avgRating,
    totalRatings,
    heatmap,
    funFacts,
    newGamesPerWeek,
  };
}

/**
 * Years with any recorded activity, newest first, always including `preferred`.
 * Bounded to [earliest data year, current year] and at most `limit` entries.
 */
export function getWrappedYears(input: WrappedInputs, now: Date = new Date(), preferred?: number, limit = 4): number[] {
  const current = now.getFullYear();
  const years = new Set<number>();
  const add = (iso: string | undefined) => {
    const t = toTime(iso);
    if (!Number.isFinite(t)) return;
    const y = new Date(t).getFullYear();
    if (y >= 2000 && y <= current) years.add(y);
  };
  for (const s of input.sessions || []) add(s?.startTime);
  for (const e of input.journey || []) { add(e?.addedAt); add(e?.firstPlayedAt); add(e?.lastPlayedAt); }
  for (const c of input.statusChanges || []) add(c?.timestamp);
  if (preferred != null) years.add(preferred);
  if (years.size === 0) years.add(current);
  return [...years].sort((a, b) => b - a).slice(0, limit);
}
