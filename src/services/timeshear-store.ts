/**
 * Timeshear Store — Phase 3.0
 *
 * Builds per-game weekly timelines from libraryStore + statusHistoryStore + journeyStore.
 * Used by the Galaxy scrubber to morph node appearance through the past 52 weeks.
 *
 * STATE ENCODING per (game, week):
 *   0 = unowned (game not in library that week)
 *   1 = in library, not yet completed
 *   2 = completed
 *
 * The PCA-reduced-position approach from the original punch list is deferred —
 * positions are static; only appearance (brightness + completion tint) shifts. This
 * delivers 90% of the "watch your library become" feel with a fraction of the cost.
 */

import { libraryStore } from './library-store';
import { statusHistoryStore } from './status-history-store';

export const TIMESHEAR_WEEKS = 52;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

export type TimeshearState = 0 | 1 | 2;

export interface Timeline {
  /** Week W (0..TIMESHEAR_WEEKS-1) → state. W=0 is 52 weeks ago; W=TIMESHEAR_WEEKS-1 is current week. */
  states: Uint8Array;
}

/** Convert an ISO string or Date into a week index. Anchor is "now" → TIMESHEAR_WEEKS - 1. */
export function timestampToWeekIndex(input: string | Date | null | undefined, nowMs: number): number {
  if (!input) return -Infinity;
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return -Infinity;
  const ageMs = nowMs - ts;
  const ageWeeks = ageMs / MS_PER_WEEK;
  return (TIMESHEAR_WEEKS - 1) - Math.floor(ageWeeks);
}

/**
 * Build a timeline for a single game id. Sources:
 *   - libraryStore for addedAt (entry timestamp)
 *   - statusHistoryStore for any Completed transition timestamp
 *   - falls back to libraryStore.lastPlayedAt for Completed if no history change is recorded
 */
export function buildTimelineForGame(gameId: string, nowMs: number): Timeline {
  const states = new Uint8Array(TIMESHEAR_WEEKS);
  const entry = libraryStore.getEntry(gameId);
  if (!entry) return { states };
  const addedAt = entry.addedAt ?? null;
  if (!addedAt) return { states };
  const addedWeek = Math.max(0, Math.min(TIMESHEAR_WEEKS - 1, timestampToWeekIndex(addedAt, nowMs)));

  // Find first Completed transition, if any
  let completedWeek = Infinity;
  const history = statusHistoryStore.getAll();
  for (const ev of history) {
    if (ev.gameId !== gameId) continue;
    if (ev.newStatus !== 'Completed') continue;
    const w = timestampToWeekIndex(ev.timestamp, nowMs);
    if (w !== -Infinity && w < completedWeek) completedWeek = w;
  }
  if (completedWeek === Infinity && entry.status === 'Completed' && entry.lastPlayedAt) {
    completedWeek = timestampToWeekIndex(entry.lastPlayedAt, nowMs);
  }

  for (let w = addedWeek; w < TIMESHEAR_WEEKS; w++) {
    if (w >= completedWeek) states[w] = 2;
    else states[w] = 1;
  }
  return { states };
}

/**
 * Bulk build — one Uint8Array of length nodeIds.length × TIMESHEAR_WEEKS.
 * Indexing: states[nodeIdx * TIMESHEAR_WEEKS + weekIdx].
 * Returns a flat buffer so consumers can scan one row per scrub frame at minimum cost.
 */
export function buildTimelineMatrix(nodeIds: string[], nowMs: number = Date.now()): Uint8Array {
  const out = new Uint8Array(nodeIds.length * TIMESHEAR_WEEKS);
  // Pre-build a single status-history map: gameId → first Completed week
  const completedAtByGame = new Map<string, number>();
  const history = statusHistoryStore.getAll();
  for (const ev of history) {
    if (ev.newStatus !== 'Completed') continue;
    const w = timestampToWeekIndex(ev.timestamp, nowMs);
    if (w === -Infinity) continue;
    const prior = completedAtByGame.get(ev.gameId) ?? Infinity;
    if (w < prior) completedAtByGame.set(ev.gameId, w);
  }
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    const entry = libraryStore.getEntry(id);
    if (!entry || !entry.addedAt) continue;
    const addedWeek = Math.max(0, Math.min(TIMESHEAR_WEEKS - 1, timestampToWeekIndex(entry.addedAt, nowMs)));
    let completedWeek = completedAtByGame.get(id) ?? Infinity;
    if (completedWeek === Infinity && entry.status === 'Completed' && entry.lastPlayedAt) {
      completedWeek = timestampToWeekIndex(entry.lastPlayedAt, nowMs);
    }
    const base = i * TIMESHEAR_WEEKS;
    for (let w = addedWeek; w < TIMESHEAR_WEEKS; w++) {
      out[base + w] = w >= completedWeek ? 2 : 1;
    }
  }
  return out;
}

/** Format the "week label" for the scrubber. W=51 → "now"; W=0 → "1 year ago". */
export function formatWeekLabel(week: number): string {
  if (week >= TIMESHEAR_WEEKS - 1) return 'now';
  if (week <= 0) return '1 year ago';
  const weeksAgo = TIMESHEAR_WEEKS - 1 - week;
  if (weeksAgo < 4) return `${weeksAgo}w ago`;
  const monthsAgo = Math.round(weeksAgo / 4.345);
  return `${monthsAgo}mo ago`;
}
