/**
 * Store-reading glue for Ark Wrapped. Kept separate from `stats.ts` so the
 * statistics stay a pure, unit-testable function.
 */
import { journeyStore } from '@/services/journey-store';
import { sessionStore } from '@/services/session-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { libraryStore } from '@/services/library-store';
import { computeWrappedStats, getWrappedYears, type WrappedInputs, type WrappedStats } from './stats';

export function readWrappedInputs(): WrappedInputs {
  const safe = <T,>(fn: () => T[]): T[] => {
    try { return fn() || []; } catch { return []; }
  };
  return {
    journey: safe(() => journeyStore.getAllEntries()),
    sessions: safe(() => sessionStore.getAll()),
    statusChanges: safe(() => statusHistoryStore.getAll()),
    lookupGame: (gameId) => {
      try {
        const e = libraryStore.getEntry(gameId);
        if (!e) return undefined;
        return { title: e.cachedMeta?.title, coverUrl: e.cachedMeta?.coverUrl };
      } catch {
        return undefined;
      }
    },
  };
}

/** Compute stats for `year` from the live stores. */
export function computeStats(year: number, now: Date = new Date()): WrappedStats {
  return computeWrappedStats(year, readWrappedInputs(), now);
}

/** Compute stats and the selectable years in one pass over the stores. */
export function computeWrappedBundle(year: number, now: Date = new Date()): { stats: WrappedStats; years: number[] } {
  const inputs = readWrappedInputs();
  return { stats: computeWrappedStats(year, inputs, now), years: getWrappedYears(inputs, now, year) };
}
