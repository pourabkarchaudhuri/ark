import { useMemo } from 'react';
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import { ALL_BADGES } from '@/data/badges';
import type { BadgeCondition, BadgeProgress, BadgeBranch, TasteDnaAxis, BadgeTier } from '@/data/badge-types';
import { TIER_POINTS } from '@/data/badge-types';
import { toCanonicalGenre } from '@/data/canonical-genres';

// ─── Derived stats computed once from raw data ────────────────────────────────

interface DerivedStats {
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
  metacriticCounts: Map<number, number>; // threshold → count of games above threshold
  gamesWithZeroHours: number;
  multiGenreCompletionCount: number;
  longestStreakDays: number;
}

function computeDerivedStats(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
  libraryEntries: LibraryGameEntry[],
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
    const d = new Date(s.startTime);
    sessionDays.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  let longestStreakDays = 0;
  if (sessionDays.size > 0) {
    const sortedDays = Array.from(sessionDays).map(d => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m, day).getTime();
    }).sort((a, b) => a - b);

    let streak = 1;
    let maxStreak = 1;
    const DAY_MS = 86400000;
    for (let i = 1; i < sortedDays.length; i++) {
      const diff = sortedDays[i] - sortedDays[i - 1];
      if (diff <= DAY_MS) { streak++; maxStreak = Math.max(maxStreak, streak); }
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

  return {
    gameCount,
    completionCount,
    totalHours,
    sessionCount: sessions.length,
    ratingCount,
    reviewCount,
    statusChangeCount: statusHistory.length,
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
    metacriticCounts,
    gamesWithZeroHours,
    multiGenreCompletionCount: completedGenres.size,
    longestStreakDays,
  };
}

// ─── Condition evaluator ─────────────────────────────────────────────────────

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
      const met = r >= min && r <= max && stats.ratingCount >= 10;
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
    case 'metacriticAbove': {
      const count = stats.metacriticCounts.get(cond.score) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'gamesPerYear':
      return { met: stats.gameCount >= cond.min, current: stats.gameCount, target: cond.min };
    case 'hoursInMonth':
      return { met: stats.totalHours >= cond.min, current: Math.floor(stats.totalHours), target: cond.min };
    case 'completionsInMonth':
      return { met: stats.completionCount >= cond.min, current: stats.completionCount, target: cond.min };
    case 'gamesWithZeroHours':
      return { met: stats.gamesWithZeroHours >= cond.min, current: stats.gamesWithZeroHours, target: cond.min };
    case 'multiGenreCompletion':
      return { met: stats.multiGenreCompletionCount >= cond.min, current: stats.multiGenreCompletionCount, target: cond.min };
    case 'totalBadgeCount':
      return { met: unlockedCount >= cond.min, current: unlockedCount, target: cond.min };
    case 'branchBadgeCount': {
      const max = Math.max(...Array.from(branchCounts.values()));
      return { met: max >= cond.min, current: max, target: cond.min };
    }
    case 'tierBadgeCount': {
      const count = tierCounts.get(cond.tier) || 0;
      return { met: count >= cond.min, current: count, target: cond.min };
    }
    case 'allBranchesUnlocked': {
      const coreBranches: BadgeBranch[] = ['voyager','conqueror','sentinel','timekeeper','scholar','chronicler','pioneer','stargazer'];
      const minBranch = Math.min(...coreBranches.map(br => branchCounts.get(br) || 0));
      return { met: minBranch >= cond.minPerBranch, current: minBranch, target: cond.minPerBranch };
    }
    case 'tasteDnaAverage':
      return { met: false, current: 0, target: cond.min };
    default:
      return { met: false, current: 0, target: 1 };
  }
}

// ─── Taste DNA ───────────────────────────────────────────────────────────────

function computeTasteDna(stats: DerivedStats): TasteDnaAxis[] {
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

// ─── Main hook ───────────────────────────────────────────────────────────────

export interface MedalsData {
  badges: BadgeProgress[];
  unlockedCount: number;
  totalPoints: number;
  tasteDna: TasteDnaAxis[];
  genomePurity: number;
  branchProgress: Map<BadgeBranch, { unlocked: number; total: number }>;
  commanderLevel: number;
}

export function useBadgeProgress(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
  sessions: GameSession[],
  libraryEntries: LibraryGameEntry[],
): MedalsData {
  // Split into granular memos so each recomputes only when its specific inputs change.

  const stats = useMemo(
    () => computeDerivedStats(journeyEntries, statusHistory, sessions, libraryEntries),
    [journeyEntries, statusHistory, sessions, libraryEntries],
  );

  const tasteDna = useMemo(() => computeTasteDna(stats), [stats]);

  const genomePurity = useMemo(
    () => Math.round(tasteDna.reduce((s, a) => s + a.value, 0) / tasteDna.length),
    [tasteDna],
  );

  // Badge evaluation depends on stats + tasteDna but NOT on sessions/library directly,
  // so it can skip recomputation when only sessions change without affecting stats.
  return useMemo(() => {
    const branchCounts = new Map<BadgeBranch, number>();
    const tierCounts = new Map<BadgeTier, number>();
    let unlockedCount = 0;

    const results: BadgeProgress[] = ALL_BADGES.map(badge => {
      const { met, current, target } = evaluateCondition(
        badge.condition, stats, unlockedCount, branchCounts, tierCounts,
      );
      if (met) {
        unlockedCount++;
        branchCounts.set(badge.branch, (branchCounts.get(badge.branch) || 0) + 1);
        tierCounts.set(badge.tier, (tierCounts.get(badge.tier) || 0) + 1);
      }
      return { badge, unlocked: met, current, target };
    });

    // Second pass for meta-badges
    for (const result of results) {
      if (!result.unlocked) {
        const cond = result.badge.condition;
        if (cond.type === 'totalBadgeCount' || cond.type === 'tierBadgeCount' || cond.type === 'allBranchesUnlocked' || cond.type === 'tasteDnaAverage') {
          let re;
          if (cond.type === 'tasteDnaAverage') {
            const minAxis = Math.min(...tasteDna.map(a => a.value));
            re = { met: minAxis >= cond.min, current: minAxis, target: cond.min };
          } else {
            re = evaluateCondition(cond, stats, unlockedCount, branchCounts, tierCounts);
          }
          result.current = re.current;
          result.target = re.target;
          if (re.met) {
            result.unlocked = true;
            unlockedCount++;
            branchCounts.set(result.badge.branch, (branchCounts.get(result.badge.branch) || 0) + 1);
            tierCounts.set(result.badge.tier, (tierCounts.get(result.badge.tier) || 0) + 1);
          }
        }
      }
    }

    const totalPoints = results
      .filter(r => r.unlocked)
      .reduce((sum, r) => sum + TIER_POINTS[r.badge.tier], 0);

    const branchProgress = new Map<BadgeBranch, { unlocked: number; total: number }>();
    for (const badge of ALL_BADGES) {
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

    const commanderLevel = Math.floor(totalPoints / 100) + 1;

    return {
      badges: results,
      unlockedCount,
      totalPoints,
      tasteDna,
      genomePurity,
      branchProgress,
      commanderLevel,
    };
  }, [stats, tasteDna, genomePurity]);
}
