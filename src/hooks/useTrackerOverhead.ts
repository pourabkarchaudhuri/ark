/**
 * useTrackerOverhead
 *
 * React hook that subscribes a component to the renderer-side tracker
 * overhead ring buffer. When `gameId` is provided, samples are filtered
 * to that game; otherwise the full buffer is returned.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  trackerOverheadStore,
  type OverheadSample,
} from '../services/tracker-overhead-store';

const EMPTY: readonly OverheadSample[] = Object.freeze([]);

function getServerSnapshot(): readonly OverheadSample[] {
  return EMPTY;
}

export function useTrackerOverhead(gameId?: string): OverheadSample[] {
  const subscribe = useCallback(
    (listener: () => void) => trackerOverheadStore.subscribe(listener),
    [],
  );

  const getSnapshot = useCallback(
    () => trackerOverheadStore.getAll(),
    [],
  );

  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return useMemo(() => {
    if (!gameId) {
      return all as OverheadSample[];
    }
    const out: OverheadSample[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const s = all[i];
      if (s.gameId === gameId) {
        out.push(s);
      }
    }
    return out;
  }, [all, gameId]);
}

export type { OverheadSample };
