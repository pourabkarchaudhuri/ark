/**
 * Voyage · Scenes
 *
 * A stream of detected play *episodes*, not a timeline. Captain's Log already
 * owns chronology; a third chronological view is exactly what got the old Gantt
 * retired. The unit here is the episode produced by the clustering in
 * lib/voyage-derive.ts, so:
 *
 *  - empty calendar time costs zero pixels
 *  - silence between episodes is rendered as *content* ("Your longest break,
 *    8 months. You came back with Baldur's Gate 3"), never as proportional
 *    whitespace
 *  - magnitude is log-scaled area, not bar length against a date axis
 *
 * Nothing below iterates calendar time, so a decade of history costs the same
 * as a month of it.
 *
 * Motion is transforms and opacity only (scatter-then-lock plus a stagger).
 * No WebGL, no scroll hijacking, no sound. Respects prefers-reduced-motion.
 *
 * Deliberately self-contained: it imports the shared pure layer and UI
 * primitives, never journey-audit-view, so retiring the loser of the A/B is one
 * commit.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  Activity,
  CalendarDays,
  ChevronDown,
  Clapperboard,
  Clock3,
  Coffee,
  Filter,
  Flame,
  Hourglass,
  Milestone as MilestoneIcon,
  RotateCcw,
  Sparkles,
  Timer,
  TrendingUp,
  Wind,
  Zap,
} from 'lucide-react';
import type { GameSession, JourneyEntry, StatusChangeEntry } from '@/types/game';
import {
  DAYPART_LABELS,
  SCENE_TYPE_LABEL,
  WEEKDAY_LABELS,
  clusterSessionsIntoScenes,
  computePlayCadence,
  computeRhythmHeatmap,
  computeSceneGaps,
  computeSessionLengthHistogram,
  computeStreaks,
  deriveMilestones,
  detectBulkImportGameIds,
  detectStatusChurnGameIds,
  formatDay,
  formatPlayMinutes,
  formatSpan,
  magnitudeToAreaScale,
  magnitudeVsMedian,
  median,
  sceneMagnitude,
  type Milestone,
  type PlayScene,
  type SceneGap,
  type SceneType,
} from '@/lib/voyage-derive';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import PacingPanel from '@/components/telemetry/PacingPanel';
import SessionAnalyticsPanel from '@/components/telemetry/SessionAnalyticsPanel';
import { resolveJourneyDisplayTitle } from '@/lib/journey-display-title';
import { cn } from '@/lib/utils';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface JourneyScenesViewProps {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions: GameSession[];
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Below this many episodes the stream has nothing to say, so we say that. */
const MIN_SCENES = 3;
/** Rows rendered before the reveal button; keeps first paint bounded. */
const PAGE_SIZE = 60;
const SPINE_ROW_H = 44;

type Density = 'compact' | 'comfortable' | 'roomy';

const DENSITY_ORDER: Density[] = ['compact', 'comfortable', 'roomy'];
const DENSITY_LABEL: Record<Density, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  roomy: 'Roomy',
};

interface CurationState {
  /** Sub-30-minute one-off launches. */
  microLaunches: boolean;
  /** Games that arrived in a sync burst rather than one decision at a time. */
  bulkImports: boolean;
  /** Rapid status flip-flops — a moment of tidying, not something in the game. */
  churn: boolean;
}

const DEFAULT_CURATION: CurationState = {
  microLaunches: true,
  bulkImports: true,
  churn: true,
};

// ─── Scene presentation ──────────────────────────────────────────────────────

interface SceneMeta {
  icon: typeof Flame;
  accent: string;
  glyph: string;
  ring: string;
}

const SCENE_META: Record<SceneType, SceneMeta> = {
  binge: {
    icon: Flame,
    accent: 'text-fuchsia-300',
    glyph: 'bg-fuchsia-500/30 border-fuchsia-400/40',
    ring: 'group-hover:border-fuchsia-500/40',
  },
  marathon: {
    icon: Timer,
    accent: 'text-amber-300',
    glyph: 'bg-amber-500/30 border-amber-400/40',
    ring: 'group-hover:border-amber-500/40',
  },
  return: {
    icon: RotateCcw,
    accent: 'text-cyan-300',
    glyph: 'bg-cyan-500/30 border-cyan-400/40',
    ring: 'group-hover:border-cyan-500/40',
  },
  drip: {
    icon: Coffee,
    accent: 'text-emerald-300',
    glyph: 'bg-emerald-500/25 border-emerald-400/35',
    ring: 'group-hover:border-emerald-500/40',
  },
  'false-start': {
    icon: Clapperboard,
    accent: 'text-white/50',
    glyph: 'bg-white/10 border-white/20',
    ring: 'group-hover:border-white/25',
  },
  drift: {
    icon: Wind,
    accent: 'text-white/60',
    glyph: 'bg-white/[0.14] border-white/25',
    ring: 'group-hover:border-white/25',
  },
};

/**
 * Verb-forward grammar. Endings that are not completions are named neutrally —
 * "wound down", "moved on" — because the view describes what the record shows,
 * not whether it was a good use of an evening.
 */
function sceneGrammar(scene: PlayScene): { prefix: string; suffix: string } {
  const play = formatPlayMinutes(scene.minutes);
  switch (scene.type) {
    case 'binge':
      return {
        prefix: `Poured ${play} into `,
        suffix: scene.dayCount > 1 ? ` over ${scene.dayCount} days` : ' in a single day',
      };
    case 'marathon':
      return {
        prefix: 'Sat down with ',
        suffix: ` for a ${formatPlayMinutes(scene.longestSessionMinutes)} stretch`,
      };
    case 'return':
      return {
        prefix: 'Came back to ',
        suffix: ` after ${formatSpan(scene.sincePreviousMs ?? 0)} away — ${play}`,
      };
    case 'false-start':
      return { prefix: 'Opened ', suffix: `, played ${play}, moved on` };
    case 'drift':
      return { prefix: 'Wound down on ', suffix: ` with ${play}` };
    case 'drip':
    default:
      return {
        prefix: 'Chipped away at ',
        suffix: ` — ${play} across ${scene.dayCount} day${scene.dayCount === 1 ? '' : 's'}`,
      };
  }
}

/** Benchmarked against the user's own median episode, never against anyone else. */
function comparativeHeadline(minutes: number, medianMinutes: number): string {
  if (!(medianMinutes > 0)) return 'Your first measured episodes';
  const ratio = magnitudeVsMedian(minutes, medianMinutes);
  if (ratio >= 1.5) return `${ratio.toFixed(1)}× your median episode`;
  if (ratio >= 0.85) return 'About your median episode';
  if (ratio >= 0.35) return `${Math.round(ratio * 100)}% of your median episode`;
  return 'Well under your median episode';
}

// ─── Motion ──────────────────────────────────────────────────────────────────

/** Deterministic per-row scatter so a re-render never reshuffles the reveal. */
function scatterFor(seed: string): { x: number; y: number; rotate: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000;
  const b = ((h >>> 9) % 1000) / 1000;
  return { x: (a - 0.5) * 40, y: 14 + b * 20, rotate: (b - 0.5) * 3 };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

// ─── Stream model ────────────────────────────────────────────────────────────

type StreamRow =
  | { kind: 'scene'; key: string; atMs: number; scene: PlayScene; magnitude: number }
  | { kind: 'gap'; key: string; atMs: number; gap: SceneGap }
  | { kind: 'milestone'; key: string; atMs: number; milestone: Milestone };

// ─── Row components ──────────────────────────────────────────────────────────

const SceneRow = memo(function SceneRow({
  scene,
  magnitude,
  medianMinutes,
  density,
  active,
  reduced,
  index,
  registerRef,
}: {
  scene: PlayScene;
  magnitude: number;
  medianMinutes: number;
  density: Density;
  active: boolean;
  reduced: boolean;
  index: number;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const meta = SCENE_META[scene.type];
  const Icon = meta.icon;
  const { prefix, suffix } = sceneGrammar(scene);
  const side = 16 + Math.round(magnitudeToAreaScale(magnitude) * 34);
  const scatter = scatterFor(scene.id);

  const attach = useCallback(
    (el: HTMLDivElement | null) => registerRef(scene.id, el),
    [registerRef, scene.id],
  );

  return (
    <motion.div
      ref={attach}
      data-scene-id={scene.id}
      className={cn(
        'group relative flex gap-3 rounded-xl border bg-gradient-to-r from-white/[0.025] to-transparent transition-colors',
        meta.ring,
        active
          ? 'border-white/25 bg-white/[0.04] shadow-[inset_3px_0_0_0_rgba(232,121,249,0.75)]'
          : 'border-white/[0.06]',
        density === 'compact' ? 'px-3 py-2' : density === 'comfortable' ? 'px-4 py-3' : 'px-5 py-4',
      )}
      initial={reduced ? false : { opacity: 0, x: scatter.x, y: scatter.y, rotate: scatter.rotate }}
      animate={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
      transition={{
        duration: 0.5,
        delay: reduced ? 0 : Math.min(index, 12) * 0.035,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {/* Log-scaled magnitude: the rendered *area* tracks play time, so a
          200-hour epic does not squash everything else to a hairline. */}
      <div className="flex w-[56px] shrink-0 items-center justify-center">
        <div
          className={cn('rounded-md border', meta.glyph)}
          style={{ width: side, height: side }}
          aria-hidden
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', meta.accent)} />
          <p className="min-w-0 text-sm leading-snug text-white/75">
            {prefix}
            <span className="font-semibold text-white">{scene.title}</span>
            {suffix}
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[22px] font-mono text-[10px] uppercase tracking-wider text-white/35">
          <span className={meta.accent}>{SCENE_TYPE_LABEL[scene.type]}</span>
          <span aria-hidden>·</span>
          <span>{formatDay(scene.startMs)}</span>
          <span aria-hidden>·</span>
          <span>
            {scene.sessionCount} session{scene.sessionCount === 1 ? '' : 's'}
          </span>
          {scene.isFirstForGame && (
            <>
              <span aria-hidden>·</span>
              <span>First run</span>
            </>
          )}
        </div>

        {density !== 'compact' && (
          <p className="mt-1.5 pl-[22px] text-[11px] text-white/40">
            {comparativeHeadline(scene.minutes, medianMinutes)}
          </p>
        )}
      </div>
    </motion.div>
  );
});

const GapRow = memo(function GapRow({
  gap,
  reduced,
  index,
}: {
  gap: SceneGap;
  reduced: boolean;
  index: number;
}) {
  return (
    <motion.div
      className={cn(
        'relative flex items-center gap-3 rounded-xl border border-dashed px-4 py-3',
        gap.isLongest
          ? 'border-cyan-500/30 bg-cyan-500/[0.04]'
          : 'border-white/[0.08] bg-transparent',
      )}
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: reduced ? 0 : Math.min(index, 12) * 0.035 }}
    >
      <Hourglass
        className={cn('h-4 w-4 shrink-0', gap.isLongest ? 'text-cyan-300' : 'text-white/30')}
      />
      <p className="text-sm leading-snug text-white/60">
        {gap.isLongest ? 'Your longest break, ' : 'Nothing tracked for '}
        <span className={cn('font-semibold', gap.isLongest ? 'text-cyan-200' : 'text-white/80')}>
          {formatSpan(gap.ms)}
        </span>
        {'. You came back with '}
        <span className="font-semibold text-white">{gap.nextTitle}</span>
        {'.'}
      </p>
    </motion.div>
  );
});

const MilestoneRow = memo(function MilestoneRow({
  milestone,
  reduced,
  index,
}: {
  milestone: Milestone;
  reduced: boolean;
  index: number;
}) {
  return (
    <motion.div
      className="flex items-center gap-3 px-1"
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduced ? 0 : Math.min(index, 12) * 0.035 }}
    >
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-fuchsia-500/25" />
      <div className="flex items-center gap-1.5 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/[0.07] px-3 py-1">
        <Sparkles className="h-3 w-3 text-fuchsia-300" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-fuchsia-200">
          {milestone.label}
        </span>
        {milestone.detail && (
          <span className="max-w-[180px] truncate text-[10px] text-white/40">
            {milestone.detail}
          </span>
        )}
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-fuchsia-500/25" />
    </motion.div>
  );
});

// ─── Play-rhythm dashboard ───────────────────────────────────────────────────

const CADENCE_CONFIG: ChartConfig = {
  sessions: { label: 'Sessions', color: 'hsl(292, 84%, 61%)' },
};
const LENGTH_CONFIG: ChartConfig = {
  count: { label: 'Sessions', color: 'hsl(187, 96%, 42%)' },
};

const DASH_HEAT = 'rgb(217, 70, 239)'; // fuchsia-500

/** One-line takeaway under a chart — short, data-aware, never moralizing. */
function ChartTldr({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 border-t border-white/[0.05] pt-2.5 text-[11px] leading-relaxed text-white/45">
      <span className="mr-1.5 font-mono text-[9px] uppercase tracking-wider text-fuchsia-300/70">
        TLDR
      </span>
      {children}
    </p>
  );
}

function SectionHeader({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <header className="mb-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/70">
        {eyebrow}
      </p>
      <h3 className="mt-1 font-['Orbitron'] text-base font-bold tracking-wide text-white">{title}</h3>
      <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-white/45">{blurb}</p>
    </header>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  reduced,
  index = 0,
}: {
  icon: typeof Flame;
  label: string;
  value: string;
  hint?: string;
  reduced?: boolean;
  index?: number;
}) {
  return (
    <motion.div
      className="rounded-xl border border-white/[0.07] bg-gradient-to-b from-white/[0.04] to-white/[0.01] px-3 py-2.5"
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: reduced ? 0 : index * 0.04, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="flex items-center gap-1.5 text-white/40">
        <Icon className="h-3 w-3" />
        <span className="font-mono text-[9px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1 font-mono text-xl font-black text-white">{value}</p>
      {hint && <p className="text-[10px] leading-tight text-white/30">{hint}</p>}
    </motion.div>
  );
}

/** A weekday × part-of-day grid. Empty cells stay visible so a quiet slot reads. */
function RhythmGrid({ heat }: { heat: ReturnType<typeof computeRhythmHeatmap> }) {
  return (
    <div className="grid grid-cols-[auto_repeat(4,1fr)] gap-1 text-white/40">
      <div aria-hidden />
      {DAYPART_LABELS.map((d) => (
        <div key={d} className="text-center font-mono text-[9px] uppercase tracking-wider">
          {d.slice(0, 3)}
        </div>
      ))}
      {WEEKDAY_LABELS.map((wd, wi) => (
        <div key={wd} className="contents">
          <div className="flex items-center justify-end pr-1 font-mono text-[9px] uppercase tracking-wider">
            {wd}
          </div>
          {heat.grid[wi].map((count, di) => {
            const opacity = heat.max > 0 ? 0.06 + (count / heat.max) * 0.94 : 0.04;
            return (
              <div
                key={di}
                className="flex h-6 items-center justify-center rounded-[3px] border border-white/[0.04] transition-[opacity,transform] duration-200 hover:scale-[1.04]"
                style={{ backgroundColor: DASH_HEAT, opacity: count > 0 ? opacity : 0.04 }}
                title={`${wd} ${DAYPART_LABELS[di]} — ${count} session${count === 1 ? '' : 's'}`}
              >
                {count > 0 && (
                  <span className="font-mono text-[9px] font-bold text-white/90">{count}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
  tldr,
  className,
  reduced,
  delay = 0,
}: {
  title: string;
  icon: typeof Flame;
  children: ReactNode;
  tldr?: ReactNode;
  className?: string;
  reduced?: boolean;
  delay?: number;
}) {
  return (
    <motion.div
      className={cn(
        'rounded-2xl border border-white/[0.07] bg-gradient-to-b from-white/[0.03] to-transparent p-4',
        className,
      )}
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduced ? 0 : delay, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="mb-3 flex items-center gap-1.5 text-white/45">
        <Icon className="h-3.5 w-3.5" />
        <span className="font-mono text-[10px] uppercase tracking-wider">{title}</span>
      </div>
      {children}
      {tldr != null && tldr !== false && <ChartTldr>{tldr}</ChartTldr>}
    </motion.div>
  );
}

const PlayRhythmDashboard = memo(function PlayRhythmDashboard({
  sessions,
  scenes,
  medianMinutes,
  reduced,
}: {
  sessions: GameSession[];
  scenes: PlayScene[];
  medianMinutes: number;
  reduced: boolean;
}) {
  const cadence = useMemo(() => computePlayCadence(sessions, Date.now(), 12), [sessions]);
  const streaks = useMemo(() => computeStreaks(sessions), [sessions]);
  const lengthHist = useMemo(() => computeSessionLengthHistogram(sessions), [sessions]);
  const rhythm = useMemo(() => computeRhythmHeatmap(sessions), [sessions]);

  const totalHours = useMemo(() => {
    let mins = 0;
    for (const s of sessions) mins += Math.max(0, s.durationMinutes ?? 0);
    return mins / 60;
  }, [sessions]);

  const topScenes = useMemo(
    () => [...scenes].sort((a, b) => b.minutes - a.minutes).slice(0, 6),
    [scenes],
  );

  const peakSlot = useMemo(() => {
    if (rhythm.peakWeekday === null || rhythm.peakHour === null) return '—';
    return `${WEEKDAY_LABELS[rhythm.peakWeekday]} ${DAYPART_LABELS[
      rhythm.peakHour < 6 ? 0 : rhythm.peakHour < 12 ? 1 : rhythm.peakHour < 18 ? 2 : 3
    ].toLowerCase()}`;
  }, [rhythm.peakWeekday, rhythm.peakHour]);

  const hasCadence = cadence.some((w) => w.sessions > 0);

  const cadenceTldr = useMemo(() => {
    if (!hasCadence) return null;
    const activeWeeks = cadence.filter((w) => w.sessions > 0).length;
    const peak = cadence.reduce(
      (best, w) => (w.sessions > best.sessions ? w : best),
      cadence[0],
    );
    const recent = cadence.slice(-4).reduce((s, w) => s + w.sessions, 0);
    const earlier = cadence.slice(0, 4).reduce((s, w) => s + w.sessions, 0);
    const trend =
      recent > earlier * 1.25
        ? 'Recent weeks are busier than the start of this window.'
        : earlier > recent * 1.25
          ? 'Play has thinned out compared with earlier weeks.'
          : 'Session volume has stayed roughly steady across the window.';
    return (
      <>
        Active in {activeWeeks} of 12 weeks; peak week of {peak.sessions} session
        {peak.sessions === 1 ? '' : 's'} starting {peak.label}. {trend}
      </>
    );
  }, [cadence, hasCadence]);

  const lengthTldr = useMemo(() => {
    if (sessions.length === 0) return null;
    const mode = lengthHist.reduce(
      (best, b) => (b.count > best.count ? b : best),
      lengthHist[0],
    );
    const total = lengthHist.reduce((s, b) => s + b.count, 0);
    if (!mode || total === 0) return null;
    const pct = Math.round((mode.count / total) * 100);
    return (
      <>
        Most sits land in the {mode.label} bucket ({pct}% of sessions) — the shape of a typical
        sit-down, not a target.
      </>
    );
  }, [lengthHist, sessions.length]);

  const rhythmTldr = useMemo(() => {
    if (rhythm.total === 0 || peakSlot === '—') return null;
    return (
      <>
        Sessions cluster around {peakSlot}. Brighter cells are busier slots; empty cells stay
        visible so quiet hours still read.
      </>
    );
  }, [rhythm.total, peakSlot]);

  const notableTldr = useMemo(() => {
    if (topScenes.length === 0) return null;
    const top = topScenes[0];
    const ratio = medianMinutes > 0 ? magnitudeVsMedian(top.minutes, medianMinutes) : 0;
    return (
      <>
        Biggest measured episode: {top.title} ({formatPlayMinutes(top.minutes)}
        {ratio > 0 ? `, ${ratio.toFixed(1)}× your median` : ''}). Ranked by play time in the curated
        stream, not by calendar span.
      </>
    );
  }, [topScenes, medianMinutes]);

  return (
    <div className="mb-10 space-y-4">
      <SectionHeader
        eyebrow="Play rhythm"
        title="How your sessions shape up"
        blurb="Aggregate telemetry the episode stream cannot show — cadence, streaks, session shape, and when play actually happens."
      />

      {/* Headline stat tiles */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          icon={Flame}
          label="Current streak"
          value={`${streaks.current}d`}
          hint={streaks.current > 0 ? 'in a row' : 'no active streak'}
          reduced={reduced}
          index={0}
        />
        <StatTile
          icon={TrendingUp}
          label="Longest streak"
          value={`${streaks.longest}d`}
          hint="your record"
          reduced={reduced}
          index={1}
        />
        <StatTile
          icon={CalendarDays}
          label="Active days"
          value={streaks.activeDays.toLocaleString()}
          hint="days with play"
          reduced={reduced}
          index={2}
        />
        <StatTile
          icon={Timer}
          label="Tracked time"
          value={totalHours >= 100 ? `${Math.round(totalHours)}h` : `${totalHours.toFixed(1)}h`}
          hint={`${sessions.length.toLocaleString()} sessions`}
          reduced={reduced}
          index={3}
        />
        <StatTile
          icon={Coffee}
          label="Median episode"
          value={formatPlayMinutes(medianMinutes)}
          hint="typical run"
          reduced={reduced}
          index={4}
        />
        <StatTile
          icon={Clock3}
          label="Peak slot"
          value={peakSlot}
          hint="busiest time"
          reduced={reduced}
          index={5}
        />
      </div>

      {/* Cadence + length distribution */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Weekly cadence — last 12 weeks"
          icon={Activity}
          tldr={cadenceTldr}
          reduced={reduced}
          delay={0.05}
        >
          {hasCadence ? (
            <ChartContainer config={CADENCE_CONFIG} className="aspect-[3/1] w-full">
              <AreaChart data={cadence} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillCadence" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-sessions)" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="var(--color-sessions)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={22}
                  allowDecimals={false}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  dataKey="sessions"
                  type="natural"
                  fill="url(#fillCadence)"
                  stroke="var(--color-sessions)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <p className="py-8 text-center text-xs text-white/35">
              No sessions in the last 12 weeks.
            </p>
          )}
        </Panel>

        <Panel
          title="Session-length distribution"
          icon={Zap}
          tldr={lengthTldr}
          reduced={reduced}
          delay={0.1}
        >
          {sessions.length > 0 ? (
            <ChartContainer config={LENGTH_CONFIG} className="aspect-[3/1] w-full">
              <BarChart data={lengthHist} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={4}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={22}
                  allowDecimals={false}
                  tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="py-8 text-center text-xs text-white/35">No sessions recorded yet.</p>
          )}
        </Panel>
      </div>

      {/* Rhythm heatmap + notable episodes */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="When you play"
          icon={CalendarDays}
          tldr={rhythmTldr}
          reduced={reduced}
          delay={0.15}
        >
          {rhythm.total > 0 ? (
            <RhythmGrid heat={rhythm} />
          ) : (
            <p className="py-8 text-center text-xs text-white/35">
              Not enough sessions to map a rhythm.
            </p>
          )}
        </Panel>

        <Panel
          title="Notable episodes"
          icon={Flame}
          tldr={notableTldr}
          reduced={reduced}
          delay={0.2}
        >
          {topScenes.length > 0 ? (
            <div className="space-y-2">
              {topScenes.map((scene) => {
                const meta = SCENE_META[scene.type];
                const intensity = magnitudeVsMedian(scene.minutes, medianMinutes);
                return (
                  <div
                    key={scene.id}
                    className="flex items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2 transition-colors hover:border-white/12 hover:bg-white/[0.03]"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-white/80">
                      {scene.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-white/45">
                      <span className={meta.accent}>{formatPlayMinutes(scene.minutes)}</span>
                      <span aria-hidden>·</span>
                      <span>{scene.sessionCount}×</span>
                      {medianMinutes > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-fuchsia-300/80">{intensity.toFixed(1)}× med</span>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-white/35">No episodes yet.</p>
          )}
        </Panel>
      </div>

      {/* Aggregated telemetry — library-wide play cadence & session analytics.
          Both panels take a flat session list; the gameId is unused by their
          math, so a placeholder is safe. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PacingPanel gameId="__library__" sessions={sessions} />
        <SessionAnalyticsPanel gameId="__library__" sessions={sessions} />
      </div>
    </div>
  );
});

// ─── Not-enough-data gate ────────────────────────────────────────────────────

function NotEnoughData({ scenes, sessionCount }: { scenes: PlayScene[]; sessionCount: number }) {
  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-white/[0.08] bg-white/[0.015] p-8 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/5">
        <Clapperboard className="h-6 w-6 text-fuchsia-400" />
      </div>
      <h3 className="mb-2 font-['Orbitron'] text-lg font-bold text-white">Not enough data yet</h3>
      <p className="mx-auto mb-1 max-w-md text-sm text-white/55">
        Scenes reads play episodes out of your tracked sessions. It needs at least{' '}
        {MIN_SCENES} before the stream says anything you could not read off the Log.
      </p>
      <p className="font-mono text-[11px] uppercase tracking-wider text-white/35">
        {sessionCount} session{sessionCount === 1 ? '' : 's'} · {scenes.length} episode
        {scenes.length === 1 ? '' : 's'} detected
      </p>

      {scenes.length > 0 && (
        <div className="mt-6 space-y-2 text-left">
          {scenes.map((scene) => {
            const { prefix, suffix } = sceneGrammar(scene);
            return (
              <div
                key={scene.id}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-sm text-white/65"
              >
                {prefix}
                <span className="font-semibold text-white">{scene.title}</span>
                {suffix}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main view ───────────────────────────────────────────────────────────────

export const JourneyScenesView = memo(function JourneyScenesView({
  journeyEntries,
  statusHistory,
  sessions,
}: JourneyScenesViewProps) {
  const reduced = usePrefersReducedMotion();
  const [density, setDensity] = useState<Density>('comfortable');
  const [curation, setCuration] = useState<CurationState>(DEFAULT_CURATION);
  const [curationOpen, setCurationOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const spineRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<string | null>(null);

  const titleFor = useMemo(() => {
    const byId = new Map(journeyEntries.map((e) => [e.gameId, e.title]));
    return (gameId: string) => resolveJourneyDisplayTitle(gameId, byId.get(gameId) ?? gameId);
  }, [journeyEntries]);

  const allScenes = useMemo(
    () => clusterSessionsIntoScenes(sessions, titleFor),
    [sessions, titleFor],
  );

  const bulkImportIds = useMemo(
    () => detectBulkImportGameIds(journeyEntries.map((e) => ({ gameId: e.gameId, addedAt: e.addedAt }))),
    [journeyEntries],
  );
  const churnIds = useMemo(() => detectStatusChurnGameIds(statusHistory), [statusHistory]);

  const allMilestones = useMemo(
    () => deriveMilestones(statusHistory, sessions),
    [statusHistory, sessions],
  );

  // Curation happens before layout, so a collapsed row never leaves a hole and
  // the gaps are recomputed against what actually survives.
  const curated = useMemo(() => {
    const scenes = allScenes.filter((s) => !(curation.microLaunches && s.isMicroLaunch));
    const milestones = allMilestones.filter((m) => {
      if (!m.gameId) return true;
      if (curation.bulkImports && bulkImportIds.has(m.gameId)) return false;
      if (curation.churn && churnIds.has(m.gameId)) return false;
      return true;
    });
    return { scenes, milestones };
  }, [allScenes, allMilestones, curation, bulkImportIds, churnIds]);

  const collapsedCounts = useMemo(
    () => ({
      microLaunches: allScenes.filter((s) => s.isMicroLaunch).length,
      bulkImports: allMilestones.filter((m) => m.gameId && bulkImportIds.has(m.gameId)).length,
      churn: allMilestones.filter((m) => m.gameId && churnIds.has(m.gameId)).length,
    }),
    [allScenes, allMilestones, bulkImportIds, churnIds],
  );

  const medianMinutes = useMemo(
    () => median(curated.scenes.map((s) => s.minutes)),
    [curated.scenes],
  );
  const maxMinutes = useMemo(
    () => curated.scenes.reduce((max, s) => Math.max(max, s.minutes), 0),
    [curated.scenes],
  );

  const rows = useMemo<StreamRow[]>(() => {
    const gaps = computeSceneGaps(curated.scenes);
    const out: StreamRow[] = [];
    for (const scene of curated.scenes) {
      out.push({
        kind: 'scene',
        key: scene.id,
        atMs: scene.startMs,
        scene,
        magnitude: sceneMagnitude(scene.minutes, maxMinutes),
      });
    }
    for (const gap of gaps) out.push({ kind: 'gap', key: gap.id, atMs: gap.endMs - 1, gap });
    for (const m of curated.milestones) {
      out.push({ kind: 'milestone', key: m.id, atMs: m.atMs, milestone: m });
    }
    out.sort((a, b) => b.atMs - a.atMs);
    return out;
  }, [curated, maxMinutes]);

  const sceneRows = useMemo(
    () => rows.filter((r): r is Extract<StreamRow, { kind: 'scene' }> => r.kind === 'scene'),
    [rows],
  );

  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const visibleSceneIds = useMemo(
    () => visibleRows.filter((r) => r.kind === 'scene').map((r) => r.key).join('|'),
    [visibleRows],
  );

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  // Spine ← stream. One observer over the mounted scene rows; the top-most
  // intersecting row wins, so the spine tracks reading position rather than
  // whichever row happened to fire last.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const elements = Array.from(rowRefs.current.values());
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (observed) => {
        let best: { id: string; top: number } | null = null;
        for (const entry of observed) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.sceneId;
          if (!id) continue;
          const top = entry.boundingClientRect.top;
          if (!best || top < best.top) best = { id, top };
        }
        if (best) setActiveSceneId(best.id);
      },
      { rootMargin: '-15% 0px -65% 0px', threshold: 0 },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [visibleSceneIds]);

  const activeIndex = useMemo(
    () => sceneRows.findIndex((r) => r.key === activeSceneId),
    [sceneRows, activeSceneId],
  );

  const spineVirtualizer = useVirtualizer({
    count: sceneRows.length,
    getScrollElement: () => spineRef.current,
    estimateSize: () => SPINE_ROW_H,
    overscan: 8,
  });

  // Stream → spine.
  useEffect(() => {
    if (activeIndex < 0) return;
    spineVirtualizer.scrollToIndex(activeIndex, { align: 'auto' });
  }, [activeIndex, spineVirtualizer]);

  const scrollToScene = useCallback((id: string) => {
    const el = rowRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setActiveSceneId(id);
      return true;
    }
    return false;
  }, []);

  // Spine → stream, including targets past the current reveal window.
  const handleSpineClick = useCallback(
    (id: string, index: number) => {
      if (scrollToScene(id)) return;
      pendingScrollRef.current = id;
      setVisibleCount((n) => Math.max(n, index + PAGE_SIZE));
    },
    [scrollToScene],
  );

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    if (scrollToScene(pending)) pendingScrollRef.current = null;
  }, [visibleCount, scrollToScene]);

  const toggleCuration = useCallback((key: keyof CurationState) => {
    setCuration((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const titleCount = useMemo(
    () => new Set(curated.scenes.map((s) => s.gameId)).size,
    [curated.scenes],
  );

  if (allScenes.length < MIN_SCENES) {
    return (
      <div className="mx-auto max-w-7xl px-4 pb-16 md:px-8 lg:px-10">
        <NotEnoughData scenes={allScenes} sessionCount={sessions.length} />
      </div>
    );
  }

  const curationHidden =
    (curation.microLaunches ? collapsedCounts.microLaunches : 0) +
    (curation.bulkImports ? collapsedCounts.bulkImports : 0) +
    (curation.churn ? collapsedCounts.churn : 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 md:px-8 lg:px-10">
      {/* Play-rhythm dashboard — the aggregate telemetry the stream cannot show:
          cadence, streaks, session shape and when play actually happens. */}
      <PlayRhythmDashboard
        sessions={sessions}
        scenes={curated.scenes}
        medianMinutes={medianMinutes}
        reduced={reduced}
      />

      <SectionHeader
        eyebrow="Episode stream"
        title="Detected play episodes"
        blurb="Clustered sits, not a calendar. Silence between runs is content — never proportional whitespace."
      />

      {/* One control strip: a density stepper and the curation filters. */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] p-0.5 shadow-inner shadow-black/20">
          {DENSITY_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDensity(d)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                density === d
                  ? 'bg-fuchsia-500 text-white shadow-md shadow-fuchsia-500/25'
                  : 'text-white/55 hover:text-white',
              )}
            >
              {DENSITY_LABEL[d]}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setCurationOpen((v) => !v)}
          aria-expanded={curationOpen}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium transition-colors',
            curationOpen ? 'border-white/20 text-white' : 'text-white/55 hover:text-white',
          )}
        >
          <Filter className="h-3 w-3" />
          Curation
          {curationHidden > 0 && (
            <span className="rounded-full bg-white/10 px-1.5 py-px font-mono text-[10px] text-white/60">
              {curationHidden} hidden
            </span>
          )}
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-200', curationOpen && 'rotate-180')}
          />
        </button>

        <p className="ml-auto font-mono text-[11px] uppercase tracking-wider text-white/35">
          {curated.scenes.length} episode{curated.scenes.length === 1 ? '' : 's'} · {titleCount}{' '}
          title{titleCount === 1 ? '' : 's'} · median {formatPlayMinutes(medianMinutes)}
        </p>
      </div>

      {curationOpen && (
        <motion.div
          className="mb-5 grid gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:grid-cols-3"
          initial={reduced ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {(
            [
              ['microLaunches', 'Brief launches', 'Single sessions under 30 minutes'],
              ['bulkImports', 'Bulk imports', 'Titles that arrived in one sync burst'],
              ['churn', 'Status flip-flops', 'Several status edits inside an hour'],
            ] as Array<[keyof CurationState, string, string]>
          ).map(([key, label, help]) => (
            <label
              key={key}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <input
                type="checkbox"
                checked={curation[key]}
                onChange={() => toggleCuration(key)}
                className="mt-0.5 h-3.5 w-3.5 accent-fuchsia-500"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-white/80">
                  {label}
                  <span className="ml-1.5 font-mono text-[10px] text-white/35">
                    {collapsedCounts[key]}
                  </span>
                </span>
                <span className="block text-[11px] leading-tight text-white/40">{help}</span>
              </span>
            </label>
          ))}
        </motion.div>
      )}

      <div className="flex gap-6">
        {/* Navigation spine — virtualized, so a thousand episodes still mount
            a couple of dozen rows. */}
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-6 rounded-xl border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-white/[0.01] p-2">
            <p className="px-2 pb-2 font-mono text-[10px] uppercase tracking-wider text-white/35">
              Episodes
            </p>
            <div ref={spineRef} className="scrollbar-hide max-h-[60vh] overflow-y-auto">
              <div
                className="relative w-full"
                style={{ height: spineVirtualizer.getTotalSize() }}
              >
                {spineVirtualizer.getVirtualItems().map((item) => {
                  const row = sceneRows[item.index];
                  if (!row) return null;
                  const isActive = row.key === activeSceneId;
                  const meta = SCENE_META[row.scene.type];
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onClick={() => handleSpineClick(row.key, item.index)}
                      className={cn(
                        'absolute left-0 top-0 flex w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                        isActive ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                      )}
                      style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                    >
                      <span
                        className={cn(
                          'h-6 w-0.5 shrink-0 rounded-full',
                          isActive ? 'bg-fuchsia-400' : 'bg-white/15',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-[11px]',
                            isActive ? 'text-white' : 'text-white/60',
                          )}
                        >
                          {row.scene.title}
                        </span>
                        <span
                          className={cn(
                            'block font-mono text-[9px] uppercase tracking-wider',
                            meta.accent,
                          )}
                        >
                          {SCENE_TYPE_LABEL[row.scene.type]}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-2">
          {visibleRows.map((row, i) => {
            if (row.kind === 'scene') {
              return (
                <SceneRow
                  key={row.key}
                  scene={row.scene}
                  magnitude={row.magnitude}
                  medianMinutes={medianMinutes}
                  density={density}
                  active={row.key === activeSceneId}
                  reduced={reduced}
                  index={i}
                  registerRef={registerRef}
                />
              );
            }
            if (row.kind === 'gap') {
              return <GapRow key={row.key} gap={row.gap} reduced={reduced} index={i} />;
            }
            return (
              <MilestoneRow key={row.key} milestone={row.milestone} reduced={reduced} index={i} />
            );
          })}

          {visibleCount < rows.length && (
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] py-3 text-xs font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
            >
              <MilestoneIcon className="h-3.5 w-3.5" />
              Show {Math.min(PAGE_SIZE, rows.length - visibleCount)} more of{' '}
              {rows.length - visibleCount}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
