/**
 * Ark Wrapped — shared visual primitives (motion context, counters, covers,
 * ambient background, slide scaffold). Everything here animates with CSS
 * transform/opacity only; see wrapped.css.
 */
import {
  createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { Gamepad2 } from 'lucide-react';
import { cn, buildGameImageChain } from '@/lib/utils';
import { libraryStore } from '@/services/library-store';

// ─── Motion context ──────────────────────────────────────────────────────────

export interface WrappedMotion {
  /** Run entrance animations / counters. False for export and reduced motion. */
  animate: boolean;
  /** Rendering into the fixed-size export canvas (no chrome, no buttons). */
  exporting: boolean;
}

export const WrappedMotionContext = createContext<WrappedMotion>({ animate: true, exporting: false });
export const useWrappedMotion = () => useContext(WrappedMotionContext);

/** Inline style carrying an animation delay for the CSS entrance primitives. */
export function d(ms: number, extra?: CSSProperties): CSSProperties {
  return { ['--d' as string]: `${Math.round(ms)}ms`, ...extra } as CSSProperties;
}

// ─── Counter ─────────────────────────────────────────────────────────────────

function formatNumber(n: number, decimals: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Count-up number. Writes textContent from a single rAF loop — no React state
 * updates per frame. Shows the final value immediately when not animating.
 */
export function CountNumber({
  value, decimals = 0, prefix = '', suffix = '', delay = 0, duration = 1400, className,
}: {
  value: number; decimals?: number; prefix?: string; suffix?: string;
  delay?: number; duration?: number; className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { animate } = useWrappedMotion();
  const safe = Number.isFinite(value) ? value : 0;
  const finalText = `${prefix}${formatNumber(safe, decimals)}${suffix}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!animate || safe === 0) {
      el.textContent = finalText;
      return;
    }
    el.textContent = `${prefix}${formatNumber(0, decimals)}${suffix}`;
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = `${prefix}${formatNumber(safe * eased, decimals)}${suffix}`;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    const timer = window.setTimeout(() => { raf = requestAnimationFrame(step); }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [animate, safe, decimals, prefix, suffix, delay, duration, finalText]);

  return <span ref={ref} className={cn('tabular-nums', className)} aria-label={finalText} />;
}

// ─── Covers ──────────────────────────────────────────────────────────────────

export function coverCandidates(gameId: string, title: string, coverUrl?: string): string[] {
  try {
    const meta = libraryStore.getEntry(gameId)?.cachedMeta;
    return buildGameImageChain(gameId, title, coverUrl || meta?.coverUrl, meta?.headerImage);
  } catch {
    return coverUrl ? [coverUrl] : [];
  }
}

/** Warm the browser cache for upcoming covers (first candidate only). */
export function preloadCovers(refs: Array<{ gameId: string; title: string; coverUrl?: string }>) {
  for (const r of refs) {
    const url = coverCandidates(r.gameId, r.title, r.coverUrl)[0];
    if (!url) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

export const CoverImage = memo(function CoverImage({ gameId, title, coverUrl, className }: {
  gameId: string; title: string; coverUrl?: string; className?: string;
}) {
  const chain = useMemo(() => coverCandidates(gameId, title, coverUrl), [gameId, title, coverUrl]);
  const [attempt, setAttempt] = useState(0);

  if (attempt >= chain.length) {
    return (
      <div
        className={cn('flex items-center justify-center bg-gradient-to-br from-violet-900/60 via-fuchsia-950/60 to-slate-950', className)}
        role="img"
        aria-label={title}
      >
        <Gamepad2 className="w-1/3 h-1/3 max-w-10 max-h-10 text-white/25" />
      </div>
    );
  }
  return (
    <img
      src={chain[attempt]}
      alt={title}
      draggable={false}
      decoding="async"
      className={cn('object-cover bg-white/[0.04]', className)}
      onError={() => setAttempt((a) => a + 1)}
    />
  );
});

// ─── Ambient background ──────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starLayer(seed: number, count: number, tile: number, minR: number, maxR: number, tint: string[]): string {
  const rnd = mulberry32(seed);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round(rnd() * tile);
    const y = Math.round(rnd() * tile);
    const r = (minR + rnd() * (maxR - minR)).toFixed(2);
    const a = (0.35 + rnd() * 0.6).toFixed(2);
    const c = tint[Math.floor(rnd() * tint.length)];
    parts.push(`radial-gradient(${r}px ${r}px at ${x}px ${y}px, rgba(${c},${a}), transparent)`);
  }
  return parts.join(',');
}

// Generated once per module load — deterministic, so layers never "jump" between renders.
const STAR_LAYERS = [
  { tile: 420, drift: '180s', opacity: 0.9, image: starLayer(7, 46, 420, 0.6, 1.2, ['255,255,255', '216,180,254', '165,243,252']) },
  { tile: 760, drift: '300s', opacity: 0.7, image: starLayer(23, 22, 760, 1.1, 1.9, ['255,255,255', '240,171,252', '125,211,252']) },
];

export const Starfield = memo(function Starfield() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      {STAR_LAYERS.map((l, i) => (
        <div
          key={i}
          className="wr-stars"
          style={{
            ['--wr-tile' as string]: `${l.tile}px`,
            ['--wr-drift' as string]: l.drift,
            backgroundImage: l.image,
            opacity: l.opacity,
          } as CSSProperties}
        />
      ))}
    </div>
  );
});

export const AURORAS: Record<string, string> = {
  intro: 'radial-gradient(60% 50% at 25% 40%, rgba(124,58,237,0.32), transparent 70%), radial-gradient(45% 40% at 80% 25%, rgba(236,72,153,0.20), transparent 70%), radial-gradient(50% 45% at 60% 90%, rgba(34,211,238,0.12), transparent 70%)',
  numbers: 'radial-gradient(55% 45% at 50% 85%, rgba(59,130,246,0.26), transparent 70%), radial-gradient(45% 40% at 18% 20%, rgba(168,85,247,0.22), transparent 70%)',
  calendar: 'radial-gradient(55% 45% at 30% 40%, rgba(6,182,212,0.22), transparent 70%), radial-gradient(45% 40% at 82% 80%, rgba(139,92,246,0.22), transparent 70%)',
  topgame: 'radial-gradient(55% 50% at 70% 30%, rgba(236,72,153,0.26), transparent 70%), radial-gradient(50% 45% at 20% 80%, rgba(139,92,246,0.26), transparent 70%)',
  top5: 'radial-gradient(55% 45% at 30% 60%, rgba(245,158,11,0.16), transparent 70%), radial-gradient(45% 40% at 80% 30%, rgba(236,72,153,0.18), transparent 70%)',
  marathon: 'radial-gradient(55% 45% at 50% 50%, rgba(249,115,22,0.16), transparent 70%), radial-gradient(45% 40% at 20% 80%, rgba(59,130,246,0.18), transparent 70%)',
  genres: 'radial-gradient(55% 45% at 60% 40%, rgba(217,70,239,0.22), transparent 70%), radial-gradient(45% 40% at 30% 85%, rgba(99,102,241,0.22), transparent 70%)',
  months: 'radial-gradient(55% 45% at 70% 70%, rgba(249,115,22,0.18), transparent 70%), radial-gradient(45% 40% at 20% 30%, rgba(236,72,153,0.16), transparent 70%)',
  week: 'radial-gradient(55% 45% at 40% 30%, rgba(34,211,238,0.18), transparent 70%), radial-gradient(45% 40% at 80% 70%, rgba(168,85,247,0.18), transparent 70%)',
  completion: 'radial-gradient(55% 45% at 20% 60%, rgba(34,197,94,0.18), transparent 70%), radial-gradient(45% 40% at 80% 40%, rgba(6,182,212,0.18), transparent 70%)',
  patterns: 'radial-gradient(55% 45% at 50% 20%, rgba(99,102,241,0.26), transparent 70%), radial-gradient(45% 40% at 50% 85%, rgba(236,72,153,0.14), transparent 70%)',
  ratings: 'radial-gradient(55% 45% at 70% 70%, rgba(250,204,21,0.14), transparent 70%), radial-gradient(45% 40% at 20% 30%, rgba(168,85,247,0.18), transparent 70%)',
  facts: 'radial-gradient(55% 45% at 30% 30%, rgba(168,85,247,0.22), transparent 70%), radial-gradient(45% 40% at 75% 75%, rgba(34,211,238,0.14), transparent 70%)',
  quiet: 'radial-gradient(55% 45% at 50% 40%, rgba(99,102,241,0.2), transparent 70%)',
  finale: 'radial-gradient(50% 45% at 50% 45%, rgba(139,92,246,0.34), transparent 70%), radial-gradient(40% 40% at 18% 18%, rgba(236,72,153,0.24), transparent 70%), radial-gradient(45% 40% at 85% 85%, rgba(6,182,212,0.2), transparent 70%)',
};

export function Aurora({ id }: { id: string }) {
  return <div className="wr-aurora" style={{ backgroundImage: AURORAS[id] || AURORAS.intro }} aria-hidden />;
}

// ─── Slide scaffold ──────────────────────────────────────────────────────────

/** Consistent slide layout: scroll-safe vertical centering, shared type scale. */
export function SlideLayout({ eyebrow, title, subtitle, children, className, titleClassName }: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
  titleClassName?: string;
}) {
  const { exporting } = useWrappedMotion();
  return (
    <div className="wr-scroll absolute inset-0 overflow-y-auto overflow-x-hidden">
      <div
        className={cn(
          'min-h-full w-full flex flex-col items-center justify-center text-center',
          'gap-[clamp(12px,2.6cqh,28px)] px-[max(20px,6cqw)]',
          exporting ? 'pt-10 pb-14' : 'pt-[clamp(56px,11cqh,88px)] pb-[clamp(88px,16cqh,132px)]',
          className,
        )}
      >
        {eyebrow && (
          <p className="wr-rise wr-eyebrow text-[11px] font-semibold text-fuchsia-200/70" style={d(0)}>
            {eyebrow}
          </p>
        )}
        {title && (
          <h2
            className={cn(
              'wr-rise font-display font-bold text-white leading-[1.08] tracking-tight max-w-[24ch]',
              'text-[length:clamp(24px,5.6cqmin,50px)]',
              titleClassName,
            )}
            style={d(90)}
          >
            {title}
          </h2>
        )}
        {subtitle && (
          <p className="wr-rise text-white/55 leading-relaxed max-w-[56ch] text-[length:clamp(12px,2cqmin,16px)]" style={d(190)}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** Flat translucent card — no backdrop blur (expensive under moving layers). */
export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div
      className={cn('rounded-2xl border border-white/[0.08] bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]', className)}
      style={style}
    >
      {children}
    </div>
  );
}

export function Accent({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-fuchsia-300 font-semibold', className)}>{children}</span>;
}

/** Hours → "12h 30m" / "45m" (compact, for big numbers use CountNumber). */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
