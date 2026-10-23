/**
 * Ark Wrapped — the year-in-review overlay.
 *
 * Structure (src/components/year-wrapped/):
 *   stats.ts       pure statistics (unit tested)      data.ts       store glue
 *   slides.tsx     slide components + slide list      primitives.tsx shared visuals
 *   flythrough.ts  Galaxy handoff ('ark.flythrough.pending')
 *   banner.tsx     seasonal banner + desktop notification (WrappedSnackbar)
 *   wrapped.css    transform/opacity-only animations
 *
 * Performance notes:
 *  - Nothing is computed while closed. Stats are computed once per open (and
 *    per year switch) in an idle callback, with a short loading state.
 *  - Only the active slide is mounted (plus the outgoing one during the
 *    crossfade). Slide entrances are CSS keyframes on transform/opacity.
 *  - No per-frame React state: counters write textContent from one rAF loop,
 *    auto-advance is driven by the progress bar's CSS animation.
 *  - Ambient background = two pre-rendered star tiles drifting via transform
 *    plus a crossfading aurora gradient. No blur filters, no DOM particles.
 *  - prefers-reduced-motion disables decorative motion and slide sliding.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import confetti from 'canvas-confetti';
import { cn } from '@/lib/utils';
import {
  canGoNext, canGoPrev, clampSlide, resolveKeyNavAction, resolveSwipeNavAction, resolveTapNavAction,
  type TapNavAction,
} from '@/lib/year-wrapped-nav';
import { defaultWrappedYear, markWrappedSeen, readForceMode, resolveWrappedSeason } from '@/lib/wrapped-season';
import { computeWrappedBundle } from '@/components/year-wrapped/data';
import type { WrappedStats } from '@/components/year-wrapped/stats';
import { buildSlideList, WrappedActionsContext, type SlideDef, type WrappedActions } from '@/components/year-wrapped/slides';
import { Aurora, Starfield, WrappedMotionContext, preloadCovers } from '@/components/year-wrapped/primitives';
import { buildFlythroughKeyframes, stashFlythrough } from '@/components/year-wrapped/flythrough';
import '@/components/year-wrapped/wrapped.css';

export { buildFlythroughKeyframes } from '@/components/year-wrapped/flythrough';
export { WrappedSnackbar } from '@/components/year-wrapped/banner';
export { computeStats } from '@/components/year-wrapped/data';
export type { WrappedStats } from '@/components/year-wrapped/stats';

interface YearWrappedProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional. When provided, the finale slide offers a Galaxy flythrough.
   *  Caller is responsible for navigating to the Galaxy view after the callback fires.
   *  Keyframes are stashed in localStorage at `ark.flythrough.pending`. */
  onLaunchFlythrough?: () => void;
}

const AUTOPLAY_KEY = 'ark-wrapped-autoplay';
// Export renders a 540×675 "phone card" and captures it at 2× → 1080×1350 PNGs (4:5, social-friendly).
const EXPORT_W = 540;
const EXPORT_H = 675;
const EXPORT_SCALE = 2;
const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function readAutoplay(): boolean {
  try {
    const v = localStorage.getItem(AUTOPLAY_KEY);
    return v == null ? true : v === '1';
  } catch {
    return true;
  }
}

function scheduleIdle(fn: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout: 250 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 16);
  return () => window.clearTimeout(id);
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function waitForImages(root: HTMLElement, timeoutMs: number) {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.race([
    Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise<void>((r) => {
      img.addEventListener('load', () => r(), { once: true });
      img.addEventListener('error', () => r(), { once: true });
    })))),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function buildShareText(stats: WrappedStats): string {
  return [
    `My ${stats.year} in games — Ark Wrapped`,
    '',
    `${Math.round(stats.totalHoursPlayed)} hours played`,
    `${stats.gamesPlayed} games played · ${stats.gamesCompleted} completed`,
    stats.topGame ? `#1: ${stats.topGame.title} (${Math.round(stats.topGame.hours)}h)` : '',
    stats.topGenre ? `Favourite genre: ${stats.topGenre}` : '',
    stats.longestStreak > 1 ? `Best streak: ${stats.longestStreak} days` : '',
    `I was ${stats.gamerTitle}.`,
    '',
    '#ArkWrapped',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ─── Public component ───────────────────────────────────────────────────────

export const YearWrapped = memo(function YearWrapped({ isOpen, onClose, onLaunchFlythrough }: YearWrappedProps) {
  // The overlay only exists while open: no stats work at app start-up, fresh
  // data on every open, and AnimatePresence can play the exit fade.
  return (
    <AnimatePresence>
      {isOpen && <WrappedOverlay key="ark-wrapped" onClose={onClose} onLaunchFlythrough={onLaunchFlythrough} />}
    </AnimatePresence>
  );
});

// ─── Overlay ────────────────────────────────────────────────────────────────

type Bundle = { stats: WrappedStats; years: number[] };

function WrappedOverlay({ onClose, onLaunchFlythrough }: Omit<YearWrappedProps, 'isOpen'>) {
  const reduced = !!useReducedMotion();
  const [year, setYear] = useState(() => defaultWrappedYear(new Date()));
  const [bundles, setBundles] = useState<Record<number, Bundle>>({});
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [autoplay, setAutoplay] = useState(() => readAutoplay() && !reduced);
  const [hidden, setHidden] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportSlide, setExportSlide] = useState<SlideDef | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportNodeRef = useRef<HTMLDivElement>(null);
  const confettiRef = useRef<ReturnType<typeof confetti.create> | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const navLockRef = useRef(-Infinity);
  const mountedRef = useRef(true);
  const celebratedRef = useRef<Set<string>>(new Set());

  const bundle = bundles[year];
  const stats = bundle?.stats ?? null;
  const slides = useMemo(() => (stats ? buildSlideList(stats) : []), [stats]);
  const total = slides.length;
  const slide = slides[clampSlide(index, total)] as SlideDef | undefined;
  const exporting = exportProgress != null;
  const canFlythrough = useMemo(
    () => !!stats && !!onLaunchFlythrough && buildFlythroughKeyframes(stats).length >= 2,
    [stats, onLaunchFlythrough],
  );
  // Remember the selectable years so the year chips don't flicker while a new year loads.
  const [years, setYears] = useState<number[]>([]);
  useEffect(() => { if (bundle) setYears(bundle.years); }, [bundle]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try { confettiRef.current?.reset(); } catch { /* ignore */ }
    };
  }, []);

  // Opening Wrapped during the season counts as "seen" — the banner stops nagging.
  useEffect(() => {
    const season = resolveWrappedSeason(new Date(), readForceMode());
    if (season) markWrappedSeen(season.year);
  }, []);

  // Compute stats off the critical render path (idle callback), once per year per open.
  useEffect(() => {
    if (bundles[year]) return;
    return scheduleIdle(() => {
      let next: Bundle;
      try {
        next = computeWrappedBundle(year, new Date());
      } catch (err) {
        console.error('[ArkWrapped] Failed to compute stats:', err);
        return;
      }
      if (mountedRef.current) setBundles((b) => ({ ...b, [year]: next }));
    });
  }, [year, bundles]);

  // Focus management: take focus on open, give it back on close.
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { try { prev?.focus?.({ preventScroll: true }); } catch { /* element gone */ } };
  }, []);

  // Pause auto-advance while the window is hidden.
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const toastTimer = useRef<number>();
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => { if (mountedRef.current) setToast(null); }, 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // ── Navigation ──
  const goTo = useCallback((target: number, dir?: number) => {
    if (exporting || total === 0) return;
    const now = performance.now();
    if (now - navLockRef.current < 160) return; // swallow key-repeat bursts
    navLockRef.current = now;
    const next = clampSlide(target, total);
    if (next === index) return;
    setDirection(dir ?? (next > index ? 1 : -1));
    setIndex(next);
  }, [exporting, total, index]);

  const applyNav = useCallback((action: TapNavAction) => {
    if (action === 'next') goTo(index + 1, 1);
    else if (action === 'prev') goTo(index - 1, -1);
  }, [goTo, index]);

  const toggleAutoplay = useCallback(() => {
    setAutoplay((a) => {
      const next = !a;
      try { localStorage.setItem(AUTOPLAY_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Keyboard: capture phase so dashboard shortcuts underneath never see these keys.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      // Let focused buttons handle Enter/Space natively.
      if ((e.key === 'Enter' || e.key === ' ') && (tag === 'BUTTON' || tag === 'A')) return;
      const action = resolveKeyNavAction(e.key);
      if (action === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'close') { if (!exporting) onClose(); return; }
      if (action === 'toggle-autoplay') { toggleAutoplay(); return; }
      if (action === 'first') { goTo(0, -1); return; }
      if (action === 'last') { goTo(total - 1, 1); return; }
      applyNav(action === 'next'
        ? (canGoNext(index, total) ? 'next' : 'none')
        : (canGoPrev(index) ? 'prev' : 'none'));
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [applyNav, goTo, index, total, onClose, toggleAutoplay, exporting]);

  // Year switch → restart at the intro.
  const selectYear = useCallback((y: number) => {
    if (y === year || exporting) return;
    setDirection(0);
    setIndex(0);
    setYear(y);
  }, [year, exporting]);

  // Preload the next slide's covers only.
  useEffect(() => {
    if (!stats) return;
    const next = slides[index + 1];
    if (next?.covers) preloadCovers(next.covers(stats));
  }, [stats, slides, index]);

  // Celebrate on the intro and the finale (once each per open), never when reduced/exporting.
  useEffect(() => {
    if (!slide || reduced || exporting) return;
    if (slide.id !== 'intro' && slide.id !== 'finale') return;
    const key = `${year}:${slide.id}`;
    if (celebratedRef.current.has(key)) return;
    const timer = window.setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      celebratedRef.current.add(key);
      try {
        if (!confettiRef.current) {
          try {
            confettiRef.current = confetti.create(canvas, { resize: true, useWorker: true, disableForReducedMotion: true });
          } catch {
            confettiRef.current = confetti.create(canvas, { resize: true, useWorker: false, disableForReducedMotion: true });
          }
        }
        const fire = confettiRef.current;
        const colors = ['#a78bfa', '#f0abfc', '#67e8f9', '#f472b6', '#fde68a'];
        if (slide.id === 'intro') {
          void fire({ particleCount: 60, spread: 80, startVelocity: 38, origin: { y: 0.62 }, colors, ticks: 180, scalar: 0.9 });
        } else {
          void fire({ particleCount: 55, angle: 60, spread: 70, origin: { x: 0, y: 0.7 }, colors, ticks: 200, scalar: 0.9 });
          void fire({ particleCount: 55, angle: 120, spread: 70, origin: { x: 1, y: 0.7 }, colors, ticks: 200, scalar: 0.9 });
        }
      } catch { /* confetti is decorative */ }
    }, slide.id === 'intro' ? 900 : 600);
    return () => window.clearTimeout(timer);
  }, [slide, year, reduced, exporting]);

  // ── Share / export / flythrough ──
  const handleShare = useCallback(async (platform: 'twitter' | 'reddit' | 'whatsapp' | 'copy') => {
    if (!stats) return;
    const text = buildShareText(stats);
    const enc = encodeURIComponent(text);
    switch (platform) {
      case 'twitter':
        window.open(`https://twitter.com/intent/tweet?text=${enc}`, '_blank', 'noopener');
        break;
      case 'reddit':
        window.open(`https://www.reddit.com/submit?title=${encodeURIComponent(`My ${stats.year} in games — Ark Wrapped`)}&selftext=true&text=${enc}`, '_blank', 'noopener');
        break;
      case 'whatsapp':
        window.open(`https://wa.me/?text=${enc}`, '_blank', 'noopener');
        break;
      case 'copy':
        showToast((await copyText(text)) ? 'Summary copied to clipboard' : 'Couldn’t copy — try again');
        break;
    }
  }, [stats, showToast]);

  const handleSaveImages = useCallback(async () => {
    if (!stats || exporting || slides.length === 0) return;
    const [{ toBlob, getFontEmbedCSS }, { default: JSZip }, { saveAs }] = await Promise.all([
      import('html-to-image'),
      import('jszip'),
      import('file-saver'),
    ]);
    const zip = new JSZip();
    let fontCSS: string | null = null;
    let saved = 0;
    try {
      for (let i = 0; i < slides.length; i++) {
        if (!mountedRef.current) return;
        setExportProgress({ current: i + 1, total: slides.length });
        setExportSlide(slides[i]);
        await nextFrame();
        await nextFrame();
        const node = exportNodeRef.current;
        if (!node || !mountedRef.current) return;
        await waitForImages(node, 3000);
        if (fontCSS == null) {
          try { fontCSS = await withTimeout(getFontEmbedCSS(node), 6000); } catch { fontCSS = ''; }
        }
        try {
          const blob = await toBlob(node, {
            width: EXPORT_W,
            height: EXPORT_H,
            pixelRatio: EXPORT_SCALE,
            cacheBust: false,
            backgroundColor: '#05030c',
            imagePlaceholder: TRANSPARENT_PX,
            ...(fontCSS ? { fontEmbedCSS: fontCSS } : { skipFonts: true }),
          });
          if (blob) {
            zip.file(`ark-wrapped-${stats.year}-${String(i + 1).padStart(2, '0')}-${slides[i].id}.png`, blob);
            saved++;
          }
        } catch (err) {
          console.warn('[ArkWrapped] Could not capture slide', slides[i].id, err);
        }
      }
      if (!mountedRef.current) return;
      if (saved === 0) {
        showToast('Couldn’t save images — please try again');
        return;
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `ark-wrapped-${stats.year}.zip`);
      showToast(`Saved ${saved} ${saved === 1 ? 'image' : 'images'}`);
    } catch (err) {
      console.error('[ArkWrapped] Export failed:', err);
      if (mountedRef.current) showToast('Couldn’t save images — please try again');
    } finally {
      if (mountedRef.current) {
        setExportSlide(null);
        setExportProgress(null);
      }
    }
  }, [stats, slides, exporting, showToast]);

  const handleFlythrough = useCallback(() => {
    if (!stats || !onLaunchFlythrough) return;
    stashFlythrough(stats);
    onLaunchFlythrough();
    onClose();
  }, [stats, onLaunchFlythrough, onClose]);

  const actions = useMemo<WrappedActions>(() => ({
    onSaveImages: () => { void handleSaveImages(); },
    onShare: (p) => { void handleShare(p); },
    onLaunchFlythrough: canFlythrough ? handleFlythrough : undefined,
    exportProgress,
  }), [handleSaveImages, handleShare, canFlythrough, handleFlythrough, exportProgress]);

  const liveMotion = useMemo(() => ({ animate: !reduced, exporting: false }), [reduced]);
  const exportMotion = useMemo(() => ({ animate: false, exporting: true }), []);

  const isFirst = index === 0;
  const isLast = total > 0 && index === total - 1;
  const paused = !autoplay || hidden || exporting;
  const variants = useMemo(() => ({
    enter: (dir: number) => ({ opacity: 0, x: reduced ? 0 : dir * 56 }),
    center: { opacity: 1, x: 0 },
    exit: (dir: number) => ({ opacity: 0, x: reduced ? 0 : dir * -56 }),
  }), [reduced]);

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Ark Wrapped ${year}`}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="wr-root fixed inset-0 z-[200] flex flex-col select-none outline-none text-white"
      onClick={(e) => {
        if (exporting) return;
        if ((e.target as HTMLElement).closest('[data-wrapped-interactive]')) return;
        const rect = e.currentTarget.getBoundingClientRect();
        applyNav(resolveTapNavAction(e.clientX, rect.left, rect.width, index, total));
      }}
      onTouchStart={(e) => { touchStartXRef.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const start = touchStartXRef.current;
        touchStartXRef.current = null;
        if (exporting || start == null) return;
        if ((e.target as HTMLElement).closest('[data-wrapped-interactive]')) return;
        const end = e.changedTouches[0]?.clientX;
        if (end == null) return;
        applyNav(resolveSwipeNavAction(start, end, index, total));
      }}
    >
      {/* Ambient background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
        <AnimatePresence initial={false}>
          <motion.div
            key={slide?.id ?? 'loading'}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: 'easeInOut' }}
          >
            <Aurora id={slide?.id ?? 'intro'} />
          </motion.div>
        </AnimatePresence>
        <Starfield />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55))' }} />
      </div>

      {/* Confetti renders into our own canvas (above slides, below chrome). */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-[30]" aria-hidden />

      {/* Top chrome */}
      <div data-wrapped-interactive className="absolute top-0 inset-x-0 z-50 flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-2">
        <div className="flex items-center gap-1.5 min-w-0" role="tablist" aria-label="Year">
          {years.length > 1 && years.map((y) => (
            <button
              key={y}
              type="button"
              role="tab"
              aria-selected={y === year}
              onClick={(e) => { e.stopPropagation(); selectYear(y); }}
              disabled={exporting}
              className={cn(
                'h-8 px-3 rounded-full text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300',
                y === year
                  ? 'bg-fuchsia-500/20 text-fuchsia-100 border-fuchsia-400/40'
                  : 'bg-white/[0.04] text-white/45 border-white/10 hover:text-white/80 hover:bg-white/[0.08]',
              )}
            >
              {y}
            </button>
          ))}
        </div>
        <p className="hidden sm:block absolute left-1/2 -translate-x-1/2 text-white/30 text-[10px] font-bold tracking-[0.42em] uppercase pointer-events-none font-display">
          Ark Wrapped
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          {total > 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleAutoplay(); }}
              aria-label={autoplay ? 'Pause auto-advance' : 'Play auto-advance'}
              title={autoplay ? 'Pause (Space)' : 'Auto-advance (Space)'}
              className="w-9 h-9 rounded-full bg-white/[0.05] border border-white/10 text-white/60 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
            >
              {autoplay ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (!exporting) onClose(); }}
            aria-label="Close Ark Wrapped"
            title="Close (Esc)"
            className="h-9 pl-3 pr-3.5 rounded-full bg-white/[0.05] border border-white/10 text-white/60 hover:text-white hover:bg-white/10 flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
          >
            <X className="w-4 h-4" />
            <span className="text-xs font-medium">Close</span>
          </button>
        </div>
      </div>

      {/* Slide stage */}
      <WrappedMotionContext.Provider value={liveMotion}>
        <WrappedActionsContext.Provider value={actions}>
          <div className="wr-frame relative flex-1 overflow-hidden">
            {!stats ? (
              <LoadingState year={year} />
            ) : (
              <AnimatePresence initial={false} custom={direction}>
                <motion.div
                  key={`${year}:${slide?.id}`}
                  custom={direction}
                  variants={variants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: reduced ? 0.2 : 0.45, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0"
                  aria-live="polite"
                >
                  {slide?.render(stats)}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </WrappedActionsContext.Provider>
      </WrappedMotionContext.Provider>

      {/* Side arrows (wide windows only) */}
      {total > 0 && (
        <>
          <SideArrow side="left" hidden={isFirst || exporting} onClick={() => applyNav('prev')} />
          <SideArrow side="right" hidden={isLast || exporting} onClick={() => applyNav('next')} />
        </>
      )}

      {/* Bottom chrome: back · progress · continue */}
      <div
        data-wrapped-interactive
        className="absolute bottom-0 inset-x-0 z-50 px-4 sm:px-5 pb-4 pt-8"
        style={{ background: 'linear-gradient(to top, rgba(5,3,12,0.92) 35%, transparent)' }}
      >
        <div className="flex items-center gap-3 max-w-3xl mx-auto">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (isFirst) onClose(); else applyNav('prev'); }}
            disabled={exporting}
            className="shrink-0 h-10 px-4 rounded-full bg-white/[0.06] border border-white/12 text-white/80 hover:bg-white/10 hover:text-white text-sm font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
          >
            <ChevronLeft className="w-4 h-4" />
            {isFirst ? 'Close' : 'Back'}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1" role="tablist" aria-label="Slides">
              {slides.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`${i + 1}. ${s.label}`}
                  title={s.label}
                  onClick={(e) => { e.stopPropagation(); goTo(i); }}
                  className="group flex-1 py-2 focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      'block h-1 rounded-full overflow-hidden group-hover:bg-white/25 group-focus-visible:ring-2 group-focus-visible:ring-fuchsia-300 transition-colors',
                      i === index ? 'bg-white/30' : 'bg-white/[0.12]',
                    )}
                  >
                    <span
                      key={i === index ? `run-${year}-${index}` : 'idle'}
                      className="wr-progress-fill block h-full w-full rounded-full bg-gradient-to-r from-fuchsia-400 to-cyan-300"
                      data-state={i < index ? 'done' : i === index ? (s.duration > 0 ? 'running' : 'static') : 'idle'}
                      data-paused={paused ? 'true' : 'false'}
                      style={{ ['--wr-dur' as string]: `${s.duration}ms` } as CSSProperties}
                      onAnimationEnd={(e) => {
                        if (e.animationName !== 'wr-progress' || paused) return;
                        if (i === index && canGoNext(index, total)) goTo(index + 1, 1);
                      }}
                    />
                  </span>
                </button>
              ))}
              {total === 0 && <span className="block flex-1 h-1 rounded-full bg-white/[0.08] wr-pulse" />}
            </div>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-white/35 mt-1">
              <span className="truncate">{slide?.label ?? 'Loading'}</span>
              <span className="tabular-nums">{total > 0 ? `${index + 1} / ${total}` : ''}</span>
            </div>
          </div>

          {!isLast ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); applyNav('next'); }}
              disabled={exporting || total === 0}
              className="shrink-0 h-10 px-4 rounded-full bg-fuchsia-500/20 border border-fuchsia-400/35 text-fuchsia-50 hover:bg-fuchsia-500/30 text-sm font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
            >
              {isFirst ? 'Start' : 'Next'}
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (!exporting) onClose(); }}
              disabled={exporting}
              className="shrink-0 h-10 px-5 rounded-full bg-white/[0.08] border border-white/15 text-white/90 hover:bg-white/12 text-sm font-medium transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
            >
              Done
            </button>
          )}
        </div>
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-24 inset-x-0 mx-auto w-max max-w-[calc(100%-2rem)] z-[60] flex items-center gap-2 px-4 py-2 rounded-full bg-[#0d1f1a] border border-emerald-400/30 text-emerald-200 text-sm"
            role="status"
          >
            <Check className="w-4 h-4" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Off-screen, fixed-size, animation-free render target for "Save as images". */}
      {exportSlide && stats && (
        <div className="fixed top-0 pointer-events-none" style={{ left: -(EXPORT_W + 200) }} aria-hidden>
          <WrappedMotionContext.Provider value={exportMotion}>
            <WrappedActionsContext.Provider value={null}>
              <div
                ref={exportNodeRef}
                className="wr-root wr-static wr-frame relative overflow-hidden text-white"
                style={{ width: EXPORT_W, height: EXPORT_H }}
              >
                <Aurora id={exportSlide.id} />
                <Starfield />
                <div className="absolute inset-0">{exportSlide.render(stats)}</div>
                <div className="absolute bottom-5 inset-x-0 flex items-center justify-center gap-2.5 text-white/40">
                  <span className="font-display text-[10px] font-bold tracking-[0.4em] uppercase">Ark Wrapped</span>
                  <span className="w-1 h-1 rounded-full bg-white/30" />
                  <span className="font-display text-[10px]">{stats.year}</span>
                </div>
              </div>
            </WrappedActionsContext.Provider>
          </WrappedMotionContext.Provider>
        </div>
      )}
    </motion.div>
  );
}

function SideArrow({ side, hidden, onClick }: { side: 'left' | 'right'; hidden: boolean; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      data-wrapped-interactive
      type="button"
      tabIndex={hidden ? -1 : 0}
      aria-hidden={hidden}
      aria-label={side === 'left' ? 'Previous slide' : 'Next slide'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'hidden md:flex absolute top-1/2 -translate-y-1/2 z-40 w-11 h-11 rounded-full border items-center justify-center transition-opacity duration-300',
        side === 'left' ? 'left-4' : 'right-4',
        hidden
          ? 'opacity-0 pointer-events-none'
          : 'opacity-100 bg-black/30 border-white/12 text-white/60 hover:text-white hover:bg-fuchsia-500/20 hover:border-fuchsia-400/40',
      )}
    >
      <Icon className="w-5 h-5" />
    </button>
  );
}

function LoadingState({ year }: { year: number }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5" role="status" aria-label="Preparing your Wrapped">
      <p className="font-display font-black text-[length:clamp(64px,18cqmin,160px)] leading-none text-white/[0.07]">{year}</p>
      <div className="flex items-center gap-2 text-white/45 text-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-300 wr-pulse" />
        Gathering your year…
      </div>
    </div>
  );
}
