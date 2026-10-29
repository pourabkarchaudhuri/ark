import { useEffect, useState } from 'react';
import type { HltbTimes } from '@/types/hltb';

/** Settings switch for HowLongToBeat lookups (game titles are sent to howlongtobeat.com). */
export const HLTB_ENABLED_LS_KEY = 'ark:hltbEnabled';

export function isHltbEnabled(): boolean {
  try {
    return window.localStorage?.getItem(HLTB_ENABLED_LS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setHltbEnabled(enabled: boolean): void {
  try {
    window.localStorage?.setItem(HLTB_ENABLED_LS_KEY, enabled ? 'true' : 'false');
  } catch {
    /* storage unavailable: the default applies */
  }
}

/** First 4-digit year in a release-date string ("Oct 25, 2019", "2019-10-25"), if any. */
export function releaseYearOf(date: string | undefined | null): number | undefined {
  const m = /\b(19[7-9]\d|20\d\d)\b/.exec(date ?? '');
  return m ? Number(m[1]) : undefined;
}

export type HltbState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; times: HltbTimes }
  | { status: 'none' };

/** HowLongToBeat times for a game (never blocks the page; hidden when off, offline or unmatched). */
export function useHltbTimes(title: string | undefined, year: number | undefined): HltbState {
  const [state, setState] = useState<HltbState>({ status: 'idle' });

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.hltb : undefined;
    if (!title || !bridge || typeof bridge.getTimes !== 'function' || !isHltbEnabled()) {
      setState({ status: 'idle' });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState({ status: 'none' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    bridge.getTimes({ title, year })
      .then((times) => {
        if (cancelled) return;
        setState(times ? { status: 'ready', times } : { status: 'none' });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'none' });
      });
    return () => { cancelled = true; };
  }, [title, year]);

  return state;
}
