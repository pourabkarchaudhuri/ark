/**
 * Year Wrapped — "Ark Wrapped" end-of-year gaming recap experience.
 *
 * Spotify-Wrapped-style full-screen storytelling with animated slides
 * that recap the user's gaming year from journey, library, session &
 * status-history data stores.
 *
 * Uses ReactBits-adapted components (CountUp, BlurText, GradientText,
 * ShinyText, SplitText, SpotlightCard) plus Framer Motion for cinematic
 * transitions, canvas-confetti for celebrations, and html-to-image + jszip
 * for screenshot export.
 */

import { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Gamepad2, Clock, Trophy, Star,
  ChevronLeft, ChevronRight, TrendingUp,
  Moon, Sun, Sunrise, Sunset,
  Flame, Calendar, Zap, Target,
  Download, Copy, Check,
  Twitter, MessageCircle, Send,
} from 'lucide-react';
import { cn, formatHours, buildGameImageChain } from '@/lib/utils';
import { journeyStore } from '@/services/journey-store';
import { sessionStore } from '@/services/session-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { libraryStore } from '@/services/library-store';
import type { JourneyEntry } from '@/types/game';
import confetti from 'canvas-confetti';
import { toPng } from 'html-to-image';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

import CountUp from '@/components/reactbits/CountUp';
import BlurText from '@/components/reactbits/BlurText';
import GradientText from '@/components/reactbits/GradientText';
import ShinyText from '@/components/reactbits/ShinyText';
import SplitText from '@/components/reactbits/SplitText';
import SpotlightCard from '@/components/reactbits/SpotlightCard';
import { TooltipCard } from '@/components/ui/tooltip-card';

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
  // ── Enhanced insights ──
  longestSession: { gameTitle: string; durationMinutes: number; date: string } | null;
  avgSessionMinutes: number;
  totalActiveDays: number;
  currentStreak: number;
  longestStreak: number;
  dayOfWeekBreakdown: { day: string; sessions: number; hours: number }[];
  busiestDayOfWeek: string;
  ratingDistribution: { rating: number; count: number }[];
  avgRating: number;
  totalRatings: number;
  heatmapData: Map<string, number>;
  funFacts: string[];
  topGamePercentage: number;
  newGamesPerWeek: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  const yearJourney = allJourney.filter((e) => new Date(e.addedAt).getFullYear() === year);
  const yearSessions = allSessions.filter((s) => new Date(s.startTime).getFullYear() === year);
  const yearStatusChanges = allStatusChanges.filter((s) => new Date(s.timestamp).getFullYear() === year);

  const totalHoursFromJourney = yearJourney.reduce((sum, e) => sum + (e.hoursPlayed || 0), 0);
  const totalHoursFromSessions = yearSessions.reduce((sum, s) => sum + s.durationMinutes / 60, 0);
  const totalHoursPlayed = Math.max(totalHoursFromJourney, totalHoursFromSessions);

  const completedGames = yearJourney.filter((e) => e.status === 'Completed');
  const completionRate = yearJourney.length > 0 ? Math.round((completedGames.length / yearJourney.length) * 100) : 0;

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

  const topGamePercentage = topGame && totalHoursPlayed > 0
    ? Math.round((topGame.hours / totalHoursPlayed) * 100) : 0;

  const top5Games = sortedByHours.slice(0, 5).map(([id, { entry }]) => ({
    title: entry.title,
    hours: entry.hoursPlayed || 0,
    rating: entry.rating || 0,
    coverUrl: entry.coverUrl,
    gameId: id,
  }));

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

  const monthlyActivity = MONTHS.map((month, i) => {
    const gamesAdded = yearJourney.filter((e) => new Date(e.addedAt).getMonth() === i).length;
    const sessions = yearSessions.filter((s) => new Date(s.startTime).getMonth() === i).length;
    return { month, gamesAdded, sessions };
  });
  const busiestMonth = monthlyActivity.reduce(
    (best, m) => (m.gamesAdded + m.sessions > best.count ? { month: m.month, count: m.gamesAdded + m.sessions } : best),
    { month: 'Jan', count: 0 },
  );

  const minuteBuckets = [0, 0, 0, 0];
  const BUCKET_BOUNDARIES = [0, 6, 12, 18, 24];
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

  const platformCounts = new Map<string, number>();
  for (const entry of yearJourney) {
    for (const p of entry.platform || []) {
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }
  }
  const platformBreakdown = [...platformCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => ({ platform, count }));

  const sorted = [...yearJourney].sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
  const firstGameAdded = sorted[0]
    ? { title: sorted[0].title, date: new Date(sorted[0].addedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) }
    : null;

  // ── Enhanced insights ──

  let longestSession: WrappedStats['longestSession'] = null;
  for (const s of yearSessions) {
    if (!longestSession || s.durationMinutes > longestSession.durationMinutes) {
      const entry = yearJourney.find((e) => e.gameId === s.gameId);
      longestSession = {
        gameTitle: entry?.title || 'Unknown',
        durationMinutes: s.durationMinutes,
        date: new Date(s.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      };
    }
  }

  const avgSessionMinutes = yearSessions.length > 0
    ? Math.round(yearSessions.reduce((s, v) => s + v.durationMinutes, 0) / yearSessions.length) : 0;

  const activeDaySet = new Set<string>();
  for (const s of yearSessions) {
    const d = new Date(s.startTime);
    activeDaySet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const totalActiveDays = activeDaySet.size;

  const currentStreak = sessionStore.getCurrentStreak();
  const longestStreak = sessionStore.getLongestStreak();

  const dayOfWeekBuckets = DAYS_OF_WEEK.map(() => ({ sessions: 0, minutes: 0 }));
  for (const s of yearSessions) {
    const dayIdx = new Date(s.startTime).getDay();
    dayOfWeekBuckets[dayIdx].sessions++;
    dayOfWeekBuckets[dayIdx].minutes += s.durationMinutes;
  }
  const dayOfWeekBreakdown = DAYS_OF_WEEK.map((day, i) => ({
    day,
    sessions: dayOfWeekBuckets[i].sessions,
    hours: Math.round((dayOfWeekBuckets[i].minutes / 60) * 10) / 10,
  }));
  const busiestDayOfWeek = dayOfWeekBreakdown.reduce(
    (best, d) => (d.sessions > best.sessions ? d : best),
    dayOfWeekBreakdown[0],
  ).day;

  const ratingCounts = new Map<number, number>();
  let totalRatingSum = 0;
  let totalRatings = 0;
  for (const entry of yearJourney) {
    if (entry.rating > 0) {
      ratingCounts.set(entry.rating, (ratingCounts.get(entry.rating) || 0) + 1);
      totalRatingSum += entry.rating;
      totalRatings++;
    }
  }
  const ratingDistribution = [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: ratingCounts.get(r) || 0 }));
  const avgRating = totalRatings > 0 ? Math.round((totalRatingSum / totalRatings) * 10) / 10 : 0;

  // Heatmap for the year
  const heatmapData = new Map<string, number>();
  for (const s of yearSessions) {
    const d = new Date(s.startTime);
    if (d.getFullYear() !== year) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    heatmapData.set(key, (heatmapData.get(key) || 0) + s.durationMinutes);
  }

  // Fun facts
  const funFacts: string[] = [];
  if (totalHoursPlayed > 0) {
    const movies = Math.round(totalHoursPlayed / 2);
    if (movies > 0) funFacts.push(`You could've watched ${movies.toLocaleString()} movies instead`);
  }
  if (topGame && topGamePercentage > 0) {
    funFacts.push(`${topGame.title} consumed ${topGamePercentage}% of your total playtime`);
  }
  if (longestSession && longestSession.durationMinutes > 60) {
    const hrs = Math.round(longestSession.durationMinutes / 60 * 10) / 10;
    funFacts.push(`Your longest marathon was ${hrs}h of ${longestSession.gameTitle}`);
  }
  if (yearJourney.length > 0) {
    const weeksInYear = 52;
    const perWeek = Math.round((yearJourney.length / weeksInYear) * 10) / 10;
    if (perWeek >= 1) funFacts.push(`You added ~${perWeek} games per week`);
  }
  if (genreCounts.size > 5) {
    funFacts.push(`You explored ${genreCounts.size} different genres — a true polymath`);
  }
  if (totalActiveDays > 0) {
    const pct = Math.round((totalActiveDays / 365) * 100);
    funFacts.push(`You gamed on ${totalActiveDays} days — that's ${pct}% of the year`);
  }
  if (longestStreak > 3) {
    funFacts.push(`Your longest streak was ${longestStreak} consecutive days`);
  }
  if (totalHoursPlayed > 40) {
    const workWeeks = Math.round((totalHoursPlayed / 40) * 10) / 10;
    funFacts.push(`That's ${workWeeks} work weeks of pure gaming`);
  }

  const newGamesPerWeek = yearJourney.length > 0 ? Math.round((yearJourney.length / 52) * 10) / 10 : 0;

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
    longestSession,
    avgSessionMinutes,
    totalActiveDays,
    currentStreak,
    longestStreak,
    dayOfWeekBreakdown,
    busiestDayOfWeek,
    ratingDistribution,
    avgRating,
    totalRatings,
    heatmapData,
    funFacts,
    topGamePercentage,
    newGamesPerWeek,
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
  'radial-gradient(ellipse at 20% 50%, rgba(120,0,255,0.18) 0%, transparent 70%), radial-gradient(ellipse at 80% 20%, rgba(255,0,128,0.12) 0%, transparent 60%)',
  'radial-gradient(ellipse at 50% 80%, rgba(59,130,246,0.18) 0%, transparent 60%), radial-gradient(ellipse at 20% 20%, rgba(168,85,247,0.14) 0%, transparent 50%)',
  'radial-gradient(ellipse at 30% 40%, rgba(6,182,212,0.16) 0%, transparent 60%), radial-gradient(ellipse at 80% 80%, rgba(59,130,246,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 70% 30%, rgba(236,72,153,0.22) 0%, transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(139,92,246,0.18) 0%, transparent 50%)',
  'radial-gradient(ellipse at 30% 60%, rgba(245,158,11,0.14) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(236,72,153,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 50%, rgba(34,197,94,0.14) 0%, transparent 60%), radial-gradient(ellipse at 20% 80%, rgba(59,130,246,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 60% 40%, rgba(236,72,153,0.18) 0%, transparent 60%), radial-gradient(ellipse at 30% 80%, rgba(168,85,247,0.14) 0%, transparent 50%)',
  'radial-gradient(ellipse at 40% 30%, rgba(6,182,212,0.16) 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, rgba(168,85,247,0.14) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 20%, rgba(99,102,241,0.18) 0%, transparent 60%), radial-gradient(ellipse at 50% 80%, rgba(236,72,153,0.12) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 50%, rgba(139,92,246,0.22) 0%, transparent 50%), radial-gradient(ellipse at 20% 20%, rgba(236,72,153,0.18) 0%, transparent 60%)',
  'radial-gradient(ellipse at 70% 70%, rgba(245,158,11,0.16) 0%, transparent 60%), radial-gradient(ellipse at 20% 30%, rgba(168,85,247,0.14) 0%, transparent 50%)',
  'radial-gradient(ellipse at 20% 60%, rgba(34,197,94,0.18) 0%, transparent 60%), radial-gradient(ellipse at 80% 40%, rgba(6,182,212,0.14) 0%, transparent 50%)',
  'radial-gradient(ellipse at 50% 50%, rgba(236,72,153,0.20) 0%, transparent 50%), radial-gradient(ellipse at 30% 30%, rgba(139,92,246,0.16) 0%, transparent 60%)',
  'radial-gradient(ellipse at 50% 50%, rgba(139,92,246,0.25) 0%, transparent 45%), radial-gradient(ellipse at 20% 20%, rgba(236,72,153,0.20) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(6,182,212,0.15) 0%, transparent 60%)',
];

// ─── Animated Particles ──────────────────────────────────────────────────────

const particleKeyframes = `
@keyframes float-particle {
  0%, 100% { transform: translateY(0px) translateX(0px); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  50% { transform: translateY(-40vh) translateX(20px); }
}
@keyframes pulse-glow {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.5); }
}
@keyframes drift {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25% { transform: translate(10px, -15px) rotate(90deg); }
  50% { transform: translate(-5px, -30px) rotate(180deg); }
  75% { transform: translate(15px, -10px) rotate(270deg); }
}
`;

function FloatingParticles({ intensity = 1 }: { intensity?: number }) {
  const count = Math.round(25 * intensity);
  return (
    <>
      <style>{particleKeyframes}</style>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              width: 2 + Math.random() * 4,
              height: 2 + Math.random() * 4,
              left: `${Math.random() * 100}%`,
              top: `${60 + Math.random() * 40}%`,
              background: `rgba(${150 + Math.random() * 105}, ${85 + Math.random() * 170}, ${200 + Math.random() * 55}, ${0.3 + Math.random() * 0.5})`,
              animation: `float-particle ${6 + Math.random() * 14}s ease-in-out ${Math.random() * 8}s infinite`,
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
    scale: 0.92,
  }),
  center: {
    x: 0,
    opacity: 1,
    scale: 1,
  },
  exit: (direction: number) => ({
    x: direction < 0 ? '100%' : '-100%',
    opacity: 0,
    scale: 0.92,
  }),
};

// ─── Heatmap Component ───────────────────────────────────────────────────────

function ActivityHeatmap({ year, data, active }: { year: number; data: Map<string, number>; active: boolean }) {
  const weeks = useMemo(() => {
    const result: { date: string; minutes: number; dayOfWeek: number }[][] = [];
    const start = new Date(year, 0, 1);
    const startDay = start.getDay();
    const cursor = new Date(start);
    cursor.setDate(cursor.getDate() - startDay);

    let currentWeek: typeof result[0] = [];
    const endDate = new Date(year, 11, 31);

    while (cursor <= endDate || currentWeek.length < 7) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const isInYear = cursor.getFullYear() === year;
      currentWeek.push({
        date: key,
        minutes: isInYear ? (data.get(key) || 0) : -1,
        dayOfWeek: cursor.getDay(),
      });
      if (currentWeek.length === 7) {
        result.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) result.push(currentWeek);
    return result;
  }, [year, data]);

  const maxMinutes = Math.max(...Array.from(data.values()), 1);

  const getColor = (minutes: number) => {
    if (minutes < 0) return 'transparent';
    if (minutes === 0) return 'rgba(255,255,255,0.03)';
    const intensity = Math.min(minutes / maxMinutes, 1);
    if (intensity < 0.25) return 'rgba(139, 92, 246, 0.25)';
    if (intensity < 0.5) return 'rgba(139, 92, 246, 0.45)';
    if (intensity < 0.75) return 'rgba(168, 85, 247, 0.65)';
    return 'rgba(192, 132, 252, 0.9)';
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={active ? { opacity: 1, scale: 1 } : {}}
      transition={{ delay: 0.6, duration: 0.8 }}
      className="w-full max-w-2xl overflow-x-auto"
    >
      <div className="flex gap-[2px] min-w-[600px]">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[2px]">
            {week.map((day, di) => (
              <motion.div
                key={day.date}
                initial={{ opacity: 0, scale: 0 }}
                animate={active ? { opacity: 1, scale: 1 } : {}}
                transition={{ delay: 0.8 + (wi * 7 + di) * 0.002, duration: 0.3 }}
                className="w-[9px] h-[9px] rounded-[2px]"
                style={{ backgroundColor: getColor(day.minutes) }}
                title={day.minutes > 0 ? `${day.date}: ${Math.round(day.minutes)}min` : day.date}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3 justify-end">
        <span className="text-white/20 text-[9px]">Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((level) => (
          <div
            key={level}
            className="w-[9px] h-[9px] rounded-[2px]"
            style={{ backgroundColor: getColor(level === 0 ? 0 : level * maxMinutes) }}
          />
        ))}
        <span className="text-white/20 text-[9px]">More</span>
      </div>
    </motion.div>
  );
}

// ─── Individual Slides ───────────────────────────────────────────────────────

function SlideIntro({ stats, active }: { stats: WrappedStats; active: boolean }) {
  useEffect(() => {
    if (active) {
      const timer = setTimeout(() => {
        confetti({
          particleCount: 80,
          spread: 90,
          origin: { y: 0.6 },
          colors: ['#a855f7', '#ec4899', '#6366f1', '#06b6d4'],
        });
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [active]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8">
      <motion.div
        initial={{ scale: 0.3, opacity: 0, rotateZ: -10 }}
        animate={active ? { scale: 1, opacity: 1, rotateZ: 0 } : {}}
        transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <GradientText
          className="text-[120px] md:text-[180px] font-black leading-none tracking-tighter"
          colors={['#a855f7', '#ec4899', '#6366f1', '#06b6d4', '#a855f7']}
          animationSpeed={3}
        >
          {stats.year}
        </GradientText>
      </motion.div>

      <SplitText
        text="Your Year in Gaming"
        className="text-3xl md:text-5xl font-bold text-white"
        delay={60}
        startWhen={active}
      />

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={active ? { opacity: 0.5, y: 0 } : {}}
        transition={{ delay: 1.8, duration: 0.8 }}
        className="text-white/50 text-lg text-center max-w-md"
      >
        A cinematic journey through your gaming memories
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ delay: 2.8, duration: 0.6 }}
        className="flex items-center gap-2 text-white/25 text-sm mt-8"
      >
        <motion.div
          animate={{ x: [0, 8, 0] }}
          transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
        >
          <ChevronRight className="w-4 h-4" />
        </motion.div>
        <span>Swipe or press arrow keys</span>
      </motion.div>
    </div>
  );
}

function SlideNumbers({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const items = [
    { icon: Gamepad2, label: 'Games Added', value: stats.totalGamesAdded, color: 'text-fuchsia-400', glow: 'rgba(168, 85, 247, 0.12)' },
    { icon: Clock, label: 'Hours Played', value: Math.round(stats.totalHoursPlayed), suffix: 'h', color: 'text-blue-400', glow: 'rgba(59, 130, 246, 0.12)' },
    { icon: TrendingUp, label: 'Play Sessions', value: stats.totalSessions, color: 'text-emerald-400', glow: 'rgba(34, 197, 94, 0.12)' },
    { icon: Trophy, label: 'Completed', value: stats.gamesCompleted, color: 'text-amber-400', glow: 'rgba(245, 158, 11, 0.12)' },
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

      <div className="grid grid-cols-2 gap-5 max-w-lg w-full">
        {items.map((item, i) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 40, scale: 0.8 }}
            animate={active ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ delay: 0.5 + i * 0.15, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <SpotlightCard
              className="rounded-2xl p-6 bg-white/[0.02] backdrop-blur-sm text-center"
              spotlightColor={item.glow}
            >
              <item.icon className={cn('w-6 h-6 mx-auto mb-3', item.color)} />
              <div className={cn('text-4xl md:text-5xl font-black', item.color)}>
                <CountUp to={item.value} duration={2.5} startWhen={active} suffix={item.suffix || ''} separator="," />
              </div>
              <p className="text-white/40 text-xs mt-2 uppercase tracking-wider">{item.label}</p>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>

      {stats.firstGameAdded && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.4 } : {}}
          transition={{ delay: 2 }}
          className="text-white/40 text-sm mt-2"
        >
          It all started with <span className="text-fuchsia-400 font-medium">{stats.firstGameAdded.title}</span> on {stats.firstGameAdded.date}
        </motion.p>
      )}
    </div>
  );
}

function SlideCalendar({ stats, active }: { stats: WrappedStats; active: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Your Gaming Calendar"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <motion.p
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.5 } : {}}
        transition={{ delay: 0.4 }}
        className="text-white/50 text-sm text-center"
      >
        <span className="text-cyan-400 font-semibold">{stats.totalActiveDays}</span> active days this year
      </motion.p>

      <ActivityHeatmap year={stats.year} data={stats.heatmapData} active={active} />

      <div className="flex items-center gap-6 mt-2">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={active ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 1.5 }}
          className="flex items-center gap-2"
        >
          <Flame className="w-4 h-4 text-orange-400" />
          <span className="text-white/40 text-xs">
            Current streak: <span className="text-orange-400 font-bold">{stats.currentStreak} days</span>
          </span>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={active ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 1.7 }}
          className="flex items-center gap-2"
        >
          <Zap className="w-4 h-4 text-amber-400" />
          <span className="text-white/40 text-xs">
            Longest streak: <span className="text-amber-400 font-bold">{stats.longestStreak} days</span>
          </span>
        </motion.div>
      </div>
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
        <div className="absolute -inset-3 bg-gradient-to-r from-fuchsia-500/30 via-purple-500/20 to-pink-500/30 rounded-2xl blur-xl animate-pulse" />
        <CoverImage
          gameId={gameId}
          title={title}
          coverUrl={coverUrl}
          className="relative w-48 h-72 md:w-56 md:h-80 object-cover rounded-xl shadow-2xl shadow-fuchsia-500/20"
        />
        {stats.topGamePercentage > 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0 }}
            animate={active ? { opacity: 1, scale: 1 } : {}}
            transition={{ delay: 1.5, type: 'spring', damping: 10 }}
            className="absolute -top-3 -right-3 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-full w-14 h-14 flex items-center justify-center shadow-lg shadow-fuchsia-500/30"
          >
            <span className="text-white font-black text-sm">{stats.topGamePercentage}%</span>
          </motion.div>
        )}
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

      <div className="flex items-center gap-6 mt-1">
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
            <span key={g} className="text-[10px] px-2.5 py-0.5 rounded-full border border-fuchsia-500/20 text-fuchsia-400/60 uppercase tracking-wider">
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
          className="text-white/35 text-sm mt-2 italic"
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
  const badgeColors = ['from-amber-500 to-yellow-600', 'from-zinc-300 to-zinc-400', 'from-orange-600 to-orange-700', '', ''];

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
            <div className="relative">
              {i < 3 ? (
                <div className={cn('w-8 h-8 rounded-full bg-gradient-to-br flex items-center justify-center text-sm font-black text-white shadow-lg', badgeColors[i])}>
                  {i + 1}
                </div>
              ) : (
                <span className={cn('text-2xl font-black w-8 text-center', medals[i])}>{i + 1}</span>
              )}
            </div>
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

function SlideMarathon({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const items = [
    {
      icon: Zap,
      label: 'Longest Session',
      value: stats.longestSession ? `${Math.round(stats.longestSession.durationMinutes / 60 * 10) / 10}h` : '—',
      sub: stats.longestSession ? `${stats.longestSession.gameTitle} on ${stats.longestSession.date}` : '',
      color: 'text-amber-400',
      glow: 'rgba(245, 158, 11, 0.12)',
    },
    {
      icon: Clock,
      label: 'Avg Session',
      value: stats.avgSessionMinutes > 0 ? `${stats.avgSessionMinutes}m` : '—',
      sub: stats.avgSessionMinutes >= 60 ? `About ${Math.round(stats.avgSessionMinutes / 60 * 10) / 10} hours each time` : 'Short but sweet',
      color: 'text-blue-400',
      glow: 'rgba(59, 130, 246, 0.12)',
    },
    {
      icon: Calendar,
      label: 'Active Days',
      value: String(stats.totalActiveDays),
      sub: `${Math.round((stats.totalActiveDays / 365) * 100)}% of the year`,
      color: 'text-emerald-400',
      glow: 'rgba(34, 197, 94, 0.12)',
    },
    {
      icon: Flame,
      label: 'Best Streak',
      value: `${stats.longestStreak}d`,
      sub: stats.currentStreak > 0 ? `Currently on a ${stats.currentStreak}-day streak!` : 'Start a new one today',
      color: 'text-orange-400',
      glow: 'rgba(249, 115, 22, 0.12)',
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Marathon & Dedication"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <div className="grid grid-cols-2 gap-4 max-w-lg w-full mt-4">
        {items.map((item, i) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 30, scale: 0.9 }}
            animate={active ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ delay: 0.5 + i * 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <SpotlightCard
              className="rounded-2xl p-5 bg-white/[0.02] backdrop-blur-sm"
              spotlightColor={item.glow}
            >
              <item.icon className={cn('w-5 h-5 mb-2', item.color)} />
              <p className={cn('text-3xl font-black', item.color)}>{item.value}</p>
              <p className="text-white/50 text-xs font-medium mt-1">{item.label}</p>
              <p className="text-white/25 text-[10px] mt-1 leading-tight">{item.sub}</p>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function SlideGenreDNA({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const maxCount = stats.genreBreakdown[0]?.count || 1;
  const barColors = [
    'from-fuchsia-600 to-purple-600',
    'from-blue-500 to-cyan-400',
    'from-emerald-500 to-teal-400',
    'from-amber-500 to-orange-400',
    'from-rose-500 to-pink-400',
    'from-indigo-500 to-violet-400',
    'from-lime-500 to-green-400',
    'from-red-500 to-orange-500',
  ];

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

      <div className="w-full max-w-md space-y-2.5 mt-4">
        {stats.genreBreakdown.map((g, i) => (
          <motion.div
            key={g.genre}
            initial={{ opacity: 0, x: -40 }}
            animate={active ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.8 + i * 0.08, duration: 0.5 }}
            className="flex items-center gap-3"
          >
            <span className="text-white/50 text-xs w-24 text-right truncate">{g.genre}</span>
            <div className="flex-1 h-7 bg-white/5 rounded-full overflow-hidden relative">
              <motion.div
                initial={{ width: 0 }}
                animate={active ? { width: `${(g.count / maxCount) * 100}%` } : { width: 0 }}
                transition={{ delay: 1 + i * 0.08, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className={cn('h-full rounded-full bg-gradient-to-r', barColors[i % barColors.length])}
              />
              <motion.span
                initial={{ opacity: 0 }}
                animate={active ? { opacity: 1 } : {}}
                transition={{ delay: 1.5 + i * 0.08 }}
                className="absolute inset-y-0 right-2 flex items-center text-white/50 text-[10px] font-medium"
              >
                {g.percentage}%
              </motion.span>
            </div>
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

      <div className="flex items-end gap-1.5 h-36 w-full max-w-lg mt-4">
        {stats.monthlyActivity.map((m, i) => {
          const height = ((m.gamesAdded + m.sessions) / maxActivity) * 100;
          const isBusiest = m.month === stats.busiestMonth.month;
          return (
            <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
              <motion.div
                initial={{ height: 0 }}
                animate={active ? { height: `${Math.max(height, 3)}%` } : { height: 0 }}
                transition={{ delay: 0.8 + i * 0.06, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  'w-full rounded-t-lg relative overflow-hidden',
                  isBusiest ? 'bg-gradient-to-t from-orange-600 to-amber-400' : 'bg-white/10',
                )}
              >
                {isBusiest && (
                  <motion.div
                    className="absolute inset-0 bg-gradient-to-t from-transparent to-white/20"
                    animate={{ opacity: [0.3, 0.6, 0.3] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                  />
                )}
              </motion.div>
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

function SlideDayOfWeek({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const maxSessions = Math.max(...stats.dayOfWeekBreakdown.map((d) => d.sessions), 1);
  const dayColors = ['text-rose-400', 'text-blue-400', 'text-cyan-400', 'text-emerald-400', 'text-amber-400', 'text-orange-400', 'text-purple-400'];
  const barGradients = [
    'from-rose-600 to-rose-400', 'from-blue-600 to-blue-400', 'from-cyan-600 to-cyan-400',
    'from-emerald-600 to-emerald-400', 'from-amber-600 to-amber-400', 'from-orange-600 to-orange-400',
    'from-purple-600 to-purple-400',
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Week at a Glance"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.5 } : {}}
        transition={{ delay: 0.5 }}
        className="text-center"
      >
        <p className="text-white/50 text-sm">
          <span className={dayColors[DAYS_OF_WEEK.indexOf(stats.busiestDayOfWeek)]}>{stats.busiestDayOfWeek}</span> is your gaming day
        </p>
      </motion.div>

      <div className="flex items-end gap-3 h-44 w-full max-w-md mt-4">
        {stats.dayOfWeekBreakdown.map((d, i) => {
          const height = (d.sessions / maxSessions) * 100;
          const isBusiest = d.day === stats.busiestDayOfWeek;
          return (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-2">
              <motion.div
                initial={{ opacity: 0 }}
                animate={active ? { opacity: isBusiest ? 0.8 : 0.4 } : {}}
                transition={{ delay: 1.2 + i * 0.08 }}
                className="text-[10px] text-white/40 font-medium"
              >
                {d.sessions}
              </motion.div>
              <motion.div
                initial={{ height: 0 }}
                animate={active ? { height: `${Math.max(height, 4)}%` } : { height: 0 }}
                transition={{ delay: 0.6 + i * 0.1, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  'w-full rounded-t-lg',
                  isBusiest
                    ? cn('bg-gradient-to-t', barGradients[i])
                    : 'bg-white/10',
                )}
              />
              <span className={cn('text-xs font-medium', isBusiest ? dayColors[i] : 'text-white/30')}>
                {d.day}
              </span>
            </div>
          );
        })}
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.3 } : {}}
        transition={{ delay: 1.8 }}
        className="text-white/30 text-xs mt-2 italic"
      >
        Total: {stats.dayOfWeekBreakdown.reduce((s, d) => s + d.hours, 0).toFixed(1)}h across all days
      </motion.p>
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

      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: 0.5, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-44 h-44"
      >
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
          <motion.circle
            cx="50" cy="50" r="42" fill="none"
            stroke="url(#completionGradient)" strokeWidth="7" strokeLinecap="round"
            strokeDasharray={264}
            initial={{ strokeDashoffset: 264 }}
            animate={active ? { strokeDashoffset: 264 - (264 * stats.completionRate) / 100 } : { strokeDashoffset: 264 }}
            transition={{ delay: 0.8, duration: 2, ease: [0.16, 1, 0.3, 1] }}
          />
          <defs>
            <linearGradient id="completionGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#22c55e" />
              <stop offset="50%" stopColor="#06b6d4" />
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
        <div className="flex gap-2.5 mt-2 flex-wrap justify-center max-w-md">
          {stats.completedGames.slice(0, 8).map((game, i) => (
            <motion.div
              key={game.gameId}
              initial={{ opacity: 0, scale: 0.5, rotateZ: -10 }}
              animate={active ? { opacity: 1, scale: 1, rotateZ: 0 } : {}}
              transition={{ delay: 1.8 + i * 0.1, type: 'spring', damping: 12 }}
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
  const glows = {
    moon: 'rgba(99, 102, 241, 0.12)',
    sunrise: 'rgba(251, 146, 60, 0.12)',
    sun: 'rgba(245, 158, 11, 0.12)',
    sunset: 'rgba(244, 63, 94, 0.12)',
  };

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
        initial={{ opacity: 0, scale: 0.8, rotateZ: -20 }}
        animate={active ? { opacity: 1, scale: 1, rotateZ: 0 } : {}}
        transition={{ delay: 0.5, duration: 0.8, type: 'spring' }}
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
          ? `${stats.nightPercentage}% of your gaming happened in the evening or at night`
          : 'You prefer gaming during the day — a true early bird'}
      </motion.p>

      <div className="grid grid-cols-2 gap-4 mt-4 w-full max-w-xs">
        {stats.playTimeOfDay.map((period, i) => {
          const Icon = icons[period.icon];
          return (
            <motion.div
              key={period.period}
              initial={{ opacity: 0, y: 20 }}
              animate={active ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 1 + i * 0.12 }}
            >
              <SpotlightCard
                className="rounded-xl p-3 bg-white/[0.02] backdrop-blur-sm"
                spotlightColor={glows[period.icon]}
              >
                <div className="flex items-center gap-3">
                  <Icon className={cn('w-5 h-5', colors[period.icon])} />
                  <div>
                    <p className="text-white/70 text-xs font-medium">{period.period}</p>
                    <p className={cn('text-lg font-bold', colors[period.icon])}>
                      <CountUp to={period.percentage} duration={1.5} startWhen={active} suffix="%" />
                    </p>
                  </div>
                </div>
              </SpotlightCard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SlideRatings({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const maxRating = Math.max(...stats.ratingDistribution.map((r) => r.count), 1);
  const starColors = ['text-red-400', 'text-orange-400', 'text-amber-400', 'text-lime-400', 'text-emerald-400'];

  const criticTitle = stats.avgRating >= 4.5
    ? 'Generous Critic'
    : stats.avgRating >= 3.5
    ? 'Fair Judge'
    : stats.avgRating >= 2.5
    ? 'Tough Reviewer'
    : stats.avgRating > 0
    ? 'Harsh Critic'
    : 'Silent Observer';

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="The Critic"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : {}}
        transition={{ delay: 0.5 }}
        className="text-center"
      >
        <GradientText
          className="text-2xl md:text-3xl font-black"
          colors={['#fbbf24', '#f97316', '#ef4444']}
          animationSpeed={4}
        >
          {criticTitle}
        </GradientText>
      </motion.div>

      {stats.totalRatings > 0 && (
        <>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={active ? { opacity: 1, scale: 1 } : {}}
            transition={{ delay: 0.7 }}
            className="flex items-center gap-2"
          >
            <span className="text-4xl font-black text-amber-400">
              <CountUp to={stats.avgRating} duration={2} startWhen={active} />
            </span>
            <div className="flex items-center gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={cn('w-5 h-5', i < Math.round(stats.avgRating) ? 'text-amber-400 fill-amber-400' : 'text-white/10')}
                />
              ))}
            </div>
            <span className="text-white/30 text-sm ml-2">avg</span>
          </motion.div>

          <div className="w-full max-w-sm space-y-2 mt-4">
            {stats.ratingDistribution.map((r, i) => (
              <motion.div
                key={r.rating}
                initial={{ opacity: 0, x: -30 }}
                animate={active ? { opacity: 1, x: 0 } : {}}
                transition={{ delay: 1 + i * 0.1, duration: 0.5 }}
                className="flex items-center gap-3"
              >
                <div className="flex items-center gap-0.5 w-20 justify-end">
                  {Array.from({ length: r.rating }).map((_, si) => (
                    <Star key={si} className={cn('w-3 h-3 fill-current', starColors[i])} />
                  ))}
                </div>
                <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={active ? { width: `${(r.count / maxRating) * 100}%` } : { width: 0 }}
                    transition={{ delay: 1.2 + i * 0.1, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-400"
                  />
                </div>
                <span className="text-white/30 text-xs w-6 text-right">{r.count}</span>
              </motion.div>
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={active ? { opacity: 0.3 } : {}}
            transition={{ delay: 2 }}
            className="text-white/30 text-xs mt-2"
          >
            {stats.totalRatings} games rated this year
          </motion.p>
        </>
      )}

      {stats.totalRatings === 0 && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={active ? { opacity: 0.4 } : {}}
          transition={{ delay: 0.8 }}
          className="text-white/40 text-sm text-center"
        >
          You haven't rated any games yet — your opinions matter!
        </motion.p>
      )}
    </div>
  );
}

function SlideFunFacts({ stats, active }: { stats: WrappedStats; active: boolean }) {
  const facts = stats.funFacts.slice(0, 6);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
      <BlurText
        text="Fun Facts"
        className="text-4xl md:text-5xl font-bold text-white justify-center"
        delay={60}
        animateBy="letters"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 0.5 } : {}}
        transition={{ delay: 0.4 }}
      >
        <ShinyText text="DID YOU KNOW?" className="text-sm font-bold tracking-[0.3em] text-purple-300/60" speed={3} />
      </motion.div>

      <div className="flex flex-col gap-3 max-w-md w-full mt-2">
        {facts.map((fact, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: i % 2 === 0 ? -40 : 40 }}
            animate={active ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.6 + i * 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <SpotlightCard
              className="rounded-xl p-4 bg-white/[0.02] backdrop-blur-sm"
              spotlightColor="rgba(168, 85, 247, 0.08)"
            >
              <div className="flex items-start gap-3">
                <Target className="w-4 h-4 text-fuchsia-400 mt-0.5 shrink-0" />
                <p className="text-white/60 text-sm leading-relaxed">{fact}</p>
              </div>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function SlideFinale({ stats, active, onDownload, onShare, isExporting }: {
  stats: WrappedStats;
  active: boolean;
  onDownload: () => void;
  onShare: (platform: string) => void;
  isExporting: boolean;
}) {
  useEffect(() => {
    if (active) {
      const timer = setTimeout(() => {
        confetti({
          particleCount: 120,
          spread: 120,
          origin: { y: 0.5 },
          colors: ['#a855f7', '#ec4899', '#6366f1', '#06b6d4', '#22c55e', '#f59e0b'],
          gravity: 0.8,
          ticks: 150,
        });
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [active]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 px-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={active ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <GradientText
          className="text-4xl md:text-6xl font-black text-center leading-tight"
          colors={['#a855f7', '#ec4899', '#6366f1', '#06b6d4', '#a855f7']}
          animationSpeed={3}
        >
          {stats.gamerTitle}
        </GradientText>
      </motion.div>

      <BlurText
        text="That's who you were this year"
        className="text-base text-white/50 justify-center"
        delay={80}
        animateBy="words"
        startWhen={active}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ delay: 0.8 }}
        className="grid grid-cols-3 gap-6 mt-3"
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
            transition={{ delay: 1 + i * 0.12 }}
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
          transition={{ delay: 1.5 }}
          className="flex items-center gap-3 mt-2"
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
        transition={{ delay: 2 }}
        className="mt-4"
      >
        <ShinyText
          text="Until next year, gamer."
          className="text-lg font-semibold"
          speed={4}
          color="#666"
          shineColor="#e879f9"
        />
      </motion.div>

      {/* Share & Download controls */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={active ? { opacity: 1, y: 0 } : {}}
        transition={{ delay: 2.5 }}
        className="flex flex-col items-center gap-4 mt-4"
      >
        {/* Download button */}
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          disabled={isExporting}
          className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-gradient-to-r from-fuchsia-600/20 to-purple-600/20 hover:from-fuchsia-600/30 hover:to-purple-600/30 border border-fuchsia-500/20 text-fuchsia-300 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isExporting ? (
            <>
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              >
                <Download className="w-4 h-4" />
              </motion.div>
              <span>Exporting...</span>
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              <span>Download All Slides</span>
            </>
          )}
        </button>

        {/* Social share row */}
        <div className="flex items-center gap-2">
          <span className="text-white/20 text-xs mr-1">Share:</span>
          {[
            { id: 'twitter', icon: Twitter, label: 'X / Twitter', desc: 'Share your gaming year recap on X (Twitter).', color: 'hover:text-sky-400' },
            { id: 'reddit', icon: MessageCircle, label: 'Reddit', desc: 'Post your year in review to Reddit.', color: 'hover:text-orange-400' },
            { id: 'whatsapp', icon: Send, label: 'WhatsApp', desc: 'Send your gaming stats via WhatsApp.', color: 'hover:text-green-400' },
            { id: 'copy', icon: Copy, label: 'Copy stats', desc: 'Copy your stats summary to the clipboard.', color: 'hover:text-purple-400' },
          ].map((social) => (
            <TooltipCard key={social.id} content={social.desc}>
              <button
                onClick={(e) => { e.stopPropagation(); onShare(social.id); }}
                className={cn(
                  'w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/30 transition-colors',
                  social.color,
                )}
              >
                <social.icon className="w-4 h-4" />
              </button>
            </TooltipCard>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface YearWrappedProps {
  isOpen: boolean;
  onClose: () => void;
}

const TOTAL_SLIDES = 14;

export const YearWrapped = memo(function YearWrapped({ isOpen, onClose }: YearWrappedProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [direction, setDirection] = useState(0);
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [isExporting, setIsExporting] = useState(false);
  const [copiedStats, setCopiedStats] = useState(false);
  const slideContainerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const stats = useMemo(() => computeStats(selectedYear), [selectedYear]);

  useEffect(() => {
    if (isOpen) {
      setCurrentSlide(0);
      setDirection(0);
      setCopiedStats(false);
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

  const buildShareText = useCallback(() => {
    const lines = [
      `My ${stats.year} Gaming Wrapped`,
      ``,
      `Games: ${stats.totalGamesAdded}`,
      `Hours Played: ${Math.round(stats.totalHoursPlayed)}h`,
      `Sessions: ${stats.totalSessions}`,
      `Completed: ${stats.gamesCompleted}`,
      `Completion Rate: ${stats.completionRate}%`,
      stats.topGame ? `#1 Game: ${stats.topGame.title} (${Math.round(stats.topGame.hours)}h)` : '',
      `Top Genre: ${stats.topGenre}`,
      `Gamer Title: ${stats.gamerTitle}`,
      `Active Days: ${stats.totalActiveDays}`,
      stats.longestStreak > 0 ? `Longest Streak: ${stats.longestStreak} days` : '',
      stats.avgRating > 0 ? `Avg Rating: ${stats.avgRating}/5` : '',
      ``,
      `#ArkWrapped #GamingWrapped`,
    ];
    return lines.filter(Boolean).join('\n');
  }, [stats]);

  const handleShare = useCallback((platform: string) => {
    const text = buildShareText();
    const encodedText = encodeURIComponent(text);

    switch (platform) {
      case 'twitter':
        window.open(`https://twitter.com/intent/tweet?text=${encodedText}`, '_blank');
        break;
      case 'reddit':
        window.open(`https://www.reddit.com/submit?title=${encodeURIComponent(`My ${stats.year} Gaming Wrapped`)}&selftext=true&text=${encodedText}`, '_blank');
        break;
      case 'whatsapp':
        window.open(`https://wa.me/?text=${encodedText}`, '_blank');
        break;
      case 'copy':
        navigator.clipboard.writeText(text).then(() => {
          if (!mountedRef.current) return;
          setCopiedStats(true);
          setTimeout(() => { if (mountedRef.current) setCopiedStats(false); }, 2000);
        });
        break;
    }
  }, [buildShareText, stats.year]);

  const handleDownloadAll = useCallback(async () => {
    if (!wrapperRef.current || isExporting) return;
    setIsExporting(true);

    try {
      const zip = new JSZip();
      const originalSlide = currentSlide;
      const slideNames = [
        'intro', 'numbers', 'calendar', 'top-game', 'top-5',
        'marathon', 'genre-dna', 'busiest-month', 'day-of-week',
        'completionist', 'play-patterns', 'ratings', 'fun-facts', 'finale',
      ];

      for (let i = 0; i < TOTAL_SLIDES; i++) {
        if (!mountedRef.current) return;
        setDirection(i > currentSlide ? 1 : -1);
        setCurrentSlide(i);
        await new Promise((r) => setTimeout(r, 800));

        if (!mountedRef.current || !wrapperRef.current) return;
        try {
          const dataUrl = await toPng(wrapperRef.current, {
            quality: 0.95,
            backgroundColor: '#000000',
            pixelRatio: 2,
          });
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          zip.file(`ark-wrapped-${stats.year}-${String(i + 1).padStart(2, '0')}-${slideNames[i] || 'slide'}.png`, blob);
        } catch {
          // Skip slides that fail to capture
        }
      }

      if (!mountedRef.current) return;
      setCurrentSlide(originalSlide);
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `ark-wrapped-${stats.year}.zip`);
    } catch (err) {
      console.error('[ArkWrapped] Export failed:', err);
    } finally {
      if (mountedRef.current) setIsExporting(false);
    }
  }, [currentSlide, stats, isExporting]);

  if (!isOpen) return null;

  const slides = [
    <SlideIntro key="intro" stats={stats} active={currentSlide === 0} />,
    <SlideNumbers key="numbers" stats={stats} active={currentSlide === 1} />,
    <SlideCalendar key="calendar" stats={stats} active={currentSlide === 2} />,
    <SlideTopGame key="topgame" stats={stats} active={currentSlide === 3} />,
    <SlideTop5 key="top5" stats={stats} active={currentSlide === 4} />,
    <SlideMarathon key="marathon" stats={stats} active={currentSlide === 5} />,
    <SlideGenreDNA key="genredna" stats={stats} active={currentSlide === 6} />,
    <SlideBusiestMonth key="busiest" stats={stats} active={currentSlide === 7} />,
    <SlideDayOfWeek key="dayofweek" stats={stats} active={currentSlide === 8} />,
    <SlideCompletionist key="completionist" stats={stats} active={currentSlide === 9} />,
    <SlidePlayPatterns key="patterns" stats={stats} active={currentSlide === 10} />,
    <SlideRatings key="ratings" stats={stats} active={currentSlide === 11} />,
    <SlideFunFacts key="funfacts" stats={stats} active={currentSlide === 12} />,
    null, // Finale is rendered separately with extra props
  ];

  const isFinale = currentSlide === TOTAL_SLIDES - 1;

  return (
    <AnimatePresence>
      <motion.div
        ref={wrapperRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] bg-black flex flex-col"
        onClick={(e) => {
          if (isExporting) return;
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          if (clickX > rect.width / 2) goNext();
          else goPrev();
        }}
      >
        {/* Animated background gradient */}
        <motion.div
          className="absolute inset-0"
          animate={{ opacity: [0.8, 1, 0.8] }}
          transition={{ repeat: Infinity, duration: 4, ease: 'easeInOut' }}
          style={{ backgroundImage: SLIDE_GRADIENTS[currentSlide % SLIDE_GRADIENTS.length] }}
        />

        <FloatingParticles intensity={isFinale ? 1.5 : 1} />

        {/* Close button */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute top-6 right-6 z-50 w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Year selector */}
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

        {/* Branding */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.15 }}
          className="absolute top-6 left-1/2 -translate-x-1/2 z-40 text-white/15 text-[10px] font-bold tracking-[0.4em] uppercase"
        >
          Ark Wrapped
        </motion.div>

        {/* Slides */}
        <div ref={slideContainerRef} className="relative flex-1 overflow-hidden">
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
              {currentSlide === TOTAL_SLIDES - 1 ? (
                <SlideFinale
                  stats={stats}
                  active={true}
                  onDownload={handleDownloadAll}
                  onShare={handleShare}
                  isExporting={isExporting}
                />
              ) : (
                slides[currentSlide]
              )}
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

        {/* Progress bar */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5">
          {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                setDirection(i > currentSlide ? 1 : -1);
                setCurrentSlide(i);
              }}
              className={cn(
                'h-1 rounded-full transition-all duration-500',
                i === currentSlide
                  ? 'w-8 bg-gradient-to-r from-fuchsia-500 to-purple-600'
                  : i < currentSlide
                  ? 'w-2 bg-fuchsia-500/30'
                  : 'w-1.5 bg-white/15 hover:bg-white/25',
              )}
            />
          ))}
        </div>

        {/* Slide counter */}
        <div className="absolute bottom-8 right-6 z-50 text-white/20 text-xs font-medium">
          {currentSlide + 1} / {TOTAL_SLIDES}
        </div>

        {/* Copied toast */}
        <AnimatePresence>
          {copiedStats && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.9 }}
              className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[300] flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/20 border border-green-500/30 text-green-400 text-sm"
            >
              <Check className="w-4 h-4" />
              Stats copied to clipboard!
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
});

// ─── Snackbar Notification ───────────────────────────────────────────────────

const SNACKBAR_VIEWED_KEY = 'ark-wrapped-viewed';

export function WrappedSnackbar({ onLaunch }: { onLaunch: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const now = new Date();
    const year = now.getFullYear();
    const dec17 = new Date(year, 11, 17);
    const dec31 = new Date(year, 11, 31, 23, 59, 59);

    if (now < dec17 || now > dec31) return;

    const viewedYear = localStorage.getItem(SNACKBAR_VIEWED_KEY);
    if (viewedYear === String(year)) return;

    const timer = setTimeout(() => setVisible(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
  }, []);

  const launch = useCallback(() => {
    setVisible(false);
    localStorage.setItem(SNACKBAR_VIEWED_KEY, String(new Date().getFullYear()));
    onLaunch();
  }, [onLaunch]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 60, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 60, scale: 0.95 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed bottom-6 right-6 z-[150] max-w-sm"
        >
          <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-fuchsia-950/90 to-purple-950/90 border border-fuchsia-500/20 backdrop-blur-xl shadow-2xl shadow-fuchsia-500/10 p-4">
            <div className="absolute inset-0 bg-gradient-to-r from-fuchsia-500/5 to-purple-600/5" />
            <div className="relative flex items-start gap-3">
              <motion.div
                animate={{ rotate: [0, 15, -15, 0] }}
                transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              >
                <Gamepad2 className="w-8 h-8 text-fuchsia-400 shrink-0" />
              </motion.div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-semibold">Your Year in Review is ready!</p>
                <p className="text-white/40 text-xs mt-0.5">Relive your {new Date().getFullYear()} gaming journey with Ark Wrapped</p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={launch}
                    className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-600 text-white text-xs font-semibold transition-all"
                  >
                    Launch
                  </button>
                  <button
                    onClick={dismiss}
                    className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/60 text-xs transition-colors"
                  >
                    Later
                  </button>
                </div>
              </div>
              <button
                onClick={dismiss}
                className="text-white/20 hover:text-white/40 transition-colors"
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
