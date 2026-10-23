/**
 * Ark Wrapped — seasonal surfacing.
 *
 * `WrappedSnackbar` (name kept for dashboard compatibility) renders:
 *  1. An in-app banner during the Wrapped season (Dec 15 → Jan 2, see
 *     src/lib/wrapped-season.ts). Dismissing it or opening Wrapped marks the
 *     season's year as seen, so it never nags again that season.
 *  2. One desktop notification per season (keyed by year) while the app is
 *     running in season. Clicking it focuses the window and opens Wrapped.
 *     Skipped when the OS / user has denied notifications, or when the user
 *     already opened Wrapped (or dismissed the banner) this season.
 *
 * The season is re-evaluated every 30 minutes and when the window regains
 * focus, so an app left running in the tray from Dec 14 picks it up on Dec 15.
 *
 * Testing before December: localStorage.setItem('ark-wrapped-force-season', 'always')
 * then reload (see wrapped-season.ts for all options).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import {
  WRAPPED_SEEN_EVENT, bannerYear, defaultStorage, markWrappedNotified, markWrappedSeen,
  notificationYear, readForceMode, type NotificationPermissionLike,
} from '@/lib/wrapped-season';
import './wrapped.css';

const BANNER_DELAY_MS = 2500;
const NOTIFY_DELAY_MS = 8000;
const RECHECK_MS = 30 * 60_000;

/** At most one desktop notification per app run (matters for the 'always' dev override). */
let notifiedThisSession = false;

function currentPermission(): NotificationPermissionLike {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return (window.Notification.permission as NotificationPermissionLike) || 'default';
  } catch {
    return 'unsupported';
  }
}

async function ensurePermission(): Promise<NotificationPermissionLike> {
  const p = currentPermission();
  if (p !== 'default') return p;
  try {
    return (await window.Notification.requestPermission()) as NotificationPermissionLike;
  } catch {
    return 'denied';
  }
}

/** Show the once-per-season desktop notification. Returns true when shown. */
export async function sendWrappedNotification(year: number, onClick: () => void): Promise<boolean> {
  const permission = await ensurePermission();
  if (permission !== 'granted') return false;
  try {
    const n = new window.Notification(`Ark Wrapped ${year} is here`, {
      body: 'Your year in games is ready — top titles, marathon sessions and the player you became.',
      tag: `ark-wrapped-${year}`,
      silent: false,
    });
    n.onclick = () => {
      // window.focus() can't raise a window hidden in the tray — ask main to show it
      try { void window.electron?.showAndFocus?.(); window.focus(); } catch { /* ignore */ }
      onClick();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

export function WrappedSnackbar({ onLaunch }: { onLaunch: () => void }) {
  const [year, setYear] = useState<number | null>(null);
  const reduced = useReducedMotion();
  const onLaunchRef = useRef(onLaunch);
  onLaunchRef.current = onLaunch;
  const notifyPendingRef = useRef(false);
  const notifyTimerRef = useRef<number | null>(null);

  const evaluate = useCallback(() => {
    const now = new Date();
    const force = readForceMode();
    const storage = defaultStorage();
    setYear(bannerYear(now, storage, force));

    const nYear = notificationYear(now, storage, currentPermission(), force);
    if (nYear != null && !notifyPendingRef.current && !notifiedThisSession) {
      notifyPendingRef.current = true;
      notifyTimerRef.current = window.setTimeout(() => {
        notifyTimerRef.current = null;
        // Re-check: the user may have opened Wrapped in the meantime.
        const again = notificationYear(new Date(), defaultStorage(), currentPermission(), readForceMode());
        if (again == null) { notifyPendingRef.current = false; return; }
        notifiedThisSession = true;
        void sendWrappedNotification(again, () => onLaunchRef.current()).finally(() => {
          // Mark even when permission was refused so we never prompt again this season.
          markWrappedNotified(again);
        });
      }, NOTIFY_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(evaluate, BANNER_DELAY_MS);
    const interval = window.setInterval(evaluate, RECHECK_MS);
    const onFocus = () => evaluate();
    const onSeen = () => setYear(null);
    window.addEventListener('focus', onFocus);
    window.addEventListener(WRAPPED_SEEN_EVENT, onSeen);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      // An unfired notification must not call a stale onLaunch after unmount
      if (notifyTimerRef.current != null) { window.clearTimeout(notifyTimerRef.current); notifyTimerRef.current = null; notifyPendingRef.current = false; }
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(WRAPPED_SEEN_EVENT, onSeen);
    };
  }, [evaluate]);

  const dismiss = useCallback(() => {
    if (year != null) markWrappedSeen(year);
    setYear(null);
  }, [year]);

  const launch = useCallback(() => {
    if (year != null) markWrappedSeen(year);
    setYear(null);
    onLaunch();
  }, [year, onLaunch]);

  return (
    <AnimatePresence>
      {year != null && (
        <motion.div
          key="wrapped-banner"
          role="region"
          aria-label={`Ark Wrapped ${year}`}
          initial={{ opacity: 0, y: reduced ? 0 : 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : 16 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          // Centred with margins (not translate classes) — framer-motion owns `transform` here.
          className="fixed bottom-5 inset-x-0 mx-auto z-[150] w-[min(560px,calc(100vw-2rem))]"
        >
          <div className="relative overflow-hidden rounded-2xl border border-fuchsia-400/25 bg-[#0b0716]/95 shadow-[0_18px_50px_-12px_rgba(168,85,247,0.45)]">
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ backgroundImage: 'radial-gradient(60% 120% at 0% 50%, rgba(139,92,246,0.28), transparent 70%), radial-gradient(50% 120% at 100% 50%, rgba(6,182,212,0.16), transparent 70%)' }}
              aria-hidden
            />
            <div className="absolute inset-y-0 left-0 w-1/3 pointer-events-none wr-banner-sheen" aria-hidden
              style={{ background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.07), transparent)' }} />
            <div className="relative flex items-center gap-4 p-4 pr-3">
              <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-semibold leading-tight">
                  Ark Wrapped <span className="font-display">{year}</span> is here
                </p>
                <p className="text-white/50 text-xs mt-1 leading-snug">
                  Your year in games — top titles, marathon sessions and the player you became.
                </p>
              </div>
              <button
                type="button"
                onClick={launch}
                className="shrink-0 h-9 px-4 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
              >
                Open Wrapped
              </button>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                title="Dismiss"
                className="shrink-0 w-8 h-8 rounded-full text-white/35 hover:text-white/80 hover:bg-white/10 flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
