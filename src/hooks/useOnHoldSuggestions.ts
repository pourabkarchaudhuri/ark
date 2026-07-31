import { useEffect, useState } from 'react';
import { libraryStore } from '@/services/library-store';

/**
 * useOnHoldSuggestions (v1.0.41)
 *
 * Purely-derived suggestion list: library entries whose status is "Playing" but
 * that have been untouched for more than 14 days. The UI can surface these as
 * gentle "move to On Hold?" nudges. Nothing is persisted — the list is recomputed
 * on demand from live libraryStore state.
 *
 * Refresh triggers:
 *   1. libraryStore subscription — reruns immediately when the library mutates.
 *   2. A 60-second interval — catches entries that cross the 14-day boundary
 *      while the app is left open (time-based staleness).
 */

/** Suggestion payload — one entry per stale "Playing" game. */
export interface OnHoldSuggestion {
  gameId: string;
  lastPlayedAt: string;
  daysStale: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = 14 * DAY_MS;
const REFRESH_INTERVAL_MS = 60_000;

function computeSuggestions(now: number = Date.now()): OnHoldSuggestion[] {
  const out: OnHoldSuggestion[] = [];
  for (const entry of libraryStore.getAllEntries()) {
    if (entry.status !== 'Playing') continue;
    if (!entry.lastPlayedAt) continue;
    const last = Date.parse(entry.lastPlayedAt);
    if (Number.isNaN(last)) continue;
    const elapsed = now - last;
    if (elapsed <= STALE_THRESHOLD_MS) continue;
    out.push({
      gameId: entry.gameId,
      lastPlayedAt: entry.lastPlayedAt,
      daysStale: Math.floor(elapsed / DAY_MS),
    });
  }
  return out;
}

export function useOnHoldSuggestions(): OnHoldSuggestion[] {
  const [suggestions, setSuggestions] = useState<OnHoldSuggestion[]>(() => computeSuggestions());

  useEffect(() => {
    const refresh = () => setSuggestions(computeSuggestions());

    // Immediate refresh on any library mutation.
    const unsubscribe = libraryStore.subscribe(refresh);

    // Time-based refresh so entries flip into the suggestion list even when the
    // library itself hasn't changed.
    const intervalId = window.setInterval(refresh, REFRESH_INTERVAL_MS);

    return () => {
      unsubscribe();
      window.clearInterval(intervalId);
    };
  }, []);

  return suggestions;
}
