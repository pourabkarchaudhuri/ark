/**
 * Journey View Component
 * Shows the user's gaming history as a vertical timeline, grouped by year.
 * Uses the journey store which persists entries even after library removal.
 * Scrolls from latest (top) to oldest (bottom).
 *
 * Two view styles:
 *  - "Noob" (default): vertical timeline grouped by year
 *  - "OCD": horizontally scrollable Gantt chart with status-colored bars
 */
import { useMemo, useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { Gamepad2, Clock, Star, Calendar, Trash2, Library, Users, BarChart3, List, PieChart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Timeline, TimelineEntry } from '@/components/ui/timeline';
import { JourneyEntry, GameStatus } from '@/types/game';
import { steamService } from '@/services/steam-service';
import { libraryStore } from '@/services/library-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { JourneyGanttView } from '@/components/journey-gantt-view';
import { JourneyAnalyticsView } from '@/components/journey-analytics-view';
import { generateMockGanttData } from '@/components/journey-gantt-mock-data';
import { cn } from '@/lib/utils';

type JourneyViewStyle = 'noob' | 'ocd' | 'analytics';
type GanttDataSource = 'live' | 'mock';

/** Format player count with K/M suffixes */
function formatPlayerCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return count.toLocaleString();
}

interface JourneyViewProps {
  entries: JourneyEntry[];
  loading: boolean;
  onSwitchToBrowse?: () => void;
}

// Status badge color mapping
const statusColors: Record<GameStatus, string> = {
  'Completed': 'bg-green-500/20 text-green-400 border-green-500/30',
  'Playing': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'Playing Now': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'On Hold': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'Want to Play': 'bg-white/10 text-white/60 border-white/20',
};

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            'w-3 h-3',
            i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
          )}
        />
      ))}
    </div>
  );
}

function JourneyGameCard({ entry, playerCount }: { entry: JourneyEntry; playerCount?: number }) {
  const [, navigate] = useLocation();
  const addedDate = entry.addedAt
    ? new Date(entry.addedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '';
  const isRemoved = !!entry.removedAt;
  const inLibrary = libraryStore.isInLibrary(entry.gameId);

  return (
    <motion.div
      className={cn(
        'rounded-lg bg-white/5 border border-white/10 overflow-hidden cursor-pointer group hover:border-fuchsia-500/40 transition-colors min-h-[120px]',
        isRemoved && 'opacity-60'
      )}
      onClick={() => navigate(`/game/${entry.gameId}`)}
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      <div className="flex gap-3 p-3 h-full">
        {/* Cover image */}
        <div className="flex-shrink-0 w-16 h-24 rounded overflow-hidden bg-white/5">
          {entry.coverUrl ? (
            <img
              src={entry.coverUrl}
              alt={entry.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onLoad={(e) => {
                // Detect tiny placeholder images from old CDN (newer games)
                const img = e.currentTarget;
                if (img.naturalWidth < 50 || img.naturalHeight < 50) {
                  img.style.display = 'none';
                }
              }}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                img.style.display = 'none';
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/20">
              <Gamepad2 className="w-6 h-6" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          <div>
            <h4 className="font-semibold text-sm truncate group-hover:text-fuchsia-400 transition-colors">
              {entry.title}
            </h4>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', statusColors[entry.status])}
              >
                {entry.status}
              </Badge>
              {inLibrary && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30"
                >
                  <Library className="w-2.5 h-2.5 mr-0.5" />
                  In Library
                </Badge>
              )}
              {isRemoved && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 bg-red-500/10 text-red-400/70 border-red-500/20"
                >
                  <Trash2 className="w-2.5 h-2.5 mr-0.5" />
                  Removed
                </Badge>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 mt-1.5 min-h-[1.25rem] flex-wrap">
            <div className="flex items-center gap-1 text-xs text-white/50">
              <Clock className="w-3 h-3" />
              <span>{entry.hoursPlayed > 0 ? `${entry.hoursPlayed}h` : '0h'}</span>
            </div>
            {entry.rating > 0 && <StarRating rating={entry.rating} />}
            {addedDate && (
              <div className="flex items-center gap-1 text-xs text-white/40">
                <Calendar className="w-3 h-3" />
                <span>{addedDate}</span>
              </div>
            )}
            {playerCount !== undefined && playerCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-cyan-400">
                <Users className="w-3 h-3" />
                <span>{formatPlayerCount(playerCount)} playing</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function JourneyView({ entries, loading, onSwitchToBrowse }: JourneyViewProps) {
  // View style toggle: "Noob" (vertical timeline) vs "OCD" (Gantt chart)
  const [viewStyle, setViewStyle] = useState<JourneyViewStyle>('noob');
  // Data source for OCD view: live store data vs mock data for dev/demo
  const [dataSource, setDataSource] = useState<GanttDataSource>('live');

  // Fetch live player counts for journey entries in the background.
  const [playerCounts, setPlayerCounts] = useState<Record<number, number>>({});

  // Stabilise the dependency: only re-fetch when the set of game IDs changes,
  // not when the parent passes a new array reference with the same entries.
  const entryIdsKey = useMemo(
    () => entries.map(e => e.gameId).join(','),
    [entries]
  );

  useEffect(() => {
    if (entries.length === 0) return;
    let cancelled = false;

    const fetchCounts = async () => {
      const ids = entries.map(e => e.gameId);
      const allCounts: Record<number, number> = {};

      const BATCH_SIZE = 20;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = ids.slice(i, i + BATCH_SIZE);
        try {
          const counts = await steamService.getMultiplePlayerCounts(batch);
          if (cancelled) return;
          Object.assign(allCounts, counts);
        } catch {
          // Non-critical
        }
      }

      if (!cancelled) {
        setPlayerCounts(prev => {
          // Only update state if counts actually changed
          const next = { ...prev, ...allCounts };
          const changed = Object.keys(allCounts).some(
            k => prev[Number(k)] !== allCounts[Number(k)]
          );
          return changed ? next : prev;
        });
      }
    };

    fetchCounts();
    return () => { cancelled = true; };
  // Use the stable key instead of the raw entries array
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryIdsKey]);

  // Group entries by year from addedAt, sorted newest-first (top → bottom = latest → oldest)
  const timelineData: TimelineEntry[] = useMemo(() => {
    if (entries.length === 0) return [];

    const byYear = new Map<number, JourneyEntry[]>();
    for (const entry of entries) {
      const year = new Date(entry.addedAt).getFullYear();
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)!.push(entry);
    }

    // Sort years newest first (latest at top)
    const sortedYears = Array.from(byYear.keys()).sort((a, b) => b - a);

    return sortedYears.map((year) => {
      const yearEntries = byYear.get(year)!;
      // Sort entries within year by addedAt, newest first
      yearEntries.sort(
        (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
      );

      // Count stats for this year
      const completed = yearEntries.filter((e) => e.status === 'Completed').length;
      const playing = yearEntries.filter((e) => e.status === 'Playing').length;
      const removed = yearEntries.filter((e) => !!e.removedAt).length;

      return {
        title: String(year),
        content: (
          <div>
            {/* Year summary */}
            <p className="mb-4 text-sm text-white/60">
              {yearEntries.length} game{yearEntries.length !== 1 ? 's' : ''} added
              {completed > 0 && ` · ${completed} completed`}
              {playing > 0 && ` · ${playing} playing`}
              {removed > 0 && ` · ${removed} removed`}
            </p>

            {/* Game cards grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {yearEntries.map((entry) => (
                <JourneyGameCard
                  key={entry.gameId}
                  entry={entry}
                  playerCount={playerCounts[entry.gameId]}
                />
              ))}
            </div>
          </div>
        ),
      };
    });
  }, [entries, playerCounts]);

  // Loading state
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto py-10 px-4 md:px-10">
        <div className="mb-8">
          <div className="h-8 w-48 bg-white/10 rounded animate-pulse mb-2" />
          <div className="h-4 w-72 bg-white/5 rounded animate-pulse" />
        </div>
        <div className="space-y-16">
          {Array.from({ length: 2 }).map((_, yearIdx) => (
            <div key={yearIdx} className="flex gap-10">
              <div className="w-32 flex-shrink-0">
                <div className="h-10 w-20 bg-white/10 rounded animate-pulse" />
              </div>
              <div className="flex-1 space-y-3">
                <div className="h-4 w-40 bg-white/5 rounded animate-pulse" />
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="rounded-lg bg-white/5 border border-white/10 p-3 flex gap-3 animate-pulse"
                    >
                      <div className="w-16 h-24 bg-white/10 rounded" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-3/4 bg-white/10 rounded" />
                        <div className="h-3 w-1/2 bg-white/5 rounded" />
                        <div className="h-3 w-1/3 bg-white/5 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Empty state
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6 shadow-lg shadow-fuchsia-500/10">
          <Gamepad2 className="w-10 h-10 text-fuchsia-500" />
        </div>
        <h2 className="text-2xl font-bold mb-2 font-['Orbitron']">Your Journey Awaits</h2>
        <p className="text-white/60 mb-6 max-w-md">
          Start adding games to your library to see your gaming journey unfold as a timeline.
        </p>
        {onSwitchToBrowse && (
          <Button
            onClick={onSwitchToBrowse}
            className="bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
          >
            Browse Games
          </Button>
        )}
      </div>
    );
  }

  // Total stats
  const totalHours = entries.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);
  const completedCount = entries.filter((e) => e.status === 'Completed').length;

  // Prepare Gantt/analytics data (only when OCD or Analytics view is active)
  const ganttData = useMemo(() => {
    if (viewStyle !== 'ocd' && viewStyle !== 'analytics') return null;

    if (viewStyle === 'ocd' && dataSource === 'mock') {
      return generateMockGanttData();
    }

    // Live data from stores
    return {
      journeyEntries: entries,
      statusHistory: statusHistoryStore.getAll(),
    };
  }, [viewStyle, dataSource, entries]);

  return (
    <div className="relative w-full overflow-clip">
      {/* Header */}
      <div className="max-w-7xl mx-auto py-10 px-4 md:px-8 lg:px-10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg md:text-3xl mb-2 text-white font-bold font-['Orbitron']">
              Your Gaming Journey
            </h2>
            <p className="text-white/60 text-sm md:text-base max-w-lg">
              {entries.length} game{entries.length !== 1 ? 's' : ''} in your history
              {completedCount > 0 && ` · ${completedCount} completed`}
              {totalHours > 0 && ` · ${totalHours}h played`}
            </p>
          </div>

          {/* View style toggle + data source toggle */}
          <div className="flex items-center gap-3">
            {/* Noob / OCD / Analytics toggle */}
            <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => setViewStyle('noob')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'noob'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <List className="w-3 h-3" />
                Noob
              </button>
              <button
                onClick={() => setViewStyle('ocd')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'ocd'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <BarChart3 className="w-3 h-3" />
                OCD
              </button>
              <button
                onClick={() => setViewStyle('analytics')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'analytics'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <PieChart className="w-3 h-3" />
                Analytics
              </button>
            </div>

            {/* Mock / Live toggle (only visible in OCD view) */}
            {viewStyle === 'ocd' && (
              <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10">
                <button
                  onClick={() => setDataSource('live')}
                  className={cn(
                    'px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors',
                    dataSource === 'live'
                      ? 'bg-emerald-500 text-white'
                      : 'text-white/50 hover:text-white'
                  )}
                >
                  Live
                </button>
                <button
                  onClick={() => setDataSource('mock')}
                  className={cn(
                    'px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors',
                    dataSource === 'mock'
                      ? 'bg-amber-500 text-white'
                      : 'text-white/50 hover:text-white'
                  )}
                >
                  Mock
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conditional view rendering */}
      {viewStyle === 'ocd' && ganttData ? (
        <div className="px-0 md:px-4 lg:px-6">
          <JourneyGanttView
            journeyEntries={ganttData.journeyEntries}
            statusHistory={ganttData.statusHistory}
          />
        </div>
      ) : viewStyle === 'analytics' && ganttData ? (
        <JourneyAnalyticsView
          journeyEntries={ganttData.journeyEntries}
          statusHistory={ganttData.statusHistory}
        />
      ) : (
        <Timeline data={timelineData} />
      )}
    </div>
  );
}
