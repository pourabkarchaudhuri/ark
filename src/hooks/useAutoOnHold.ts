import { useEffect } from 'react';
import { libraryStore, type LibraryEntryWithStatusStamp } from '@/services/library-store';
import { statusHistoryStore } from '@/services/status-history-store';

/**
 * useAutoOnHold (v1.0.42)
 *
 * Periodic sweep that auto-transitions library entries whose status is
 * "Playing" but that have not been played for 30+ days into "On Hold".
 *
 * Rules:
 *   - Only "Playing" is touched. "Completed", "Playing Now", "Want to Play",
 *     and existing "On Hold" entries are left alone.
 *   - Staleness is measured from the MOST RECENT of: `lastPlayedAt`, the
 *     entry's `statusChangedAt` stamp, the latest status-history transition
 *     into Playing / Playing Now, and `addedAt`. (Previously it was
 *     `lastPlayedAt ?? addedAt`, so a game the user had just switched to
 *     "Playing" — whose last play was months ago — was flipped straight back
 *     to On Hold on the next sweep.)
 *   - Waits for the library + status-history stores to hydrate, and skips
 *     the sweep entirely when the library is read-only.
 *   - `lastPlayedAt` is NEVER overwritten — the real last-play date is
 *     preserved. Only `status` and `autoTransitionedAt` are updated.
 *   - Gated by the `autoOnHoldTransition` setting (defaults ON, per the user's
 *     explicit request).
 *
 * Triggers:
 *   - Once at hook mount (app startup).
 *   - Every 60 minutes thereafter (setInterval, cleaned up on unmount).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ON_HOLD_THRESHOLD_MS = 30 * DAY_MS;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

/** LocalStorage fallback so the sweep can be disabled without a preload update. */
const AUTO_ON_HOLD_LS_KEY = 'ark:autoOnHoldTransition';

/**
 * Read the `autoOnHoldTransition` flag. Default is TRUE (user asked for this
 * explicitly). Prefers the main-process settings bridge; falls back to
 * localStorage. Never throws.
 */
async function isAutoOnHoldTransitionEnabled(): Promise<boolean> {
  try {
    const bridge = (window as unknown as {
      settings?: { getAutoOnHoldTransition?: () => Promise<boolean> | boolean };
    }).settings;
    if (bridge && typeof bridge.getAutoOnHoldTransition === 'function') {
      const value = await bridge.getAutoOnHoldTransition();
      return value !== false;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage?.getItem(AUTO_ON_HOLD_LS_KEY);
    // No stored preference → default TRUE.
    if (raw === null || raw === undefined) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

const PLAYING_STATUSES = ['Playing', 'Playing Now'] as const;

/** Coerce an entry's `addedAt` (which may be a Date OR an ISO string after rehydration). */
function toMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Single sweep. Public for testing; the hook wires the timer.
 */
export async function runAutoOnHoldSweep(now: number = Date.now()): Promise<void> {
  try {
    const enabled = await isAutoOnHoldTransitionEnabled();
    if (!enabled) return;

    // Never judge staleness against a half-hydrated view: the status history
    // (our record of "user set this to Playing on <date>") loads async.
    await Promise.all([
      libraryStore.ready.catch(() => undefined),
      statusHistoryStore.ready().catch(() => undefined),
    ]);
    if (libraryStore.isReadOnly()) return;

    for (const entry of libraryStore.getAllEntries() as LibraryEntryWithStatusStamp[]) {
      // Only "Playing" transitions to On Hold. Completed, Want to Play,
      // Playing Now (live), and existing On Hold are all skipped.
      if (entry.status !== 'Playing') continue;

      const candidates = [
        toMs(entry.lastPlayedAt),
        toMs(entry.statusChangedAt),
        statusHistoryStore.getLatestTransitionInto(entry.gameId, PLAYING_STATUSES),
        toMs(entry.addedAt),
      ].filter((v): v is number => v !== null && Number.isFinite(v));
      if (candidates.length === 0) continue;
      const referenceMs = Math.max(...candidates);

      const elapsed = now - referenceMs;
      if (elapsed < ON_HOLD_THRESHOLD_MS) continue;

      const daysStale = Math.floor(elapsed / DAY_MS);
      // Do NOT touch lastPlayedAt — preserve the real last-play date so the
      // On Hold nudge remains accurate if the user resumes later.
      libraryStore.updateEntry(entry.gameId, {
        status: 'On Hold',
        autoTransitionedAt: new Date().toISOString(),
      });
      console.log(
        `[useAutoOnHold] Auto-transitioned ${entry.gameId} to On Hold — no session in ${daysStale} days`,
      );
    }
  } catch (err) {
    // A failed sweep must never surface as an error toast; try again next tick.
    console.warn('[useAutoOnHold] sweep skipped:', err);
  }
}

/**
 * useAutoOnHold — mounts a periodic Playing → On Hold sweep. Invoke this once
 * from a component that lives at the app root (SessionTrackerProvider already
 * does — this hook composes cleanly next to `useSessionTracker`).
 */
export function useAutoOnHold(): void {
  useEffect(() => {
    // Kick a sweep on startup so long-idle games get flipped immediately.
    void runAutoOnHoldSweep();

    // Time-based sweep so entries flip as they cross the 30-day boundary
    // during a long-running session.
    const intervalId = window.setInterval(() => {
      void runAutoOnHoldSweep();
    }, CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);
}
