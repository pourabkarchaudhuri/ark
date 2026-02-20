/**
 * Year Wrapped — "Ark Wrapped" end-of-year gaming recap experience.
 *
 * Spotify-Wrapped-style full-screen storytelling with animated slides
 * that recap the user's gaming year from journey, library, session &
 * status-history data stores.
 *
 * Uses ReactBits-adapted components (CountUp, BlurText, GradientText,
 * ShinyText) plus Framer Motion for cinematic transitions.
 */

import { useState, useMemo, useCallback, useEffect, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Gamepad2, Clock, Trophy, Star,
  ChevronLeft, ChevronRight, TrendingUp,
  Moon, Sun, Sunrise, Sunset,
} from 'lucide-react';
import { cn, formatHours, buildGameImageChain } from '@/lib/utils';
import { journeyStore } from '@/services/journey-store';
import { sessionStore } from '@/services/session-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { libraryStore } from '@/services/library-store';
import type { JourneyEntry } from '@/types/game';

import CountUp from '@/components/reactbits/CountUp';
import BlurText from '@/components/reactbits/BlurText';
import GradientText from '@/components/reactbits/GradientText';
import ShinyText from '@/components/reactbits/ShinyText';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WrappedStats {
  year: number;
  totalGamesAdded: number;
  totalHoursPlayed: number;
  totalSessions: number;
  gamesCompleted: number;
  topGame: {
    title: string;
    hours: number;
    sessions: number;
    coverUrl?: string;
    genre: string[];
    gameId: string;
  } | null;
  top5Games: {
    title: string;
    hours: number;
    rating: number;
    coverUrl?: string;
    gameId: string;
  }[];
  genreBreakdown: { genre: string; count: number; percentage: number }[];
  topGenre: string;
  gamerTitle: string;
  busiestMonth: { month: string; count: number };
  monthlyActivity: { month: string; gamesAdded: number; sessions: number }[];
  completionRate: number;
  completedGames: { title: string; coverUrl?: string; gameId: string }[];
  playTimeOfDay: { period: string; percentage: number; icon: 'moon' | 'sunrise' | 'sun' | 'sunset' }[];
  isNightOwl: boolean;
  nightPercentage: number;
  platformBreakdown: { platform: string; count: number }[];
  statusChanges: number;
  firstGameAdded: { title: string; date: string } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getGamerTitle(topGenre: string, completionRate: number, isNightOwl: boolean, totalHours: number): string {
  if (totalHours > 500) return 'The Legend';
  if (completionRate > 70) return 'The Completionist';
  if (isNightOwl) return 'The Night Owl';
  const genreTitles: Record<string, string> = {
    'Action': 'The Action Hero',
    'RPG': 'The Adventurer',
    'Strategy': 'The Mastermind',
    'Simulation': 'The Architect',
    'Adventure': 'The Explorer',
    'Puzzle': 'The Problem Solver',
    'Racing': 'The Speed Demon',
    'Sports': 'The Athlete',
    'Horror': 'The Fearless',
    'Shooter': 'The Sharpshooter',
    'Indie': 'The Indie Soul',
    'Casual': 'The Casual King',
  };
  for (const [key, title] of Object.entries(genreTitles)) {
    if (topGenre.toLowerCase().includes(key.toLowerCase())) return title;
  }
  return 'The Gamer';
}

function computeStats(year: number): WrappedStats {
  const allJourney = journeyStore.getAllEntries();
  const allSessions = sessionStore.getAll();
  const allStatusChanges = statusHistoryStore.getAll();

  // Filter to selected year
  const yearJourney = allJourney.filter((e) => new Date(e.addedAt).getFullYear() === year);
  const yearSessions = allSessions.filter((s) => new Date(s.startTime).getFullYear() === year);
  const yearStatusChanges = allStatusChanges.filter((s) => new Date(s.timestamp).getFullYear() === year);

  // Total hours from journey entries
  const totalHoursFromJourney = yearJourney.reduce((sum, e) => sum + (e.hoursPlayed || 0), 0);
  const totalHoursFromSessions = yearSessions.reduce((sum, s) => sum + s.durationMinutes / 60, 0);
  const totalHoursPlayed = Math.max(totalHoursFromJourney, totalHoursFromSessions);

  // Completed games
  const completedGames = yearJourney.filter((e) => e.status === 'Completed');
  const completionRate = yearJourney.length > 0 ? Math.round((completedGames.length / yearJourney.length) * 100) : 0;

  // Top games by hours
  const gameHoursMap = new Map<string, { entry: JourneyEntry; sessions: number }>();
  for (const entry of yearJourney) {
    const sessions = yearSessions.filter((s) => s.gameId === entry.gameId).length;
    gameHoursMap.set(entry.gameId, { entry, sessions });
  }
  const sortedByHours = [...gameHoursMap.entries()].sort(
    (a, b) => (b[1].entry.hoursPlayed || 0) - (a[1].entry.hoursPlayed || 0),
  );

  const topGame = sortedByHours[0]
    ? {
        title: sortedByHours[0][1].entry.title,
        hours: sortedByHours[0][1].entry.hoursPlayed || 0,
        sessions: sortedByHours[0][1].sessions,
        coverUrl: sortedByHours[0][1].entry.coverUrl,
        genre: sortedByHours[0][1].entry.genre || [],
        gameId: sortedByHours[0][0],
      }
    : null;

  const top5Games = sortedByHours.slice(0, 5).map(([id, { entry }]) => ({
    title: entry.title,
    hours: entry.hoursPlayed || 0,
    rating: entry.rating || 0,
    coverUrl: entry.coverUrl,
    gameId: id,
  }));

  // Genre breakdown
  const genreCounts = new Map<string, number>();
  for (const entry of yearJourney) {
    for (const g of entry.genre || []) {
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
  }
  const totalGenreTags = [...genreCounts.values()].reduce((s, c) => s + c, 0) || 1;
  const genreBreakdown = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([genre, count]) => ({
      genre,
      count,
      percentage: Math.round((count / totalGenreTags) * 100),
    }));
  const topGenre = genreBreakdown[0]?.genre || 'Gaming';

  // Monthly activity
  const monthlyActivity = MONTHS.map((month, i) => {
    const gamesAdded = yearJourney.filter((e) => new Date(e.addedAt).getMonth() === i).length;
    const sessions = yearSessions.filter((s) => new Date(s.startTime).getMonth() === i).length;
    return { month, gamesAdded, sessions };
  });
  const busiestMonth = monthlyActivity.reduce(
    (best, m) => (m.gamesAdded + m.sessions > best.count ? { month: m.month, count: m.gamesAdded + m.sessions } : best),
    { month: 'Jan', count: 0 },
  );

  // Play time of day — distribute actual minutes across the buckets each
  // session spans (night 0-6, morning 6-12, afternoon 12-18, evening 18-24).
  const minuteBuckets = [0, 0, 0, 0];
  const BUCKET_BOUNDARIES = [0, 6, 12, 18, 24]; // hour boundaries
  for (const s of yearSessions) {
    const start = new Date(s.startTime);
    const end = new Date(s.endTime);
    if (end <= start) continue;

    let cursor = new Date(start);
    while (cursor < end) {
      const h = cursor.getHours();
      const bucketIdx = h < 6 ? 0 : h < 12 ? 1 : h < 18 ? 2 : 3;
      const nextBoundaryHour = BUCKET_BOUNDARIES[bucketIdx + 1];

      const nextBoundary = new Date(cursor);
      nextBoundary.setHours(nextBoundaryHour, 0, 0, 0);
      if (nextBoundaryHour === 24) {
        nextBoundary.setDate(nextBoundary.getDate() + 1);
        nextBoundary.setHours(0, 0, 0, 0);
      }

      const segmentEnd = nextBoundary < end ? nextBoundary : end;
      minuteBuckets[bucketIdx] += (segmentEnd.getTime() - cursor.getTime()) / 60_000;
      cursor = segmentEnd;
    }
  }
  const totalBuckets = minuteBuckets.reduce((s, c) => s + c, 0) || 1;
  const playTimeOfDay = [
    { period: 'Night', percentage: Math.round((minuteBuckets[0] / totalBuckets) * 100), icon: 'moon' as const },
    { period: 'Morning', percentage: Math.round((minuteBuckets[1] / totalBuckets) * 100), icon: 'sunrise' as const },
    { period: 'Afternoon', percentage: Math.round((minuteBuckets[2] / totalBuckets) * 100), icon: 'sun' as const },
    { period: 'Evening', percentage: Math.round((minuteBuckets[3] / totalBuckets) * 100), icon: 'sunset' as const },
  ];
  const nightPercentage = playTimeOfDay[0].percentage + playTimeOfDay[3].percentage;
  const isNightOwl = nightPercentage > 50;

  // Platform breakdown
  const platformCounts = new Map<string, number>();
  for (const entry of yearJourney) {
    for (const p of entry.platform || []) {
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }
  }
  const platformBreakdown = [...platformCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => ({ platform, count }));

  // First game added
  const sorted = [...yearJourney].sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
  const firstGameAdded = sorted[0]
    ? { title: sorted[0].title, date: new Date(sorted[0].addedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) }
    : null;

  const gamerTitle = getGamerTitle(topGenre, completionRate, isNightOwl, totalHoursPlayed);

  return {
    year,
    totalGamesAdded: yearJourney.length,
    totalHoursPlayed: Math.round(totalHoursPlayed * 10) / 10,
    totalSessions: yearSessions.length,
    gamesCompleted: completedGames.length,
    topGame,
    top5Games,
    genreBreakdown,
    topGenre,
    gamerTitle,
    busiestMonth,
    monthlyActivity,
    completionRate,
    completedGames: completedGames.map((e) => ({ title: e.title, coverUrl: e.coverUrl, gameId: e.gameId })),
    playTimeOfDay,
    isNightOwl,
    nightPercentage,
    platformBreakdown,
    statusChanges: yearStatusChanges.length,
    firstGameAdded,
  };
}

// ─── Cover Image Component ───────────────────────────────────────────────────

function CoverImage({ gameId, title, coverUrl, className }: {
  gameId: string; title: string; coverUrl?: string; className?: string;
}) {
  const chain = useMemo(() => {
    const meta = libraryStore.getEntry(gameId)?.cachedMeta;
    return buildGameImageChain(gameId, title, coverUrl || meta?.coverUrl, meta?.headerImage);
  }, [gameId, title, coverUrl]);

  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  if (failed || chain.length === 0) {
    return (
      <div className={cn('bg-gradient-to-br from-fuchsia-900/40 to-purple-900/40 flex items-center justify-center', className)}>
        <Gamepad2 className="w-8 h-8 text-white/20" />
      </div>
    );
  }

  return (
    <img
      src={chain[attempt]}
      alt={title}
      className={className}
      loading="eager"
      onError={() => {
        if (attempt + 1 < chain.length) setAttempt(attempt + 1);
        else setFailed(true);
      }}
    />
  );
}

// ─── Slide Backgrounds ───────────────────────────────────────────────────────

const SLIDE_GRADIENTS = [
  'radial-gradient(ellipse at 20% 50%, rgba(120,0,255,0.15) 0%, transparent 70%), radial-gradient(ellipse at 80% 20%, rgba(255,0,128,0.1) 0%, transparent 60%)',
  'radial-gradient(ellipse at 50% 80%, rgba(59,130,246,0.15) 0%, transparent 60%), radial-gradient(ellipse at 20% 20%, rgba(168,85,247,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 70% 30%, rgba(236,72,153,0.2) 0%, transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(139,92,246,0.15) 0%, transparent 50%)',
  'radial-gradient(ellipse at 30% 60%, rgba(245,158,11,0.12) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(236,72,153,0.1) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 50%, rgba(34,197,94,0.12) 0%, transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(59,130,246,0.1) 0%, transparent 50%)',
  'radial-gradient(ellipse at 60% 40%, rgba(236,72,153,0.15) 0%, transparent 60%), radial-gradient(ellipse at 30% 80%, rgba(168,85,247,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 40% 30%, rgba(6,182,212,0.15) 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, rgba(168,85,247,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 20%, rgba(99,102,241,0.15) 0%, transparent 60%), radial-gradient(ellipse at 50% 80%, rgba(236,72,153,0.1) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 50%, rgba(139,92,246,0.2) 0%, transparent 50%), radial-gradient(ellipse at 20% 20%, rgba(236,72,153,0.15) 0%, transparent 60%)',
];

// ─── Animated Particles CSS ──────────────────────────────────────────────────

const particleKeyframes = `
@keyframes float-particle {
  0%, 100% { transform: translateY(0px) translateX(0px); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  50% { transform: translateY(-40vh) translateX(20px); }
}
`;

function FloatingParticles() {
  return (
    <>
      <style>{particleKeyframes}</style>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              width: 2 + Math.random() * 3,
              height: 2 + Math.random() * 3,
              left: `${Math.random() * 100}%`,
              top: `${60 + Math.random() * 40}%`,
              background: `rgba(${168 + Math.random() * 87}, ${85 + Math.random() * 170}, ${247}, ${0.3 + Math.random() * 0.4})`,
              animation: `float-particle ${8 + Math.random() * 12}s ease-in-out ${Math.random() * 8}s infinite`,
            }}
          />
        ))}
      </div>
    </>
  );
}

// ─── Slide Transition Variants ───────────────────────────────────────────────

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? '100%' : '-100%',
    opacity: 0,
    scale: 0.9,
  }),
  center: {
    x: 0,
    opacity: 1,
    scale: 1,
  },
  exit: (direction: number) => ({
    x: direction < 0 ? '100%' : '-100%',
    opacity: 0,
    scale: 0.9,
  }),
};

// ─── Individual Slides ───────────────────────────────────────────────────────

function SlideIntro({ stats, active }: { stats: WrappedStats; active: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={active ? { scale: 1, opacity: 1 } : {}}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <GradientText
          className="text-[120px] md:text-[180px] font-black leading-none tracking-tighter"
          colors={['#a855f7', '#ec4899', '#6366f1', '#a855f7']}
          animationSpeed={4}
        >
          {stats.year}
        </GradientText>
      </motion.div>

      <BlurText
        text="Your Year in Gaming"
        className="text-3xl md:text-5xl font-bold text-white justify-center"
        delay={80}
        animateBy="words"
        direction="bottom"
        startWhen={active}
      />

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={active ? { opacity: 0.5, y: 0 } : {}}
        transition={{ delay: 1.5, duration: 0.8 }}
        className="text-white/50 text-lg"
      >
        Let's look back at your journey...
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ delay: 2.5, duration: 0.6 }}
        className="flex items-center gap-2 text-white/30 text-sm mt-8"
      >
        <ChevronRight className="w-4 h-4 animate-pulse" />
        <span>Press arrow keys or click to continue</span>
      </motion.div>
    </div>
  );
}

function SlideNumbers({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const items = [
    { icon: Gamepad2, label: 'Games Added', value: stats.totalGamesAdded, color: 'text-fuchsia-400', bg: 'bg-fuchsia-500/10' },
    { icon: Clock, label: 'Hours Played', value: Math.round(stats.totalHoursPlayed), suffix: 'h', color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { icon: TrendingUp, label: 'Play Sessions', value: stats.totalSessions, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { icon: Trophy, label: 'Games Completed', value: stats.gamesCompleted, color: 'text-amber-400', bg: 'bg-amber-500/10' },
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8">
      <BlurText
        text="The Numbers"
        className="text-4xl md:text-5xl font-bold text-white justify-center mb-4"
        delay={60}
        animateBy="letters"
        startWhen={active}
      />

      <div className="grid grid-cols-2 gap-6 max-w-lg w-full">
        {items.map((item, i) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 40, scale: 0.8 }}
            animate={active ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ delay: 0.5 + i * 0.2, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className={cn('rounded-2xl p-6 border border-white/5 backdrop-blur-sm text-center', item.bg)}
          >
            <item.icon className={cn('w-6 h-6 mx-auto mb-3', item.color)} />
            <div className={cn('text-4xl md:text-5xl font-black', item.color)}>
              <CountUp to={item.value} duration={2.5} startWhen={active} suffix={item.suffix || ''} separator="," />
            </div>
            <p className="text-white/40 text-xs mt-2 uppercase tracking-wider">{item.label}</p>
          </motion.div>
        ))}
      </div>

      {stats.firstGameAdded && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.4 } : {}}
          transition={{ delay: 2 }}
          className="text-white/40 text-sm mt-4"
        >
          It all started with <span className="text-fuchsia-400 font-medium">{stats.firstGameAdded.title}</span> on {stats.firstGameAdded.date}
        </motion.p>
      )}
    </div>
  );
}

function SlideTopGame({ stats, active }: { stats: WrappedStats; active: boolean }) {
  if (!stats.topGame) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-white/40 text-lg">No games played this year</p>
      </div>
    );
  }

  const { title, hours, sessions, genre, gameId, coverUrl } = stats.topGame;
  const movieEquivalent = Math.round(hours / 2);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ delay: 0.2 }}
      >
        <ShinyText text="YOUR #1 GAME" className="text-sm font-bold tracking-[0.3em] text-fuchsia-300/80" speed={3} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.7, rotateY: -15 }}
        animate={active ? { opacity: 1, scale: 1, rotateY: 0 } : {}}
        transition={{ delay: 0.4, duration: 1, ease: [0.16, 1, 0.3, 1] }}
        className="relative"
      >
        <div className="absolute -inset-2 bg-gradient-to-r from-fuchsia-500/30 to-purple-500/30 rounded-2xl blur-xl" />
        <CoverImage
          gameId={gameId}
          title={title}
          coverUrl={coverUrl}
          className="relative w-48 h-72 md:w-56 md:h-80 object-cover rounded-xl shadow-2xl shadow-fuchsia-500/20"
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ delay: 0.8, duration: 0.6 }}
        className="text-center"
      >
        <GradientText
          className="text-3xl md:text-4xl font-black"
          colors={['#e879f9', '#c084fc', '#818cf8']}
          animationSpeed={5}
        >
          {title}
        </GradientText>
      </motion.div>

      <div className="flex items-center gap-6 mt-2">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={active ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: 1.2 }}
          className="text-center"
        >
          <p className="text-3xl font-black text-blue-400">
            <CountUp to={Math.round(hours)} duration={2} startWhen={active} />
          </p>
          <p className="text-white/40 text-xs uppercase tracking-wider">Hours</p>
        </motion.div>
        <div className="w-px h-8 bg-white/10" />
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={active ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: 1.4 }}
          className="text-center"
        >
          <p className="text-3xl font-black text-emerald-400">
            <CountUp to={sessions} duration={2} startWhen={active} />
          </p>
          <p className="text-white/40 text-xs uppercase tracking-wider">Sessions</p>
        </motion.div>
      </div>

      {genre.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.6 } : {}}
          transition={{ delay: 1.6 }}
          className="flex gap-2 mt-1"
        >
          {genre.slice(0, 3).map((g) => (
            <span key={g} className="text-[10px] px-2 py-0.5 rounded-full border border-fuchsia-500/20 text-fuchsia-400/60 uppercase tracking-wider">
              {g}
            </span>
          ))}
        </motion.div>
      )}

      {movieEquivalent > 0 && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.35 } : {}}
          transition={{ delay: 2 }}
          className="text-white/35 text-sm mt-4 italic"
        >
          That's like watching {movieEquivalent} movies
        </motion.p>
      )}
    </div>
  );
}

function SlideTop5({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const medals = ['text-amber-400', 'text-zinc-300', 'text-orange-600', 'text-white/40', 'text-white/30'];
  const glows = ['shadow-amber-500/20', 'shadow-zinc-300/10', 'shadow-orange-600/10', '', ''];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Your Top 5"
        className="text-4xl md:text-5xl font-bold text-white justify-center mb-2"
        delay={60}
        animateBy="letters"
        startWhen={active}
      />

      <div className="flex flex-col gap-3 w-full max-w-md">
        {stats.top5Games.map((game, i) => (
          <motion.div
            key={game.gameId}
            initial={{ opacity: 0, x: -60 }}
            animate={active ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.5 + i * 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'flex items-center gap-4 rounded-xl p-3 border border-white/5 bg-white/[0.03] backdrop-blur-sm',
              i === 0 && 'border-amber-500/20 bg-amber-500/[0.04]',
            )}
          >
            <span className={cn('text-2xl font-black w-8 text-center', medals[i] || 'text-white/30')}>
              {i + 1}
            </span>
            <CoverImage
              gameId={game.gameId}
              title={game.title}
              coverUrl={game.coverUrl}
              className={cn('w-12 h-16 object-cover rounded-lg shadow-lg', glows[i])}
            />
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold truncate">{game.title}</p>
              <p className="text-white/40 text-xs">{formatHours(game.hours)}</p>
            </div>
            {game.rating > 0 && (
              <div className="flex items-center gap-0.5">
                {Array.from({ length: 5 }).map((_, si) => (
                  <Star
                    key={si}
                    className={cn('w-3 h-3', si < game.rating ? 'text-amber-400 fill-amber-400' : 'text-white/10')}
                  />
                ))}
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function SlideGenreDNA({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const maxCount = stats.genreBreakdown[0]?.count || 1;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Your Genre DNA"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: 0.6, duration: 0.6 }}
        className="text-center"
      >
        <p className="text-white/50 text-sm">You're</p>
        <GradientText
          className="text-2xl md:text-3xl font-black"
          colors={['#e879f9', '#f472b6', '#c084fc']}
          animationSpeed={4}
        >
          {stats.gamerTitle}
        </GradientText>
      </motion.div>

      <div className="w-full max-w-md space-y-3 mt-4">
        {stats.genreBreakdown.map((g, i) => (
          <motion.div
            key={g.genre}
            initial={{ opacity: 0, x: -40 }}
            animate={active ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.8 + i * 0.1, duration: 0.5 }}
            className="flex items-center gap-3"
          >
            <span className="text-white/50 text-xs w-24 text-right truncate">{g.genre}</span>
            <div className="flex-1 h-6 bg-white/5 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={active ? { width: `${(g.count / maxCount) * 100}%` } : { width: 0 }}
                transition={{ delay: 1 + i * 0.1, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="h-full rounded-full bg-gradient-to-r from-fuchsia-600 to-purple-500"
              />
            </div>
            <span className="text-white/30 text-xs w-10">{g.percentage}%</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function SlideBusiestMonth({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const maxActivity = Math.max(...stats.monthlyActivity.map((m) => m.gamesAdded + m.sessions), 1);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Your Hottest Month"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: 0.5 }}
        className="text-center"
      >
        <GradientText
          className="text-5xl md:text-6xl font-black"
          colors={['#f97316', '#ef4444', '#ec4899']}
          animationSpeed={4}
        >
          {stats.busiestMonth.month}
        </GradientText>
        <p className="text-white/40 text-sm mt-2">
          was your peak with <span className="text-orange-400 font-semibold">{stats.busiestMonth.count}</span> activities
        </p>
      </motion.div>

      <div className="flex items-end gap-1 h-32 w-full max-w-lg mt-4">
        {stats.monthlyActivity.map((m, i) => {
          const height = ((m.gamesAdded + m.sessions) / maxActivity) * 100;
          const isBusiest = m.month === stats.busiestMonth.month;
          return (
            <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
              <motion.div
                initial={{ height: 0 }}
                animate={active ? { height: `${Math.max(height, 2)}%` } : { height: 0 }}
                transition={{ delay: 0.8 + i * 0.05, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  'w-full rounded-t-md',
                  isBusiest ? 'bg-gradient-to-t from-orange-600 to-amber-400' : 'bg-white/10',
                )}
              />
              <span className={cn('text-[9px]', isBusiest ? 'text-orange-400 font-bold' : 'text-white/20')}>
                {m.month}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SlideCompletionist({ stats, active }: { stats: WrappedStats; active: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="The Completionist"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      {/* Completion ring */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: 0.5, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-40 h-40"
      >
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
          <motion.circle
            cx="50" cy="50" r="42" fill="none"
            stroke="url(#completionGradient)" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={264}
            initial={{ strokeDashoffset: 264 }}
            animate={active ? { strokeDashoffset: 264 - (264 * stats.completionRate) / 100 } : { strokeDashoffset: 264 }}
            transition={{ delay: 0.8, duration: 2, ease: [0.16, 1, 0.3, 1] }}
          />
          <defs>
            <linearGradient id="completionGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#22c55e" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-black text-green-400">
            <CountUp to={stats.completionRate} duration={2} startWhen={active} suffix="%" />
          </span>
          <span className="text-white/30 text-[10px] uppercase tracking-wider">Completed</span>
        </div>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.5 } : {}}
        transition={{ delay: 1.5 }}
        className="text-white/50 text-sm"
      >
        {stats.gamesCompleted} of {stats.totalGamesAdded} games finished
      </motion.p>

      {stats.completedGames.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap justify-center max-w-md">
          {stats.completedGames.slice(0, 6).map((game, i) => (
            <motion.div
              key={game.gameId}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={active ? { opacity: 1, scale: 1 } : {}}
              transition={{ delay: 1.8 + i * 0.1, duration: 0.4 }}
              className="relative group"
            >
              <CoverImage
                gameId={game.gameId}
                title={game.title}
                coverUrl={game.coverUrl}
                className="w-14 h-20 object-cover rounded-lg border border-green-500/20"
              />
              <Trophy className="absolute -top-1 -right-1 w-3.5 h-3.5 text-amber-400" />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function SlidePlayPatterns({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const icons = { moon: Moon, sunrise: Sunrise, sun: Sun, sunset: Sunset };
  const colors = { moon: 'text-indigo-400', sunrise: 'text-orange-300', sun: 'text-amber-400', sunset: 'text-rose-400' };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text={stats.isNightOwl ? 'Night Owl' : 'Early Bird'}
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="letters"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: 0.5, duration: 0.8 }}
      >
        {stats.isNightOwl ? (
          <Moon className="w-16 h-16 text-indigo-400" />
        ) : (
          <Sun className="w-16 h-16 text-amber-400" />
        )}
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.6 } : {}}
        transition={{ delay: 0.8 }}
        className="text-white/60 text-sm text-center max-w-xs"
      >
        {stats.isNightOwl
          ? `${stats.nightPercentage}% of your sessions started in the evening or at night`
          : `You prefer gaming during the day — a true early bird`}
      </motion.p>

      <div className="grid grid-cols-2 gap-4 mt-4 w-full max-w-xs">
        {stats.playTimeOfDay.map((period, i) => {
          const Icon = icons[period.icon];
          return (
            <motion.div
              key={period.period}
              initial={{ opacity: 0, y: 20 }}
              animate={active ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 1 + i * 0.15 }}
              className="flex items-center gap-3 rounded-xl p-3 bg-white/[0.03] border border-white/5"
            >
              <Icon className={cn('w-5 h-5', colors[period.icon])} />
              <div>
                <p className="text-white/70 text-xs font-medium">{period.period}</p>
                <p className={cn('text-lg font-bold', colors[period.icon])}>
                  <CountUp to={period.percentage} duration={1.5} startWhen={active} suffix="%" />
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SlideFinale({ stats, active }: { stats: WrappedStats; active: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <GradientText
          className="text-5xl md:text-7xl font-black text-center leading-tight"
          colors={['#a855f7', '#ec4899', '#6366f1', '#06b6d4', '#a855f7']}
          animationSpeed={3}
        >
          {stats.gamerTitle}
        </GradientText>
      </motion.div>

      <BlurText
        text="That's who you were this year"
        className="text-lg text-white/50 justify-center"
        delay={80}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ delay: 1 }}
        className="grid grid-cols-3 gap-6 mt-6"
      >
        {[
          { value: stats.totalGamesAdded, label: 'Games', color: 'text-fuchsia-400' },
          { value: Math.round(stats.totalHoursPlayed), label: 'Hours', color: 'text-blue-400' },
          { value: stats.gamesCompleted, label: 'Completed', color: 'text-green-400' },
        ].map((item, i) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 20 }}
            animate={active ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 1.2 + i * 0.15 }}
            className="text-center"
          >
            <p className={cn('text-3xl font-black', item.color)}>
              <CountUp to={item.value} duration={2} startWhen={active} />
            </p>
            <p className="text-white/30 text-xs uppercase tracking-wider">{item.label}</p>
          </motion.div>
        ))}
      </motion.div>

      {stats.topGame && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.5 } : {}}
          transition={{ delay: 1.8 }}
          className="flex items-center gap-3 mt-4"
        >
          <CoverImage
            gameId={stats.topGame.gameId}
            title={stats.topGame.title}
            coverUrl={stats.topGame.coverUrl}
            className="w-8 h-12 object-cover rounded"
          />
          <span className="text-white/40 text-sm">
            Most played: <span className="text-fuchsia-400">{stats.topGame.title}</span>
          </span>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ delay: 2.5 }}
        className="mt-8"
      >
        <ShinyText
          text="Until next year, gamer."
          className="text-xl font-semibold"
          speed={4}
          color="#666"
          shineColor="#e879f9"
        />
      </motion.div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface YearWrappedProps {
  isOpen: boolean;
  onClose: () => void;
}

const TOTAL_SLIDES = 9;

export const YearWrapped = memo(function YearWrapped({ isOpen, onClose }: YearWrappedProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [direction, setDirection] = useState(0);
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);

  const stats = useMemo(() => (isOpen ? computeStats(selectedYear) : null), [isOpen, selectedYear]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setCurrentSlide(0);
      setDirection(0);
    }
  }, [isOpen]);

  const goNext = useCallback(() => {
    if (currentSlide < TOTAL_SLIDES - 1) {
      setDirection(1);
      setCurrentSlide((s) => s + 1);
    }
  }, [currentSlide]);

  const goPrev = useCallback(() => {
    if (currentSlide > 0) {
      setDirection(-1);
      setCurrentSlide((s) => s - 1);
    }
  }, [currentSlide]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, goNext, goPrev, onClose]);

  if (!isOpen || !stats) return null;

  const slides = [
    <SlideIntro stats={stats} active={currentSlide === 0} />,
    <SlideNumbers stats={stats} active={currentSlide === 1} />,
    <SlideTopGame stats={stats} active={currentSlide === 2} />,
    <SlideTop5 stats={stats} active={currentSlide === 3} />,
    <SlideGenreDNA stats={stats} active={currentSlide === 4} />,
    <SlideBusiestMonth stats={stats} active={currentSlide === 5} />,
    <SlideCompletionist stats={stats} active={currentSlide === 6} />,
    <SlidePlayPatterns stats={stats} active={currentSlide === 7} />,
    <SlideFinale stats={stats} active={currentSlide === 8} />,
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] bg-black flex flex-col"
        onClick={(e) => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          if (clickX > rect.width / 2) goNext();
          else goPrev();
        }}
      >
        {/* Animated background gradient */}
        <div
          className="absolute inset-0 transition-all duration-1000"
          style={{ backgroundImage: SLIDE_GRADIENTS[currentSlide % SLIDE_GRADIENTS.length] }}
        />

        <FloatingParticles />

        {/* Close button */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute top-6 right-6 z-50 w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Year selector (top-left) */}
        <div className="absolute top-6 left-6 z-50 flex items-center gap-2">
          {[currentYear - 1, currentYear].map((y) => (
            <button
              key={y}
              onClick={(e) => { e.stopPropagation(); setSelectedYear(y); setCurrentSlide(0); }}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                selectedYear === y
                  ? 'bg-fuchsia-500/20 text-fuchsia-400 border border-fuchsia-500/30'
                  : 'bg-white/5 text-white/30 border border-white/10 hover:text-white/50',
              )}
            >
              {y}
            </button>
          ))}
        </div>

        {/* Slides */}
        <div className="relative flex-1 overflow-hidden">
          <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              key={currentSlide}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0"
            >
              {slides[currentSlide]}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Navigation arrows */}
        {currentSlide > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-50 w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {currentSlide < TOTAL_SLIDES - 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-50 w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/30 hover:text-white hover:bg-white/10 transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        {/* Progress dots */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2">
          {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                setDirection(i > currentSlide ? 1 : -1);
                setCurrentSlide(i);
              }}
              className={cn(
                'h-1.5 rounded-full transition-all duration-300',
                i === currentSlide ? 'w-8 bg-fuchsia-500' : 'w-1.5 bg-white/20 hover:bg-white/30',
              )}
            />
          ))}
        </div>

        {/* Slide counter */}
        <div className="absolute bottom-8 right-6 z-50 text-white/20 text-xs">
          {currentSlide + 1} / {TOTAL_SLIDES}
        </div>
      </motion.div>
    </AnimatePresence>
  );
});
