/**
 * Journey Gantt View Component ("OCD" mode)
 *
 * A horizontally scrollable Gantt chart showing each game as a row with
 * colored status-segment bars across a time axis. Derived entirely from
 * existing JourneyEntry + StatusChangeEntry data — nothing new is stored.
 *
 * Game info (cover, title, hours) is embedded directly inside the first
 * segment bar of each row so users never lose context while scrolling.
 *
 * UX features:
 *  - Zoom controls (slider + Ctrl+wheel + W/M/Y presets)
 *  - Scroll-to-Now floating button
 *  - Keyboard navigation (arrows, enter, +/-, esc) with auto-scroll
 *  - Session heatmap overlay (dots inside bars)
 *  - Sort controls (date, hours, status, rating)
 *  - Interactive legend status filters with counts
 *  - Animated bar entrance (framer-motion)
 *  - Row highlight on hover (dim others)
 *  - Minimap with viewport indicator + drag-to-scrub
 *  - Search/filter by game title
 *  - Milestone diamond hover popovers
 *  - Gap indicators between segments
 *  - Live session pulse on Playing Now bars
 *  - Drag-to-scroll (grab cursor pan)
 *  - Toolbar state persistence (localStorage)
 *  - Tooltip edge clamping
 *  - Accessibility (ARIA roles + labels)
 */
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';

import { motion } from 'framer-motion';
import { Gamepad2, Clock, Calendar, Search, X, Crosshair, ArrowUpDown, ZoomIn } from 'lucide-react';
import { JourneyEntry, StatusChangeEntry, GameStatus, GameSession } from '@/types/game';
import { Slider } from '@/components/ui/slider';
import { cn, getHardcodedCover } from '@/lib/utils';

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

type SortKey = 'addedAt' | 'hours' | 'status';

const STATUS_ORDER: Record<GameStatus, number> = {
  'Playing Now': 0,
  'Playing': 1,
  'On Hold': 2,
  'Want to Play': 3,
  'Completed': 4,
};

// ─── Status visual styles — reference-aligned two-tier system ─────────────────

interface SegmentStyle {
  bar: string;
  glow: string;
  border: string;
  text: string;
  badgeBg: string;
  badgeText: string;
  legendDot: string;
  minimapColor: string;
}

const segmentStyles: Record<GameStatus, SegmentStyle> = {
  'Playing Now': {
    bar: 'bg-gradient-to-r from-teal-600 to-emerald-500',
    glow: 'shadow-md shadow-teal-500/25',
    border: 'border border-teal-400/40',
    text: 'text-white',
    badgeBg: 'bg-black/50',
    badgeText: 'text-white',
    legendDot: 'bg-gradient-to-r from-teal-500 to-emerald-400',
    minimapColor: '#2dd4bf',
  },
  'Playing': {
    bar: 'bg-white/[0.88]',
    glow: 'shadow-sm shadow-black/10',
    border: 'border border-white/20 border-l-[3px] border-l-teal-400',
    text: 'text-gray-900',
    badgeBg: 'bg-gray-800/80',
    badgeText: 'text-white',
    legendDot: 'bg-white/85',
    minimapColor: '#e0e0e0',
  },
  'Completed': {
    bar: 'bg-white/[0.88]',
    glow: 'shadow-sm shadow-black/10',
    border: 'border border-white/20 border-l-[3px] border-l-emerald-400',
    text: 'text-gray-900',
    badgeBg: 'bg-gray-800/80',
    badgeText: 'text-white',
    legendDot: 'bg-white/85',
    minimapColor: '#d0d0d0',
  },
  'On Hold': {
    bar: 'bg-white/20',
    glow: 'shadow-sm shadow-black/5',
    border: 'border border-white/10 border-l-[3px] border-l-amber-400/70',
    text: 'text-white/80',
    badgeBg: 'bg-black/40',
    badgeText: 'text-white/80',
    legendDot: 'bg-white/25',
    minimapColor: '#666',
  },
  'Want to Play': {
    bar: 'bg-white/10',
    glow: '',
    border: 'border border-white/[0.08] border-l-[3px] border-l-white/20',
    text: 'text-white/60',
    badgeBg: 'bg-black/30',
    badgeText: 'text-white/60',
    legendDot: 'bg-white/15',
    minimapColor: '#444',
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DAY_WIDTH_DEFAULT = 4;
const DAY_WIDTH_MIN = 1;
const DAY_WIDTH_MAX = 12;

function daysBetween(a: string | Date, b: string | Date): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS));
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function formatDuration(days: number): string {
  if (days < 14) return `${days} day${days !== 1 ? 's' : ''}`;
  if (days < 60) return `${Math.round(days / 7)} wks`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, '');
  return `${years} yr`;
}

function formatTimelineSpan(days: number): string {
  if (days < 60) return `${days} days`;
  if (days < 365) {
    const months = (days / 30.44).toFixed(1).replace(/\.0$/, '');
    return `${months} month`;
  }
  const years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
  return `${years} years`;
}

function formatMonthLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short' });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── Preferences persistence ────────────────────────────────────────────────

const GANTT_PREFS_KEY = 'ark-gantt-prefs';

interface GanttPrefs {
  dayWidth: number;
  sortBy: SortKey;
  hiddenStatuses: string[];
}

function loadPrefs(): Partial<GanttPrefs> {
  try {
    return JSON.parse(localStorage.getItem(GANTT_PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePrefs(p: GanttPrefs) {
  localStorage.setItem(GANTT_PREFS_KEY, JSON.stringify(p));
}

const _savedPrefs = loadPrefs();

// ─── Build rows from store data ─────────────────────────────────────────────

export function buildGanttRows(
  journeyEntries: JourneyEntry[],
  statusHistory: StatusChangeEntry[],
): GanttGameRow[] {
  const historyByGame = new Map<number, StatusChangeEntry[]>();
  for (const entry of statusHistory) {
    if (!historyByGame.has(entry.gameId)) historyByGame.set(entry.gameId, []);
    historyByGame.get(entry.gameId)!.push(entry);
  }

  const now = new Date().toISOString();

  return journeyEntries.map((je) => {
    const changes = historyByGame.get(je.gameId) ?? [];
    changes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const segments: GanttSegment[] = [];

    if (changes.length === 0) {
      segments.push({
        status: je.status,
        startDate: je.addedAt,
        endDate: je.removedAt ?? now,
      });
    } else {
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

// ─── Tooltip (with edge clamping) ───────────────────────────────────────────

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

const TOOLTIP_W = 280;
const TOOLTIP_H = 120;

// GanttTooltip is now rendered via ref-driven DOM updates (no re-render on mouse move)

// ─── Minimap sub-component (with drag-to-scrub) ─────────────────────────────

interface MinimapProps {
  rows: GanttGameRow[];
  timelineWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  onSeek: (scrollLeft: number) => void;
  dateToX: (iso: string) => number;
}

const MINIMAP_HEIGHT = 28;
const MINIMAP_ROW_HEIGHT = 2;

function GanttMinimap({ rows, timelineWidth, scrollLeft, viewportWidth, onSeek, dateToX }: MinimapProps) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const scale = viewportWidth > 0 ? viewportWidth / timelineWidth : 1;
  const vpIndicatorLeft = scrollLeft * scale;
  const vpIndicatorWidth = Math.max(8, viewportWidth * scale);

  const seekFromEvent = useCallback((clientX: number) => {
    if (!minimapRef.current) return;
    const rect = minimapRef.current.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const targetScroll = (clickX / rect.width) * timelineWidth - viewportWidth / 2;
    onSeek(Math.max(0, targetScroll));
  }, [timelineWidth, viewportWidth, onSeek]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true;
    seekFromEvent(e.clientX);
  }, [seekFromEvent]);

  // Drag-to-scrub via document-level mouse events
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      seekFromEvent(e.clientX);
    };
    const handleUp = () => {
      isDraggingRef.current = false;
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [seekFromEvent]);

  if (rows.length === 0 || timelineWidth <= viewportWidth) return null;

  return (
    <div
      ref={minimapRef}
      className="relative mx-4 md:mx-10 mt-3 rounded-lg bg-white/[0.03] border border-white/[0.06] cursor-ew-resize overflow-hidden select-none"
      style={{ height: MINIMAP_HEIGHT }}
      onMouseDown={handleMouseDown}
      role="slider"
      aria-label="Timeline minimap"
      aria-valuemin={0}
      aria-valuemax={timelineWidth}
      aria-valuenow={scrollLeft}
    >
      {/* Compressed bars */}
      {rows.map((row, ri) => (
        <div key={row.gameId}>
          {row.segments.map((seg, si) => {
            const left = dateToX(seg.startDate) * scale;
            const right = dateToX(seg.endDate) * scale;
            const width = Math.max(1, right - left);
            return (
              <div
                key={`${ri}-${si}`}
                className="absolute rounded-[1px]"
                style={{
                  left,
                  width,
                  top: 2 + ri * (MINIMAP_ROW_HEIGHT + 1),
                  height: MINIMAP_ROW_HEIGHT,
                  backgroundColor: segmentStyles[seg.status].minimapColor,
                  opacity: 0.7,
                }}
              />
            );
          })}
        </div>
      ))}

      {/* Viewport indicator */}
      <div
        className="absolute top-0 bottom-0 border border-fuchsia-500/50 bg-fuchsia-500/10 rounded-sm"
        style={{ left: vpIndicatorLeft, width: vpIndicatorWidth }}
      />
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface JourneyGanttViewProps {
  journeyEntries: JourneyEntry[];
  statusHistory: StatusChangeEntry[];
  sessions?: GameSession[];
}

const ROW_HEIGHT = 72;
const HEADER_HEIGHT = 56;
const SIDEBAR_WIDTH = 200;
const MIN_BAR_WIDTH = 8;
const BAR_V_PADDING = 16;
const GAME_INFO_MIN_WIDTH = 130;
const GAME_PILL_MIN_WIDTH = 70;
const DURATION_BADGE_MIN_WIDTH = 56;
const GAP_THRESHOLD_DAYS = 14;

const ALL_STATUSES: GameStatus[] = ['Playing Now', 'Playing'];

/** Statuses excluded from OCD view — these indicate no active play */
const EXCLUDED_STATUSES: Set<GameStatus> = new Set(['On Hold', 'Completed', 'Want to Play']);

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'addedAt', label: 'Date' },
  { key: 'hours', label: 'Hours' },
  { key: 'status', label: 'Status' },
];

const ZOOM_PRESETS: { label: string; title: string; value: number }[] = [
  { label: 'W', title: 'Week view', value: 10 },
  { label: 'M', title: 'Month view', value: 4 },
  { label: 'Y', title: 'Year view', value: 1 },
];

export function JourneyGanttView({ journeyEntries, statusHistory, sessions }: JourneyGanttViewProps) {

  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const sidebarBodyRef = useRef<HTMLDivElement>(null);

  // ── Feature state (hydrated from localStorage) ────────────────────────
  const [dayWidth, setDayWidth] = useState(() =>
    typeof _savedPrefs.dayWidth === 'number'
      ? clamp(_savedPrefs.dayWidth, DAY_WIDTH_MIN, DAY_WIDTH_MAX)
      : DAY_WIDTH_DEFAULT
  );
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<GameStatus>>(() => {
    if (Array.isArray(_savedPrefs.hiddenStatuses)) {
      return new Set(_savedPrefs.hiddenStatuses as GameStatus[]);
    }
    return new Set();
  });
  const [sortBy, setSortBy] = useState<SortKey>(() =>
    (['addedAt', 'hours', 'status'] as SortKey[]).includes(_savedPrefs.sortBy as SortKey)
      ? (_savedPrefs.sortBy as SortKey)
      : 'addedAt'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedRowIdx, setFocusedRowIdx] = useState(-1);
  // Use refs for hover/scroll state to avoid full re-renders
  const hoveredRowIdRef = useRef<number | null>(null);
  const rowEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const [minimapScrollLeft, setMinimapScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const scrollRaf = useRef(0);
  const hasAnimated = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipDataRef = useRef<TooltipData | null>(null);

  // ── Dynamic chart height (fill remaining viewport) ─────────────────
  const [chartHeight, setChartHeight] = useState(500);

  useEffect(() => {
    const measure = () => {
      const el = scrollRef.current ?? wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Leave room for minimap (~40px) + footer (~40px) + breathing room
      const available = window.innerHeight - rect.top - 100;
      setChartHeight(Math.max(200, available));
    };

    measure();
    // Re-measure on resize and after layout settles
    window.addEventListener('resize', measure);
    const raf = requestAnimationFrame(measure);
    return () => {
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, []);

  // ── Drag-to-scroll state ──────────────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, scrollLeft: 0 });
  const hasDragged = useRef(false);

  // ── Persist preferences to localStorage ───────────────────────────────
  useEffect(() => {
    savePrefs({
      dayWidth,
      sortBy,
      hiddenStatuses: Array.from(hiddenStatuses),
    });
  }, [dayWidth, sortBy, hiddenStatuses]);

  // ── Build + filter + sort rows ─────────────────────────────────────────
  const allRows = useMemo(
    () => buildGanttRows(journeyEntries, statusHistory).filter(
      (r) => !EXCLUDED_STATUSES.has(r.currentStatus)
    ),
    [journeyEntries, statusHistory]
  );

  const rows = useMemo(() => {
    let result = allRows;

    if (hiddenStatuses.size > 0) {
      result = result.filter((r) => !hiddenStatuses.has(r.currentStatus));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((r) => r.title.toLowerCase().includes(q));
    }

    switch (sortBy) {
      case 'hours':
        result = [...result].sort((a, b) => b.hoursPlayed - a.hoursPlayed);
        break;
      case 'status':
        result = [...result].sort((a, b) => STATUS_ORDER[a.currentStatus] - STATUS_ORDER[b.currentStatus]);
        break;
      case 'addedAt':
      default:
        result = [...result].sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
        break;
    }

    return result;
  }, [allRows, hiddenStatuses, searchQuery, sortBy]);

  // ── Status counts for legend badges ───────────────────────────────────
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of ALL_STATUSES) counts[s] = 0;
    for (const r of allRows) counts[r.currentStatus]++;
    return counts;
  }, [allRows]);

  // ── Session map (for heatmap dots) ─────────────────────────────────────
  const sessionsByGame = useMemo(() => {
    const map = new Map<number, GameSession[]>();
    if (!sessions) return map;
    for (const s of sessions) {
      if (!map.has(s.gameId)) map.set(s.gameId, []);
      map.get(s.gameId)!.push(s);
    }
    return map;
  }, [sessions]);

  // ── Compute time range (uses allRows so filtering doesn't shift timeline) ─
  const { timelineStart, timelineEnd, totalDays, months, spanDays } = useMemo(() => {
    if (allRows.length === 0) {
      const now = new Date();
      const start = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 3, 1));
      return { timelineStart: start, timelineEnd: now, totalDays: 90, months: [] as Date[], spanDays: 90 };
    }

    const allDates = allRows.flatMap((r) =>
      r.segments.flatMap((s) => [new Date(s.startDate), new Date(s.endDate)])
    );
    const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime()), Date.now()));
    const dataSpan = daysBetween(minDate.toISOString(), maxDate.toISOString());

    const start = startOfMonth(addMonths(minDate, -1));
    const end = addMonths(startOfMonth(maxDate), 2);
    const total = daysBetween(start.toISOString(), end.toISOString());

    const monthMarkers: Date[] = [];
    let cursor = new Date(start);
    while (cursor <= end) {
      monthMarkers.push(new Date(cursor));
      cursor = addMonths(cursor, 1);
    }

    return { timelineStart: start, timelineEnd: end, totalDays: total, months: monthMarkers, spanDays: dataSpan };
  }, [allRows]);

  const timelineWidth = totalDays * dayWidth;

  // Position helper
  const dateToX = useCallback(
    (iso: string) => {
      const days = daysBetween(timelineStart.toISOString(), iso);
      return Math.max(0, (days - 1) * dayWidth);
    },
    [timelineStart, dayWidth]
  );

  // Info segment index
  const getInfoSegmentIndex = useCallback(
    (row: GanttGameRow): number => {
      if (row.segments.length === 0) return -1;
      const firstSeg = row.segments[0];
      const firstWidth = Math.max(MIN_BAR_WIDTH, dateToX(firstSeg.endDate) - dateToX(firstSeg.startDate));
      if (firstWidth >= GAME_PILL_MIN_WIDTH) return 0;

      let widestIdx = 0;
      let widestWidth = 0;
      for (let i = 0; i < row.segments.length; i++) {
        const seg = row.segments[i];
        const w = Math.max(MIN_BAR_WIDTH, dateToX(seg.endDate) - dateToX(seg.startDate));
        if (w > widestWidth) { widestWidth = w; widestIdx = i; }
      }
      return widestIdx;
    },
    [dateToX]
  );

  // ── Hover / tooltip via refs + direct DOM (avoids re-renders) ─────────
  // Row IDs: positive = timeline row, negative = sidebar row (negated gameId)
  const applyHoverStyles = useCallback((gameId: number | null) => {
    const prev = hoveredRowIdRef.current;
    if (prev === gameId) return;
    hoveredRowIdRef.current = gameId;
    // Update opacity/classes via direct DOM
    rowEls.current.forEach((el, id) => {
      // Match both sidebar (negative offset) and timeline (positive) rows for the same game
      const isMatch = gameId !== null && (id === gameId || id === -(gameId + 1));
      if (gameId === null) {
        el.style.opacity = '1';
        el.classList.remove('bg-white/[0.02]');
      } else if (isMatch) {
        el.style.opacity = '1';
        el.classList.add('bg-white/[0.02]');
      } else {
        el.style.opacity = '0.4';
        el.classList.remove('bg-white/[0.02]');
      }
    });
  }, []);

  const handleRowEnter = useCallback((gameId: number) => {
    applyHoverStyles(gameId);
  }, [applyHoverStyles]);

  const handleRowLeave = useCallback(() => {
    applyHoverStyles(null);
  }, [applyHoverStyles]);

  const updateTooltipEl = useCallback((data: TooltipData | null) => {
    tooltipDataRef.current = data;
    const el = tooltipRef.current;
    if (!el) return;
    if (!data) {
      el.style.display = 'none';
      return;
    }
    const left = Math.min(data.x + 16, window.innerWidth - TOOLTIP_W - 8);
    const top = Math.min(Math.max(8, data.y - 16), window.innerHeight - TOOLTIP_H - 8);
    el.style.display = 'block';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const isOngoing = new Date(data.endDate).getTime() >= Date.now() - DAY_MS;
    const style = segmentStyles[data.status];
    el.innerHTML = `
      <div class="font-bold text-white text-sm mb-1.5 truncate">${data.title}</div>
      <div class="flex items-center gap-2 mb-2">
        <div class="w-2.5 h-2.5 rounded-full ${style.legendDot}"></div>
        <span class="text-white/80 font-medium">${data.status}</span>
      </div>
      <div class="text-white/50 text-[11px]">
        ${formatShortDate(data.startDate)} — ${isOngoing ? 'Present' : formatShortDate(data.endDate)}
      </div>
      <div class="flex items-center gap-3 mt-2 text-white/40 text-[11px]">
        <span>${formatDuration(data.durationDays)}</span>
        ${data.hoursPlayed > 0 ? `<span>${data.hoursPlayed}h played</span>` : ''}
      </div>
    `;
  }, []);

  const handleSegmentHover = useCallback(
    (e: React.MouseEvent, seg: GanttSegment, row: GanttGameRow) => {
      updateTooltipEl({
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
    [updateTooltipEl]
  );

  const handleSegmentLeave = useCallback(() => updateTooltipEl(null), [updateTooltipEl]);

  // ── Ctrl+Wheel zoom ───────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const dateFraction = cursorX / (totalDays * dayWidth);

      setDayWidth((prev) => {
        const next = clamp(prev + (e.deltaY < 0 ? 1 : -1), DAY_WIDTH_MIN, DAY_WIDTH_MAX);
        requestAnimationFrame(() => {
          const newCursorX = dateFraction * totalDays * next;
          el.scrollLeft = newCursorX - (e.clientX - rect.left);
        });
        return next;
      });
    };

    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [totalDays, dayWidth]);

  // ── Sync sidebar vertical scroll with timeline ─────────────────────────
  useEffect(() => {
    const timeline = scrollRef.current;
    const sidebar = sidebarBodyRef.current;
    if (!timeline || !sidebar) return;
    const inner = sidebar.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const syncScroll = () => {
      inner.style.transform = `translateY(-${timeline.scrollTop}px)`;
    };
    timeline.addEventListener('scroll', syncScroll, { passive: true });
    return () => timeline.removeEventListener('scroll', syncScroll);
  }, []);

  // ── Drag-to-scroll ────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only start drag on the scroll container background, not on bars
    const el = scrollRef.current;
    if (!el) return;
    setIsDragging(true);
    hasDragged.current = false;
    dragStart.current = { x: e.clientX, scrollLeft: el.scrollLeft };
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const dx = e.clientX - dragStart.current.x;
      if (Math.abs(dx) > 3) hasDragged.current = true;
      el.scrollLeft = dragStart.current.scrollLeft - dx;
    };
    const handleUp = () => setIsDragging(false);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging]);

  // ── Track viewport width + scroll position for minimap (RAF-throttled) ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      setMinimapScrollLeft(el.scrollLeft);
      setViewportWidth(el.clientWidth);
    };

    // Throttle scroll updates to one per animation frame
    const onScroll = () => {
      cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = requestAnimationFrame(update);
    };

    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(scrollRaf.current);
      ro.disconnect();
    };
  }, []);

  // ── Keyboard navigation ───────────────────────────────────────────────
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedRowIdx((prev) => Math.min(prev + 1, rows.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedRowIdx((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          break;
        case '+':
        case '=':
          setDayWidth((prev) => clamp(prev + 1, DAY_WIDTH_MIN, DAY_WIDTH_MAX));
          break;
        case '-':
          setDayWidth((prev) => clamp(prev - 1, DAY_WIDTH_MIN, DAY_WIDTH_MAX));
          break;
        case 'Escape':
          setSearchQuery('');
          setFocusedRowIdx(-1);
          break;
      }
    };

    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [focusedRowIdx, rows]);

  // ── Focused row auto-scroll ───────────────────────────────────────────
  useEffect(() => {
    if (focusedRowIdx < 0) return;
    const el = wrapperRef.current?.querySelector(`[data-row-index="${focusedRowIdx}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusedRowIdx]);

  // ── Scroll-to-Now helper ──────────────────────────────────────────────
  const nowX = useMemo(() => dateToX(new Date().toISOString()), [dateToX]);

  const scrollToNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: nowX - el.clientWidth / 2, behavior: 'smooth' });
  }, [nowX]);

  const isNowVisible = useMemo(() => {
    if (viewportWidth === 0) return true;
    return nowX >= minimapScrollLeft && nowX <= minimapScrollLeft + viewportWidth;
  }, [nowX, minimapScrollLeft, viewportWidth]);

  // ── Legend toggle handler ─────────────────────────────────────────────
  const toggleStatus = useCallback((status: GameStatus) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  // ── Memoized footer stats (avoid recalculating on every render) ────────
  const footerStats = useMemo(() => ({
    gameCount: rows.length,
    totalHours: rows.reduce((sum, r) => sum + r.hoursPlayed, 0),
    completedCount: rows.filter((r) => r.currentStatus === 'Completed').length,
  }), [rows]);

  // ── Mark first animation done ─────────────────────────────────────────
  useEffect(() => {
    if (rows.length > 0 && !hasAnimated.current) {
      const timer = setTimeout(() => { hasAnimated.current = true; }, 800);
      return () => clearTimeout(timer);
    }
  }, [rows.length]);

  // ── Empty state ───────────────────────────────────────────────────────
  if (allRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Gamepad2 className="w-10 h-10 text-fuchsia-500 mb-4" />
        <p className="text-white/60">No journey data to display in the Gantt chart.</p>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="relative max-w-[100vw] outline-none"
      tabIndex={0}
      role="grid"
      aria-label="Gaming journey Gantt chart"
    >

      {/* ── Toolbar: Legend + Search + Sort + Zoom + Span ─────────────── */}
      <div className="px-4 md:px-10 mb-5 space-y-3">

        {/* Row 1: Legend (clickable filters with counts) + Span label */}
        <div className="flex items-center justify-between flex-wrap gap-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            {ALL_STATUSES.map((s) => {
              const isHidden = hiddenStatuses.has(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  aria-pressed={!isHidden}
                  className={cn(
                    'flex items-center gap-1.5 transition-opacity cursor-pointer select-none',
                    isHidden && 'opacity-30',
                  )}
                >
                  <div className={cn('w-2.5 h-2.5 rounded-full', segmentStyles[s].legendDot)} />
                  <span className="text-[11px] text-white/45 font-medium">{s}</span>
                  <span className="text-[9px] text-white/25">{statusCounts[s]}</span>
                </button>
              );
            })}
            {hiddenStatuses.size > 0 && (
              <button
                onClick={() => setHiddenStatuses(new Set())}
                className="text-[10px] text-fuchsia-400/70 hover:text-fuchsia-400 ml-1 underline underline-offset-2"
              >
                Show All
              </button>
            )}
          </div>

          <span className="text-sm text-white/30 font-medium tabular-nums">
            {formatTimelineSpan(spanDays)}
          </span>
        </div>

        {/* Row 2: Search + Sort + Zoom */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-shrink-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search games..."
              aria-label="Search games"
              className="w-44 pl-8 pr-7 py-1.5 text-[11px] rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/25 outline-none focus:border-fuchsia-500/40 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Sort pills */}
          <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5 border border-white/10">
            <ArrowUpDown className="w-3 h-3 text-white/30 mx-1.5" />
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={cn(
                  'px-2 py-1 text-[10px] font-medium rounded-md transition-colors',
                  sortBy === opt.key
                    ? 'bg-fuchsia-500 text-white'
                    : 'text-white/45 hover:text-white/70',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Zoom: presets + slider */}
          <div className="flex items-center gap-2 ml-auto">
            <ZoomIn className="w-3.5 h-3.5 text-white/30" />
            <div className="flex items-center gap-0.5">
              {ZOOM_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setDayWidth(p.value)}
                  title={p.title}
                  className={cn(
                    'px-1.5 py-0.5 text-[9px] font-bold rounded transition-colors',
                    dayWidth === p.value
                      ? 'bg-fuchsia-500 text-white'
                      : 'text-white/30 hover:text-white/60 bg-white/5',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Slider
              value={[dayWidth]}
              onValueChange={([v]) => setDayWidth(v)}
              min={DAY_WIDTH_MIN}
              max={DAY_WIDTH_MAX}
              step={1}
              className="w-24"
            />
            <span className="text-[10px] text-white/25 tabular-nums w-5 text-center">{dayWidth}x</span>
          </div>
        </div>
      </div>

      {/* ── Gantt container (sidebar + scrollable timeline) ──────────── */}
      <div className="flex" style={{ height: chartHeight }}>

        {/* ── Sticky sidebar: game labels ─────────────────────────── */}
        <div
          className="flex-shrink-0 overflow-hidden border-r border-white/[0.06] bg-black/40 backdrop-blur-sm z-20"
          style={{ width: SIDEBAR_WIDTH }}
        >
          {/* Sidebar header (aligns with timeline date header) */}
          <div
            className="flex items-end px-3 pb-2 border-b border-white/[0.06] bg-black/60"
            style={{ height: HEADER_HEIGHT }}
          >
            <span className="text-[10px] text-white/30 font-medium uppercase tracking-wider">Games</span>
          </div>

          {/* Sidebar rows — synced scroll with timeline */}
          <div
            className="overflow-hidden"
            ref={sidebarBodyRef}
            style={{ height: chartHeight - HEADER_HEIGHT }}
          >
            <div style={{ height: rows.length * ROW_HEIGHT + 24 }}>
              {rows.map((row, rowIndex) => {
                const isFocused = focusedRowIdx === rowIndex;
                return (
                  <div
                    key={row.gameId}
                    className={cn(
                      'flex items-center gap-2.5 px-3 border-b border-white/[0.03] transition-[opacity] duration-200',
                      isFocused && 'bg-fuchsia-500/5',
                    )}
                    style={{ height: ROW_HEIGHT }}
                    onMouseEnter={() => handleRowEnter(row.gameId)}
                    onMouseLeave={handleRowLeave}
                    ref={(el) => {
                      // Register sidebar rows for hover dim effect (negative key avoids collision with timeline row refs)
                      const key = -(row.gameId + 1); // offset+negate to avoid 0 collision
                      if (el) rowEls.current.set(key, el);
                      else rowEls.current.delete(key);
                    }}
                  >
                    {/* Thumbnail */}
                    <div className="flex-shrink-0 w-8 h-11 rounded-md overflow-hidden bg-white/5">
                      {(getHardcodedCover(row.title) || row.coverUrl) ? (
                        <img
                          src={getHardcodedCover(row.title) || row.coverUrl}
                          alt={row.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Gamepad2 className="w-3.5 h-3.5 text-white/20" />
                        </div>
                      )}
                    </div>

                    {/* Title + hours */}
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold text-white/80 truncate leading-tight">
                        {row.title}
                      </div>
                      <div className="text-[9px] text-white/30 mt-0.5">
                        {row.hoursPlayed}h played
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Scrollable timeline area ────────────────────────────── */}
        <div
          ref={scrollRef}
          className={cn(
            'relative flex-1 overflow-x-auto overflow-y-auto select-none',
            isDragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          onMouseDown={handleDragStart}
        >
          <div className="relative" style={{ width: timelineWidth, minWidth: '100%', height: HEADER_HEIGHT + rows.length * ROW_HEIGHT + 24 }}>

            {/* ── Date header ──────────────────────────────────────────── */}
            <div
              className="sticky top-0 z-20 border-b border-white/[0.06]"
              style={{ height: HEADER_HEIGHT }}
            >
              <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />

            {months.map((month, i) => {
              const x = dateToX(month.toISOString());
              const nextMonth = i < months.length - 1 ? months[i + 1] : timelineEnd;
              const monthWidth = dateToX(nextMonth.toISOString()) - x;
              const showYear = i === 0 || month.getMonth() === 0;
              const mid = new Date(month.getFullYear(), month.getMonth(), 15);
              const midX = dateToX(mid.toISOString());

              return (
                <div key={i}>
                  <div
                    className="absolute flex flex-col items-start justify-end pb-2 pl-2"
                    style={{ left: x, width: monthWidth, height: HEADER_HEIGHT }}
                  >
                    {showYear && (
                      <span className="text-[10px] text-fuchsia-400/70 font-bold font-display tracking-wider">
                        {month.getFullYear()}
                      </span>
                    )}
                    <span className="text-xs text-white/50 font-medium">
                      {formatMonthLabel(month)}
                    </span>
                  </div>
                  <div
                    className="absolute top-0 w-px bg-white/[0.06]"
                    style={{ left: x, height: HEADER_HEIGHT }}
                  />
                  {monthWidth > 50 && (
                    <div
                      className="absolute flex items-end pb-2 pl-1"
                      style={{ left: midX, height: HEADER_HEIGHT }}
                    >
                      <span className="text-[10px] text-white/25 font-medium">
                        15
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* "Now" pill badge */}
            <div
              className="absolute z-30 flex flex-col items-center"
              style={{ left: nowX, top: 6 }}
            >
              <div className="relative -left-[14px] px-2.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold tracking-wide shadow-lg shadow-red-500/30">
                Now
              </div>
            </div>
          </div>

          {/* ── Row area ─────────────────────────────────────────────── */}
          {rows.length === 0 && allRows.length > 0 && (
            <div className="flex items-center justify-center py-16 text-white/40 text-sm">
              No games match your filters.
            </div>
          )}

          {rows.map((row, rowIndex) => {
            const infoSegIdx = getInfoSegmentIndex(row);
            const isFocused = focusedRowIdx === rowIndex;
            const gameSessions = sessionsByGame.get(row.gameId);

            return (
              <div
                key={row.gameId}
                data-row-index={rowIndex}
                ref={(el) => {
                  if (el) rowEls.current.set(row.gameId, el);
                  else rowEls.current.delete(row.gameId);
                }}
                role="row"
                aria-label={`${row.title}: ${row.currentStatus}, ${row.hoursPlayed}h played`}
                className={cn(
                  'relative group/row transition-[opacity] duration-200',
                  isFocused && 'border-l-2 border-l-fuchsia-500/50',
                )}
                style={{ height: ROW_HEIGHT }}
                onClick={() => {
                  if (hasDragged.current) { hasDragged.current = false; return; }
                }}
                onMouseEnter={() => handleRowEnter(row.gameId)}
                onMouseLeave={handleRowLeave}
              >
                {/* Vertical month gridlines */}
                {months.map((month, mi) => (
                  <div
                    key={mi}
                    className="absolute top-0 bottom-0 w-px bg-white/[0.04]"
                    style={{ left: dateToX(month.toISOString()) }}
                  />
                ))}

                {/* "Now" dashed vertical line */}
                <div
                  className="absolute top-0 bottom-0 w-px border-l border-dashed border-red-500/30"
                  style={{ left: nowX }}
                />

                {/* ── Gap indicators between segments ────────────────── */}
                {row.segments.map((seg, i) => {
                  if (i === 0) return null;
                  const prevEnd = row.segments[i - 1].endDate;
                  const curStart = seg.startDate;
                  const gapDays = daysBetween(prevEnd, curStart);
                  if (gapDays <= GAP_THRESHOLD_DAYS) return null;

                  const gapLeft = dateToX(prevEnd);
                  const gapRight = dateToX(curStart);
                  const gapMid = (gapLeft + gapRight) / 2;

                  return (
                    <span
                      key={`gap-${i}`}
                      className="absolute text-[8px] text-white/20 italic pointer-events-none whitespace-nowrap"
                      style={{
                        left: gapMid,
                        top: ROW_HEIGHT / 2 - 5,
                        transform: 'translateX(-50%)',
                      }}
                    >
                      {formatDuration(gapDays)}
                    </span>
                  );
                })}

                {/* ── Segment bars ───────────────────────────────────── */}
                {row.segments.map((seg, i) => {
                  const left = dateToX(seg.startDate);
                  const right = dateToX(seg.endDate);
                  const width = Math.max(MIN_BAR_WIDTH, right - left);
                  const style = segmentStyles[seg.status];
                  const isInfoSegment = i === infoSegIdx;
                  const isTealBar = seg.status === 'Playing Now';
                  const segDays = daysBetween(seg.startDate, seg.endDate);
                  const isOngoing = new Date(seg.endDate).getTime() >= Date.now() - DAY_MS;

                  const animProps = !hasAnimated.current
                    ? {
                        initial: { scaleX: 0, opacity: 0 } as const,
                        animate: { scaleX: 1, opacity: 1 } as const,
                        transition: { duration: 0.4, delay: rowIndex * 0.03 + i * 0.02, ease: 'easeOut' as const },
                      }
                    : {
                        initial: false as const,
                      };

                  return (
                    <motion.div
                      key={i}
                      {...animProps}
                      role="gridcell"
                      aria-label={`${row.title}: ${seg.status} from ${formatShortDate(seg.startDate)} to ${isOngoing ? 'Present' : formatShortDate(seg.endDate)}, ${formatDuration(segDays)}`}
                      className={cn(
                        'absolute rounded-full transition-[filter,box-shadow] duration-200',
                        'hover:brightness-110 hover:shadow-lg hover:scale-y-[1.04]',
                        style.bar,
                        style.glow,
                        style.border,
                      )}
                      style={{
                        left,
                        width,
                        top: BAR_V_PADDING / 2,
                        height: ROW_HEIGHT - BAR_V_PADDING,
                        transformOrigin: 'left center',
                      }}
                      onMouseMove={(e) => {
                        e.stopPropagation();
                        handleSegmentHover(e, seg, row);
                      }}
                      onMouseLeave={handleSegmentLeave}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (hasDragged.current) { hasDragged.current = false; return; }
                      }}
                    >
                      {/* Shimmer overlay */}
                      <div className={cn(
                        'absolute inset-0 rounded-full pointer-events-none',
                        isTealBar
                          ? 'bg-gradient-to-b from-white/15 to-transparent'
                          : 'bg-gradient-to-b from-white/5 to-transparent',
                      )} />

                      {/* Session heatmap dots */}
                      {gameSessions && gameSessions.length > 0 && (
                        <div className="absolute inset-0 rounded-full overflow-hidden pointer-events-none">
                          {gameSessions.map((session) => {
                            const sessionX = dateToX(session.startTime) - left;
                            if (sessionX < 0 || sessionX > width) return null;
                            return (
                              <div
                                key={session.id}
                                className="absolute rounded-full bg-fuchsia-400/40"
                                style={{
                                  left: sessionX,
                                  top: '50%',
                                  width: 3,
                                  height: 3,
                                  transform: 'translateY(-50%)',
                                }}
                              />
                            );
                          })}
                        </div>
                      )}

                      {/* Bar content: game info + duration badge */}
                      <div className="absolute inset-0 flex items-center justify-between px-3 overflow-hidden gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {isInfoSegment && width >= GAME_INFO_MIN_WIDTH && (
                            <>
                              <div className={cn(
                                'flex-shrink-0 w-5 h-7 rounded-sm overflow-hidden',
                                isTealBar ? 'bg-black/20' : 'bg-black/10',
                              )}>
                                {(getHardcodedCover(row.title) || row.coverUrl) ? (
                                  <img
                                    src={getHardcodedCover(row.title) || row.coverUrl}
                                    alt={row.title}
                                    className="w-full h-full object-cover"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Gamepad2 className={cn('w-3 h-3', isTealBar ? 'text-white/40' : 'text-gray-400')} />
                                  </div>
                                )}
                              </div>
                              <span className={cn('text-[11px] font-semibold truncate', style.text)}>
                                {row.title}
                              </span>
                            </>
                          )}

                          {isInfoSegment && width >= GAME_PILL_MIN_WIDTH && width < GAME_INFO_MIN_WIDTH && (
                            <span className={cn('text-[10px] font-semibold truncate', style.text)}>
                              {row.title}
                            </span>
                          )}

                          {!isInfoSegment && width > 60 && (
                            <span className={cn('text-[10px] font-medium truncate', style.text, !isTealBar && 'opacity-70')}>
                              {seg.status}
                            </span>
                          )}
                        </div>

                        {width >= DURATION_BADGE_MIN_WIDTH && (
                          <span className={cn(
                            'flex-shrink-0 text-[9px] font-semibold px-2 py-0.5 rounded-full',
                            style.badgeBg, style.badgeText,
                          )}>
                            {formatDuration(segDays)}
                          </span>
                        )}
                      </div>

                      {/* Live session pulse (Playing Now only) */}
                      {isTealBar && (
                        <div
                          className="absolute top-1/2 -translate-y-1/2 right-0 w-1 h-4 rounded-full bg-emerald-400 gantt-live-pulse"
                        />
                      )}
                    </motion.div>
                  );
                })}

                {/* ── "Added" milestone diamond with popover ──────────── */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 z-10 group/diamond"
                  style={{ left: dateToX(row.addedAt) - 5 }}
                >
                  <div className="w-[10px] h-[10px] rotate-45 bg-fuchsia-500 border border-fuchsia-300/60 shadow-sm shadow-fuchsia-500/30" />
                  <div className="hidden group-hover/diamond:block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 rounded-lg bg-black/90 border border-white/10 text-[10px] text-white/70 whitespace-nowrap shadow-lg z-20">
                    Added: {formatShortDate(row.addedAt)}
                    <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-black/90" />
                  </div>
                </div>

                {/* ── "Removed" milestone diamond with popover ────────── */}
                {row.removedAt && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 z-10 group/removed"
                    style={{ left: dateToX(row.removedAt) - 5 }}
                  >
                    <div className="w-[10px] h-[10px] rotate-45 bg-red-500 border border-red-300/60 shadow-sm shadow-red-500/30" />
                    <div className="hidden group-hover/removed:block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 rounded-lg bg-black/90 border border-white/10 text-[10px] text-white/70 whitespace-nowrap shadow-lg z-20">
                      Removed: {formatShortDate(row.removedAt)}
                      <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[4px] border-t-black/90" />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </div> {/* end flex wrapper (sidebar + timeline) */}

      {/* ── Minimap ─────────────────────────────────────────────────── */}
      <GanttMinimap
        rows={rows}
        timelineWidth={timelineWidth}
        scrollLeft={minimapScrollLeft}
        viewportWidth={viewportWidth}
        dateToX={dateToX}
        onSeek={(left) => scrollRef.current?.scrollTo({ left, behavior: 'smooth' })}
      />

      {/* ── Summary footer ──────────────────────────────────────────── */}
      <div className="flex items-center gap-5 px-4 md:px-10 mt-4 text-[11px] text-white/35 flex-wrap">
        <span className="flex items-center gap-1.5">
          <Calendar className="w-3 h-3" />
          {footerStats.gameCount} game{footerStats.gameCount !== 1 ? 's' : ''} tracked
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          {footerStats.totalHours}h total
        </span>
        <span>
          {footerStats.completedCount} completed
        </span>
      </div>

      {/* ── Scroll-to-Now FAB ───────────────────────────────────────── */}
      {!isNowVisible && (
        <button
          onClick={scrollToNow}
          aria-label="Scroll to current date"
          className="absolute bottom-14 right-6 z-30 flex items-center gap-1.5 px-3 py-2 rounded-full bg-red-500/90 hover:bg-red-500 text-white text-[11px] font-bold shadow-lg shadow-red-500/30 transition-colors backdrop-blur-sm border border-red-400/30"
        >
          <Crosshair className="w-3.5 h-3.5" />
          Now
        </button>
      )}

      {/* Floating tooltip (ref-driven, no re-render on mouse move) */}
      <div
        ref={tooltipRef}
        className="fixed z-[100] pointer-events-none px-5 py-4 rounded-2xl bg-black/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60 text-xs max-w-[280px]"
        style={{ display: 'none' }}
      />
    </div>
  );
}
