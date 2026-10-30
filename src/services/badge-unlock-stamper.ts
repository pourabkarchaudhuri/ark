/**
 * App-level badge unlock stamping (v1.0.97).
 *
 * "Obtained" dates used to be written from BadgeCard's render, so a badge
 * earned in March but first scrolled into view in October read "Obtained
 * Today". This module derives the unlocked set whenever the journey, status
 * history, session or library store changes (after they and the timestamp map
 * have hydrated) and stamps every newly unlocked id in one write.
 *
 * Work is coalesced and idle-scheduled: a burst of store notifications costs
 * one badge evaluation.
 */
import type { JourneyEntry, StatusChangeEntry, GameSession, LibraryGameEntry } from '@/types/game';
import { computeDerivedStats, computeTasteDna, evaluateBadges } from '@/lib/badge-progress';
import { journeyStore } from '@/services/journey-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { sessionStore } from '@/services/session-store';
import { libraryStore } from '@/services/library-store';
import {
  badgeUnlockTimestampsReady,
  hasBadgeUnlockedAt,
  setBadgeUnlockedAtMany,
} from '@/services/badge-unlock-timestamps';

export interface BadgeInputs {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
  libraryEntries: LibraryGameEntry[];
  currentStreakDays: number;
}

export interface BadgeStamperDeps {
  /** Resolves once every input store and the timestamp map have hydrated. */
  ready: () => Promise<unknown>;
  /** Subscribes to any input store change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  snapshot: () => BadgeInputs;
  stampMany: (entries: Iterable<[number, number]>) => number;
  isStamped: (badgeId: number) => boolean;
  /** Runs fn later (idle); returns a cancel. */
  schedule: (fn: () => void) => () => void;
  now: () => number;
}

function idleSchedule(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 250);
  return () => clearTimeout(id);
}

export const defaultBadgeStamperDeps: BadgeStamperDeps = {
  ready: () => Promise.allSettled([
    journeyStore.ready,
    sessionStore.ready,
    statusHistoryStore.ready(),
    libraryStore.ready,
    badgeUnlockTimestampsReady(),
  ]),
  subscribe: (listener) => {
    const unsubs = [
      journeyStore.subscribe(listener),
      statusHistoryStore.subscribe(listener),
      sessionStore.subscribe(listener),
      libraryStore.subscribe(listener),
    ];
    return () => unsubs.forEach(u => u());
  },
  snapshot: () => ({
    journeyEntries: journeyStore.getAllEntries(),
    statusHistory: statusHistoryStore.getAll(),
    sessions: sessionStore.getAll(),
    libraryEntries: libraryStore.getAllEntries(),
    currentStreakDays: sessionStore.getCurrentStreak(),
  }),
  stampMany: setBadgeUnlockedAtMany,
  isStamped: hasBadgeUnlockedAt,
  schedule: idleSchedule,
  now: () => Date.now(),
};

/** One pass: evaluate badges and stamp the unlocked ids that have no date. Returns how many were stamped. */
export function stampUnlockedBadges(deps: BadgeStamperDeps): number {
  const input = deps.snapshot();
  const stats = computeDerivedStats(
    input.journeyEntries, input.statusHistory, input.sessions, input.libraryEntries,
    { currentStreakDays: input.currentStreakDays },
  );
  // Same latch as useBadgeProgress, so meta counts agree with the vault.
  const { badges } = evaluateBadges(stats, computeTasteDna(stats), { isLatched: deps.isStamped });
  const ts = deps.now();
  const fresh: Array<[number, number]> = [];
  for (const r of badges) {
    if (r.unlocked && !deps.isStamped(r.badge.id)) fresh.push([r.badge.id, ts]);
  }
  return fresh.length > 0 ? deps.stampMany(fresh) : 0;
}

/** Starts stamping after hydration; returns a stop function. */
export function startBadgeUnlockStamping(overrides: Partial<BadgeStamperDeps> = {}): () => void {
  const deps: BadgeStamperDeps = { ...defaultBadgeStamperDeps, ...overrides };
  let stopped = false;
  let scheduled = false;
  let cancelScheduled: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const run = () => {
    scheduled = false;
    cancelScheduled = null;
    if (stopped) return;
    try {
      stampUnlockedBadges(deps);
    } catch (err) {
      console.error('[BadgeUnlockStamper] stamping failed:', err);
    }
  };
  const request = () => {
    if (stopped || scheduled) return;
    scheduled = true;
    const cancel = deps.schedule(run);
    // A synchronous scheduler has already run (and cleared `scheduled`).
    if (scheduled) cancelScheduled = cancel;
  };

  void deps.ready().then(() => {
    if (stopped) return;
    unsubscribe = deps.subscribe(request);
    request();
  });

  return () => {
    stopped = true;
    cancelScheduled?.();
    cancelScheduled = null;
    unsubscribe?.();
    unsubscribe = null;
  };
}
