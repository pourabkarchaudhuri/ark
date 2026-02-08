/**
 * Journey Gantt View Component ("OCD" mode)
 *
 * A horizontally scrollable Gantt chart showing each game as a row with
 * colored status-segment bars across a time axis. Derived entirely from
 * existing JourneyEntry + StatusChangeEntry data — nothing new is stored.
 *
 * Game info (cover, title, hours) is embedded directly inside the first
 * segment bar of each row so users never lose context while scrolling.
 */
import { useMemo, useRef, useState, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Gamepad2, Clock, Calendar } from 'lucide-react';
import { JourneyEntry, StatusChangeEntry, GameStatus } from '@/types/game';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GanttSegment {
  status: GameStatus;
  startDate: string; // ISO
  endDate: string;   // ISO (or "now")
}

export interface GanttGameRow {
  gameId: number;
  title: string;
  coverUrl?: string;
  addedAt: string;
  removedAt?: string;
  hoursPlayed: number;
  rating: number;
  currentStatus: GameStatus;
  segments: GanttSegment[];
}

// ─── Status colors — gradient fills with glow ────────────────────────────────

const segmentStyles: Record<GameStatus, { bar: string; glow: string; border: string }> = {
  'Playing': {
    bar: 'bg-gradient-to-r from-blue-600/80 to-blue-400/60',
    glow: 'shadow-lg shadow-blue-500/20',
    border: 'border border-blue-400/30',
  },
  'Playing Now': {
    bar: 'bg-gradient-to-r from-emerald-600/80 to-emerald-400/60',
    glow: 'shadow-lg shadow-emerald-500/20',
    border: 'border border-emerald-400/30',
  },
  'Completed': {
    bar: 'bg-gradient-to-r from-green-600/80 to-green-400/60',
    glow: 'shadow-lg shadow-green-500/20',
    border: 'border border-green-400/30',
  },
  'On Hold': {
    bar: 'bg-gradient-to-r from-amber-600/80 to-amber-400/60',
    glow: 'shadow-lg shadow-amber-500/20',
    border: 'border border-amber-400/30',
  },
  'Want to Play': {
    bar: 'bg-gradient-to-r from-white/15 to-white/8',
    glow: 'shadow-md shadow-white/5',
    border: 'border border-white/15',
  },
};

// Legend dot colors (solid for the legend strip)
const legendDotColors: Record<string, string> = {
  'Playing':      'bg-blue-500',
  'Completed':    'bg-green-500',
  'On Hold':      'bg-amber-500',
  'Want to Play': 'bg-white/30',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function daysBetween(a: string | Date, b: string | Date): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS));
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMonth(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short' });
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

// ─── Build rows from store data ─────────────────────────────────────────────

export function buildGanttRows(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
): GanttGameRow[] {
  // Index status history by gameId for fast lookup
  const historyByGame = new Map<number, StatusChangeEntry[]>();
  for (const entry of statusHistory) {
    if (!historyByGame.has(entry.gameId)) historyByGame.set(entry.gameId, []);
    historyByGame.get(entry.gameId)!.push(entry);
  }

  const now = new Date().toISOString();

  return journeyEntries.map((je) => {
    const changes = historyByGame.get(je.gameId) ?? [];
    // Sort chronologically
    changes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const segments: GanttSegment[] = [];

    if (changes.length === 0) {
      // No status history — single bar from addedAt to now/removedAt
      segments.push({
        status: je.status,
        startDate: je.addedAt,
        endDate: je.removedAt ?? now,
      });
    } else {
      // Build segments from transitions
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        const startDate = i === 0 ? je.addedAt : change.timestamp;
        const endDate =
          i < changes.length - 1
            ? changes[i + 1].timestamp
            : (je.removedAt ?? now);

        segments.push({
          status: change.newStatus,
          startDate,
          endDate,
        });
      }
    }

    return {
      gameId: je.gameId,
      title: je.title,
      coverUrl: je.coverUrl,
      addedAt: je.addedAt,
      removedAt: je.removedAt,
      hoursPlayed: je.hoursPlayed,
      rating: je.rating,
      currentStatus: je.status,
      segments,
    };
  });
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

interface TooltipData {
  title: string;
  status: GameStatus;
  startDate: string;
  endDate: string;
  durationDays: number;
  hoursPlayed: number;
  x: number;
  y: number;
}

function GanttTooltip({ data }: { data: TooltipData }) {
  const isOngoing = new Date(data.endDate).getTime() >= Date.now() - DAY_MS;
  return (
    <div
      className="fixed z-[100] pointer-events-none px-4 py-3 rounded-xl bg-black/95 backdrop-blur-md border border-white/15 shadow-2xl shadow-black/40 text-xs max-w-[260px]"
      style={{ left: data.x + 14, top: data.y - 14 }}
    >
      <div className="font-bold text-white text-sm mb-1 truncate">{data.title}</div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className={cn('w-2 h-2 rounded-full', segmentStyles[data.status].bar.split(' ')[1]?.replace('/80', '') || 'bg-white/40')} />
        <span className="text-white/80 font-medium">{data.status}</span>
      </div>
      <div className="text-white/50 text-[11px]">
        {formatShortDate(data.startDate)} — {isOngoing ? 'Present' : formatShortDate(data.endDate)}
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-white/40 text-[11px]">
        <span>{data.durationDays} day{data.durationDays !== 1 ? 's' : ''}</span>
        {data.hoursPlayed > 0 && <span>{data.hoursPlayed}h played</span>}
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface JourneyGanttViewProps {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
}

const ROW_HEIGHT = 64;          // px per game row — taller for embedded info
const DAY_WIDTH = 4;            // px per day on the timeline
const MONTH_HEADER_HEIGHT = 48; // px for the month/year header
const MIN_BAR_WIDTH = 6;        // minimum px width so tiny segments are visible
const GAME_INFO_MIN_WIDTH = 130; // min px to show full game info inside bar
const GAME_PILL_MIN_WIDTH = 70; // min px to show compact pill

export function JourneyGanttView({ journeyEntries, statusHistory }: JourneyGanttViewProps) {
  const [, navigate] = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Build rows
  const rows = useMemo(
    () => buildGanttRows(journeyEntries, statusHistory)
        .sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()),
    [journeyEntries, statusHistory]
  );

  // Compute time range
  const { timelineStart, timelineEnd, totalDays, months } = useMemo(() => {
    if (rows.length === 0) {
      const now = new Date();
      const start = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 3, 1));
      return { timelineStart: start, timelineEnd: now, totalDays: 90, months: [] as Date[] };
    }

    const allDates = rows.flatMap((r) =>
      r.segments.flatMap((s) => [new Date(s.startDate), new Date(s.endDate)])
    );
    const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime()), Date.now()));

    // Pad: start one month before earliest, end one month after latest
    const start = startOfMonth(addMonths(minDate, -1));
    const end = addMonths(startOfMonth(maxDate), 2);
    const total = daysBetween(start.toISOString(), end.toISOString());

    // Generate month markers
    const monthMarkers: Date[] = [];
    let cursor = new Date(start);
    while (cursor <= end) {
      monthMarkers.push(new Date(cursor));
      cursor = addMonths(cursor, 1);
    }

    return { timelineStart: start, timelineEnd: end, totalDays: total, months: monthMarkers };
  }, [rows]);

  const timelineWidth = totalDays * DAY_WIDTH;

  // Position helper: given an ISO date, return px offset from timeline start
  const dateToX = useCallback(
    (iso: string) => {
      const days = daysBetween(timelineStart.toISOString(), iso);
      return Math.max(0, (days - 1) * DAY_WIDTH);
    },
    [timelineStart]
  );

  // Determine which segment index should show embedded game info
  // Prefer the first segment, but use widest if first is too narrow
  const getInfoSegmentIndex = useCallback(
    (row: GanttGameRow): number => {
      if (row.segments.length === 0) return -1;

      // Calculate width of first segment
      const firstSeg = row.segments[0];
      const firstLeft = dateToX(firstSeg.startDate);
      const firstRight = dateToX(firstSeg.endDate);
      const firstWidth = Math.max(MIN_BAR_WIDTH, firstRight - firstLeft);

      if (firstWidth >= GAME_PILL_MIN_WIDTH) return 0;

      // Find widest segment
      let widestIdx = 0;
      let widestWidth = 0;
      for (let i = 0; i < row.segments.length; i++) {
        const seg = row.segments[i];
        const l = dateToX(seg.startDate);
        const r = dateToX(seg.endDate);
        const w = Math.max(MIN_BAR_WIDTH, r - l);
        if (w > widestWidth) {
          widestWidth = w;
          widestIdx = i;
        }
      }
      return widestIdx;
    },
    [dateToX]
  );

  const handleSegmentHover = useCallback(
    (e: React.MouseEvent, seg: GanttSegment, row: GanttGameRow) => {
      setTooltip({
        title: row.title,
        status: seg.status,
        startDate: seg.startDate,
        endDate: seg.endDate,
        durationDays: daysBetween(seg.startDate, seg.endDate),
        hoursPlayed: row.hoursPlayed,
        x: e.clientX,
        y: e.clientY,
      });
    },
    []
  );

  const handleSegmentLeave = useCallback(() => setTooltip(null), []);

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Gamepad2 className="w-10 h-10 text-fuchsia-500 mb-4" />
        <p className="text-white/60">No journey data to display in the Gantt chart.</p>
      </div>
    );
  }

  return (
    <div className="relative max-w-[100vw]">
      {/* Legend */}
      <div className="flex items-center gap-3 px-4 md:px-10 mb-4 flex-wrap">
        {(['Playing', 'Completed', 'On Hold', 'Want to Play'] as GameStatus[]).map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <div className={cn('w-3 h-3 rounded-sm', legendDotColors[s])} />
            <span className="text-xs text-white/50">{s}</span>
          </div>
        ))}
      </div>

      {/* Gantt container — full-width timeline, no sticky left column */}
      <div
        ref={scrollRef}
        className="relative overflow-x-auto overflow-y-hidden"
        style={{ minHeight: MONTH_HEADER_HEIGHT + rows.length * ROW_HEIGHT + 20 }}
      >
        <div className="relative" style={{ width: timelineWidth, minWidth: '100%' }}>

          {/* Month header */}
          <div
            className="flex border-b border-white/10 sticky top-0 z-10 bg-black/80 backdrop-blur-sm"
            style={{ height: MONTH_HEADER_HEIGHT }}
          >
            {months.map((month, i) => {
              const x = dateToX(month.toISOString());
              const nextMonth = i < months.length - 1 ? months[i + 1] : timelineEnd;
              const width = dateToX(nextMonth.toISOString()) - x;

              // Show year for first month or January
              const showYear = i === 0 || month.getMonth() === 0;

              return (
                <div
                  key={i}
                  className="absolute flex flex-col items-start justify-end pb-1 pl-2 border-l border-white/10"
                  style={{ left: x, width, height: MONTH_HEADER_HEIGHT }}
                >
                  {showYear && (
                    <span className="text-[10px] text-fuchsia-400/80 font-bold font-['Orbitron']">
                      {month.getFullYear()}
                    </span>
                  )}
                  <span className="text-xs text-white/50 font-medium">
                    {formatMonth(month)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Rows / bars */}
          {rows.map((row) => {
            const infoSegIdx = getInfoSegmentIndex(row);

            return (
              <div
                key={row.gameId}
                className="relative border-b border-white/5 group/row hover:bg-white/[0.02] transition-colors cursor-pointer"
                style={{ height: ROW_HEIGHT }}
                onClick={() => navigate(`/game/${row.gameId}`)}
              >
                {/* Vertical month gridlines (faint) */}
                {months.map((month, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 w-px bg-white/5"
                    style={{ left: dateToX(month.toISOString()) }}
                  />
                ))}

                {/* Segment bars */}
                {row.segments.map((seg, i) => {
                  const left = dateToX(seg.startDate);
                  const right = dateToX(seg.endDate);
                  const width = Math.max(MIN_BAR_WIDTH, right - left);
                  const style = segmentStyles[seg.status];
                  const isInfoSegment = i === infoSegIdx;

                  return (
                    <div
                      key={i}
                      className={cn(
                        'absolute top-2 rounded-lg backdrop-blur-sm cursor-pointer transition-all duration-200',
                        'hover:brightness-125 hover:shadow-xl hover:scale-y-105',
                        style.bar,
                        style.glow,
                        style.border,
                      )}
                      style={{
                        left,
                        width,
                        height: ROW_HEIGHT - 16,
                      }}
                      onMouseMove={(e) => {
                        e.stopPropagation();
                        handleSegmentHover(e, seg, row);
                      }}
                      onMouseLeave={handleSegmentLeave}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/game/${row.gameId}`);
                      }}
                    >
                      {/* Glassmorphism shimmer overlay */}
                      <div className="absolute inset-0 rounded-lg bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />

                      {/* Embedded game info — only in the designated segment */}
                      {isInfoSegment && width >= GAME_INFO_MIN_WIDTH && (
                        <div className="absolute inset-0 flex items-center gap-1.5 px-2 overflow-hidden">
                          {/* Tiny cover thumbnail */}
                          <div className="flex-shrink-0 w-5 h-7 rounded-sm overflow-hidden bg-black/30">
                            {row.coverUrl ? (
                              <img
                                src={row.coverUrl}
                                alt={row.title}
                                className="w-full h-full object-cover"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Gamepad2 className="w-3 h-3 text-white/30" />
                              </div>
                            )}
                          </div>
                          {/* Title & hours */}
                          <div className="flex-1 min-w-0 flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-white truncate drop-shadow-md">
                              {row.title}
                            </span>
                            {row.hoursPlayed > 0 && width >= GAME_INFO_MIN_WIDTH + 40 && (
                              <span className="text-[10px] text-white/60 flex-shrink-0 flex items-center gap-0.5">
                                <Clock className="w-2.5 h-2.5" />
                                {row.hoursPlayed}h
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Compact pill — title only, when bar is wide enough for pill but not full info */}
                      {isInfoSegment && width >= GAME_PILL_MIN_WIDTH && width < GAME_INFO_MIN_WIDTH && (
                        <div className="absolute inset-0 flex items-center px-2 overflow-hidden">
                          <span className="text-[10px] font-semibold text-white truncate drop-shadow-md">
                            {row.title}
                          </span>
                        </div>
                      )}

                      {/* Status label inside bar (non-info segments, wide enough) */}
                      {!isInfoSegment && width > 60 && (
                        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-white/70 font-medium truncate">
                          {seg.status}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* "Added" marker dot */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-fuchsia-500 border border-fuchsia-300 z-10"
                  style={{ left: dateToX(row.addedAt) - 4 }}
                  title={`Added: ${formatShortDate(row.addedAt)}`}
                />

                {/* "Removed" marker (if applicable) */}
                {row.removedAt && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-red-500 border border-red-300 z-10"
                    style={{ left: dateToX(row.removedAt) - 4 }}
                    title={`Removed: ${formatShortDate(row.removedAt)}`}
                  />
                )}
              </div>
            );
          })}

          {/* Today marker */}
          <div
            className="absolute top-0 z-10"
            style={{
              left: dateToX(new Date().toISOString()),
              height: MONTH_HEADER_HEIGHT + rows.length * ROW_HEIGHT,
            }}
          >
            <div className="w-px h-full bg-fuchsia-500/60" />
            <div className="absolute -top-0 -left-[18px] text-[9px] text-fuchsia-400 font-semibold bg-black/80 px-1 rounded">
              Today
            </div>
          </div>
        </div>
      </div>

      {/* Summary footer */}
      <div className="flex items-center gap-4 px-4 md:px-10 mt-4 text-xs text-white/40 flex-wrap">
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {rows.length} game{rows.length !== 1 ? 's' : ''} tracked
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {rows.reduce((sum, r) => sum + r.hoursPlayed, 0)}h total
        </span>
        <span>
          {rows.filter((r) => r.currentStatus === 'Completed').length} completed
        </span>
      </div>

      {/* Floating tooltip */}
      {tooltip && <GanttTooltip data={tooltip} />}
    </div>
  );
}
