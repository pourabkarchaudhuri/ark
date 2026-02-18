/**
 * Journey View Component
 * Shows the user's gaming history as a vertical timeline, grouped by year.
 * Uses the journey store which persists entries even after library removal.
 * Scrolls from latest (top) to oldest (bottom).
 *
 * Four view styles:
 *  - "Ark": 3D card showcase
 *  - "Log" (Captain's Log): vertical timeline grouped by year and month
 *  - "OCD": horizontally scrollable Gantt chart with status-colored bars
 *  - "Medals": gamified progression with Taste DNA and badge vault (analytics in Overview)
 */
import { useMemo, useState, useEffect, memo, useCallback, useRef } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { Gamepad2, Clock, Star, Calendar, Trash2, Library, Users, BarChart3, ScrollText, X, Box, Award } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Timeline, TimelineEntry } from '@/components/ui/timeline';
import { JourneyEntry, GameStatus } from '@/types/game';
import { steamService } from '@/services/steam-service';
import { libraryStore } from '@/services/library-store';
import { journeyStore } from '@/services/journey-store';
import { statusHistoryStore } from '@/services/status-history-store';
import { sessionStore } from '@/services/session-store';
import { JourneyGanttView } from '@/components/journey-gantt-view';
import { generateMockGanttData } from '@/components/journey-gantt-mock-data';
import { cn, buildGameImageChain, formatHours } from '@/lib/utils';
import { ShowcaseView } from '@/components/showcase-view';
import { MedalsView } from '@/components/medals-view';

type JourneyViewStyle = 'log' | 'ocd' | 'ark' | 'medals';
type GanttDataSource = 'live' | 'mock';

/**
 * Build a full fallback chain of image URLs for a journey entry.
 * Also looks up the library entry's cachedMeta for richer image data
 * (especially important for Epic games where we can't construct CDN URLs).
 */
function getJourneyImageChain(entry: { gameId: string; title: string; coverUrl?: string }): string[] {
  // Try to get richer image data from the library's cached metadata
  const libEntry = libraryStore.getEntry(entry.gameId);
  const meta = libEntry?.cachedMeta;

  // Merge coverUrl: prefer entry's, then cachedMeta's
  const coverUrl = entry.coverUrl || meta?.coverUrl;
  const headerImage = meta?.headerImage;

  return buildGameImageChain(entry.gameId, entry.title, coverUrl, headerImage);
}

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

const STAR_INDICES = [0, 1, 2, 3, 4];

const StarRating = memo(function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {STAR_INDICES.map((i) => (
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
});

/** Cover image with multi-step fallback chain (cover → header → capsule → logo) */
const JourneyCoverImage = memo(function JourneyCoverImage({ entry }: { entry: JourneyEntry }) {
  const chain = useMemo(() => getJourneyImageChain(entry), [entry]);
  const [attempt, setAttempt] = useState(0);

  // Reset when the entry (and therefore the chain) changes
  useEffect(() => {
    setAttempt(0);
  }, [chain]);

  const handleError = useCallback(() => {
    setAttempt(prev => prev + 1);
  }, []);

  const currentSrc = chain[attempt];

  return (
    <div className="flex-shrink-0 w-16 h-24 rounded overflow-hidden bg-white/5">
      {currentSrc ? (
        <img
          key={currentSrc}
          src={currentSrc}
          alt={entry.title}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onLoad={(e) => {
            // Detect tiny placeholder images from old CDN
            const img = e.currentTarget;
            if (img.naturalWidth < 50 || img.naturalHeight < 50) {
              handleError();
            }
          }}
          onError={handleError}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-white/20">
          <Gamepad2 className="w-6 h-6" />
        </div>
      )}
    </div>
  );
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const JourneyGameCard = memo(function JourneyGameCard({ entry, playerCount }: { entry: JourneyEntry; playerCount?: number }) {
  const [, navigate] = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const addedDate = entry.addedAt
    ? new Date(entry.addedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '';
  const isRemoved = !!entry.removedAt;
  const inLibrary = libraryStore.isInLibrary(entry.gameId);

  const handleClick = useCallback(() => {
    // Removed entries have no detail page — the only interaction is delete
    if (isRemoved) return;
    navigate(`/game/${encodeURIComponent(entry.gameId)}`);
  }, [navigate, entry.gameId, isRemoved]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Don't navigate when clicking delete
    if (confirmDelete) {
      journeyStore.deleteEntry(entry.gameId);
    } else {
      setConfirmDelete(true);
      // Auto-reset confirmation after 3 seconds
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  }, [confirmDelete, entry.gameId]);

  return (
    <motion.div
      className={cn(
        'rounded-lg bg-white/5 border border-white/10 overflow-hidden transition-colors min-h-[120px] relative group',
        isRemoved
          ? 'opacity-60 cursor-default'
          : 'cursor-pointer hover:border-fuchsia-500/40'
      )}
      onClick={handleClick}
      whileHover={isRemoved ? undefined : { scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      {/* Delete button — top-right corner */}
      <button
        onClick={handleDelete}
        className={cn(
          'absolute top-1.5 right-1.5 z-10 rounded-full p-1 transition-all',
          confirmDelete
            ? 'bg-red-500/80 text-white hover:bg-red-500'
            : 'bg-black/40 text-white/40 opacity-0 group-hover:opacity-100 hover:bg-red-500/60 hover:text-white/90',
        )}
        title={confirmDelete ? 'Click again to confirm removal' : 'Remove from journey'}
      >
        <X className="w-3 h-3" />
      </button>
      {confirmDelete && (
        <div className="absolute top-8 right-1 z-10 text-[9px] text-red-400 bg-black/80 rounded px-1.5 py-0.5 whitespace-nowrap pointer-events-none">
          Click again to confirm
        </div>
      )}

      <div className="flex gap-3 p-3 h-full">
        {/* Cover image — resolves with Steam CDN fallback for missing coverUrls */}
        <JourneyCoverImage entry={entry} />

        {/* Info */}
        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          <div>
            <h4 className={cn('font-semibold text-sm truncate transition-colors pr-5', !isRemoved && 'group-hover:text-fuchsia-400')}>
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
              <span>{entry.hoursPlayed > 0 ? formatHours(entry.hoursPlayed) : '0 Mins'}</span>
            </div>
            {entry.rating > 0 && <StarRating rating={entry.rating} />}
            {addedDate && (
              <div className="flex items-center gap-1 text-xs text-white/40">
                <Calendar className="w-3 h-3" />
                <span>{addedDate}</span>
              </div>
            )}
            {playerCount !== undefined && playerCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-cyan-400" title="Live player count from Steam">
                <Users className="w-3 h-3" />
                <span>{formatPlayerCount(playerCount)} playing</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
});

export const JourneyView = memo(function JourneyView({ entries, loading, onSwitchToBrowse }: JourneyViewProps) {
  const [viewStyle, setViewStyle] = useState<JourneyViewStyle>('ark');
  // Data source for OCD view: live store data vs mock data for dev/demo
  const [dataSource, setDataSource] = useState<GanttDataSource>('live');

  // Fetch live player counts for journey entries in the background.
  // Keys are gameId strings ("steam-730") — values are player counts.
  const [playerCounts, setPlayerCounts] = useState<Record<string, number>>({});

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
      // Only fetch player counts for Steam games
      const steamIds = entries
        .filter(e => e.gameId.startsWith('steam-'))
        .map(e => parseInt(e.gameId.replace('steam-', ''), 10))
        .filter(id => !isNaN(id));

      if (steamIds.length === 0) return;

      const allCounts: Record<string, number> = {};

      const BATCH_SIZE = 20;
      for (let i = 0; i < steamIds.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = steamIds.slice(i, i + BATCH_SIZE);
        try {
          const counts = await steamService.getMultiplePlayerCounts(batch);
          if (cancelled) return;
          // Map numeric Steam IDs back to string gameId keys
          for (const [numericId, count] of Object.entries(counts)) {
            allCounts[`steam-${numericId}`] = count as number;
          }
        } catch {
          // Non-critical
        }
      }

      if (!cancelled && Object.keys(allCounts).length > 0) {
        setPlayerCounts(prev => {
          const next = { ...prev, ...allCounts };
          const changed = Object.keys(allCounts).some(k => prev[k] !== allCounts[k]);
          return changed ? next : prev;
        });
      }
    };

    fetchCounts();
    return () => { cancelled = true; };
  // Use the stable key instead of the raw entries array
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryIdsKey]);

  // Cache store snapshots to avoid creating new array references on every render.
  // Only recalculate when the view actually needs it and dependencies change.
  const statusHistoryRef = useRef(statusHistoryStore.getAll());
  const sessionsRef = useRef(sessionStore.getAll());
  const libraryEntriesRef = useRef(libraryStore.getAllEntries());

  // Subscribe once and update refs (no state, so no re-render from here)
  useEffect(() => {
    const unsubHistory = statusHistoryStore.subscribe(() => {
      statusHistoryRef.current = statusHistoryStore.getAll();
    });
    const unsubSessions = sessionStore.subscribe(() => {
      sessionsRef.current = sessionStore.getAll();
    });
    const unsubLibrary = libraryStore.subscribe(() => {
      libraryEntriesRef.current = libraryStore.getAllEntries();
    });
    return () => { unsubHistory(); unsubSessions(); unsubLibrary(); };
  }, []);

  // Ark and Log: entries with firstPlayedAt or lastPlayedAt; sort: Playing first, then by latest activity (lastPlayedAt ?? firstPlayedAt) desc
  const arkAndLogEntries = useMemo(() => {
    const playingStatuses: GameStatus[] = ['Playing', 'Playing Now'];
    const withActivity = entries.filter((e) => e.firstPlayedAt || e.lastPlayedAt);
    const latest = (e: JourneyEntry) =>
      new Date(e.lastPlayedAt ?? e.firstPlayedAt ?? e.addedAt).getTime();
    return withActivity.sort((a, b) => {
      const aPlaying = playingStatuses.includes(a.status);
      const bPlaying = playingStatuses.includes(b.status);
      if (aPlaying && !bPlaying) return -1;
      if (!aPlaying && bPlaying) return 1;
      return latest(b) - latest(a);
    });
  }, [entries]);

  // Captain's Log: per-month grouping. An entry appears in a month if firstPlayedAt or lastPlayedAt falls in that month (same game can appear in Jan and March).
  // Within each month, sort by the date that applies to that month (lastPlayedAt if in month, else firstPlayedAt), desc.
  const timelineData: TimelineEntry[] = useMemo(() => {
    if (arkAndLogEntries.length === 0) return [];

    const monthToEntries = new Map<string, Array<{ entry: JourneyEntry; sortDate: string }>>();

    for (const entry of arkAndLogEntries) {
      const addToMonth = (year: number, month: number, sortDate: string) => {
        const key = `${year}-${month}`;
        if (!monthToEntries.has(key)) monthToEntries.set(key, []);
        monthToEntries.get(key)!.push({ entry, sortDate });
      };
      if (entry.firstPlayedAt) {
        const d = new Date(entry.firstPlayedAt);
        addToMonth(d.getFullYear(), d.getMonth(), entry.firstPlayedAt);
      }
      if (entry.lastPlayedAt) {
        const d = new Date(entry.lastPlayedAt);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const existing = monthToEntries.get(key);
        if (existing?.some((x) => x.entry.gameId === entry.gameId)) {
          const cell = existing.find((x) => x.entry.gameId === entry.gameId)!;
          cell.sortDate = entry.lastPlayedAt;
        } else {
          addToMonth(d.getFullYear(), d.getMonth(), entry.lastPlayedAt);
        }
      }
    }

    // Group by year: year -> list of { month, list }
    const byYear = new Map<number, Array<{ month: number; list: Array<{ entry: JourneyEntry; sortDate: string }> }>>();
    for (const [key, list] of monthToEntries) {
      const [y, m] = key.split('-').map(Number);
      if (!byYear.has(y)) byYear.set(y, []);
      list.sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime());
      byYear.get(y)!.push({ month: m, list });
    }
    for (const arr of byYear.values()) {
      arr.sort((a, b) => b.month - a.month);
    }
    const sortedYears = Array.from(byYear.keys()).sort((a, b) => b - a);

    return sortedYears.map((year) => {
      const monthsWithEntries = byYear.get(year)!;
      const yearEntriesUnique = Array.from(
        new Map(
          monthsWithEntries.flatMap(({ list }) => list.map((x) => x.entry)).map((e) => [e.gameId, e])
        ).values()
      );
      const completed = yearEntriesUnique.filter((e) => e.status === 'Completed').length;
      const playing = yearEntriesUnique.filter((e) => e.status === 'Playing').length;
      const removed = yearEntriesUnique.filter((e) => !!e.removedAt).length;
      const yearHours = yearEntriesUnique.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);

      return {
        title: String(year),
        content: (
          <div>
            {viewStyle === 'log' ? (
              <p className="mb-4 font-mono text-xs text-white/40">
                // CYCLE {year} — {yearEntriesUnique.length} title{yearEntriesUnique.length !== 1 ? 's' : ''} registered
                {completed > 0 && ` · ${completed} mission${completed !== 1 ? 's' : ''} complete`}
                {playing > 0 && ` · ${playing} active`}
                {removed > 0 && ` · ${removed} decommissioned`}
                {yearHours > 0 && ` · ${formatHours(yearHours)}`}
              </p>
            ) : (
              <p className="mb-4 text-sm text-white/60">
                {yearEntriesUnique.length} game{yearEntriesUnique.length !== 1 ? 's' : ''} in history
                {completed > 0 && ` · ${completed} completed`}
                {playing > 0 && ` · ${playing} playing`}
                {removed > 0 && ` · ${removed} removed`}
              </p>
            )}

            {viewStyle === 'log' ? (
              <div className="space-y-6">
                {monthsWithEntries.map(({ month: m, list }) => {
                  const monthEntries = list.map((x) => x.entry);
                  const monthCompleted = monthEntries.filter((e) => e.status === 'Completed').length;
                  const monthHours = monthEntries.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);
                  return (
                    <div key={`${year}-${m}`}>
                      <div className="flex items-center gap-3 mb-3">
                        <h4 className="text-sm font-semibold text-white/70">
                          {MONTH_NAMES[m]}
                        </h4>
                        <div className="flex-1 h-px bg-white/10" />
                        <span className="text-[11px] text-white/30 font-mono shrink-0">
                          {monthEntries.length} title{monthEntries.length !== 1 ? 's' : ''}
                          {monthCompleted > 0 && ` · ${monthCompleted} done`}
                          {monthHours > 0 && ` · ${formatHours(monthHours)}`}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        {monthEntries.map((entry) => (
                          <JourneyGameCard
                            key={`${entry.gameId}-${year}-${m}`}
                            entry={entry}
                            playerCount={playerCounts[entry.gameId]}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {yearEntriesUnique.map((entry) => (
                  <JourneyGameCard
                    key={entry.gameId}
                    entry={entry}
                    playerCount={playerCounts[entry.gameId]}
                  />
                ))}
              </div>
            )}
          </div>
        ),
      };
    });
  }, [arkAndLogEntries, playerCounts, viewStyle]);

  // Total stats
  const totalHours = entries.reduce((sum, e) => sum + (e.hoursPlayed ?? 0), 0);
  const completedCount = entries.filter((e) => e.status === 'Completed').length;

  // Prepare Gantt data (only when OCD view is active)
  const ganttData = useMemo(() => {
    if (viewStyle !== 'ocd') return null;

    if (dataSource === 'mock') return generateMockGanttData();

    return {
      journeyEntries: entries,
      statusHistory: statusHistoryRef.current,
      sessions: sessionsRef.current,
      libraryEntries: libraryEntriesRef.current,
    };
  }, [viewStyle, dataSource, entries]);

  // Loading state — skeleton matches Voyage header + content (Your Ark / Log / OCD / Medals)
  if (loading) {
    return (
      <div className="relative w-full overflow-clip">
        {/* Header skeleton */}
        <div className="max-w-7xl mx-auto py-10 px-4 md:px-8 lg:px-10">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="h-8 md:h-9 w-48 md:w-64 bg-white/10 rounded animate-pulse mb-2" />
              <div className="h-4 w-40 bg-white/5 rounded animate-pulse" />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 gap-0.5">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-9 w-16 md:w-20 bg-white/10 rounded-md animate-pulse" />
                ))}
              </div>
            </div>
          </div>
        </div>
        {/* Content skeleton — suggests Ark / showcase area */}
        <div className="max-w-7xl mx-auto px-4 md:px-8 lg:px-10 pb-16">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden min-h-[320px] md:min-h-[380px] flex items-center justify-center animate-pulse">
            <div className="flex flex-wrap justify-center gap-4 p-6">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="w-24 h-36 md:w-28 md:h-40 rounded-lg bg-white/10 border border-white/10"
                />
              ))}
            </div>
          </div>
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
        <h2 className="text-2xl font-bold mb-2 font-['Orbitron']">Your Voyage Awaits</h2>
        <p className="text-white/60 mb-6 max-w-md">
          Start adding games to your library to see your gaming voyage unfold as a timeline.
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

  return (
    <div className="relative w-full overflow-clip">
      {/* Header */}
      <div className="max-w-7xl mx-auto py-10 px-4 md:px-8 lg:px-10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg md:text-3xl mb-2 text-white font-bold font-['Orbitron']">
              {viewStyle === 'log' ? "Captain's Log" : 'Your Gaming Voyage'}
            </h2>
            <p className="text-white/60 text-sm md:text-base max-w-lg">
              {formatHours(totalHours)} played
            </p>
          </div>

          {/* View style toggle + data source toggle */}
          <div className="flex items-center gap-3">
            <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => setViewStyle('ark')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'ark'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <Box className="w-3 h-3" />
                Your Ark
              </button>
              <button
                onClick={() => setViewStyle('log')}
                title="Captain's Log"
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'log'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <ScrollText className="w-3 h-3" />
                Log
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
                onClick={() => setViewStyle('medals')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                  viewStyle === 'medals'
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/60 hover:text-white'
                )}
              >
                <Award className="w-3 h-3" />
                Medals
              </button>
            </div>

            {/* Mock / Live toggle (visible in OCD view) */}
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
      {viewStyle === 'ark' ? (
        <ShowcaseView entries={arkAndLogEntries} />
      ) : viewStyle === 'medals' ? (
        <MedalsView entries={entries} />
      ) : viewStyle === 'ocd' && ganttData ? (
        <div className="px-0 md:px-4 lg:px-6">
          <JourneyGanttView
            journeyEntries={ganttData.journeyEntries}
            statusHistory={ganttData.statusHistory}
            sessions={ganttData.sessions}
          />
        </div>
      ) : (
        <Timeline data={timelineData} />
      )}
    </div>
  );
});
