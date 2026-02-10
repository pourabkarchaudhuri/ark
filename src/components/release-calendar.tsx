/**
 * Release Calendar Component
 *
 * Monthly grid calendar showing upcoming game releases from Steam and
 * Epic Games Store APIs. Forward-only navigation starting
 * from the current month.
 *
 * Layout: 70 / 30 split — calendar grid on the left, scrollable
 * "Coming Soon" sidebar on the right for games without exact dates.
 *
 * Features:
 *  - Calendar-shaped skeleton loader during initial fetch
 *  - Dynamic viewport-fill height so the grid always fits the screen
 *  - Coming Soon sidebar with clickable pill entries
 */

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Loader2,
  Clock,
  Monitor,
  Apple,
  Terminal,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocation } from 'wouter';
import { FaSteam } from 'react-icons/fa';
import { SiEpicgames } from 'react-icons/si';
import { getPrefetchedGames, isPrefetchReady } from '@/services/prefetch-store';
import { getSteamHeaderUrl } from '@/types/steam';

// ─── Lazy fade-in image ─────────────────────────────────────────────────────
// Shared by calendar-cell thumbnails, tooltip images, and TBD-tray thumbnails.
// Loads lazily (native `loading="lazy"`) and fades in when the image is ready.

function LazyFadeImage({
  src,
  alt = '',
  className = '',
  fallbackSrc,
  fallbackChain,
}: {
  src: string;
  alt?: string;
  className?: string;
  /** @deprecated Use fallbackChain for multi-step fallbacks */
  fallbackSrc?: string;
  /** Ordered list of fallback URLs to try when `src` (and earlier fallbacks) fail */
  fallbackChain?: string[];
}) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [errored, setErrored] = useState(false);

  // Build the full URL chain: primary → chain entries → single fallback
  const urls = useMemo(() => {
    const chain = [src];
    if (fallbackChain) chain.push(...fallbackChain);
    else if (fallbackSrc) chain.push(fallbackSrc);
    // Deduplicate consecutive identical URLs (avoids stuck loops)
    const deduped: string[] = [];
    for (const url of chain) {
      if (url && url !== deduped[deduped.length - 1]) deduped.push(url);
    }
    return deduped;
  }, [src, fallbackSrc, fallbackChain]);

  const handleError = useCallback(() => {
    const next = attempt + 1;
    if (next < urls.length) {
      setLoaded(false);
      setAttempt(next);
    } else {
      setErrored(true);
    }
  }, [attempt, urls.length]);

  if (errored) {
    return (
      <div className={cn(className, 'flex items-center justify-center bg-white/5')}>
        <CalendarDays className="w-3 h-3 text-white/15" />
      </div>
    );
  }

  return (
    <img
      src={urls[attempt]}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={handleError}
      className={cn(
        className,
        'transition-opacity duration-300 ease-in',
        loaded ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

// ─── Image helpers ──────────────────────────────────────────────────────────

/** Extract a numeric Steam appId from a game ID (e.g. "steam-12345" → 12345) */
function extractSteamAppId(id: string | number): number | null {
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && id.startsWith('steam-')) {
    const n = parseInt(id.replace('steam-', ''), 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

/** Build a full fallback chain of image URLs for a release entry.
 *  Mirrors GameCard's multi-step approach: cover → header → capsule → small capsule */
function buildImageFallbackChain(game: { id: string | number; image: string }): string[] {
  const appId = extractSteamAppId(game.id);
  if (!appId) return [];
  const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
  return [
    `${cdnBase}/${appId}/library_600x900.jpg`,
    `${cdnBase}/${appId}/header.jpg`,
    `${cdnBase}/${appId}/capsule_616x353.jpg`,
    `${cdnBase}/${appId}/capsule_231x87.jpg`,
  ].filter(url => url !== game.image); // Skip URLs identical to the primary src
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface UpcomingRelease {
  id: number | string;
  name: string;
  image: string;
  releaseDate: string;
  comingSoon: boolean;
  genres: string[];
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  store?: 'steam' | 'epic';
}

interface ParsedRelease extends UpcomingRelease {
  parsedDate: Date | null;
}

// Window.steam type is declared in @/types/steam.ts

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

// Dates more than 5 years out are sentinel placeholders (e.g. Epic's 2099-01-01)
const MAX_REASONABLE_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

function parseReleaseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const lower = dateStr.toLowerCase().trim();
  if (
    lower.includes('coming soon') ||
    lower.includes('to be announced') ||
    lower.includes('tba') ||
    lower.includes('tbd') ||
    lower === 'n/a' ||
    lower === ''
  ) return null;
  const quarterMatch = lower.match(/q(\d)\s+(\d{4})/);
  if (quarterMatch) return null;

  let result: Date | null = null;
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    result = parsed;
  } else {
    const dmyMatch = dateStr.match(/(\d{1,2})\s+(\w+),?\s+(\d{4})/);
    if (dmyMatch) {
      const attempt = new Date(`${dmyMatch[2]} ${dmyMatch[1]}, ${dmyMatch[3]}`);
      if (!isNaN(attempt.getTime())) result = attempt;
    }
  }

  // Reject far-future sentinel dates (e.g. 2099) — treat as TBD
  if (result && result.getTime() - Date.now() > MAX_REASONABLE_MS) {
    return null;
  }
  return result;
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

// ─── Layout constants ───────────────────────────────────────────────────────

// Skeleton: which cells get fake game tile bars (deterministic pattern)
const SKEL_TILE_CELLS = new Set([3, 8, 10, 15, 17, 22, 25, 29]);
const SKEL_DOUBLE_CELLS = new Set([8, 17, 25]);

// ─── Game Tile (inside calendar cell) ───────────────────────────────────────
// Redesigned as compact text pills with tiny thumbnails instead of
// image-only bars which get clipped in small calendar cells.

const TOOLTIP_SHOW_DELAY = 120; // ms — short delay prevents flicker on fast mouse moves
const TOOLTIP_HIDE_DELAY = 80;  // ms — grace period to move from pill → tooltip

const GameTile = memo(function GameTile({
  game,
  onNavigate,
}: {
  game: ParsedRelease;
  compact?: boolean;
  onNavigate?: (id: string | number) => void;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pre-compute fallback image chain once
  const fallbackChain = useMemo(() => buildImageFallbackChain(game), [game]);

  const handleEnter = useCallback(() => {
    // Cancel any pending hide
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    // Debounced show — prevents flicker when mouse skims across multiple tiles
    if (showTimerRef.current) return; // already pending
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      if (pillRef.current) {
        const rect = pillRef.current.getBoundingClientRect();
        // position: fixed is VIEWPORT-relative — do NOT add window.scrollY
        setTooltipPos({
          top: rect.top,
          left: rect.left + rect.width / 2,
        });
      }
      setShowTooltip(true);
    }, TOOLTIP_SHOW_DELAY);
  }, []);

  const handleLeave = useCallback(() => {
    // Cancel pending show
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    // Debounced hide — grace period to move mouse from pill to tooltip
    if (hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setShowTooltip(false);
    }, TOOLTIP_HIDE_DELAY);
  }, []);

  // Re-enter (mouse moves onto the portal tooltip) — cancel hide
  const handleTooltipEnter = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const handleTooltipLeave = useCallback(() => {
    // When leaving the tooltip, hide after a short grace
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setShowTooltip(false);
    }, TOOLTIP_HIDE_DELAY);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const handleClick = useCallback(() => {
    if (onNavigate && game.id) onNavigate(game.id);
  }, [onNavigate, game.id]);

  return (
    <div
      ref={pillRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {/* Compact pill: tiny thumbnail + game name */}
      <div
        onClick={handleClick}
        className={cn(
          'flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer transition-all',
          'hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
          'bg-white/[0.04]',
        )}
      >
        <div className="w-4 h-4 rounded-sm overflow-hidden flex-shrink-0 bg-white/5">
          {game.image ? (
            <LazyFadeImage src={game.image} fallbackChain={fallbackChain} className="w-full h-full object-cover" />
          ) : (
            <CalendarDays className="w-2.5 h-2.5 m-auto text-white/20" />
          )}
        </div>
        <span className="text-[9px] text-white/60 truncate leading-tight flex-1 min-w-0">
          {game.name}
        </span>
        {game.store && (
          game.store === 'steam'
            ? <FaSteam className="w-2 h-2 text-white/30 flex-shrink-0" />
            : <SiEpicgames className="w-2 h-2 text-white/30 flex-shrink-0" />
        )}
      </div>

      {/* Hover tooltip — ONLY mount the portal when visible (avoids dozens of idle portals) */}
      {showTooltip && tooltipPos && createPortal(
        <div
          className="fixed z-[9999] w-56"
          style={{
            top: tooltipPos.top - 8,
            left: tooltipPos.left,
            transform: 'translate(-50%, -100%)',
          }}
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
        >
          {/* Invisible bridge for the gap between pill and tooltip */}
          <div className="absolute left-0 right-0 bottom-0 h-4 -mb-4" />
          <div
            onClick={handleClick}
            className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden cursor-pointer hover:border-fuchsia-500/40 transition-colors animate-in fade-in duration-150"
          >
            {game.image && (
              <LazyFadeImage src={game.image} fallbackChain={fallbackChain} alt={game.name} className="w-full h-24 object-cover" />
            )}
            <div className="p-2.5 space-y-1.5">
              <div className="flex items-start justify-between gap-1">
                <p className="text-xs font-semibold text-white leading-tight">{game.name}</p>
                {game.store && (
                  <div className="flex-shrink-0 mt-0.5">
                    {game.store === 'steam'
                      ? <FaSteam className="w-3 h-3 text-white/40" />
                      : <SiEpicgames className="w-3 h-3 text-white/40" />}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-white/50">{game.releaseDate}</p>
              {game.genres.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {game.genres.slice(0, 3).map((g) => (
                    <span key={g} className="text-[9px] px-1.5 py-0.5 bg-white/10 rounded text-white/60">{g}</span>
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
        </div>,
        document.body,
      )}
    </div>
  );
});

// ─── Virtualized Coming Soon Sidebar ─────────────────────────────────────────
// Uses @tanstack/react-virtual to only render the entries visible in the
// scroll viewport, keeping DOM node count constant regardless of list size.

const COMING_SOON_ROW_H = 30; // px — height of each pill entry

const ComingSoonSidebar = memo(function ComingSoonSidebar({
  releases,
  loading,
  goToGame,
  open,
  onToggle,
}: {
  releases: ParsedRelease[];
  loading: boolean;
  goToGame: (id: string | number) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Defer virtualizer content until the CSS width-transition finishes.
  // During the 300ms transition the scroll container is resizing every frame;
  // if the virtualizer is active it recalculates visible rows on each resize
  // which hammers the layout engine and can freeze/crash the app.
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (open) {
      // Wait for the 300ms CSS transition to complete, then mount the list
      const timer = setTimeout(() => setSettled(true), 320);
      return () => clearTimeout(timer);
    }
    // Immediately hide content when collapsing (no delay needed)
    setSettled(false);
  }, [open]);

  const virtualizer = useVirtualizer({
    count: settled ? releases.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMING_SOON_ROW_H,
    overscan: 8,
    enabled: settled,
  });

  return (
    <div
      className="flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out will-change-[width]"
      style={{ width: open ? '30%' : 0 }}
    >
      <div
        className={cn(
          'border border-white/[0.06] rounded-xl overflow-hidden flex flex-col h-full',
          'transition-opacity duration-300 ease-in-out',
          open ? 'opacity-100' : 'opacity-0',
        )}
        style={{ minWidth: 220 }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 bg-white/[0.03] border-b border-white/[0.06] flex-shrink-0">
          <Clock className="w-3.5 h-3.5 text-fuchsia-400/60" />
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
            Coming Soon
          </span>
          {releases.length > 0 && (
            <span className="text-[9px] text-fuchsia-400/80 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-medium">
              {releases.length}
            </span>
          )}
          {/* Collapse button inside header */}
          <button
            onClick={onToggle}
            className="ml-auto p-1 rounded-md hover:bg-white/10 text-white/30 hover:text-white transition-colors"
            title="Collapse sidebar"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Scrollable entries — virtualizer only active after sidebar finishes opening */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-2">
          {loading || (open && !settled) ? (
            /* Skeleton shown during initial load AND during open-transition */
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-white/[0.04] mb-1">
                <div className="w-5 h-5 rounded-sm bg-white/[0.06] animate-pulse flex-shrink-0" />
                <div className="flex-1 h-3 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ))
          ) : releases.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <CalendarDays className="w-8 h-8 text-white/[0.06] mb-2" />
              <p className="text-[10px] text-white/20">No coming soon titles</p>
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const game = releases[vRow.index];
                return (
                  <div
                    key={game.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: vRow.size,
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    className="px-0 py-0.5"
                  >
                    <div
                      onClick={() => goToGame(game.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-all h-full',
                        'hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
                        'bg-white/[0.04]',
                      )}
                      title={game.name}
                    >
                      <div className="w-5 h-5 rounded-sm overflow-hidden flex-shrink-0 bg-white/5">
                        {game.image ? (
                          <LazyFadeImage
                            src={game.image}
                            fallbackChain={buildImageFallbackChain(game)}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <CalendarDays className="w-2.5 h-2.5 text-white/10" />
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] text-white/60 truncate leading-tight flex-1 min-w-0">
                        {game.name}
                      </span>
                      {game.store && (
                        game.store === 'steam'
                          ? <FaSteam className="w-2.5 h-2.5 text-white/30 flex-shrink-0" />
                          : <SiEpicgames className="w-2.5 h-2.5 text-white/30 flex-shrink-0" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Day Detail Panel (slide-out) ────────────────────────────────────────────
// Opened when the user clicks "+X more" in a calendar cell. Shows the full
// list of releases for that day in a slide-out panel overlaying the right edge.

const DayDetailPanel = memo(function DayDetailPanel({
  day,
  month,
  year,
  releases,
  onClose,
  goToGame,
}: {
  day: number;
  month: number;
  year: number;
  releases: ParsedRelease[];
  onClose: () => void;
  goToGame: (id: string | number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dateLabel = `${MONTH_NAMES[month]} ${day}, ${year}`;

  return createPortal(
    <>
      {/* Backdrop */}
      <motion.div
        key="day-detail-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[9990] bg-black/50"
        onClick={onClose}
      />
      {/* Panel */}
      <motion.div
        key="day-detail-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="fixed top-0 right-0 z-[9991] h-full w-80 max-w-[90vw] bg-zinc-950 border-l border-white/10 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
          <div>
            <p className="text-sm font-semibold text-white">{dateLabel}</p>
            <p className="text-[10px] text-white/40 mt-0.5">{releases.length} release{releases.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/10 text-white/40 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1.5">
          {releases.map((game) => {
            const chain = buildImageFallbackChain(game);
            return (
              <div
                key={game.id}
                onClick={() => goToGame(game.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-all',
                  'hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
                  'bg-white/[0.04]',
                )}
              >
                {/* Thumbnail */}
                <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-white/5">
                  {game.image ? (
                    <LazyFadeImage src={game.image} fallbackChain={chain} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <CalendarDays className="w-4 h-4 text-white/15" />
                    </div>
                  )}
                </div>
                {/* Details */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{game.name}</p>
                  {game.genres.length > 0 && (
                    <p className="text-[9px] text-white/40 truncate mt-0.5">{game.genres.slice(0, 3).join(', ')}</p>
                  )}
                  <div className="flex items-center gap-1.5 mt-1 text-white/30">
                    {game.platforms.windows && <Monitor className="w-2.5 h-2.5" />}
                    {game.platforms.mac && <Apple className="w-2.5 h-2.5" />}
                    {game.platforms.linux && <Terminal className="w-2.5 h-2.5" />}
                    <span className="ml-auto">
                      {game.store === 'steam'
                        ? <FaSteam className="w-3 h-3 text-white/30" />
                        : game.store === 'epic'
                          ? <SiEpicgames className="w-3 h-3 text-white/30" />
                          : null}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>
    </>,
    document.body,
  );
});

// ─── Main Calendar Component ────────────────────────────────────────────────

export const ReleaseCalendar = memo(function ReleaseCalendar() {
  const [, navigate] = useLocation();
  const today = useMemo(() => new Date(), []);
  const minYear = today.getFullYear();
  const minMonth = today.getMonth();

  const [currentYear, setCurrentYear] = useState(minYear);
  const [currentMonth, setCurrentMonth] = useState(minMonth);
  const [releases, setReleases] = useState<ParsedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // collapsed by default

  // Day detail panel — opened when clicking "+X more" in a cell
  const [dayDetail, setDayDetail] = useState<{ day: number; releases: ParsedRelease[] } | null>(null);
  const closeDayDetail = useCallback(() => setDayDetail(null), []);

  // New state for viewport-fill
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(600);

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);

  // Navigate to game details
  const goToGame = useCallback(
    (id: string | number) => navigate(`/game/${encodeURIComponent(String(id))}`),
    [navigate],
  );

  // ── Data fetching ─────────────────────────────────────────────────────────

  // Convert prefetched Game objects to the calendar's UpcomingRelease shape.
  // Includes: games with release dates within ~3 months of today, PLUS a capped
  // set of "Coming Soon" sentinel games (Epic 2099 placeholders) for the TBD
  // sidebar.
  //
  // Performance: iterates 70K+ games, so avoid regex/allocation per-game.
  // The "Coming Soon" bucket is hard-capped to avoid sending tens of thousands
  // of undated games to the sidebar which would crash the virtualizer.
  const COMING_SOON_CAP = 300;

  const deriveReleasesFromPrefetch = useCallback((): UpcomingRelease[] | null => {
    if (!isPrefetchReady()) return null;
    const prefetched = getPrefetchedGames();
    if (!prefetched || prefetched.length === 0) return null;

    const now = Date.now();
    const pastCutoff = now - 30 * 24 * 60 * 60 * 1000;
    const futureCutoff = now + 90 * 24 * 60 * 60 * 1000;
    const results: UpcomingRelease[] = [];
    let comingSoonCount = 0;

    for (let i = 0, len = prefetched.length; i < len; i++) {
      const game = prefetched[i];
      if (!game.releaseDate) continue;

      const store: 'steam' | 'epic' = game.store === 'epic' ? 'epic' : 'steam';
      // Construct image URL with Steam CDN fallback for lightweight catalog entries
      let image = game.coverUrl || game.headerImage || '';
      if (!image && game.steamAppId) {
        image = getSteamHeaderUrl(game.steamAppId);
      }
      const genres = game.genre || [];

      // Fast platform detection — simple lowercase includes, no regex
      const plats = game.platform;
      let windows = true, mac = false, linux = false;
      if (plats && plats.length > 0) {
        windows = false;
        for (let j = 0; j < plats.length; j++) {
          const pl = plats[j].toLowerCase();
          if (pl.includes('win') || pl.includes('pc')) windows = true;
          else if (pl.includes('mac') || pl.includes('osx')) mac = true;
          else if (pl.includes('linux')) linux = true;
        }
      }
      const platforms = { windows, mac, linux };

      // Sentinel "Coming Soon" games (former 2099 dates) → include as TBD entries
      // Cap these to avoid sending 30-50K undated games to the sidebar.
      if (game.comingSoon && game.releaseDate === 'Coming Soon') {
        if (comingSoonCount < COMING_SOON_CAP) {
          results.push({ id: game.id, name: game.title, image, releaseDate: 'Coming Soon', comingSoon: true, genres, platforms, store });
          comingSoonCount++;
        }
        continue;
      }

      const ts = (game as any)._releaseTs ?? new Date(game.releaseDate).getTime();
      if (isNaN(ts) || ts === 0) continue;
      if (ts < pastCutoff || ts > futureCutoff) continue;

      results.push({ id: game.id, name: game.title, image, releaseDate: game.releaseDate, comingSoon: ts > now, genres, platforms, store });
    }
    return results.length > 0 ? results : null;
  }, []);

  const fetchReleases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // ---- Strategy 1: Derive from prefetch store (instant, no IPC) ----
      const prefetchDerived = deriveReleasesFromPrefetch();
      let allReleases: UpcomingRelease[] = prefetchDerived ?? [];

      // ---- Strategy 2: Fall back to dedicated API calls if prefetch empty ----
      if (allReleases.length === 0) {
        // Fetch Steam + Epic in PARALLEL for maximum speed
        const [steamResult, epicResult] = await Promise.all([
          window.steam?.getUpcomingReleases
            ? window.steam.getUpcomingReleases().catch((err: unknown) => { console.warn('[ReleaseCalendar] Steam fetch failed:', err); return []; })
            : Promise.resolve([]),
          window.epic?.getUpcomingReleases
            ? window.epic.getUpcomingReleases().catch((err: unknown) => { console.warn('[ReleaseCalendar] Epic fetch failed:', err); return []; })
            : Promise.resolve([]),
        ]);

        for (const r of steamResult as any[]) {
          allReleases.push({ ...r, store: 'steam' });
        }
        for (const r of epicResult as any[]) {
          const releaseDate = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Coming Soon';
          const comingSoon = r.date ? new Date(r.date).getTime() > Date.now() : true;
          allReleases.push({
            id: `epic-${r.namespace}:${r.offerId}`,
            name: r.title,
            image: r.capsule,
            releaseDate,
            comingSoon,
            genres: [],
            platforms: { windows: true, mac: false, linux: false },
            store: 'epic',
          });
        }

        if (allReleases.length === 0 && !window.steam?.getUpcomingReleases && !window.epic?.getUpcomingReleases) {
          setError('Store APIs not available');
          setLoading(false);
          return;
        }
      }

      // Deduplicate by normalized title — single pass, no allocations per char
      const seen = new Map<string, UpcomingRelease>();
      for (let i = 0; i < allReleases.length; i++) {
        const r = allReleases[i];
        const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(key)) seen.set(key, r);
      }

      // Parse dates once and store — avoids re-parsing on month navigation
      const dedupArr = Array.from(seen.values());
      const parsed: ParsedRelease[] = new Array(dedupArr.length);
      for (let i = 0; i < dedupArr.length; i++) {
        parsed[i] = { ...dedupArr[i], parsedDate: parseReleaseDate(dedupArr[i].releaseDate) };
      }
      setReleases(parsed);
    } catch (err) {
      console.error('[ReleaseCalendar] Failed to fetch releases:', err);
      setError('Failed to load upcoming releases');
    } finally {
      setLoading(false);
    }
  }, [deriveReleasesFromPrefetch]);

  useEffect(() => {
    fetchReleases();
    const interval = setInterval(fetchReleases, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchReleases]);

  // ── Navigation ────────────────────────────────────────────────────────────

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

  // ── Release grouping ──────────────────────────────────────────────────────

  const { datedReleases, tbdReleases } = useMemo(() => {
    const dated: Map<number, ParsedRelease[]> = new Map();
    const tbd: ParsedRelease[] = [];
    for (const release of releases) {
      if (!release.parsedDate) { tbd.push(release); continue; }
      const d = release.parsedDate;
      if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
        const day = d.getDate();
        if (!dated.has(day)) dated.set(day, []);
        dated.get(day)!.push(release);
      }
    }
    return { datedReleases: dated, tbdReleases: tbd };
  }, [releases, currentYear, currentMonth]);

  // ── Calendar grid metrics ─────────────────────────────────────────────────

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

  const isInitialLoading = loading && releases.length === 0;
  const weekRows = isInitialLoading ? 5 : totalCells / 7;
  // ── Dynamic viewport-fill height (debounced resize) ──────────────────────

  useEffect(() => {
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = Math.max(window.innerHeight - rect.top - 8, 400);
      setGridHeight(h);
    };
    // Measure immediately on mount / month change
    const raf = requestAnimationFrame(measure);
    // Debounce resize events to avoid layout thrash
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(measure, 100); };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [error, currentMonth, currentYear]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        {isInitialLoading ? (
          /* Skeleton header */
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-7 h-7 rounded-md bg-white/5 animate-pulse" />
              <div className="w-[180px] h-6 rounded-md bg-white/[0.06] animate-pulse" />
              <div className="w-7 h-7 rounded-md bg-white/5 animate-pulse" />
            </div>
          </div>
        ) : (
          /* Real header */
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <button
                onClick={goPrev}
                disabled={!canGoPrev}
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  canGoPrev
                    ? 'hover:bg-white/10 text-white/60 hover:text-white'
                    : 'text-white/15 cursor-not-allowed',
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
        )}

        <div className="flex items-center gap-2">
          {loading && (
            <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />
          )}
          {/* Toggle Coming Soon sidebar */}
          {!isInitialLoading && !sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-white/40 hover:text-white hover:bg-white/10',
              )}
              title="Show Coming Soon"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
              <span className="text-[10px] font-medium">Coming Soon</span>
              {tbdReleases.length > 0 && (
                <span className="text-[9px] text-fuchsia-400/80 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-medium">
                  {tbdReleases.length}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400 mb-3">
          {error}
        </div>
      )}

      {/* ── Layout: Calendar + collapsible Coming Soon sidebar ────── */}
      <div ref={gridRef} className="flex gap-3" style={{ height: gridHeight }}>
        {/* ── Calendar grid (expands to 100% when sidebar collapsed) ── */}
        <div
          className="border border-white/[0.06] rounded-xl overflow-hidden flex flex-col flex-1 min-w-0 transition-all duration-300 ease-in-out"
        >
          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 bg-white/[0.03] flex-shrink-0">
            {DAY_NAMES.map((day) => (
              <div
                key={day}
                className="px-2 py-2 text-center text-[10px] font-medium text-white/30 uppercase tracking-wider border-b border-white/[0.06]"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Date cells (skeleton or real) */}
          <div
            className="grid grid-cols-7 flex-1 min-h-0"
            style={{ gridTemplateRows: `repeat(${weekRows}, 1fr)` }}
          >
            {isInitialLoading
              ? /* ── Skeleton cells ─────────────────────────────────────── */
                Array.from({ length: 35 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="border-b border-r border-white/[0.04] p-1.5 overflow-hidden"
                  >
                    <div className="w-4 h-3 rounded bg-white/[0.06] animate-pulse mb-1.5" />
                    {SKEL_TILE_CELLS.has(idx) && (
                      <>
                        <div className="w-full h-8 rounded bg-white/[0.04] animate-pulse mb-1" />
                        {SKEL_DOUBLE_CELLS.has(idx) && (
                          <div className="w-full h-8 rounded bg-white/[0.03] animate-pulse" />
                        )}
                      </>
                    )}
                  </div>
                ))
              : /* ── Real cells ─────────────────────────────────────────── */
                Array.from({ length: totalCells }).map((_, idx) => {
                  const dayNum = idx - firstDay + 1;
                  const isValidDay = dayNum >= 1 && dayNum <= daysInMonth;
                  const cellDate = isValidDay
                    ? new Date(currentYear, currentMonth, dayNum)
                    : null;
                  const isTodayCell = cellDate ? isToday(cellDate) : false;
                  const dayReleases = isValidDay
                    ? datedReleases.get(dayNum) || []
                    : [];
                  const isPast =
                    cellDate !== null && cellDate < today && !isTodayCell;

                  return (
                    <div
                      key={idx}
                      className={cn(
                        'border-b border-r border-white/[0.04] p-1.5 transition-colors overflow-y-auto',
                        !isValidDay && 'bg-white/[0.01]',
                        isPast && 'opacity-40',
                        isTodayCell && 'bg-fuchsia-500/[0.06]',
                        dayReleases.length > 0 && !isPast && 'hover:bg-white/[0.03]',
                      )}
                    >
                      {isValidDay && (
                        <>
                          <div
                            className={cn(
                              'text-[11px] font-medium mb-1',
                              isTodayCell ? 'text-fuchsia-400' : 'text-white/30',
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
                          <div className="space-y-0.5">
                            {dayReleases.slice(0, 5).map((game) => (
                              <GameTile
                                key={game.id}
                                game={game}
                                onNavigate={goToGame}
                              />
                            ))}
                            {dayReleases.length > 5 && (
                              <button
                                onClick={() => setDayDetail({ day: dayNum, releases: dayReleases })}
                                className={cn(
                                  'w-full text-[8px] text-fuchsia-400/70 text-center py-0.5 rounded',
                                  'hover:bg-fuchsia-500/10 hover:text-fuchsia-400 transition-colors cursor-pointer',
                                )}
                              >
                                +{dayReleases.length - 5} more
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
          </div>
        </div>

        {/* ── Coming Soon sidebar — collapsible from right ────────── */}
        <ComingSoonSidebar
          releases={tbdReleases}
          loading={isInitialLoading}
          goToGame={goToGame}
          open={sidebarOpen}
          onToggle={toggleSidebar}
        />
      </div>

      {/* Day detail slide-out panel */}
      <AnimatePresence>
        {dayDetail && (
          <DayDetailPanel
            day={dayDetail.day}
            month={currentMonth}
            year={currentYear}
            releases={dayDetail.releases}
            onClose={closeDayDetail}
            goToGame={goToGame}
          />
        )}
      </AnimatePresence>

      {/* Empty state (centered overlay-style when no releases at all) */}
      {!loading && releases.length === 0 && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <CalendarDays className="w-10 h-10 text-white/[0.06] mb-3" />
          <p className="text-sm text-white/20">No upcoming releases found</p>
          <button
            onClick={fetchReleases}
            className="mt-2 px-3 py-1.5 text-xs font-medium rounded-md bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-colors pointer-events-auto"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
});
