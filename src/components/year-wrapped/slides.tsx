/**
 * Ark Wrapped — slides.
 *
 * Each slide is a light, static DOM tree whose entrance is driven by CSS
 * classes from wrapped.css (transform/opacity only). Slides only render when
 * they are on screen (active, or leaving during a transition).
 */
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  ChevronRight, Clock, Calendar, Download, Flame, Gamepad2, Link2, Loader2, MessageCircle,
  Moon, Send, Sparkles, Star, Sun, Sunrise, Sunset, Trophy, Twitter, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Accent, Card, CountNumber, CoverImage, SlideLayout, d, formatDuration, plural, useWrappedMotion,
} from './primitives';
import { DAYS_OF_WEEK, MONTHS, MONTHS_LONG, dayKey, type TimeOfDayIcon, type WrappedGameRef, type WrappedStats } from './stats';

// ─── Slide registry ──────────────────────────────────────────────────────────

export interface SlideDef {
  id: string;
  /** Short label for the progress bar tooltip and export file names. */
  label: string;
  /** Auto-advance duration in ms. */
  duration: number;
  render: (stats: WrappedStats) => ReactNode;
  /** Covers shown on this slide (preloaded one slide ahead). */
  covers?: (stats: WrappedStats) => WrappedGameRef[];
}

const ALL_SLIDES: Array<SlideDef & { when: (s: WrappedStats) => boolean }> = [
  { id: 'intro', label: 'Intro', duration: 6500, when: () => true, render: (s) => <SlideIntro stats={s} /> },
  { id: 'quiet', label: 'A quiet year', duration: 8000, when: (s) => !s.hasActivity, render: (s) => <SlideQuiet stats={s} /> },
  { id: 'numbers', label: 'By the numbers', duration: 8000, when: (s) => s.hasActivity, render: (s) => <SlideNumbers stats={s} /> },
  { id: 'calendar', label: 'Calendar', duration: 8500, when: (s) => s.totalActiveDays > 0, render: (s) => <SlideCalendar stats={s} /> },
  {
    id: 'topgame', label: 'Top game', duration: 8500, when: (s) => !!s.topGame,
    render: (s) => <SlideTopGame stats={s} />, covers: (s) => (s.topGame ? [s.topGame] : []),
  },
  {
    id: 'top5', label: 'Top five', duration: 9000, when: (s) => s.top5Games.length >= 2,
    render: (s) => <SlideTop5 stats={s} />, covers: (s) => s.top5Games,
  },
  { id: 'marathon', label: 'Dedication', duration: 8500, when: (s) => s.totalSessions > 0, render: (s) => <SlideMarathon stats={s} /> },
  { id: 'genres', label: 'Genres', duration: 8500, when: (s) => s.genreBreakdown.length > 0, render: (s) => <SlideGenres stats={s} /> },
  { id: 'months', label: 'Peak month', duration: 8000, when: (s) => !!s.busiestMonth, render: (s) => <SlideMonths stats={s} /> },
  { id: 'week', label: 'Your week', duration: 8000, when: (s) => !!s.busiestDayOfWeek && s.totalSessions >= 3, render: (s) => <SlideWeek stats={s} /> },
  {
    id: 'completion', label: 'Finish line', duration: 8500, when: (s) => s.gamesCompleted > 0 || s.gamesPlayed >= 3,
    render: (s) => <SlideCompletion stats={s} />, covers: (s) => s.completedGames.slice(0, 6),
  },
  { id: 'patterns', label: 'When you play', duration: 8000, when: (s) => s.hasTimeOfDay, render: (s) => <SlidePatterns stats={s} /> },
  { id: 'ratings', label: 'The critic', duration: 8000, when: (s) => s.totalRatings > 0, render: (s) => <SlideRatings stats={s} /> },
  { id: 'facts', label: 'Did you know', duration: 10000, when: (s) => s.funFacts.length >= 2, render: (s) => <SlideFacts stats={s} /> },
  {
    id: 'finale', label: 'Finale', duration: 0, when: () => true,
    render: (s) => <SlideFinale stats={s} />, covers: (s) => (s.topGame ? [s.topGame] : []),
  },
];

/** Slides worth showing for these stats (empty-data slides are skipped). */
export function buildSlideList(stats: WrappedStats): SlideDef[] {
  return ALL_SLIDES.filter((s) => s.when(stats));
}

// ─── Finale actions (provided by the overlay) ────────────────────────────────

export interface WrappedActions {
  onSaveImages: () => void;
  onShare: (platform: 'twitter' | 'reddit' | 'whatsapp' | 'copy') => void;
  onLaunchFlythrough?: () => void;
  exportProgress: { current: number; total: number } | null;
}
export const WrappedActionsContext = createContext<WrappedActions | null>(null);

// ─── Slides ──────────────────────────────────────────────────────────────────

function SlideIntro({ stats }: { stats: WrappedStats }) {
  const { exporting } = useWrappedMotion();
  return (
    <SlideLayout>
      {exporting && (
        <p className="wr-eyebrow text-[11px] font-semibold text-fuchsia-200/70">Ark Wrapped</p>
      )}
      <div className="relative flex items-center justify-center">
        <div className="absolute w-[150%] max-w-[560px] aspect-square pointer-events-none wr-fade" style={d(300)} aria-hidden>
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="74" fill="none" stroke="rgba(103,232,249,0.10)" strokeWidth="0.5" />
          </svg>
          {/* Rotating the HTML box (not an SVG group) keeps the spin on the compositor. */}
          <div className="absolute inset-0 wr-orbit">
            <svg className="w-full h-full" viewBox="0 0 200 200">
              <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(216,180,254,0.18)" strokeWidth="0.6" strokeDasharray="1 5" />
              <circle cx="100" cy="8" r="2.2" fill="#f0abfc" />
            </svg>
          </div>
        </div>
        <h1
          className="wr-pop relative font-display font-black leading-none tracking-tight wr-gradient-text text-[length:clamp(80px,24cqmin,210px)]"
          style={d(120, { ['--wr-gradient' as string]: 'linear-gradient(100deg, #a78bfa 0%, #f0abfc 45%, #67e8f9 100%)' })}
        >
          {stats.year}
        </h1>
      </div>
      <h2 className="wr-rise font-display font-bold text-white text-[length:clamp(22px,5cqmin,44px)] tracking-tight" style={d(420)}>
        Your year in games
      </h2>
      <p className="wr-rise text-white/55 max-w-[48ch] text-[length:clamp(12px,2cqmin,16px)] leading-relaxed" style={d(560)}>
        {stats.isPartialYear
          ? 'The story so far — your favourites, your marathons and your late nights.'
          : 'Your favourites, your marathons and your late nights. Let’s look back.'}
      </p>
      {!exporting && (
        <div className="wr-fade flex items-center gap-2 text-white/35 text-xs mt-2" style={d(1100)}>
          <span>Press</span>
          <kbd className="px-1.5 py-0.5 rounded border border-white/15 text-white/60 text-[10px]">→</kbd>
          <span>or click to begin</span>
          <ChevronRight className="w-3.5 h-3.5 wr-nudge" />
        </div>
      )}
    </SlideLayout>
  );
}

function SlideQuiet({ stats }: { stats: WrappedStats }) {
  return (
    <SlideLayout
      eyebrow="A quiet year"
      title="Your story is just getting started"
      subtitle={`There isn't much to look back on for ${stats.year} yet. Add games to your library and play with Ark open — next time, this will be all about you.`}
    >
      <div className="wr-pop mt-2 w-20 h-20 rounded-full border border-white/10 bg-white/[0.03] flex items-center justify-center" style={d(320)}>
        <Gamepad2 className="w-8 h-8 text-fuchsia-300/70" />
      </div>
    </SlideLayout>
  );
}

function SlideNumbers({ stats }: { stats: WrappedStats }) {
  const tiles = [
    {
      icon: Clock, label: 'Hours played', value: Math.round(stats.totalHoursPlayed), color: 'text-sky-300',
      note: stats.totalSessions > 0 ? `across ${plural(stats.totalSessions, 'session')}` : stats.hoursSource === 'library' ? 'from your library playtime' : 'no sessions tracked yet',
    },
    { icon: Gamepad2, label: 'Games played', value: stats.gamesPlayed, color: 'text-fuchsia-300', note: stats.topGenre ? `mostly ${stats.topGenre}` : 'a little of everything' },
    { icon: Sparkles, label: 'Games added', value: stats.totalGamesAdded, color: 'text-violet-300', note: stats.newGamesPerWeek >= 1 ? `about ${stats.newGamesPerWeek} a week` : 'to your library' },
    { icon: Trophy, label: 'Completed', value: stats.gamesCompleted, color: 'text-amber-300', note: stats.gamesCompleted > 0 ? 'credits rolled' : 'the backlog awaits' },
  ];
  return (
    <SlideLayout eyebrow="By the numbers" title={stats.isPartialYear ? 'Your year so far' : 'Your year at a glance'}>
      <div className="grid grid-cols-2 gap-[clamp(10px,2cqmin,18px)] w-full max-w-[560px]">
        {tiles.map((t, i) => (
          <Card key={t.label} className="wr-rise p-[clamp(12px,3cqmin,24px)] text-left" style={d(300 + i * 110)}>
            <p className="flex items-center gap-2 text-white/75 text-[length:clamp(11px,1.7cqmin,14px)] font-medium">
              <t.icon className={cn('w-4 h-4 shrink-0', t.color)} />
              {t.label}
            </p>
            <div className={cn('mt-2 font-display font-black leading-none text-[length:clamp(26px,7cqmin,56px)]', t.color)}>
              <CountNumber value={t.value} delay={420 + i * 110} />
            </div>
            <p className="wr-tall-only text-white/35 text-[11px] mt-1.5 truncate">{t.note}</p>
          </Card>
        ))}
      </div>
      {stats.firstGameAdded && (
        <p className="wr-fade wr-tall-only text-white/45 text-[length:clamp(11px,1.8cqmin,14px)]" style={d(1000)}>
          It all began with <Accent>{stats.firstGameAdded.title}</Accent> on {stats.firstGameAdded.date}.
        </p>
      )}
    </SlideLayout>
  );
}

// ─── Calendar heatmap (single SVG, no per-cell animation) ────────────────────

const HEAT_COLORS = ['rgba(255,255,255,0.05)', 'rgba(139,92,246,0.35)', 'rgba(168,85,247,0.6)', 'rgba(217,70,239,0.8)', 'rgba(103,232,249,0.95)'];

function Heatmap({ year, data }: { year: number; data: Record<string, number> }) {
  const { cells, weeks, monthLabels } = useMemo(() => {
    const start = new Date(year, 0, 1);
    const offset = start.getDay();
    const max = Math.max(1, ...Object.values(data));
    const out: { x: number; y: number; level: number; key: string; minutes: number }[] = [];
    const labels: { x: number; label: string }[] = [];
    const cursor = new Date(year, 0, 1);
    let col = 0;
    while (cursor.getFullYear() === year) {
      const dow = cursor.getDay();
      col = Math.floor((daysSinceStart(start, cursor) + offset) / 7);
      if (cursor.getDate() === 1) labels.push({ x: col, label: MONTHS[cursor.getMonth()] });
      const key = dayKey(cursor);
      const minutes = data[key] || 0;
      const ratio = minutes / max;
      const level = minutes <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
      out.push({ x: col, y: dow, level, key, minutes });
      cursor.setDate(cursor.getDate() + 1);
    }
    return { cells: out, weeks: col + 1, monthLabels: labels };
  }, [year, data]);

  const CELL = 10;
  const GAP = 3;
  const TOP = 14;
  const width = weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const active = cells.filter((c) => c.minutes > 0).length;

  return (
    <div className="wr-rise w-full max-w-[760px]" style={d(320)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label={`Play calendar: ${active} active days`}>
        {monthLabels.map((m) => (
          <text key={m.label} x={m.x * (CELL + GAP)} y={9} fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="inherit">
            {m.label}
          </text>
        ))}
        {cells.map((c) => (
          <rect
            key={c.key}
            x={c.x * (CELL + GAP)}
            y={TOP + c.y * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={2.5}
            fill={HEAT_COLORS[c.level]}
          />
        ))}
      </svg>
      <div className="flex items-center gap-1.5 mt-3 justify-end text-[10px] text-white/35">
        <span>Less</span>
        {HEAT_COLORS.map((c) => <span key={c} className="w-2.5 h-2.5 rounded-[3px]" style={{ background: c }} />)}
        <span>More</span>
      </div>
    </div>
  );
}

function daysSinceStart(start: Date, cur: Date) {
  return Math.round((Date.UTC(cur.getFullYear(), cur.getMonth(), cur.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000);
}

function SlideCalendar({ stats }: { stats: WrappedStats }) {
  return (
    <SlideLayout
      eyebrow="Your calendar"
      title={<><CountNumber value={stats.totalActiveDays} delay={200} /> {stats.totalActiveDays === 1 ? 'day' : 'days'} of play</>}
      subtitle={`That's ${stats.activeDayPercentage}% of the year${stats.isPartialYear ? ' so far' : ''}.`}
    >
      <Heatmap year={stats.year} data={stats.heatmap} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        {stats.longestStreak > 1 && (
          <Card className="wr-rise flex items-center gap-2 px-4 py-2 rounded-full" style={d(700)}>
            <Zap className="w-4 h-4 text-amber-300" />
            <span className="text-white/60 text-xs">Best streak <span className="text-amber-200 font-semibold">{plural(stats.longestStreak, 'day')}</span></span>
          </Card>
        )}
        {stats.currentStreak > 1 && (
          <Card className="wr-rise flex items-center gap-2 px-4 py-2 rounded-full" style={d(820)}>
            <Flame className="w-4 h-4 text-orange-400" />
            <span className="text-white/60 text-xs">On a <span className="text-orange-300 font-semibold">{stats.currentStreak}-day</span> streak right now</span>
          </Card>
        )}
      </div>
    </SlideLayout>
  );
}

function SlideTopGame({ stats }: { stats: WrappedStats }) {
  const g = stats.topGame!;
  return (
    <SlideLayout eyebrow="Your #1 game">
      <div className="wr-pop relative" style={d(150)}>
        <div
          className="wr-halo"
          style={{ background: 'radial-gradient(closest-side, rgba(217,70,239,0.45), rgba(139,92,246,0.18) 55%, transparent)' }}
          aria-hidden
        />
        <CoverImage
          gameId={g.gameId}
          title={g.title}
          coverUrl={g.coverUrl}
          className="relative rounded-2xl border border-white/10 w-[clamp(120px,26cqmin,240px)] aspect-[2/3]"
        />
        {stats.topGamePercentage > 0 && stats.top5Games.length > 1 && (
          <div
            className="wr-pop absolute -top-3 -right-3 w-14 h-14 rounded-full bg-gradient-to-br from-fuchsia-500 to-violet-600 border border-white/20 flex flex-col items-center justify-center"
            style={d(900)}
          >
            <span className="text-white font-black text-sm leading-none">{stats.topGamePercentage}%</span>
            <span className="text-white/70 text-[8px] uppercase tracking-wider mt-0.5">of play</span>
          </div>
        )}
      </div>
      <h2
        className="wr-rise font-display font-black leading-tight wr-gradient-text max-w-[20ch] text-[length:clamp(22px,5.2cqmin,44px)]"
        style={d(420, { ['--wr-gradient' as string]: 'linear-gradient(100deg, #f0abfc, #c4b5fd 50%, #a5f3fc)' })}
      >
        {g.title}
      </h2>
      <div className="wr-rise flex items-center gap-[clamp(16px,4cqmin,36px)]" style={d(560)}>
        <div>
          <p className="font-display font-black text-sky-300 text-[length:clamp(22px,5cqmin,40px)] leading-none">
            <CountNumber value={g.hours} decimals={g.hours < 10 ? 1 : 0} delay={620} />
          </p>
          <p className="text-white/40 text-[10px] uppercase tracking-[0.2em] mt-1.5">Hours</p>
        </div>
        {g.sessions > 0 && (
          <>
            <span className="w-px h-9 bg-white/10" />
            <div>
              <p className="font-display font-black text-emerald-300 text-[length:clamp(22px,5cqmin,40px)] leading-none">
                <CountNumber value={g.sessions} delay={700} />
              </p>
              <p className="text-white/40 text-[10px] uppercase tracking-[0.2em] mt-1.5">Sessions</p>
            </div>
          </>
        )}
      </div>
      {g.genre.length > 0 && (
        <div className="wr-fade flex flex-wrap justify-center gap-2" style={d(850)}>
          {g.genre.slice(0, 3).map((genre) => (
            <span key={genre} className="text-[10px] px-2.5 py-1 rounded-full border border-fuchsia-400/25 text-fuchsia-200/70 uppercase tracking-wider">
              {genre}
            </span>
          ))}
        </div>
      )}
    </SlideLayout>
  );
}

function SlideTop5({ stats }: { stats: WrappedStats }) {
  const max = stats.top5Games[0]?.hours || 1;
  const rankStyles = [
    'from-amber-300 to-amber-500 text-amber-950',
    'from-slate-200 to-slate-400 text-slate-900',
    'from-orange-400 to-orange-600 text-orange-950',
  ];
  return (
    <SlideLayout eyebrow="Most played" title={`Your top ${stats.top5Games.length}`}>
      <ol className="flex flex-col gap-[clamp(6px,1.4cqh,12px)] w-full max-w-[520px]">
        {stats.top5Games.map((g, i) => (
          <li key={g.gameId} className="wr-from-left" style={d(280 + i * 110)}>
            <Card className={cn('wr-row-compact flex items-center gap-3 p-2.5 pr-4 text-left', i === 0 && 'border-amber-300/25 bg-amber-300/[0.05]')}>
              <span
                className={cn(
                  'shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-black',
                  i < 3 ? cn('bg-gradient-to-br', rankStyles[i]) : 'bg-white/[0.06] text-white/50',
                )}
              >
                {i + 1}
              </span>
              <CoverImage gameId={g.gameId} title={g.title} coverUrl={g.coverUrl} className="wr-cover-compact shrink-0 w-[clamp(32px,6cqmin,44px)] aspect-[3/4] rounded-md" />
              <div className="flex-1 min-w-0">
                <p className="text-white text-[length:clamp(12px,1.9cqmin,15px)] font-semibold truncate">{g.title}</p>
                <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className="wr-grow-x h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-400"
                    style={d(520 + i * 110, { width: `${Math.max(4, (g.hours / max) * 100)}%` })}
                  />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-white/80 text-sm font-semibold tabular-nums">{formatDuration(g.hours * 60)}</p>
                {g.rating > 0 && (
                  <p className="flex justify-end gap-px mt-0.5" aria-label={`Rated ${g.rating} of 5`}>
                    {Array.from({ length: 5 }).map((_, si) => (
                      <Star key={si} className={cn('w-2.5 h-2.5', si < g.rating ? 'text-amber-300 fill-amber-300' : 'text-white/15')} />
                    ))}
                  </p>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </SlideLayout>
  );
}

function SlideMarathon({ stats }: { stats: WrappedStats }) {
  const ls = stats.longestSession;
  const tiles = [
    { icon: Clock, label: 'Average session', value: formatDuration(stats.avgSessionMinutes), color: 'text-sky-300' },
    { icon: Calendar, label: 'Days you played', value: stats.totalActiveDays.toLocaleString('en-US'), color: 'text-emerald-300' },
    { icon: Flame, label: 'Best streak', value: plural(stats.longestStreak, 'day'), color: 'text-orange-300' },
  ];
  return (
    <SlideLayout eyebrow="Dedication" title="Your longest sitting">
      {ls && (
        <div className="wr-pop flex flex-col items-center" style={d(250)}>
          <p
            className="font-display font-black leading-none wr-gradient-text text-[length:clamp(44px,13cqmin,110px)]"
            style={{ ['--wr-gradient' as string]: 'linear-gradient(100deg, #fde68a, #fb923c 55%, #f472b6)' } as CSSProperties}
          >
            {formatDuration(ls.durationMinutes)}
          </p>
          <p className="text-white/55 mt-3 text-[length:clamp(12px,2cqmin,16px)]">
            of <Accent className="text-orange-200">{ls.gameTitle}</Accent> on {ls.date}
          </p>
        </div>
      )}
      <div className="grid grid-cols-3 gap-[clamp(8px,1.8cqmin,16px)] w-full max-w-[560px] mt-2">
        {tiles.map((t, i) => (
          <Card key={t.label} className="wr-rise p-[clamp(10px,2.4cqmin,18px)]" style={d(600 + i * 110)}>
            <t.icon className={cn('w-4 h-4 mx-auto mb-2', t.color)} />
            <p className={cn('font-display font-bold text-[length:clamp(15px,3.2cqmin,24px)] leading-tight', t.color)}>{t.value}</p>
            <p className="text-white/40 text-[10px] uppercase tracking-wider mt-1">{t.label}</p>
          </Card>
        ))}
      </div>
    </SlideLayout>
  );
}

const BAR_GRADIENTS = [
  'from-fuchsia-500 to-violet-400',
  'from-sky-500 to-cyan-300',
  'from-emerald-500 to-teal-300',
  'from-amber-500 to-orange-300',
  'from-rose-500 to-pink-300',
  'from-indigo-500 to-violet-300',
];

function SlideGenres({ stats }: { stats: WrappedStats }) {
  const max = stats.genreBreakdown[0]?.count || 1;
  return (
    <SlideLayout
      eyebrow="Your genre DNA"
      title={<>Mostly <span className="wr-gradient-text">{stats.topGenre}</span></>}
      subtitle={stats.distinctGenres > 1 ? `You explored ${stats.distinctGenres} genres this year.` : undefined}
    >
      <div className="w-full max-w-[520px] flex flex-col gap-[clamp(6px,1.3cqh,11px)]">
        {stats.genreBreakdown.map((g, i) => (
          <div key={g.genre} className="wr-from-left flex items-center gap-3" style={d(320 + i * 90)}>
            <span className="w-[30%] shrink-0 text-right text-white/60 text-[length:clamp(11px,1.7cqmin,13px)] truncate">{g.genre}</span>
            <div className="flex-1 h-[clamp(14px,2.6cqmin,22px)] rounded-full bg-white/[0.05] overflow-hidden">
              <div
                className={cn('wr-grow-x h-full rounded-full bg-gradient-to-r', BAR_GRADIENTS[i % BAR_GRADIENTS.length])}
                style={d(460 + i * 90, { width: `${Math.max(6, (g.count / max) * 100)}%` })}
              />
            </div>
            <span className="w-10 shrink-0 text-left text-white/50 text-xs tabular-nums">{g.percentage}%</span>
          </div>
        ))}
      </div>
    </SlideLayout>
  );
}

function SlideMonths({ stats }: { stats: WrappedStats }) {
  const bm = stats.busiestMonth!;
  const useHours = stats.totalSessions > 0;
  const values = stats.monthlyActivity.map((m) => (useHours ? m.hours : m.gamesAdded));
  const max = Math.max(1, ...values);
  return (
    <SlideLayout
      eyebrow="Your peak month"
      title={<span className="wr-gradient-text" style={{ ['--wr-gradient' as string]: 'linear-gradient(100deg, #fdba74, #fb7185 55%, #f0abfc)' } as CSSProperties}>{bm.monthLong}</span>}
      titleClassName="text-[length:clamp(36px,10cqmin,84px)]"
      subtitle={useHours
        ? `${formatDuration(bm.hours * 60)} across ${plural(bm.sessions, 'session')}${bm.gamesAdded ? ` and ${plural(bm.gamesAdded, 'new game')}` : ''}.`
        : `${plural(bm.gamesAdded, 'game')} added to your library.`}
    >
      <div className="flex items-end gap-[clamp(4px,1cqmin,10px)] w-full max-w-[600px] h-[clamp(90px,24cqh,190px)]" aria-hidden>
        {stats.monthlyActivity.map((m, i) => {
          const v = values[i];
          const isPeak = i === bm.index;
          return (
            <div key={m.month} className="flex-1 h-full flex flex-col items-center justify-end gap-1.5">
              <div
                className={cn(
                  'wr-grow-y w-full rounded-t-md',
                  isPeak ? 'bg-gradient-to-t from-orange-600 to-amber-300' : v > 0 ? 'bg-white/[0.16]' : 'bg-white/[0.06]',
                )}
                style={d(360 + i * 50, { height: `${Math.max(3, (v / max) * 100)}%` })}
              />
              <span className={cn('text-[9px]', isPeak ? 'text-amber-200 font-bold' : 'text-white/30')}>{m.month}</span>
            </div>
          );
        })}
      </div>
      <p className="sr-only">Monthly activity: {MONTHS_LONG.map((name, i) => `${name} ${values[i]}`).join(', ')}</p>
    </SlideLayout>
  );
}

function SlideWeek({ stats }: { stats: WrappedStats }) {
  const max = Math.max(1, ...stats.dayOfWeekBreakdown.map((x) => x.hours));
  return (
    <SlideLayout
      eyebrow="Your week"
      title={<>{stats.busiestDayOfWeekLong}s were <span className="wr-gradient-text">game days</span></>}
      subtitle="Hours played by day of the week."
    >
      <div className="flex items-end gap-[clamp(8px,2cqmin,18px)] w-full max-w-[480px] h-[clamp(100px,26cqh,200px)]">
        {stats.dayOfWeekBreakdown.map((x, i) => {
          const peak = x.day === stats.busiestDayOfWeek;
          return (
            <div key={x.day} className="flex-1 h-full flex flex-col items-center justify-end gap-1.5">
              <span className={cn('wr-fade text-[10px] tabular-nums', peak ? 'text-cyan-200' : 'text-white/35')} style={d(700 + i * 60)}>
                {x.hours > 0 ? `${x.hours}h` : ''}
              </span>
              <div
                className={cn('wr-grow-y w-full rounded-t-lg', peak ? 'bg-gradient-to-t from-violet-600 to-cyan-300' : 'bg-white/[0.14]')}
                style={d(320 + i * 70, { height: `${Math.max(3, (x.hours / max) * 100)}%` })}
              />
              <span className={cn('text-xs', peak ? 'text-cyan-200 font-semibold' : 'text-white/40')}>{DAYS_OF_WEEK[i]}</span>
            </div>
          );
        })}
      </div>
    </SlideLayout>
  );
}

function SlideCompletion({ stats }: { stats: WrappedStats }) {
  const R = 42;
  const C = 2 * Math.PI * R;
  const offset = C - (C * stats.completionRate) / 100;
  const base = Math.max(stats.gamesPlayed, stats.gamesCompleted);
  return (
    <SlideLayout
      eyebrow="Finish line"
      title={stats.gamesCompleted > 0 ? `${plural(stats.gamesCompleted, 'game')} completed` : 'Still on the journey'}
      subtitle={stats.gamesCompleted > 0
        ? `That's ${stats.gamesCompleted} of the ${base} games you spent time with this year.`
        : 'Nothing crossed the finish line this year — the best endings are still ahead.'}
    >
      <div className="wr-pop relative w-[clamp(110px,26cqmin,190px)] aspect-square" style={d(250)}>
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" aria-hidden>
          <defs>
            <linearGradient id="wr-ring-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#67e8f9" />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7" />
          <circle
            className="wr-ring"
            cx="50" cy="50" r={R} fill="none" stroke="url(#wr-ring-grad)" strokeWidth="7" strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
            style={d(420, { ['--wr-ring-from' as string]: String(C) })}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display font-black text-emerald-300 text-[length:clamp(22px,5.4cqmin,40px)] leading-none">
            <CountNumber value={stats.completionRate} suffix="%" delay={480} />
          </span>
          <span className="text-white/40 text-[9px] uppercase tracking-[0.2em] mt-1">finished</span>
        </div>
      </div>
      {stats.completedGames.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2.5 max-w-[520px]">
          {stats.completedGames.slice(0, 6).map((g, i) => (
            <div key={g.gameId} className="wr-pop relative" style={d(800 + i * 80)} title={g.title}>
              <CoverImage gameId={g.gameId} title={g.title} coverUrl={g.coverUrl} className="w-[clamp(40px,8cqmin,60px)] aspect-[3/4] rounded-lg border border-emerald-400/20" />
              <Trophy className="absolute -top-1.5 -right-1.5 w-4 h-4 text-amber-300 drop-shadow" />
            </div>
          ))}
          {stats.completedGames.length > 6 && (
            <span className="wr-fade self-center text-white/40 text-xs ml-1" style={d(1300)}>+{stats.completedGames.length - 6} more</span>
          )}
        </div>
      )}
    </SlideLayout>
  );
}

const PERIOD_ICON: Record<TimeOfDayIcon, typeof Sun> = { moon: Moon, sunrise: Sunrise, sun: Sun, sunset: Sunset };
const PERIOD_COLOR: Record<TimeOfDayIcon, string> = {
  sunrise: 'text-orange-200', sun: 'text-amber-300', sunset: 'text-rose-300', moon: 'text-indigo-300',
};
const PERIOD_BAR: Record<TimeOfDayIcon, string> = {
  sunrise: 'from-orange-400 to-amber-200', sun: 'from-amber-500 to-yellow-200', sunset: 'from-rose-500 to-pink-300', moon: 'from-indigo-500 to-violet-300',
};
const PERIOD_TITLE: Record<TimeOfDayIcon, string> = {
  moon: 'A true night owl', sunset: 'An evening player', sun: 'An afternoon regular', sunrise: 'An early riser',
};
const PERIOD_HINT: Record<TimeOfDayIcon, string> = {
  moon: 'Most of your playtime happened after midnight.',
  sunset: 'Your controller came alive once the sun went down.',
  sun: 'Afternoons were your favourite time to play.',
  sunrise: 'You liked to get a session in before the day began.',
};

function SlidePatterns({ stats }: { stats: WrappedStats }) {
  const dom = stats.dominantPeriod || 'sunset';
  const HeroIcon = PERIOD_ICON[dom];
  return (
    <SlideLayout eyebrow="When you play" title={PERIOD_TITLE[dom]} subtitle={PERIOD_HINT[dom]}>
      <div className="wr-pop" style={d(260)}>
        <HeroIcon className={cn('w-[clamp(40px,9cqmin,64px)] h-[clamp(40px,9cqmin,64px)]', PERIOD_COLOR[dom])} />
      </div>
      <div className="grid grid-cols-2 gap-[clamp(8px,1.8cqmin,14px)] w-full max-w-[460px]">
        {stats.playTimeOfDay.map((p, i) => {
          const Icon = PERIOD_ICON[p.icon];
          return (
            <Card key={p.period} className="wr-rise p-3 text-left" style={d(420 + i * 90)}>
              <div className="flex items-center gap-2.5">
                <Icon className={cn('w-4 h-4 shrink-0', PERIOD_COLOR[p.icon])} />
                <span className="text-white/65 text-xs flex-1">{p.period}</span>
                <span className={cn('font-display font-bold text-sm tabular-nums', PERIOD_COLOR[p.icon])}>{p.percentage}%</span>
              </div>
              <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                <div className={cn('wr-grow-x h-full rounded-full bg-gradient-to-r', PERIOD_BAR[p.icon])} style={d(600 + i * 90, { width: `${Math.max(2, p.percentage)}%` })} />
              </div>
            </Card>
          );
        })}
      </div>
    </SlideLayout>
  );
}

function criticTitle(avg: number) {
  if (avg >= 4.5) return 'The generous critic';
  if (avg >= 3.5) return 'The fair judge';
  if (avg >= 2.5) return 'The tough reviewer';
  return 'The harsh critic';
}

function SlideRatings({ stats }: { stats: WrappedStats }) {
  const max = Math.max(1, ...stats.ratingDistribution.map((r) => r.count));
  return (
    <SlideLayout
      eyebrow="The critic"
      title={criticTitle(stats.avgRating)}
      subtitle={`You rated ${plural(stats.totalRatings, 'game')} you played this year.`}
    >
      <div className="wr-pop flex items-center gap-3" style={d(260)}>
        <span className="font-display font-black text-amber-300 text-[length:clamp(36px,9cqmin,64px)] leading-none">
          <CountNumber value={stats.avgRating} decimals={1} delay={320} />
        </span>
        <div className="flex gap-0.5" aria-hidden>
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} className={cn('w-5 h-5', i < Math.round(stats.avgRating) ? 'text-amber-300 fill-amber-300' : 'text-white/15')} />
          ))}
        </div>
      </div>
      <div className="w-full max-w-[420px] flex flex-col gap-2">
        {[...stats.ratingDistribution].reverse().map((r, i) => (
          <div key={r.rating} className="wr-from-left flex items-center gap-3" style={d(420 + i * 80)}>
            <span className="w-12 shrink-0 flex items-center justify-end gap-1 text-white/55 text-xs">
              {r.rating}<Star className="w-3 h-3 text-amber-300 fill-amber-300" />
            </span>
            <div className="flex-1 h-3 rounded-full bg-white/[0.05] overflow-hidden">
              {r.count > 0 && (
                <div className="wr-grow-x h-full rounded-full bg-gradient-to-r from-amber-500 to-yellow-200" style={d(560 + i * 80, { width: `${(r.count / max) * 100}%` })} />
              )}
            </div>
            <span className="w-6 shrink-0 text-left text-white/45 text-xs tabular-nums">{r.count}</span>
          </div>
        ))}
      </div>
    </SlideLayout>
  );
}

function SlideFacts({ stats }: { stats: WrappedStats }) {
  const facts = stats.funFacts.slice(0, 5);
  return (
    <SlideLayout eyebrow="Did you know" title="A few things we noticed">
      <ul className="flex flex-col gap-[clamp(6px,1.4cqh,12px)] w-full max-w-[540px]">
        {facts.map((f, i) => (
          <li key={f} className="wr-from-left" style={d(300 + i * 140)}>
            <Card className="flex items-start gap-3 p-[clamp(10px,2.2cqmin,16px)] text-left">
              <Sparkles className="w-4 h-4 text-fuchsia-300 mt-0.5 shrink-0" />
              <p className="text-white/75 text-[length:clamp(12px,1.9cqmin,15px)] leading-relaxed">{f}</p>
            </Card>
          </li>
        ))}
      </ul>
    </SlideLayout>
  );
}

const SHARES = [
  { id: 'twitter' as const, icon: Twitter, label: 'Share on X' },
  { id: 'reddit' as const, icon: MessageCircle, label: 'Share on Reddit' },
  { id: 'whatsapp' as const, icon: Send, label: 'Share on WhatsApp' },
  { id: 'copy' as const, icon: Link2, label: 'Copy summary' },
];

function SlideFinale({ stats }: { stats: WrappedStats }) {
  const actions = useContext(WrappedActionsContext);
  const { exporting } = useWrappedMotion();
  const summary = [
    { label: 'Hours', value: Math.round(stats.totalHoursPlayed), color: 'text-sky-300' },
    { label: 'Games', value: stats.gamesPlayed || stats.totalGamesAdded, color: 'text-fuchsia-300' },
    { label: 'Completed', value: stats.gamesCompleted, color: 'text-emerald-300' },
  ];
  const progress = actions?.exportProgress;
  return (
    <SlideLayout>
      {exporting && (
        <p className="wr-eyebrow text-[11px] font-semibold text-fuchsia-200/70">Ark Wrapped {stats.year}</p>
      )}
      <p className="wr-rise text-white/50 text-[length:clamp(12px,2cqmin,16px)]" style={d(120)}>This year, you were</p>
      <h2
        className="wr-pop font-display font-black leading-[1.02] wr-gradient-text text-[length:clamp(34px,9cqmin,80px)] max-w-[16ch]"
        style={d(220, { ['--wr-gradient' as string]: 'linear-gradient(100deg, #a78bfa, #f0abfc 45%, #67e8f9)' })}
      >
        {stats.gamerTitle}
      </h2>
      <p className="wr-rise text-white/60 italic text-[length:clamp(12px,2cqmin,16px)]" style={d(420)}>{stats.gamerTagline}</p>

      <div className="wr-rise grid grid-cols-3 gap-[clamp(16px,5cqmin,44px)]" style={d(560)}>
        {summary.map((s, i) => (
          <div key={s.label}>
            <p className={cn('font-display font-black text-[length:clamp(22px,5cqmin,40px)] leading-none', s.color)}>
              <CountNumber value={s.value} delay={640 + i * 100} />
            </p>
            <p className="text-white/40 text-[10px] uppercase tracking-[0.2em] mt-1.5">{s.label}</p>
          </div>
        ))}
      </div>

      {stats.topGame && (
        <div className="wr-fade flex items-center gap-3" style={d(800)}>
          <CoverImage gameId={stats.topGame.gameId} title={stats.topGame.title} coverUrl={stats.topGame.coverUrl} className="w-8 aspect-[2/3] rounded" />
          <span className="text-white/50 text-sm">Most played: <Accent>{stats.topGame.title}</Accent></span>
        </div>
      )}

      {exporting ? (
        <p className="text-white/40 text-sm mt-2">See you next year.</p>
      ) : actions && (
        <div data-wrapped-interactive className="wr-rise flex flex-col items-center gap-3 mt-2" style={d(1000)}>
          {actions.onLaunchFlythrough && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); actions.onLaunchFlythrough?.(); }}
              className="group flex items-center gap-2 h-11 px-6 rounded-full bg-gradient-to-r from-violet-600/80 via-fuchsia-600/80 to-cyan-600/70 hover:from-violet-500 hover:via-fuchsia-500 hover:to-cyan-500 border border-white/15 text-white text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
            >
              <Sparkles className="w-4 h-4" />
              Fly through your year in the Galaxy
            </button>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); actions.onSaveImages(); }}
              disabled={!!progress}
              className="flex items-center gap-2 h-9 px-4 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/12 text-white/80 text-xs font-medium transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
            >
              {progress ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {progress ? `Saving ${progress.current} of ${progress.total}…` : 'Save as images'}
            </button>
            {SHARES.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.label}
                aria-label={s.label}
                onClick={(e) => { e.stopPropagation(); actions.onShare(s.id); }}
                className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-white/60 hover:text-white flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300"
              >
                <s.icon className="w-4 h-4" />
              </button>
            ))}
          </div>
          <p className="wr-tall-only text-white/30 text-xs mt-1">See you next year.</p>
        </div>
      )}
    </SlideLayout>
  );
}
