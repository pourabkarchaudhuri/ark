/**
 * Journey Analytics View Component
 *
 * A dashboard of stat cards and visualisations derived from journey entries
 * and status-change history. No new storage is required — everything is
 * computed at render time from the existing stores.
 */
import { useMemo } from 'react';
import {
  Gamepad2,
  Clock,
  Trophy,
  TrendingUp,
  CalendarDays,
  BarChart3,
  Timer,
  Tag,
} from 'lucide-react';
import { JourneyEntry, StatusChangeEntry, GameStatus } from '@/types/game';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JourneyAnalyticsViewProps {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
}

// ─── Status colours (reused for breakdown bars) ──────────────────────────────

const statusBarColors: Record<GameStatus, string> = {
  'Playing':      'bg-blue-500',
  'Playing Now':  'bg-emerald-500',
  'Completed':    'bg-green-500',
  'On Hold':      'bg-amber-500',
  'Want to Play': 'bg-white/30',
};

const statusTextColors: Record<GameStatus, string> = {
  'Playing':      'text-blue-400',
  'Playing Now':  'text-emerald-400',
  'Completed':    'text-green-400',
  'On Hold':      'text-amber-400',
  'Want to Play': 'text-white/50',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Glassmorphic card wrapper */
function StatCard({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/10 p-5 overflow-hidden',
        'hover:border-white/20 hover:bg-white/[0.06] transition-all duration-300 group',
        className,
      )}
    >
      {/* Subtle glow in corner */}
      <div className="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-fuchsia-500/5 blur-2xl group-hover:bg-fuchsia-500/10 transition-all" />

      <div className="flex items-center gap-2 mb-3 text-white/50 text-xs font-medium uppercase tracking-wider">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>

      {children}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function JourneyAnalyticsView({ journeyEntries, statusHistory }: JourneyAnalyticsViewProps) {
  const analytics = useMemo(() => {
    const totalGames = journeyEntries.length;
    const totalHours = journeyEntries.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);

    // --- Status breakdown ---
    const statusCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
    }

    const completedCount = statusCounts['Completed'] || 0;
    const completionRate = totalGames > 0 ? Math.round((completedCount / totalGames) * 100) : 0;

    // --- Top games by hours ---
    const topGames = [...journeyEntries]
      .sort((a, b) => b.hoursPlayed - a.hoursPlayed)
      .slice(0, 5);
    const maxHours = topGames.length > 0 ? topGames[0].hoursPlayed : 1;

    // --- Monthly activity (games added per month, last 12 months) ---
    const now = new Date();
    const monthlyActivity: { label: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const year = d.getFullYear();
      const month = d.getMonth();

      const count = journeyEntries.filter((e) => {
        const added = new Date(e.addedAt);
        return added.getFullYear() === year && added.getMonth() === month;
      }).length;

      monthlyActivity.push({ label, count });
    }
    const maxMonthly = Math.max(1, ...monthlyActivity.map((m) => m.count));

    // --- Average time to complete ---
    let avgDaysToComplete = 0;
    const completedEntries = journeyEntries.filter((e) => e.status === 'Completed');
    if (completedEntries.length > 0) {
      // For each completed game, find its earliest status change to 'Completed'
      const historyByGame = new Map<number, StatusChangeEntry[]>();
      for (const h of statusHistory) {
        if (!historyByGame.has(h.gameId)) historyByGame.set(h.gameId, []);
        historyByGame.get(h.gameId)!.push(h);
      }

      let totalDays = 0;
      let countWithData = 0;
      for (const entry of completedEntries) {
        const changes = historyByGame.get(entry.gameId) ?? [];
        const completedChange = changes.find((c) => c.newStatus === 'Completed');
        if (completedChange) {
          const addedDate = new Date(entry.addedAt).getTime();
          const completedDate = new Date(completedChange.timestamp).getTime();
          const days = Math.max(1, Math.round((completedDate - addedDate) / 86_400_000));
          totalDays += days;
          countWithData++;
        }
      }
      avgDaysToComplete = countWithData > 0 ? Math.round(totalDays / countWithData) : 0;
    }

    // --- Genre distribution ---
    const genreCounts: Record<string, number> = {};
    for (const entry of journeyEntries) {
      for (const g of entry.genre) {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    }
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      totalGames,
      totalHours,
      completedCount,
      completionRate,
      statusCounts,
      topGames,
      maxHours,
      monthlyActivity,
      maxMonthly,
      avgDaysToComplete,
      topGenres,
    };
  }, [journeyEntries, statusHistory]);

  if (journeyEntries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Gamepad2 className="w-10 h-10 text-fuchsia-500 mb-4" />
        <p className="text-white/60">No journey data to analyse yet.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 lg:px-10 pb-10 space-y-6">
      {/* ─── Row 1: Key metrics ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Games */}
        <StatCard icon={Gamepad2} label="Total Games">
          <p className="text-3xl font-bold text-fuchsia-400 font-['Orbitron']">
            {formatNumber(analytics.totalGames)}
          </p>
          <p className="text-xs text-white/40 mt-1">in your library</p>
        </StatCard>

        {/* Total Hours */}
        <StatCard icon={Clock} label="Total Hours">
          <p className="text-3xl font-bold text-cyan-400 font-['Orbitron']">
            {formatNumber(analytics.totalHours)}
          </p>
          <p className="text-xs text-white/40 mt-1">hours played</p>
        </StatCard>

        {/* Completion Rate */}
        <StatCard icon={Trophy} label="Completion Rate">
          <div className="flex items-end gap-2">
            <p className="text-3xl font-bold text-green-400 font-['Orbitron']">
              {analytics.completionRate}%
            </p>
            <p className="text-xs text-white/40 mb-1">
              ({analytics.completedCount}/{analytics.totalGames})
            </p>
          </div>
          {/* Mini progress bar */}
          <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-700"
              style={{ width: `${analytics.completionRate}%` }}
            />
          </div>
        </StatCard>

        {/* Avg Days to Complete */}
        <StatCard icon={Timer} label="Avg. Time to Complete">
          <p className="text-3xl font-bold text-amber-400 font-['Orbitron']">
            {analytics.avgDaysToComplete > 0 ? analytics.avgDaysToComplete : '—'}
          </p>
          <p className="text-xs text-white/40 mt-1">
            {analytics.avgDaysToComplete > 0 ? 'days on average' : 'no data yet'}
          </p>
        </StatCard>
      </div>

      {/* ─── Row 2: Status Breakdown + Monthly Activity ──────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status Breakdown */}
        <StatCard icon={BarChart3} label="Status Breakdown">
          <div className="space-y-2.5">
            {(
              ['Playing', 'Completed', 'On Hold', 'Want to Play'] as GameStatus[]
            ).map((status) => {
              const count = analytics.statusCounts[status] || 0;
              const pct = analytics.totalGames > 0 ? (count / analytics.totalGames) * 100 : 0;
              return (
                <div key={status}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={cn('text-xs font-medium', statusTextColors[status])}>
                      {status}
                    </span>
                    <span className="text-xs text-white/40">{count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-700', statusBarColors[status])}
                      style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </StatCard>

        {/* Monthly Activity */}
        <StatCard icon={CalendarDays} label="Monthly Activity (Games Added)">
          <div className="flex items-end gap-1 h-28">
            {analytics.monthlyActivity.map((m, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 group/bar">
                <span className="text-[9px] text-white/30 opacity-0 group-hover/bar:opacity-100 transition-opacity">
                  {m.count}
                </span>
                <div
                  className={cn(
                    'w-full rounded-t-sm transition-all duration-300',
                    m.count > 0
                      ? 'bg-gradient-to-t from-fuchsia-600/80 to-fuchsia-400/60 hover:from-fuchsia-500 hover:to-fuchsia-300'
                      : 'bg-white/5',
                  )}
                  style={{
                    height: `${Math.max(m.count > 0 ? 8 : 2, (m.count / analytics.maxMonthly) * 100)}%`,
                  }}
                />
                <span className="text-[9px] text-white/30">{m.label}</span>
              </div>
            ))}
          </div>
        </StatCard>
      </div>

      {/* ─── Row 3: Top Games + Genre Distribution ──────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top Games by Hours */}
        <StatCard icon={TrendingUp} label="Top Games by Hours">
          {analytics.topGames.length === 0 ? (
            <p className="text-xs text-white/40">No hours recorded yet</p>
          ) : (
            <div className="space-y-2">
              {analytics.topGames.map((game, i) => {
                const pct = analytics.maxHours > 0
                  ? (game.hoursPlayed / analytics.maxHours) * 100
                  : 0;
                return (
                  <div key={game.gameId} className="flex items-center gap-2">
                    <span className="text-[10px] text-white/30 w-3 text-right font-mono">
                      {i + 1}
                    </span>
                    {/* Tiny cover */}
                    <div className="w-5 h-7 rounded-sm overflow-hidden bg-white/5 flex-shrink-0">
                      {game.coverUrl ? (
                        <img
                          src={game.coverUrl}
                          alt={game.title}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Gamepad2 className="w-2.5 h-2.5 text-white/20" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-white/80 truncate font-medium">
                          {game.title}
                        </span>
                        <span className="text-[10px] text-cyan-400 flex-shrink-0 ml-2">
                          {game.hoursPlayed}h
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-400 transition-all duration-700"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </StatCard>

        {/* Genre Distribution */}
        <StatCard icon={Tag} label="Genre Distribution">
          {analytics.topGenres.length === 0 ? (
            <p className="text-xs text-white/40">No genre data available</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {analytics.topGenres.map(([genre, count]) => (
                <div
                  key={genre}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium',
                    'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20',
                    'hover:bg-fuchsia-500/20 hover:border-fuchsia-500/30 transition-colors',
                  )}
                >
                  {genre}
                  <span className="ml-1 text-fuchsia-400/60">{count}</span>
                </div>
              ))}
            </div>
          )}
        </StatCard>
      </div>
    </div>
  );
}
