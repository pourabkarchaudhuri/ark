/**
 * Badge evaluation — pure functions shared by the Medals view (useBadgeProgress)
 * and the app-level unlock stamper (services/badge-unlock-stamper).
 *
 * v1.0.97: meta badges (counts of other badges) are evaluated to a fixed point,
 * volatile badges (active streak, zero-hour backlog) latch once stamped, and
 * release-year / per-day / minimum-rating criteria match their descriptions.
 */
import { isBookkeepingStatusChange } from '@/lib/status-source';
import { DAY_MS } from '@/lib/voyage-derive';
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import { ALL_BADGES } from '@/data/badges';
import type { BadgeCondition, BadgeDefinition, BadgeProgress, BadgeBranch, TasteDnaAxis, BadgeTier } from '@/data/badge-types';
import { TIER_POINTS } from '@/data/badge-types';
import { toCanonicalGenre } from '@/data/canonical-genres';

// ─── Derived stats computed once from raw data ────────────────────────────────

export interface DerivedStats {
  gameCount: number;
  completionCount: number;
  totalHours: number;
  sessionCount: number;
  ratingCount: number;
  reviewCount: number;
  statusChangeCount: number;
  genreSet: Set<string>;
  genreGameCounts: Map<string, number>;
  genreHours: Map<string, number>;
  genreCompletions: Map<string, number>;
  storeGameCounts: Map<string, number>;
  platformGameCounts: Map<string, number>;
  singleGameMaxHours: number;
  singleSessionMaxMinutes: number;
  completionRate: number;
  averageRating: number;
  statusCounts: Map<string, number>;
  uniqueStatuses: number;
  releaseYearSpan: number;
  releaseYearCount: number;
  metacriticCounts: Map<number, number>; // threshold → count of games above threshold
  gamesWithZeroHours: number;
  multiGenreCompletionCount: number;
  longestStreakDays: number;
  currentStreakDays: number;
  /** Most journey entries whose addedAt falls on one local calendar day. */
  maxEntriesAddedInOneDay: number;
  /** Journey entries added per local calendar year. */
  entriesAddedByYear: Map<number, number>;
  currentYear: number;
}

export interface DerivedStatsOptions {
  /** Live streak (sessionStore.getCurrentStreak()); 0 when omitted. */
  currentStreakDays?: number;
  /** Clock for year:'current' conditions. */
  now?: Date;
}

const localDayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function computeDerivedStats(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
  libraryEntries: LibraryGameEntry[],
  opts: DerivedStatsOptions = {},
): DerivedStats {
  const genreGameCounts = new Map<string, number>();
  const genreHours = new Map<string, number>();
  const genreCompletions = new Map<string, number>();
  const storeGameCounts = new Map<string, number>();
  const platformGameCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const genreSet = new Set<string>();
  const completedGenres = new Set<string>();
  let totalHours = 0;
  let completionCount = 0;
  let ratingCount = 0;
  let reviewCount = 0;
  let singleGameMaxHours = 0;
  let gamesWithZeroHours = 0;
  const metacriticThresholds = [70, 80, 90, 95];
  const metacriticCounts = new Map<number, number>();
  metacriticThresholds.forEach(t => metacriticCounts.set(t, 0));

  const releaseYears = new Set<number>();
  // Bucketed on addedAt (when the game joined the library), not firstPlayedAt.
  // Bulk imports count too: entries carry no marker for how they were added.
  const addedPerDay = new Map<string, number>();
  const entriesAddedByYear = new Map<number, number>();

  for (const entry of journeyEntries) {
    totalHours += entry.hoursPlayed ?? 0;
    if (entry.hoursPlayed > singleGameMaxHours) singleGameMaxHours = entry.hoursPlayed;
    if ((entry.hoursPlayed ?? 0) === 0) gamesWithZeroHours++;
    if (entry.status === 'Completed') completionCount++;
    if (entry.rating > 0) ratingCount++;

    const store = entry.gameId.startsWith('epic-') ? 'epic' : entry.gameId.startsWith('custom-') ? 'custom' : 'steam';
    storeGameCounts.set(store, (storeGameCounts.get(store) || 0) + 1);

    statusCounts.set(entry.status, (statusCounts.get(entry.status) || 0) + 1);

    for (const g of entry.genre) {
      const can = toCanonicalGenre(g);
      if (!can) continue;
      genreSet.add(can);
      genreGameCounts.set(can, (genreGameCounts.get(can) || 0) + 1);
      genreHours.set(can, (genreHours.get(can) || 0) + (entry.hoursPlayed ?? 0));
      if (entry.status === 'Completed') {
        genreCompletions.set(can, (genreCompletions.get(can) || 0) + 1);
        completedGenres.add(can);
      }
    }

    for (const p of entry.platform) {
      platformGameCounts.set(p, (platformGameCounts.get(p) || 0) + 1);
    }

    if (entry.releaseDate) {
      const y = new Date(entry.releaseDate).getFullYear();
      if (!isNaN(y)) releaseYears.add(y);
    }

    if (entry.addedAt) {
      const added = new Date(entry.addedAt);
      if (!isNaN(added.getTime())) {
        const k = localDayKey(added);
        addedPerDay.set(k, (addedPerDay.get(k) || 0) + 1);
        const y = added.getFullYear();
        entriesAddedByYear.set(y, (entriesAddedByYear.get(y) || 0) + 1);
      }
    }
  }

  for (const lib of libraryEntries) {
    if (lib.publicReviews && lib.publicReviews.trim().length > 0) reviewCount++;
    const meta = lib.cachedMeta;
    if (meta?.metacriticScore) {
      for (const t of metacriticThresholds) {
        if (meta.metacriticScore >= t) metacriticCounts.set(t, (metacriticCounts.get(t) || 0) + 1);
      }
    }
  }

  let singleSessionMaxMinutes = 0;
  for (const s of sessions) {
    if (s.durationMinutes > singleSessionMaxMinutes) singleSessionMaxMinutes = s.durationMinutes;
  }

  // Streak calculation
  const sessionDays = new Set<string>();
  for (const s of sessions) {
    sessionDays.add(localDayKey(new Date(s.startTime)));
  }
  let longestStreakDays = 0;
  if (sessionDays.size > 0) {
    const sortedDays = Array.from(sessionDays).map(d => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m, day).getTime();
    }).sort((a, b) => a - b);

    let streak = 1;
    let maxStreak = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      // Rounded, so a 23h/25h DST day still counts as one calendar day.
      const diff = sortedDays[i] - sortedDays[i - 1];
      if (Math.round(diff / DAY_MS) === 1) { streak++; maxStreak = Math.max(maxStreak, streak); }
      else { streak = 1; }
    }
    longestStreakDays = maxStreak;
  }

  const gameCount = journeyEntries.length;
  const completionRate = gameCount > 0 ? (completionCount / gameCount) * 100 : 0;
  const ratedEntries = journeyEntries.filter(e => e.rating > 0);
  const averageRating = ratedEntries.length > 0
    ? ratedEntries.reduce((sum, e) => sum + e.rating, 0) / ratedEntries.length
    : 0;

  const releaseYearSpan = releaseYears.size > 0
    ? Math.floor((Math.max(...releaseYears) - Math.min(...releaseYears)) / 10) + 1
    : 0;

  let maxEntriesAddedInOneDay = 0;
  for (const n of addedPerDay.values()) if (n > maxEntriesAddedInOneDay) maxEntriesAddedInOneDay = n;

  return {
    gameCount,
    completionCount,
    totalHours,
    sessionCount: sessions.length,
    ratingCount,
    reviewCount,
    // Automatic/bookkeeping rows (idle On Hold, cross-store sync, undo) are not the user's activity.
    statusChangeCount: statusHistory.filter(r => !isBookkeepingStatusChange(r)).length,
    genreSet,
    genreGameCounts,
    genreHours,
    genreCompletions,
    storeGameCounts,
    platformGameCounts,
    singleGameMaxHours,
    singleSessionMaxMinutes,
    completionRate,
    averageRating,
    statusCounts,
    uniqueStatuses: statusCounts.size,
    releaseYearSpan,
    releaseYearCount: releaseYears.size,
    metacriticCounts,
    gamesWithZeroHours,
    multiGenreCompletionCount: completedGenres.size,
    longestStreakDays,
    currentStreakDays: opts.currentStreakDays ?? 0,
    maxEntriesAddedInOneDay,
    entriesAddedByYear,
    currentYear: (opts.now ?? new Date()).getFullYear(),
  };
}

// ─── Condition evaluator ─────────────────────────────────────────────────────

const CORE_BRANCHES: BadgeBranch[] = ['voyager','conqueror','sentinel','timekeeper','scholar','chronicler','pioneer','stargazer'];

/** Conditions that depend on how many other badges are unlocked. */
function isMetaCondition(cond: BadgeCondition): boolean {
  return cond.type === 'totalBadgeCount' || cond.type === 'tierBadgeCount'
    || cond.type === 'allBranchesUnlocked' || cond.type === 'branchBadgeCount';
}

/**
 * Conditions judged on a live value that can drop again (current streak,
 * current backlog). Once stamped as unlocked they stay unlocked.
 */
function isVolatileCondition(cond: BadgeCondition): boolean {
  return cond.type === 'currentStreakDays' || cond.type === 'gamesWithZeroHours';
}

function evaluateCondition(
  cond: BadgeCondition,
  stats: DerivedStats,
  unlockedCount: number,
  branchCounts: Map<BadgeBranch, number>,
  tierCounts: Map<BadgeTier, number>,
): { met: boolean; current: number; target: number } {
  switch (cond.type) {
    case 'always':
      return { met: true, current: 1, target: 1 };
    case 'gameCount':
      return { met: stats.gameCount >= cond.min, current: stats.gameCount, target: cond.min };
    case 'completionCount':
      return { met: stats.completionCount >= cond.min, current: stats.completionCount, target: cond.min };
    case 'totalHours':
      return { met: stats.totalHours >= cond.min, current: Math.floor(stats.totalHours), target: cond.min };
    case 'sessionCount':
      return { met: stats.sessionCount >= cond.min, current: stats.sessionCount, target: cond.min };
    case 'streakDays':
      return { met: stats.longestStreakDays >= cond.min, current: stats.longestStreakDays, target: cond.min };
    case 'currentStreakDays':
      return { met: stats.currentStreakDays >= cond.min, current: stats.currentStreakDays, target: cond.min };
    case 'ratingCount':
      return { met: stats.ratingCount >= cond.min, current: stats.ratingCount, target: cond.min };
    case 'reviewCount':
      return { met: stats.reviewCount >= cond.min, current: stats.reviewCount, target: cond.min };
    case 'genreCount':
      return { met: stats.genreSet.size >= cond.min, current: stats.genreSet.size, target: cond.min };
    case 'statusChangeCount':
      return { met: stats.statusChangeCount >= cond.min, current: stats.statusChangeCount, target: cond.min };
    case 'storeGameCount': {
      const count = stats.storeGameCounts.get(cond.store) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'platformGameCount': {
      const count = stats.platformGameCounts.get(cond.platform) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'genreGameCount': {
      const genreKey = toCanonicalGenre(cond.genre) ?? cond.genre;
      const count = stats.genreGameCounts.get(genreKey) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'genreHours': {
      const genreKey = toCanonicalGenre(cond.genre) ?? cond.genre;
      const hours = stats.genreHours.get(genreKey) || 0;
      return { met: hours >= cond.min, current: Math.floor(hours), target: cond.min };
    }
    case 'genreCompletions': {
      const genreKey = toCanonicalGenre(cond.genre) ?? cond.genre;
      const count = stats.genreCompletions.get(genreKey) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'singleGameHours':
      return { met: stats.singleGameMaxHours >= cond.min, current: Math.floor(stats.singleGameMaxHours), target: cond.min };
    case 'singleSessionMinutes':
      return { met: stats.singleSessionMaxMinutes >= cond.min, current: stats.singleSessionMaxMinutes, target: cond.min };
    case 'completionRate':
      return { met: stats.completionRate >= cond.min, current: Math.floor(stats.completionRate), target: cond.min };
    case 'averageRating': {
      const r = stats.averageRating;
      const min = cond.min ?? 0;
      const max = cond.max ?? 5;
      const met = r >= min && r <= max && stats.ratingCount >= (cond.minRatings ?? 10);
      return { met, current: Math.round(r * 10) / 10, target: min };
    }
    case 'gamesInStatus': {
      if (cond.status.startsWith('any')) {
        const minStatuses = parseInt(cond.status.replace('any', ''), 10);
        return { met: stats.uniqueStatuses >= minStatuses, current: stats.uniqueStatuses, target: minStatuses };
      }
      const count = stats.statusCounts.get(cond.status) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'releaseYearSpan':
      return { met: stats.releaseYearSpan >= cond.min, current: stats.releaseYearSpan, target: cond.min };
    case 'releaseYearCount':
      return { met: stats.releaseYearCount >= cond.min, current: stats.releaseYearCount, target: cond.min };
    case 'metacriticAbove': {
      const count = stats.metacriticCounts.get(cond.score) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'gamesPerYear': {
      const count = cond.year === 'current'
        ? stats.entriesAddedByYear.get(stats.currentYear) || 0
        : Math.max(0, ...stats.entriesAddedByYear.values());
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'gamesAddedInOneDay':
      return { met: stats.maxEntriesAddedInOneDay >= cond.min, current: stats.maxEntriesAddedInOneDay, target: cond.min };
    case 'gamesWithZeroHours':
      return { met: stats.gamesWithZeroHours >= cond.min, current: stats.gamesWithZeroHours, target: cond.min };
    case 'multiGenreCompletion':
      return { met: stats.multiGenreCompletionCount >= cond.min, current: stats.multiGenreCompletionCount, target: cond.min };
    case 'totalBadgeCount':
      return { met: unlockedCount >= cond.min, current: unlockedCount, target: cond.min };
    case 'branchBadgeCount': {
      const max = Math.max(0, ...branchCounts.values());
      return { met: max >= cond.min, current: max, target: cond.min };
    }
    case 'tierBadgeCount': {
      const count = tierCounts.get(cond.tier) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'allBranchesUnlocked': {
      const minBranch = Math.min(...CORE_BRANCHES.map(br => branchCounts.get(br) || 0));
      return { met: minBranch >= cond.minPerBranch, current: minBranch, target: cond.minPerBranch };
    }
    case 'tasteDnaAverage':
      // Evaluated by evaluateBadges against the taste DNA (not a stat).
      return { met: false, current: 0, target: cond.min };
    default:
      return { met: false, current: 0, target: 1 };
  }
}

// ─── Taste DNA ───────────────────────────────────────────────────────────────

export function computeTasteDna(stats: DerivedStats): TasteDnaAxis[] {
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

  const breadth = clamp((stats.genreSet.size / 20) * 100);
  const depth = stats.gameCount > 0 ? clamp((stats.totalHours / stats.gameCount / 50) * 100) : 0;
  const velocity = clamp((stats.gameCount / 24) * 100); // ~2/month = 100%
  const tenacity = clamp(stats.completionRate);
  const loyalty = clamp((stats.longestStreakDays / 30) * 100);
  const discernment = stats.ratingCount >= 5 ? clamp((stats.averageRating / 5) * 100) : 0;

  const platforms = stats.platformGameCounts.size;
  const stores = stats.storeGameCounts.size;
  const range = clamp(((platforms + stores) / 6) * 100);
  const instinct = clamp((stats.ratingCount / Math.max(stats.gameCount, 1)) * 100);

  return [
    { label: 'Breadth', key: 'breadth', value: breadth },
    { label: 'Depth', key: 'depth', value: depth },
    { label: 'Velocity', key: 'velocity', value: velocity },
    { label: 'Tenacity', key: 'tenacity', value: tenacity },
    { label: 'Loyalty', key: 'loyalty', value: loyalty },
    { label: 'Discernment', key: 'discernment', value: discernment },
    { label: 'Range', key: 'range', value: range },
    { label: 'Instinct', key: 'instinct', value: instinct },
  ];
}

// ─── Badge evaluation ────────────────────────────────────────────────────────

export interface BadgeEvaluation {
  badges: BadgeProgress[];
  unlockedCount: number;
  totalPoints: number;
  branchProgress: Map<BadgeBranch, { unlocked: number; total: number }>;
  commanderLevel: number;
}

export interface EvaluateBadgesOptions {
  /**
   * True when the badge already has a stored unlock date. Only volatile
   * conditions (active streak, zero-hour backlog) consult it.
   */
  isLatched?: (badgeId: number) => boolean;
  /** Badge list override (tests). Defaults to ALL_BADGES. */
  badges?: BadgeDefinition[];
}

export function evaluateBadges(
  stats: DerivedStats,
  tasteDna: TasteDnaAxis[],
  opts: EvaluateBadgesOptions = {},
): BadgeEvaluation {
  const list = opts.badges ?? ALL_BADGES;
  const isLatched = opts.isLatched;
  const branchCounts = new Map<BadgeBranch, number>();
  const tierCounts = new Map<BadgeTier, number>();
  let unlockedCount = 0;
  const minAxis = tasteDna.length > 0 ? Math.min(...tasteDna.map(a => a.value)) : 0;

  const unlock = (r: BadgeProgress) => {
    r.unlocked = true;
    unlockedCount++;
    branchCounts.set(r.badge.branch, (branchCounts.get(r.badge.branch) || 0) + 1);
    tierCounts.set(r.badge.tier, (tierCounts.get(r.badge.tier) || 0) + 1);
  };

  // First pass: everything that does not depend on other badges.
  const metaIdx: number[] = [];
  const results: BadgeProgress[] = list.map((badge, i) => {
    const cond = badge.condition;
    const r: BadgeProgress = { badge, unlocked: false, current: 0, target: 1 };
    if (isMetaCondition(cond)) {
      metaIdx.push(i);
      return r;
    }
    let met: boolean;
    if (cond.type === 'tasteDnaAverage') {
      met = minAxis >= cond.min;
      r.current = minAxis;
      r.target = cond.min;
    } else {
      const re = evaluateCondition(cond, stats, 0, branchCounts, tierCounts);
      met = re.met || (isVolatileCondition(cond) && !!isLatched?.(badge.id));
      r.current = re.current;
      r.target = re.target;
    }
    if (met) unlock(r);
    return r;
  });

  // Meta badges: iterate to a fixed point. Counts only grow, so this settles;
  // the final pass (which unlocks nothing) refreshes every locked badge's progress.
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of metaIdx) {
      const r = results[i];
      if (r.unlocked) continue;
      const re = evaluateCondition(r.badge.condition, stats, unlockedCount, branchCounts, tierCounts);
      r.current = re.current;
      r.target = re.target;
      if (re.met) {
        unlock(r);
        changed = true;
      }
    }
  }
  // Unlocked meta badges show the final counts too.
  for (const i of metaIdx) {
    const r = results[i];
    if (!r.unlocked) continue;
    const re = evaluateCondition(r.badge.condition, stats, unlockedCount, branchCounts, tierCounts);
    r.current = re.current;
    r.target = re.target;
  }

  const totalPoints = results
    .filter(r => r.unlocked)
    .reduce((sum, r) => sum + TIER_POINTS[r.badge.tier], 0);

  const branchProgress = new Map<BadgeBranch, { unlocked: number; total: number }>();
  for (const badge of list) {
    const prev = branchProgress.get(badge.branch) || { unlocked: 0, total: 0 };
    prev.total++;
    branchProgress.set(badge.branch, prev);
  }
  for (const r of results) {
    if (r.unlocked) {
      const prev = branchProgress.get(r.badge.branch)!;
      prev.unlocked++;
    }
  }

  return {
    badges: results,
    unlockedCount,
    totalPoints,
    branchProgress,
    commanderLevel: Math.floor(totalPoints / 100) + 1,
  };
}
