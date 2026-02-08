/**
 * Release Calendar Component
 *
 * Monthly grid calendar showing upcoming game releases from Steam's
 * Coming Soon + New Releases APIs. Forward-only navigation starting
 * from the current month. Games without exact dates go in a TBD section.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Loader2,
  RefreshCw,
  Clock,
  Monitor,
  Apple,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface UpcomingRelease {
  id: number;
  name: string;
  image: string;
  releaseDate: string; // e.g. "Mar 15, 2026", "Coming Soon", "To be announced"
  comingSoon: boolean;
  genres: string[];
  platforms: { windows: boolean; mac: boolean; linux: boolean };
}

interface ParsedRelease extends UpcomingRelease {
  parsedDate: Date | null; // null = TBD
}

// Declare the Steam API type for the new method
declare global {
  interface Window {
    steam?: {
      getUpcomingReleases?: () => Promise<UpcomingRelease[]>;
      [key: string]: any;
    };
  }
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

/**
 * Parse Steam's release_date.date string into a Date or null.
 * Handles: "Mar 15, 2026", "15 Mar, 2026", "March 2026", "Q1 2026",
 *          "Coming Soon", "To be announced", etc.
 */
function parseReleaseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  const lower = dateStr.toLowerCase().trim();

  // TBD patterns
  if (
    lower.includes('coming soon') ||
    lower.includes('to be announced') ||
    lower.includes('tba') ||
    lower.includes('tbd') ||
    lower === 'n/a' ||
    lower === ''
  ) {
    return null;
  }

  // Quarter patterns (Q1 2026, etc.)
  const quarterMatch = lower.match(/q(\d)\s+(\d{4})/);
  if (quarterMatch) {
    return null; // Treat quarter dates as approximate / TBD
  }

  // Try standard Date parsing
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  // Try "DD Mon, YYYY" format
  const dmyMatch = dateStr.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
  if (dmyMatch) {
    const attempt = new Date(`${dmyMatch[2]} ${dmyMatch[1]}, ${dmyMatch[3]}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  return null;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

// ─── Game Tile (inside calendar cell) ───────────────────────────────────────

function GameTile({
  game,
  compact = false,
}: {
  game: ParsedRelease;
  compact?: boolean;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div
        className={cn(
          'rounded overflow-hidden cursor-pointer transition-all hover:ring-1 hover:ring-fuchsia-500/50',
          compact ? 'w-full h-8' : 'w-full h-10'
        )}
      >
        {game.image ? (
          <img
            src={game.image}
            alt={game.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-white/10 flex items-center justify-center">
            <span className="text-[6px] text-white/40 truncate px-0.5">
              {game.name}
            </span>
          </div>
        )}
      </div>

      {/* Tooltip */}
      <AnimatePresence>
        {showTooltip && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 pointer-events-none"
          >
            <div className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden">
              {game.image && (
                <img
                  src={game.image}
                  alt={game.name}
                  className="w-full h-24 object-cover"
                />
              )}
              <div className="p-2.5 space-y-1.5">
                <p className="text-xs font-semibold text-white leading-tight">
                  {game.name}
                </p>
                <p className="text-[10px] text-white/50">
                  {game.releaseDate}
                </p>
                {game.genres.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {game.genres.slice(0, 3).map((g) => (
                      <span
                        key={g}
                        className="text-[9px] px-1.5 py-0.5 bg-white/10 rounded text-white/60"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-white/40">
                  {game.platforms.windows && <Monitor className="w-2.5 h-2.5" />}
                  {game.platforms.mac && <Apple className="w-2.5 h-2.5" />}
                  {game.platforms.linux && <Terminal className="w-2.5 h-2.5" />}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── TBD Card (for games without exact dates) ───────────────────────────────

function TBDCard({ game }: { game: ParsedRelease }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg overflow-hidden hover:border-white/10 transition-colors group">
      <div className="h-20 overflow-hidden">
        {game.image ? (
          <img
            src={game.image}
            alt={game.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-white/5 flex items-center justify-center">
            <CalendarDays className="w-6 h-6 text-white/10" />
          </div>
        )}
      </div>
      <div className="p-2 space-y-1">
        <p className="text-[11px] font-medium text-white truncate">{game.name}</p>
        <div className="flex items-center gap-1">
          <Clock className="w-2.5 h-2.5 text-white/30" />
          <span className="text-[9px] text-white/30">{game.releaseDate}</span>
        </div>
        {game.genres.length > 0 && (
          <div className="flex flex-wrap gap-0.5">
            {game.genres.slice(0, 2).map((g) => (
              <span
                key={g}
                className="text-[8px] px-1 py-0.5 bg-white/5 rounded text-white/40"
              >
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Calendar Component ────────────────────────────────────────────────

export function ReleaseCalendar() {
  const today = useMemo(() => new Date(), []);
  const minYear = today.getFullYear();
  const minMonth = today.getMonth();

  const [currentYear, setCurrentYear] = useState(minYear);
  const [currentMonth, setCurrentMonth] = useState(minMonth);
  const [releases, setReleases] = useState<ParsedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch upcoming releases
  const fetchReleases = useCallback(async () => {
    if (!window.steam?.getUpcomingReleases) {
      setError('Steam API not available');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const raw = await window.steam.getUpcomingReleases();
      const parsed: ParsedRelease[] = raw.map((r) => ({
        ...r,
        parsedDate: parseReleaseDate(r.releaseDate),
      }));
      setReleases(parsed);
    } catch (err) {
      console.error('[ReleaseCalendar] Failed to fetch releases:', err);
      setError('Failed to load upcoming releases');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount + auto-refresh every 30 minutes
  useEffect(() => {
    fetchReleases();
    const interval = setInterval(fetchReleases, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchReleases]);

  // Navigation
  const goNext = useCallback(() => {
    setCurrentMonth((m) => {
      if (m === 11) {
        setCurrentYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  const goPrev = useCallback(() => {
    // Don't go before current month
    if (currentYear === minYear && currentMonth === minMonth) return;

    setCurrentMonth((m) => {
      if (m === 0) {
        setCurrentYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, [currentYear, currentMonth, minYear, minMonth]);

  const goToday = useCallback(() => {
    setCurrentYear(minYear);
    setCurrentMonth(minMonth);
  }, [minYear, minMonth]);

  const canGoPrev = currentYear > minYear || currentMonth > minMonth;
  const isCurrentMonth = currentYear === minYear && currentMonth === minMonth;

  // Group releases by date for the current month
  const { datedReleases, tbdReleases } = useMemo(() => {
    const dated: Map<number, ParsedRelease[]> = new Map();
    const tbd: ParsedRelease[] = [];

    for (const release of releases) {
      if (!release.parsedDate) {
        tbd.push(release);
        continue;
      }

      const d = release.parsedDate;
      if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
        const day = d.getDate();
        if (!dated.has(day)) {
          dated.set(day, []);
        }
        dated.get(day)!.push(release);
      }
    }

    return { datedReleases: dated, tbdReleases: tbd };
  }, [releases, currentYear, currentMonth]);

  // Calendar grid data
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

  // Loading state
  if (loading && releases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <Loader2 className="w-8 h-8 text-fuchsia-500 animate-spin" />
        <p className="text-sm text-white/40">Loading upcoming releases...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={goPrev}
              disabled={!canGoPrev}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                canGoPrev
                  ? 'hover:bg-white/10 text-white/60 hover:text-white'
                  : 'text-white/15 cursor-not-allowed'
              )}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <h2 className="text-lg font-semibold text-white min-w-[180px] text-center">
              {MONTH_NAMES[currentMonth]} {currentYear}
            </h2>

            <button
              onClick={goNext}
              className="p-1.5 rounded-md hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {!isCurrentMonth && (
            <button
              onClick={goToday}
              className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-fuchsia-500/20 text-fuchsia-400 hover:bg-fuchsia-500/30 transition-colors"
            >
              Today
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {loading && (
            <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />
          )}
          <button
            onClick={fetchReleases}
            disabled={loading}
            className="p-1.5 rounded-md hover:bg-white/10 text-white/40 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Calendar Grid */}
      <div className="border border-white/[0.06] rounded-xl overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-7 bg-white/[0.03]">
          {DAY_NAMES.map((day) => (
            <div
              key={day}
              className="px-2 py-2 text-center text-[10px] font-medium text-white/30 uppercase tracking-wider border-b border-white/[0.06]"
            >
              {day}
            </div>
          ))}
        </div>

        {/* Date cells */}
        <div className="grid grid-cols-7">
          {Array.from({ length: totalCells }).map((_, idx) => {
            const dayNum = idx - firstDay + 1;
            const isValidDay = dayNum >= 1 && dayNum <= daysInMonth;
            const cellDate = isValidDay
              ? new Date(currentYear, currentMonth, dayNum)
              : null;
            const isTodayCell = cellDate ? isToday(cellDate) : false;
            const dayReleases = isValidDay
              ? datedReleases.get(dayNum) || []
              : [];

            // Grey out past days (before today)
            const isPast =
              cellDate !== null && cellDate < today && !isTodayCell;

            return (
              <div
                key={idx}
                className={cn(
                  'min-h-[90px] border-b border-r border-white/[0.04] p-1.5 transition-colors',
                  !isValidDay && 'bg-white/[0.01]',
                  isPast && 'opacity-40',
                  isTodayCell && 'bg-fuchsia-500/[0.06]',
                  dayReleases.length > 0 &&
                    !isPast &&
                    'hover:bg-white/[0.03]'
                )}
              >
                {isValidDay && (
                  <>
                    <div
                      className={cn(
                        'text-[11px] font-medium mb-1',
                        isTodayCell
                          ? 'text-fuchsia-400'
                          : 'text-white/30'
                      )}
                    >
                      {isTodayCell ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-fuchsia-500 text-white text-[10px]">
                          {dayNum}
                        </span>
                      ) : (
                        dayNum
                      )}
                    </div>
                    <div className="space-y-1">
                      {dayReleases.slice(0, 3).map((game) => (
                        <GameTile
                          key={game.id}
                          game={game}
                          compact={dayReleases.length > 2}
                        />
                      ))}
                      {dayReleases.length > 3 && (
                        <div className="text-[8px] text-white/30 text-center">
                          +{dayReleases.length - 3} more
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* TBD Section */}
      {tbdReleases.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-white/30" />
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">
              Coming Soon — No Exact Date
            </h3>
            <span className="text-[10px] text-white/20 bg-white/5 px-1.5 py-0.5 rounded">
              {tbdReleases.length}
            </span>
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2">
            {tbdReleases.map((game) => (
              <TBDCard key={game.id} game={game} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && releases.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <CalendarDays className="w-10 h-10 text-white/10" />
          <p className="text-sm text-white/30">No upcoming releases found</p>
          <button
            onClick={fetchReleases}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
