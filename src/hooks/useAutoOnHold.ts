import { useEffect, useRef } from 'react';
import { libraryStore, type LibraryEntryWithStatusStamp } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { sessionStore } from '@/services/session-store';
import { useOptionalToast } from '@/components/ui/toast';
import { getAutoOnHoldEnabled } from '@/lib/auto-status-settings';
import { isAutoHeld } from '@/lib/status-source';
import type { GameStatus } from '@/types/game';

/**
 * useAutoOnHold (v1.0.42; 4 weeks since v1.0.88)
 *
 * Periodic sweep that moves games marked "Playing" that have not been played for 4 weeks into
 * "On Hold" — library and custom games alike.
 *
 * Rules:
 *   - Only "Playing" is touched (and a stored "Playing Now" left behind by a crash, when the game is
 *     not actually running). Games running right now are never touched.
 *   - Staleness is measured from the MOST RECENT of: `lastPlayedAt`, the end of the latest recorded
 *     play session, the entry's `statusChangedAt` stamp (so setting a game to Playing restarts the
 *     clock), the latest status-history transition into Playing / Playing Now, `addedAt`, and the
 *     last library import (an import is not "4 weeks without play").
 *   - The history row is tagged `source: 'auto-hold'`; one toast lists the games, with Undo.
 *   - `lastPlayedAt` is NEVER overwritten. Waits for the stores to hydrate; skips read-only stores.
 *   - Switch: Settings → Application → "Auto On Hold" (localStorage, default ON).
 *
 * Triggers: once at mount (app startup), then every 60 minutes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const ON_HOLD_THRESHOLD_DAYS = 28;
const ON_HOLD_THRESHOLD_MS = ON_HOLD_THRESHOLD_DAYS * DAY_MS;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

/** Set by a library import (libraryStore.importData) so imported Playing games get a fresh 4 weeks. */
export const LIBRARY_IMPORTED_AT_LS_KEY = 'ark:libraryImportedAt';

/**
 * Read the `autoOnHoldTransition` switch. An explicit choice in localStorage (the Settings toggle)
 * wins; otherwise the main-process settings bridge if one exists; otherwise ON. Never throws.
 */
export async function isAutoOnHoldTransitionEnabled(): Promise<boolean> {
  try {
    const raw = window.localStorage?.getItem('ark:autoOnHoldTransition');
    if (raw === 'true' || raw === 'false') return raw === 'true';
  } catch {
    /* fall through */
  }
  try {
    const bridge = (window as unknown as {
      settings?: { getAutoOnHoldTransition?: () => Promise<boolean> | boolean };
    }).settings;
    if (bridge && typeof bridge.getAutoOnHoldTransition === 'function') {
      return (await bridge.getAutoOnHoldTransition()) !== false;
    }
  } catch {
    /* fall through */
  }
  return getAutoOnHoldEnabled();
}

const PLAYING_STATUSES = ['Playing', 'Playing Now'] as const;

/** Coerce an entry's `addedAt` (which may be a Date OR an ISO string after rehydration). */
function toMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function lastSessionEndMs(gameId: string): number | null {
  let latest: number | null = null;
  for (const s of sessionStore.getForGame(gameId)) {
    const end = toMs(s.endTime) ?? toMs(s.startTime);
    if (end !== null && (latest === null || end > latest)) latest = end;
  }
  return latest;
}

function libraryImportedAtMs(): number | null {
  try {
    return toMs(window.localStorage?.getItem(LIBRARY_IMPORTED_AT_LS_KEY) ?? null);
  } catch {
    return null;
  }
}

export interface AutoHeldGame {
  gameId: string;
  title: string;
  custom: boolean;
}

export interface SweepOptions {
  /** Games running right now (never moved). */
  isLive?: (gameId: string) => boolean;
}

function isStalePlaying(
  gameId: string,
  status: GameStatus,
  dates: unknown[],
  now: number,
  opts: SweepOptions,
): boolean {
  if (status !== 'Playing' && status !== 'Playing Now') return false;
  if (opts.isLive?.(gameId)) return false;
  const candidates = [
    ...dates.map(toMs),
    lastSessionEndMs(gameId),
    statusHistoryStore.getLatestTransitionInto(gameId, PLAYING_STATUSES),
    libraryImportedAtMs(),
  ].filter((v): v is number => v !== null && Number.isFinite(v));
  if (candidates.length === 0) return false;
  let referenceMs = candidates[0];
  for (const c of candidates) if (c > referenceMs) referenceMs = c;
  return now - referenceMs >= ON_HOLD_THRESHOLD_MS;
}

/**
 * Single sweep. Returns the games it moved to On Hold. Public for testing; the hook wires the timer.
 */
export async function runAutoOnHoldSweep(now: number = Date.now(), opts: SweepOptions = {}): Promise<AutoHeldGame[]> {
  const moved: AutoHeldGame[] = [];
  try {
    const enabled = await isAutoOnHoldTransitionEnabled();
    if (!enabled) return moved;

    // Never judge staleness against a half-hydrated view: the status history
    // (our record of "user set this to Playing on <date>") loads async.
    await Promise.all([
      libraryStore.ready.catch(() => undefined),
      customGameStore.ready.catch(() => undefined),
      statusHistoryStore.ready().catch(() => undefined),
    ]);

    if (!libraryStore.isReadOnly()) {
      for (const entry of libraryStore.getAllEntries() as LibraryEntryWithStatusStamp[]) {
        if (!isStalePlaying(entry.gameId, entry.status, [entry.lastPlayedAt, entry.statusChangedAt, entry.addedAt], now, opts)) continue;
        // Do NOT touch lastPlayedAt — preserve the real last-play date.
        libraryStore.updateEntry(entry.gameId, {
          status: 'On Hold',
          autoTransitionedAt: new Date(now).toISOString(),
        }, { source: 'auto-hold' });
        moved.push({ gameId: entry.gameId, title: entry.cachedMeta?.title?.trim() || entry.gameId, custom: false });
      }
    }

    if (!customGameStore.isReadOnly()) {
      for (const game of customGameStore.getAllGames()) {
        if (!isStalePlaying(game.id, game.status, [game.lastPlayedAt, game.addedAt], now, opts)) continue;
        customGameStore.updateGame(game.id, { status: 'On Hold' }, { source: 'auto-hold' });
        moved.push({ gameId: game.id, title: game.title, custom: true });
      }
    }

    for (const g of moved) {
      console.log(`[useAutoOnHold] Moved ${g.gameId} to On Hold: no play for ${ON_HOLD_THRESHOLD_DAYS}+ days`);
    }
  } catch (err) {
    // A failed sweep must never surface as an error toast; try again next tick.
    console.warn('[useAutoOnHold] sweep skipped:', err);
  }
  return moved;
}

/** Undo an automatic hold: back to Playing (tagged `undo`, which also restarts the 4 weeks). */
export function undoAutoHold(games: readonly AutoHeldGame[]): number {
  let restored = 0;
  for (const g of games) {
    if (g.custom) {
      const cur = customGameStore.getGame(g.gameId);
      if (cur?.status !== 'On Hold') continue;
      customGameStore.updateGame(g.gameId, { status: 'Playing' }, { source: 'undo' });
    } else {
      const cur = libraryStore.getEntry(g.gameId);
      if (cur?.status !== 'On Hold') continue;
      libraryStore.updateEntry(g.gameId, { status: 'Playing' }, { source: 'undo' });
    }
    restored++;
  }
  return restored;
}

/**
 * When a real play session ends on a game the idle sweep put On Hold, it is being played again:
 * move it back to Playing. A game the user put On Hold themselves is never touched.
 */
export async function maybeResumeAutoHeld(gameId: string): Promise<boolean> {
  try {
    if (!(await isAutoOnHoldTransitionEnabled())) return false;
    const custom = gameId.startsWith('custom-');
    const status = custom ? customGameStore.getGame(gameId)?.status : libraryStore.getEntry(gameId)?.status;
    if (status !== 'On Hold') return false;
    if (!isAutoHeld(statusHistoryStore.getForGame(gameId))) return false;
    if (custom) customGameStore.updateGame(gameId, { status: 'Playing' }, { source: 'auto-promote' });
    else libraryStore.updateEntry(gameId, { status: 'Playing', autoTransitionedAt: new Date().toISOString() }, { source: 'auto-promote' });
    console.log(`[useAutoOnHold] ${gameId} was played again: back to Playing`);
    return true;
  } catch (err) {
    console.warn('[useAutoOnHold] resume skipped:', err);
    return false;
  }
}

function describeMoved(moved: readonly AutoHeldGame[]): string {
  const names = moved.slice(0, 3).map(g => g.title).join(', ');
  const more = moved.length > 3 ? ` and ${moved.length - 3} more` : '';
  return moved.length === 1
    ? `${names} moved to On Hold: not played for 4 weeks.`
    : `${moved.length} games moved to On Hold after 4 weeks without play: ${names}${more}.`;
}

/**
 * useAutoOnHold — mounts the periodic Playing → On Hold sweep. Invoke this once from a component that
 * lives at the app root (SessionTrackerProvider does). `liveGames` is a ref to the set of games
 * running right now.
 */
export function useAutoOnHold(liveGames?: { readonly current: ReadonlySet<string> }): void {
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const sweep = async () => {
      const moved = await runAutoOnHoldSweep(Date.now(), { isLive: (id) => liveGames?.current.has(id) ?? false });
      if (moved.length === 0) return;
      toastRef.current?.addToast(describeMoved(moved), 'info', 15_000, {
        label: 'Undo',
        onClick: () => { undoAutoHold(moved); },
      });
    };
    // Kick a sweep on startup so long-idle games get flipped immediately.
    void sweep();
    // Time-based sweep so entries flip as they cross the 4-week boundary during a long session.
    const intervalId = window.setInterval(() => { void sweep(); }, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  // liveGames is a ref; reading .current at sweep time is intended.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
