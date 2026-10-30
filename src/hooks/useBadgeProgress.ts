import { useMemo, useSyncExternalStore } from 'react';
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import type { BadgeProgress, BadgeBranch, TasteDnaAxis } from '@/data/badge-types';
import { computeDerivedStats, computeTasteDna, evaluateBadges } from '@/lib/badge-progress';
import { sessionStore } from '@/services/session-store';
import {
  hasBadgeUnlockedAt,
  subscribeBadgeUnlockTimestamps,
  getBadgeUnlockTimestampsVersion,
} from '@/services/badge-unlock-timestamps';

// Evaluation lives in src/lib/badge-progress.ts so the app-level unlock stamper
// (services/badge-unlock-stamper) derives exactly the same unlocked set.

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
    () => computeDerivedStats(journeyEntries, statusHistory, sessions, libraryEntries, {
      currentStreakDays: sessionStore.getCurrentStreak(),
    }),
    [journeyEntries, statusHistory, sessions, libraryEntries],
  );

  const tasteDna = useMemo(() => computeTasteDna(stats), [stats]);

  const genomePurity = useMemo(
    () => Math.round(tasteDna.reduce((s, a) => s + a.value, 0) / tasteDna.length),
    [tasteDna],
  );

  // Latched badges read the stored unlock dates; the version changes when the
  // map hydrates and on every new stamp, so the memo re-derives then.
  const stampsVersion = useSyncExternalStore(subscribeBadgeUnlockTimestamps, getBadgeUnlockTimestampsVersion);

  // Badge evaluation depends on stats + tasteDna but NOT on sessions/library directly,
  // so it can skip recomputation when only sessions change without affecting stats.
  return useMemo(() => {
    const evaluation = evaluateBadges(stats, tasteDna, { isLatched: hasBadgeUnlockedAt });
    return { ...evaluation, tasteDna, genomePurity };
  }, [stats, tasteDna, genomePurity, stampsVersion]); // stampsVersion invalidates hasBadgeUnlockedAt
}
