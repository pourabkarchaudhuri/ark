/**
 * "When did the user first play this?" — one shared answer for every journey writer.
 *
 * Evidence, earliest wins: the first recorded play session (the executable actually ran) and the
 * first status transition into Playing / Playing Now. Timestamps outside a plausible window are
 * ignored so a stray 0 / 1970 default (catalog rows use 0) can never win an "earliest" comparison.
 */
import { sessionStore } from './session-store';
import { statusHistoryStore } from './status-history-store';

const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export function isPlausibleTimestamp(ms: number, now = Date.now()): boolean {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_MS && ms <= now + FUTURE_SLACK_MS;
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return isPlausibleTimestamp(ms) ? ms : null;
}

/** Earliest plausible value as an ISO string, or undefined when none is usable. */
export function earliestIso(...values: Array<string | number | null | undefined>): string | undefined {
  let best: number | null = null;
  for (const v of values) {
    const ms = toMs(v);
    if (ms !== null && (best === null || ms < best)) best = ms;
  }
  return best === null ? undefined : new Date(best).toISOString();
}

/** Earliest real evidence of play (first session or first move into Playing), or undefined. */
export function firstPlayEvidenceIso(gameId: string): string | undefined {
  const firstSession = sessionStore.getFirstSessionStart(gameId);
  const firstPlaying = statusHistoryStore.getFirstPlayingTransition(gameId);
  return earliestIso(firstSession > 0 ? firstSession : null, firstPlaying);
}

/** First-played date for a journey row: real evidence when there is any, else `fallback`. */
export function resolveFirstPlayedAt(gameId: string, fallback: string): string {
  return firstPlayEvidenceIso(gameId) ?? fallback;
}
