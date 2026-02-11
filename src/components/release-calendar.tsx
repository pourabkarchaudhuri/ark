/**
 * Release Calendar Component
 *
 * Monthly / Week / Agenda calendar showing upcoming game releases from Steam
 * and Epic Games Store APIs. Forward-only navigation starting from the
 * current month.
 *
 * Features:
 *  - Three view modes: Month grid, Week detail, Agenda list
 *  - "My Radar" filter — highlights library / Want-to-Play games
 *  - Genre / platform quick-filter chips
 *  - Heat-map cell density in month view
 *  - Countdown chips (3d, Tomorrow, Today!) for library games
 *  - One-click "Add to Library" from tooltip
 *  - "This Week" summary banner
 *  - Multi-month mini-map for quick navigation
 *  - Coming Soon sidebar with virtualized list
 *  - Calendar-shaped skeleton loader during initial fetch
 *  - Dynamic viewport-fill height so the grid always fits the screen
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
  Crosshair,
  Plus,
  List,
  Grid3X3,
  Calendar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocation } from 'wouter';
import { FaSteam } from 'react-icons/fa';
import { SiEpicgames } from 'react-icons/si';
import { getPrefetchedGames, isPrefetchReady } from '@/services/prefetch-store';
import { getSteamHeaderUrl } from '@/types/steam';
import { libraryStore } from '@/services/library-store';
import { useToast } from '@/components/ui/toast';
import type { CachedGameMeta } from '@/types/game';

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

  // Reset state when src changes (prevents stale loaded/errored when reused without remount)
  const prevSrcRef = useRef(src);
  if (prevSrcRef.current !== src) {
    prevSrcRef.current = src;
    setLoaded(false);
    setAttempt(0);
    setErrored(false);
  }

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

type CalendarView = 'month' | 'week' | 'agenda';

// Window.steam type is declared in @/types/steam.ts

// ─── Date Helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// ─── Countdown helper ────────────────────────────────────────────────────────

/** Compute a countdown label for games releasing within 7 days. */
function getCountdownLabel(releaseDate: Date | null): string | null {
  if (!releaseDate) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(releaseDate);
  target.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return null;
  if (diffDays === 0) return 'Today!';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return null;
}

// ─── Layout constants ───────────────────────────────────────────────────────

// Skeleton: which cells get fake game tile bars (deterministic pattern)
const SKEL_TILE_CELLS = new Set([3, 8, 10, 15, 17, 22, 25, 29]);
const SKEL_DOUBLE_CELLS = new Set([8, 17, 25]);
const COMING_SOON_CAP = 300;

// View toggle button definitions (stable reference — avoids per-render allocation)
const VIEW_TOGGLE_OPTIONS: { id: CalendarView; icon: typeof Grid3X3; label: string }[] = [
  { id: 'month', icon: Grid3X3, label: 'Month' },
  { id: 'week', icon: Calendar, label: 'Week' },
  { id: 'agenda', icon: List, label: 'Agenda' },
];

// ─── Library helpers ─────────────────────────────────────────────────────────

function buildLibraryIdSet(): Set<string> {
  const ids = libraryStore.getAllGameIds();
  return new Set(ids);
}

function isReleaseInLibrary(id: string | number, libSet: Set<string>): boolean {
  const strId = String(id);
  if (libSet.has(strId)) return true;
  if (typeof id === 'number' || /^\d+$/.test(strId)) {
    return libSet.has(`steam-${strId}`);
  }
  return false;
}

/** Convert a release entry ID to a canonical library game ID. */
function releaseToGameId(game: ParsedRelease): string {
  const strId = String(game.id);
  if (strId.startsWith('steam-') || strId.startsWith('epic-')) return strId;
  if (typeof game.id === 'number' || /^\d+$/.test(strId)) return `steam-${strId}`;
  return strId;
}

/** Build a CachedGameMeta from a ParsedRelease for offline library display. */
function releaseToMeta(game: ParsedRelease): CachedGameMeta {
  const platformArr: string[] = [];
  if (game.platforms.windows) platformArr.push('Windows');
  if (game.platforms.mac) platformArr.push('Mac');
  if (game.platforms.linux) platformArr.push('Linux');
  return {
    title: game.name,
    store: game.store,
    coverUrl: game.image || undefined,
    genre: game.genres,
    platform: platformArr,
    releaseDate: game.releaseDate,
    steamAppId: extractSteamAppId(game.id) ?? undefined,
  };
}

// ─── Game Tile (inside calendar cell) ───────────────────────────────────────
// Compact text pills with tiny thumbnails. Hover tooltip shows full details
// including a one-click "Add to Library" button and countdown chip.

const TOOLTIP_SHOW_DELAY = 120;
const TOOLTIP_HIDE_DELAY = 80;

const GameTile = memo(function GameTile({
  game,
  inLibrary,
  onNavigate,
  onAddToLibrary,
  radarDimmed,
  countdownLabel,
}: {
  game: ParsedRelease;
  inLibrary?: boolean;
  compact?: boolean;
  onNavigate?: (id: string | number) => void;
  onAddToLibrary?: (game: ParsedRelease) => void;
  radarDimmed?: boolean;
  countdownLabel?: string | null;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use primitive deps — game object ref changes on filter recalc but id/image stay the same
  const fallbackChain = useMemo(() => buildImageFallbackChain(game), [game.id, game.image]);

  const handleEnter = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (showTimerRef.current) return;
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      if (pillRef.current) {
        const rect = pillRef.current.getBoundingClientRect();
        setTooltipPos({ top: rect.top, left: rect.left + rect.width / 2 });
      }
      setShowTooltip(true);
    }, TOOLTIP_SHOW_DELAY);
  }, []);

  const handleLeave = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    if (hideTimerRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setShowTooltip(false);
    }, TOOLTIP_HIDE_DELAY);
  }, []);

  const handleTooltipEnter = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const handleTooltipLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setShowTooltip(false);
    }, TOOLTIP_HIDE_DELAY);
  }, []);

  useEffect(() => () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const handleClick = useCallback(() => {
    if (onNavigate && game.id) onNavigate(game.id);
  }, [onNavigate, game.id]);

  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onAddToLibrary) onAddToLibrary(game);
  }, [onAddToLibrary, game]);

  return (
    <div
      ref={pillRef}
      className={cn('relative', radarDimmed && 'opacity-[0.15] pointer-events-none')}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {/* Compact pill: tiny thumbnail + game name + optional countdown */}
      <div
        onClick={handleClick}
        className={cn(
          'flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer transition-all',
          inLibrary
            ? 'bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30 hover:bg-fuchsia-500/25 hover:ring-fuchsia-500/50'
            : 'bg-white/[0.04] hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
        )}
      >
        <div className={cn(
          'w-4 h-4 rounded-sm overflow-hidden flex-shrink-0',
          inLibrary ? 'bg-fuchsia-500/10' : 'bg-white/5',
        )}>
          {game.image ? (
            <LazyFadeImage src={game.image} fallbackChain={fallbackChain} className="w-full h-full object-cover" />
          ) : (
            <CalendarDays className="w-2.5 h-2.5 m-auto text-white/20" />
          )}
        </div>
        <span className={cn(
          'text-[9px] truncate leading-tight flex-1 min-w-0',
          inLibrary ? 'text-fuchsia-300/90 font-medium' : 'text-white/60',
        )}>
          {game.name}
        </span>
        {/* Countdown chip */}
        {countdownLabel && (
          <span className={cn(
            'text-[7px] px-1 py-px rounded font-bold flex-shrink-0 uppercase tracking-wide',
            countdownLabel === 'Today!'
              ? 'bg-green-500/25 text-green-300 animate-pulse'
              : countdownLabel === 'Tomorrow'
                ? 'bg-amber-500/25 text-amber-300'
                : 'bg-fuchsia-500/25 text-fuchsia-300/80',
          )}>
            {countdownLabel}
          </span>
        )}
        {game.store && (
          game.store === 'steam'
            ? <FaSteam className={cn('w-2 h-2 flex-shrink-0', inLibrary ? 'text-fuchsia-400/50' : 'text-white/30')} />
            : <SiEpicgames className={cn('w-2 h-2 flex-shrink-0', inLibrary ? 'text-fuchsia-400/50' : 'text-white/30')} />
        )}
      </div>

      {/* Hover tooltip — ONLY mount the portal when visible */}
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
          <div className="absolute left-0 right-0 bottom-0 h-4 -mb-4" />
          <div
            onClick={handleClick}
            className={cn(
              'rounded-lg shadow-xl overflow-hidden cursor-pointer transition-colors animate-in fade-in duration-150',
              inLibrary
                ? 'bg-zinc-900 border border-fuchsia-500/30 hover:border-fuchsia-500/50 ring-1 ring-fuchsia-500/10'
                : 'bg-zinc-900 border border-white/10 hover:border-fuchsia-500/40',
            )}
          >
            {game.image && (
              <div className="relative">
                <LazyFadeImage src={game.image} fallbackChain={fallbackChain} alt={game.name} className="w-full h-24 object-cover" />
                {inLibrary && (
                  <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-fuchsia-500/90 text-[8px] font-bold text-white uppercase tracking-wide shadow-lg">
                    In Library
                  </div>
                )}
                {countdownLabel && (
                  <div className={cn(
                    'absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold text-white uppercase tracking-wide shadow-lg',
                    countdownLabel === 'Today!' ? 'bg-green-500/90' : countdownLabel === 'Tomorrow' ? 'bg-amber-500/90' : 'bg-fuchsia-500/90',
                  )}>
                    {countdownLabel}
                  </div>
                )}
              </div>
            )}
            <div className="p-2.5 space-y-1.5">
              <div className="flex items-start justify-between gap-1">
                <p className={cn('text-xs font-semibold leading-tight', inLibrary ? 'text-fuchsia-300' : 'text-white')}>{game.name}</p>
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-white/40">
                  {game.platforms.windows && <Monitor className="w-2.5 h-2.5" />}
                  {game.platforms.mac && <Apple className="w-2.5 h-2.5" />}
                  {game.platforms.linux && <Terminal className="w-2.5 h-2.5" />}
                </div>
                {/* One-click add to library */}
                {!inLibrary && onAddToLibrary && (
                  <button
                    onClick={handleAdd}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-fuchsia-500/20 text-fuchsia-400 hover:bg-fuchsia-500/40 transition-colors"
                    title="Add to Library"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    Track
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

// ─── Filter Chips ────────────────────────────────────────────────────────────

const FilterChips = memo(function FilterChips({
  platformFilter,
  setPlatformFilter,
  genreFilter,
  setGenreFilter,
  topGenres,
  radarActive,
  setRadarActive,
}: {
  platformFilter: string;
  setPlatformFilter: (v: string) => void;
  genreFilter: string | null;
  setGenreFilter: (v: string | null) => void;
  topGenres: string[];
  radarActive: boolean;
  setRadarActive: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
      {/* My Radar toggle */}
      <button
        onClick={() => setRadarActive(!radarActive)}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all',
          radarActive
            ? 'bg-fuchsia-500/25 text-fuchsia-300 ring-1 ring-fuchsia-500/40'
            : 'bg-white/[0.04] text-white/40 hover:bg-white/10 hover:text-white/70',
        )}
      >
        <Crosshair className="w-3 h-3" />
        My Radar
      </button>

      <div className="w-px h-4 bg-white/10" />

      {/* Platform filters */}
      {(['all', 'windows', 'mac', 'linux'] as const).map((p) => (
        <button
          key={p}
          onClick={() => setPlatformFilter(p)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all',
            platformFilter === p
              ? 'bg-fuchsia-500/25 text-fuchsia-300 ring-1 ring-fuchsia-500/40'
              : 'bg-white/[0.04] text-white/40 hover:bg-white/10 hover:text-white/70',
          )}
        >
          {p === 'all' ? 'All' : p === 'windows' ? <><Monitor className="w-3 h-3" /> Win</> : p === 'mac' ? <><Apple className="w-3 h-3" /> Mac</> : <><Terminal className="w-3 h-3" /> Linux</>}
        </button>
      ))}

      {topGenres.length > 0 && (
        <>
          <div className="w-px h-4 bg-white/10" />
          {topGenres.map((g) => (
            <button
              key={g}
              onClick={() => setGenreFilter(genreFilter === g ? null : g)}
              className={cn(
                'px-2 py-1 rounded-md text-[10px] font-medium transition-all',
                genreFilter === g
                  ? 'bg-fuchsia-500/25 text-fuchsia-300 ring-1 ring-fuchsia-500/40'
                  : 'bg-white/[0.04] text-white/40 hover:bg-white/10 hover:text-white/70',
              )}
            >
              {g}
            </button>
          ))}
        </>
      )}
    </div>
  );
});

// ─── This Week Banner ────────────────────────────────────────────────────────

const ThisWeekBanner = memo(function ThisWeekBanner({
  releases,
  libraryIds,
  goToGame,
}: {
  releases: ParsedRelease[];
  libraryIds: Set<string>;
  goToGame: (id: string | number) => void;
}) {
  const thisWeekGames = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return releases
      .filter((r) => r.parsedDate && r.parsedDate >= now && r.parsedDate < weekEnd)
      .sort((a, b) => (a.parsedDate!.getTime() - b.parsedDate!.getTime()));
  }, [releases]);

  if (thisWeekGames.length === 0) return null;

  return (
    <div className="mb-3 p-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <div className="flex items-center gap-2 mb-2">
        <CalendarDays className="w-3.5 h-3.5 text-fuchsia-400/60" />
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">This Week</span>
        <span className="text-[9px] text-fuchsia-400/80 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-medium">
          {thisWeekGames.length}
        </span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
        {thisWeekGames.slice(0, 20).map((game) => {
          const owned = isReleaseInLibrary(game.id, libraryIds);
          const label = getCountdownLabel(game.parsedDate);
          const dayName = game.parsedDate ? DAY_NAMES_SHORT[game.parsedDate.getDay()] : '';
          return (
            <button
              key={game.id}
              onClick={() => goToGame(game.id)}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-lg flex-shrink-0 transition-all',
                owned
                  ? 'bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30 hover:bg-fuchsia-500/25'
                  : 'bg-white/[0.04] hover:bg-white/10',
              )}
            >
              <div className={cn('w-5 h-5 rounded-sm overflow-hidden flex-shrink-0', owned ? 'bg-fuchsia-500/10' : 'bg-white/5')}>
                {game.image ? (
                  <LazyFadeImage src={game.image} fallbackChain={buildImageFallbackChain(game)} className="w-full h-full object-cover" />
                ) : (
                  <CalendarDays className="w-2.5 h-2.5 m-auto text-white/20" />
                )}
              </div>
              <span className={cn('text-[10px] truncate max-w-[100px]', owned ? 'text-fuchsia-300/90 font-medium' : 'text-white/60')}>
                {game.name}
              </span>
              <span className={cn(
                'text-[8px] px-1 py-px rounded font-bold flex-shrink-0',
                label === 'Today!' ? 'bg-green-500/25 text-green-300' :
                label === 'Tomorrow' ? 'bg-amber-500/25 text-amber-300' :
                'bg-white/10 text-white/40',
              )}>
                {label || dayName}
              </span>
            </button>
          );
        })}
        {thisWeekGames.length > 20 && (
          <span className="text-[9px] text-white/30 self-center px-2 flex-shrink-0">+{thisWeekGames.length - 20} more</span>
        )}
      </div>
    </div>
  );
});

// ─── Mini-Month Strip ────────────────────────────────────────────────────────

const MiniMonthStrip = memo(function MiniMonthStrip({
  releases,
  currentYear,
  currentMonth,
  onNavigate,
}: {
  releases: ParsedRelease[];
  currentYear: number;
  currentMonth: number;
  onNavigate: (year: number, month: number) => void;
}) {
  // Compute density for prev, current, next months
  const monthData = useMemo(() => {
    const months: { year: number; month: number; weekDensity: number[] }[] = [];
    for (let offset = -1; offset <= 1; offset++) {
      let y = currentYear;
      let m = currentMonth + offset;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      const daysIn = getDaysInMonth(y, m);
      const weeks = Math.ceil(daysIn / 7);
      const weekCounts = new Array(weeks).fill(0);
      for (const r of releases) {
        if (!r.parsedDate) continue;
        const d = r.parsedDate;
        if (d.getFullYear() === y && d.getMonth() === m) {
          const weekIdx = Math.min(Math.floor((d.getDate() - 1) / 7), weeks - 1);
          weekCounts[weekIdx]++;
        }
      }
      months.push({ year: y, month: m, weekDensity: weekCounts });
    }
    return months;
  }, [releases, currentYear, currentMonth]);

  return (
    <div className="flex items-center gap-1">
      {monthData.map((md) => {
        const isActive = md.year === currentYear && md.month === currentMonth;
        return (
          <button
            key={`${md.year}-${md.month}`}
            onClick={() => onNavigate(md.year, md.month)}
            className={cn(
              'flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-all min-w-[50px]',
              isActive
                ? 'bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30'
                : 'bg-white/[0.03] hover:bg-white/[0.06]',
            )}
          >
            <span className={cn('text-[9px] font-medium', isActive ? 'text-fuchsia-400' : 'text-white/40')}>
              {MONTH_NAMES_SHORT[md.month]}
            </span>
            <div className="flex gap-0.5">
              {md.weekDensity.map((count, wi) => {
                const size = count === 0 ? 2 : Math.min(2 + count, 6);
                return (
                  <div
                    key={wi}
                    className={cn('rounded-full', count > 0 ? 'bg-fuchsia-400' : 'bg-white/15')}
                    style={{ width: size, height: size, opacity: count > 0 ? Math.min(0.4 + count * 0.15, 1) : 0.3 }}
                  />
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
});

// ─── Week View ───────────────────────────────────────────────────────────────

const WeekViewGrid = memo(function WeekViewGrid({
  weekStart,
  releases,
  libraryIds,
  goToGame,
  onAddToLibrary,
  radarActive,
}: {
  weekStart: Date;
  releases: ParsedRelease[];
  libraryIds: Set<string>;
  goToGame: (id: string | number) => void;
  onAddToLibrary: (game: ParsedRelease) => void;
  radarActive: boolean;
}) {
  // Group releases by day in this week
  const dayGroups = useMemo(() => {
    const groups: ParsedRelease[][] = Array.from({ length: 7 }, () => []);
    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);
    for (const r of releases) {
      if (!r.parsedDate) continue;
      const d = new Date(r.parsedDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.round((d.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
      if (diff >= 0 && diff < 7) groups[diff].push(r);
    }
    return groups;
  }, [weekStart, releases]);

  return (
    <div className="grid grid-cols-7 gap-px flex-1 min-h-0 border border-white/[0.06] rounded-xl overflow-hidden">
      {dayGroups.map((games, dayIdx) => {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + dayIdx);
        const isTodayCell = isToday(date);

        return (
          <div
            key={dayIdx}
            className={cn(
              'flex flex-col bg-white/[0.01] overflow-hidden',
              isTodayCell && 'bg-fuchsia-500/[0.06]',
            )}
          >
            {/* Day header */}
            <div className={cn(
              'px-2 py-1.5 border-b border-white/[0.06] flex items-center gap-1.5 flex-shrink-0 bg-white/[0.02]',
              isTodayCell && 'bg-fuchsia-500/[0.08]',
            )}>
              <span className={cn('text-[10px] font-medium', isTodayCell ? 'text-fuchsia-400' : 'text-white/30')}>
                {DAY_NAMES[date.getDay()]}
              </span>
              {isTodayCell ? (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-fuchsia-500 text-white text-[10px] font-bold">
                  {date.getDate()}
                </span>
              ) : (
                <span className="text-[11px] text-white/50">{date.getDate()}</span>
              )}
              {games.length > 0 && (
                <span className="text-[8px] text-fuchsia-400/70 bg-fuchsia-500/10 px-1 rounded-full ml-auto">{games.length}</span>
              )}
            </div>
            {/* Game list — scrollable */}
            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
              {games.map((game) => {
                const owned = isReleaseInLibrary(game.id, libraryIds);
                const countdown = owned ? getCountdownLabel(game.parsedDate) : null;
                return (
                  <GameTile
                    key={game.id}
                    game={game}
                    inLibrary={owned}
                    onNavigate={goToGame}
                    onAddToLibrary={onAddToLibrary}
                    radarDimmed={radarActive && !owned}
                    countdownLabel={countdown}
                  />
                );
              })}
              {games.length === 0 && (
                <div className="flex items-center justify-center h-full text-white/10">
                  <CalendarDays className="w-4 h-4" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ─── Agenda Game Row (extracted from AgendaListView for memoization) ─────────

const AgendaGameRow = memo(function AgendaGameRow({
  game,
  libraryIds,
  goToGame,
  onAddToLibrary,
  radarActive,
}: {
  game: ParsedRelease;
  libraryIds: Set<string>;
  goToGame: (id: string | number) => void;
  onAddToLibrary: (game: ParsedRelease) => void;
  radarActive: boolean;
}) {
  const owned = isReleaseInLibrary(game.id, libraryIds);
  const countdown = owned ? getCountdownLabel(game.parsedDate) : null;
  const dimmed = radarActive && !owned;
  const chain = useMemo(() => buildImageFallbackChain(game), [game.id, game.image]);

  const handleClick = useCallback(() => goToGame(game.id), [goToGame, game.id]);
  const handleAdd = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAddToLibrary(game);
  }, [onAddToLibrary, game]);

  return (
    <div
      onClick={handleClick}
      className={cn(
        'flex items-center gap-2.5 px-3 h-full cursor-pointer transition-all border-b border-white/[0.03]',
        dimmed && 'opacity-[0.15]',
        owned
          ? 'bg-fuchsia-500/[0.04] hover:bg-fuchsia-500/[0.08]'
          : 'hover:bg-white/[0.04]',
      )}
    >
      <div className={cn('w-9 h-9 rounded overflow-hidden flex-shrink-0', owned ? 'bg-fuchsia-500/10 ring-1 ring-fuchsia-500/20' : 'bg-white/5')}>
        {game.image ? (
          <LazyFadeImage src={game.image} fallbackChain={chain} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center"><CalendarDays className="w-3 h-3 text-white/15" /></div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className={cn('text-xs font-medium truncate', owned ? 'text-fuchsia-300' : 'text-white/80')}>{game.name}</p>
          {countdown && (
            <span className={cn(
              'text-[7px] px-1 py-px rounded font-bold flex-shrink-0',
              countdown === 'Today!' ? 'bg-green-500/25 text-green-300' : countdown === 'Tomorrow' ? 'bg-amber-500/25 text-amber-300' : 'bg-fuchsia-500/25 text-fuchsia-300/80',
            )}>{countdown}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {game.genres.slice(0, 2).map((g) => (
            <span key={g} className="text-[8px] px-1 py-px bg-white/[0.06] rounded text-white/40">{g}</span>
          ))}
          <div className="flex items-center gap-1 ml-auto text-white/30">
            {game.platforms.windows && <Monitor className="w-2.5 h-2.5" />}
            {game.platforms.mac && <Apple className="w-2.5 h-2.5" />}
            {game.platforms.linux && <Terminal className="w-2.5 h-2.5" />}
            {game.store === 'steam' && <FaSteam className="w-2.5 h-2.5" />}
            {game.store === 'epic' && <SiEpicgames className="w-2.5 h-2.5" />}
          </div>
        </div>
      </div>
      {!owned && !dimmed && (
        <button
          onClick={handleAdd}
          className="p-1 rounded-md bg-fuchsia-500/15 text-fuchsia-400 hover:bg-fuchsia-500/30 transition-colors flex-shrink-0"
          title="Add to Library"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
});

// ─── Agenda View ─────────────────────────────────────────────────────────────

const AGENDA_ROW_H = 56;

const AgendaListView = memo(function AgendaListView({
  releases,
  libraryIds,
  goToGame,
  onAddToLibrary,
  radarActive,
}: {
  releases: ParsedRelease[];
  libraryIds: Set<string>;
  goToGame: (id: string | number) => void;
  onAddToLibrary: (game: ParsedRelease) => void;
  radarActive: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Group dated releases chronologically
  const groups = useMemo(() => {
    const dated = releases
      .filter((r) => r.parsedDate)
      .sort((a, b) => a.parsedDate!.getTime() - b.parsedDate!.getTime());
    const map = new Map<string, ParsedRelease[]>();
    for (const r of dated) {
      const key = r.parsedDate!.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).map(([date, games]) => ({ date, games, isToday: games[0]?.parsedDate ? isToday(games[0].parsedDate) : false }));
  }, [releases]);

  // Flatten into rows: header rows + game rows for the virtualizer
  const flatRows = useMemo(() => {
    const rows: { type: 'header'; date: string; count: number; isToday: boolean }[] | { type: 'game'; game: ParsedRelease }[] = [];
    for (const g of groups) {
      (rows as any[]).push({ type: 'header', date: g.date, count: g.games.length, isToday: g.isToday });
      for (const game of g.games) {
        (rows as any[]).push({ type: 'game', game });
      }
    }
    return rows as ({ type: 'header'; date: string; count: number; isToday: boolean } | { type: 'game'; game: ParsedRelease })[];
  }, [groups]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (idx) => flatRows[idx].type === 'header' ? 32 : AGENDA_ROW_H,
    overscan: 10,
  });

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto border border-white/[0.06] rounded-xl">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const row = flatRows[vRow.index];
          return (
            <div
              key={vRow.index}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: vRow.size, transform: `translateY(${vRow.start}px)` }}
            >
              {row.type === 'header' ? (
                <div className={cn(
                  'flex items-center gap-2 px-3 h-full border-b border-white/[0.06]',
                  row.isToday ? 'bg-fuchsia-500/[0.08]' : 'bg-white/[0.02]',
                )}>
                  <span className={cn('text-[11px] font-semibold', row.isToday ? 'text-fuchsia-400' : 'text-white/50')}>{row.date}</span>
                  {row.isToday && <span className="text-[8px] font-bold text-fuchsia-400 bg-fuchsia-500/20 px-1.5 py-0.5 rounded uppercase">Today</span>}
                  <span className="text-[9px] text-white/30 ml-auto">{row.count} release{row.count !== 1 ? 's' : ''}</span>
                </div>
              ) : (
                <AgendaGameRow
                  game={row.game}
                  libraryIds={libraryIds}
                  goToGame={goToGame}
                  onAddToLibrary={onAddToLibrary}
                  radarActive={radarActive}
                />
              )}
            </div>
          );
        })}
      </div>
      {flatRows.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center py-12">
          <CalendarDays className="w-8 h-8 text-white/[0.06] mb-2" />
          <p className="text-[11px] text-white/20">No dated releases match your filters</p>
        </div>
      )}
    </div>
  );
});

// ─── Virtualized Coming Soon Sidebar ─────────────────────────────────────────

const COMING_SOON_ROW_H = 30;

const ComingSoonSidebar = memo(function ComingSoonSidebar({
  releases,
  loading,
  goToGame,
  open,
  onToggle,
  libraryIds,
}: {
  releases: ParsedRelease[];
  loading: boolean;
  goToGame: (id: string | number) => void;
  open: boolean;
  onToggle: () => void;
  libraryIds: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => setSettled(true), 320);
      return () => clearTimeout(timer);
    }
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
        <div className="flex items-center gap-2 px-3 py-2.5 bg-white/[0.03] border-b border-white/[0.06] flex-shrink-0">
          <Clock className="w-3.5 h-3.5 text-fuchsia-400/60" />
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">Coming Soon</span>
          {releases.length > 0 && (
            <span className="text-[9px] text-fuchsia-400/80 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-medium">{releases.length}</span>
          )}
          <button onClick={onToggle} className="ml-auto p-1 rounded-md hover:bg-white/10 text-white/30 hover:text-white transition-colors" title="Collapse sidebar">
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-2">
          {loading || (open && !settled) ? (
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
                const owned = isReleaseInLibrary(game.id, libraryIds);
                return (
                  <div
                    key={game.id}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, height: vRow.size, transform: `translateY(${vRow.start}px)` }}
                    className="px-0 py-0.5"
                  >
                    <div
                      onClick={() => goToGame(game.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-all h-full',
                        owned
                          ? 'bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30 hover:bg-fuchsia-500/25 hover:ring-fuchsia-500/50'
                          : 'bg-white/[0.04] hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
                      )}
                      title={owned ? `${game.name} (In Library)` : game.name}
                    >
                      <div className={cn('w-5 h-5 rounded-sm overflow-hidden flex-shrink-0', owned ? 'bg-fuchsia-500/10' : 'bg-white/5')}>
                        {game.image ? (
                          <LazyFadeImage src={game.image} fallbackChain={buildImageFallbackChain(game)} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><CalendarDays className="w-2.5 h-2.5 text-white/10" /></div>
                        )}
                      </div>
                      <span className={cn('text-[10px] truncate leading-tight flex-1 min-w-0', owned ? 'text-fuchsia-300/90 font-medium' : 'text-white/60')}>{game.name}</span>
                      {owned && (
                        <span className="text-[7px] px-1 py-px rounded bg-fuchsia-500/25 text-fuchsia-300/80 font-bold uppercase tracking-wide flex-shrink-0">Owned</span>
                      )}
                      {game.store && (
                        game.store === 'steam'
                          ? <FaSteam className={cn('w-2.5 h-2.5 flex-shrink-0', owned ? 'text-fuchsia-400/50' : 'text-white/30')} />
                          : <SiEpicgames className={cn('w-2.5 h-2.5 flex-shrink-0', owned ? 'text-fuchsia-400/50' : 'text-white/30')} />
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

const DayDetailPanel = memo(function DayDetailPanel({
  day,
  month,
  year,
  releases,
  onClose,
  goToGame,
  libraryIds,
}: {
  day: number;
  month: number;
  year: number;
  releases: ParsedRelease[];
  onClose: () => void;
  goToGame: (id: string | number) => void;
  libraryIds: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dateLabel = `${MONTH_NAMES[month]} ${day}, ${year}`;

  return createPortal(
    <>
      <motion.div
        key="day-detail-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[9990] bg-black/50"
        onClick={onClose}
      />
      <motion.div
        key="day-detail-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="fixed top-0 right-0 z-[9991] h-full w-80 max-w-[90vw] bg-zinc-950 border-l border-white/10 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
          <div>
            <p className="text-sm font-semibold text-white">{dateLabel}</p>
            <p className="text-[10px] text-white/40 mt-0.5">{releases.length} release{releases.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/10 text-white/40 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1.5">
          {releases.map((game) => {
            const chain = buildImageFallbackChain(game);
            const owned = isReleaseInLibrary(game.id, libraryIds);
            return (
              <div
                key={game.id}
                onClick={() => goToGame(game.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-all',
                  owned
                    ? 'bg-fuchsia-500/10 ring-1 ring-fuchsia-500/25 hover:bg-fuchsia-500/20 hover:ring-fuchsia-500/40'
                    : 'bg-white/[0.04] hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
                )}
              >
                <div className={cn('w-10 h-10 rounded overflow-hidden flex-shrink-0', owned ? 'bg-fuchsia-500/10 ring-1 ring-fuchsia-500/20' : 'bg-white/5')}>
                  {game.image ? (
                    <LazyFadeImage src={game.image} fallbackChain={chain} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><CalendarDays className="w-4 h-4 text-white/15" /></div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className={cn('text-xs font-medium truncate', owned ? 'text-fuchsia-300' : 'text-white')}>{game.name}</p>
                    {owned && (
                      <span className="text-[7px] px-1.5 py-0.5 rounded bg-fuchsia-500/25 text-fuchsia-300 font-bold uppercase tracking-wide flex-shrink-0">In Library</span>
                    )}
                  </div>
                  {game.genres.length > 0 && (
                    <p className="text-[9px] text-white/40 truncate mt-0.5">{game.genres.slice(0, 3).join(', ')}</p>
                  )}
                  <div className="flex items-center gap-1.5 mt-1 text-white/30">
                    {game.platforms.windows && <Monitor className="w-2.5 h-2.5" />}
                    {game.platforms.mac && <Apple className="w-2.5 h-2.5" />}
                    {game.platforms.linux && <Terminal className="w-2.5 h-2.5" />}
                    <span className="ml-auto">
                      {game.store === 'steam' ? <FaSteam className="w-3 h-3 text-white/30" /> : game.store === 'epic' ? <SiEpicgames className="w-3 h-3 text-white/30" /> : null}
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
  // Use a ref for toast to avoid re-rendering the entire calendar when toasts appear/disappear.
  // useToast() subscribes to context — each toast addition/removal would trigger a reconciliation.
  const toastCtx = useToast();
  const toastRef = useRef(toastCtx);
  toastRef.current = toastCtx;
  const today = useMemo(() => new Date(), []);
  const minYear = today.getFullYear();
  const minMonth = today.getMonth();

  const [currentYear, setCurrentYear] = useState(minYear);
  const [currentMonth, setCurrentMonth] = useState(minMonth);
  const [releases, setReleases] = useState<ParsedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── New feature state ────────────────────────────────────────────────────
  const [calView, setCalView] = useState<CalendarView>('month');
  const [radarActive, setRadarActive] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0); // weeks from start of current month

  // ── Reactive library IDs ─────────────────────────────────────────────────
  const [libraryIds, setLibraryIds] = useState(() => buildLibraryIdSet());
  useEffect(() => {
    const unsub = libraryStore.subscribe(() => setLibraryIds(buildLibraryIdSet()));
    return unsub;
  }, []);

  // Day detail panel
  const [dayDetail, setDayDetail] = useState<{ day: number; releases: ParsedRelease[] } | null>(null);
  const closeDayDetail = useCallback(() => setDayDetail(null), []);

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(600);

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);

  const goToGame = useCallback(
    (id: string | number) => navigate(`/game/${encodeURIComponent(String(id))}`),
    [navigate],
  );

  // ── One-click add to library ─────────────────────────────────────────────
  // Calls libraryStore directly (avoids useLibrary() hook and its redundant subscription).
  const handleAddToLibrary = useCallback((game: ParsedRelease) => {
    const gameId = releaseToGameId(game);
    if (libraryStore.isInLibrary(gameId)) return;
    const appId = extractSteamAppId(game.id);
    libraryStore.addToLibrary({
      gameId,
      steamAppId: appId ?? undefined,
      status: 'Want to Play',
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      cachedMeta: releaseToMeta(game),
    });
    toastRef.current.success(`"${game.name}" added to your library!`);
  }, []);

  // ── Top genres (memoized) ────────────────────────────────────────────────
  const topGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of releases) {
      for (const g of r.genres) {
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);
  }, [releases]);

  // ── Unified filter pipeline ──────────────────────────────────────────────
  const filteredReleases = useMemo(() => {
    let result = releases;
    // Platform filter
    if (platformFilter !== 'all') {
      result = result.filter((r) => r.platforms[platformFilter as keyof typeof r.platforms]);
    }
    // Genre filter
    if (genreFilter) {
      result = result.filter((r) => r.genres.includes(genreFilter));
    }
    return result;
  }, [releases, platformFilter, genreFilter]);

  // ── Data fetching ─────────────────────────────────────────────────────────

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
      let image = game.coverUrl || game.headerImage || '';
      if (!image && game.steamAppId) {
        image = getSteamHeaderUrl(game.steamAppId);
      }
      const genres = game.genre || [];

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
      const prefetchDerived = deriveReleasesFromPrefetch();
      let allReleases: UpcomingRelease[] = prefetchDerived ?? [];

      if (allReleases.length === 0) {
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

      const seen = new Map<string, UpcomingRelease>();
      for (let i = 0; i < allReleases.length; i++) {
        const r = allReleases[i];
        const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(key)) seen.set(key, r);
      }

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
    if (calView === 'week') {
      setWeekOffset((w) => w + 1);
      return;
    }
    setCurrentMonth((m) => {
      if (m === 11) { setCurrentYear((y) => y + 1); return 0; }
      return m + 1;
    });
  }, [calView]);

  const goPrev = useCallback(() => {
    if (calView === 'week') {
      setWeekOffset((w) => Math.max(w - 1, 0));
      return;
    }
    if (currentYear === minYear && currentMonth === minMonth) return;
    setCurrentMonth((m) => {
      if (m === 0) { setCurrentYear((y) => y - 1); return 11; }
      return m - 1;
    });
  }, [calView, currentYear, currentMonth, minYear, minMonth]);

  const goToday = useCallback(() => {
    setCurrentYear(minYear);
    setCurrentMonth(minMonth);
    setWeekOffset(0);
  }, [minYear, minMonth]);

  const navigateToMonth = useCallback((year: number, month: number) => {
    setCurrentYear(year);
    setCurrentMonth(month);
  }, []);

  const canGoPrev = calView === 'week' ? weekOffset > 0 : (currentYear > minYear || currentMonth > minMonth);
  const isCurrentMonth = currentYear === minYear && currentMonth === minMonth;

  // ── Release grouping (uses filteredReleases) ──────────────────────────────

  const { datedReleases, tbdReleases } = useMemo(() => {
    const dated: Map<number, ParsedRelease[]> = new Map();
    const tbd: ParsedRelease[] = [];
    for (const release of filteredReleases) {
      if (!release.parsedDate) { tbd.push(release); continue; }
      const d = release.parsedDate;
      if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
        const day = d.getDate();
        if (!dated.has(day)) dated.set(day, []);
        dated.get(day)!.push(release);
      }
    }
    return { datedReleases: dated, tbdReleases: tbd };
  }, [filteredReleases, currentYear, currentMonth]);

  // ── Week view date range ──────────────────────────────────────────────────

  const weekStart = useMemo(() => {
    const d = new Date(currentYear, currentMonth, 1);
    d.setDate(d.getDate() + weekOffset * 7);
    // Align to Sunday
    d.setDate(d.getDate() - d.getDay());
    return d;
  }, [currentYear, currentMonth, weekOffset]);

  const weekLabel = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const fmt = (d: Date) => `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
    return `${fmt(weekStart)} – ${fmt(end)}, ${end.getFullYear()}`;
  }, [weekStart]);

  // ── Calendar grid metrics ─────────────────────────────────────────────────

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

  const isInitialLoading = loading && releases.length === 0;
  const weekRows = isInitialLoading ? 5 : totalCells / 7;

  // ── Dynamic viewport-fill height ──────────────────────────────────────────

  useEffect(() => {
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = Math.max(window.innerHeight - rect.top - 8, 400);
      setGridHeight(h);
    };
    const raf = requestAnimationFrame(measure);
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(measure, 100); };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [error, currentMonth, currentYear, calView]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-2">
        {isInitialLoading ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-7 h-7 rounded-md bg-white/5 animate-pulse" />
              <div className="w-[180px] h-6 rounded-md bg-white/[0.06] animate-pulse" />
              <div className="w-7 h-7 rounded-md bg-white/5 animate-pulse" />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {/* Month / week navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={goPrev}
                disabled={!canGoPrev}
                className={cn('p-1.5 rounded-md transition-colors', canGoPrev ? 'hover:bg-white/10 text-white/60 hover:text-white' : 'text-white/15 cursor-not-allowed')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h2 className="text-lg font-semibold text-white min-w-[180px] text-center">
                {calView === 'week' ? weekLabel : `${MONTH_NAMES[currentMonth]} ${currentYear}`}
              </h2>
              <button onClick={goNext} className="p-1.5 rounded-md hover:bg-white/10 text-white/60 hover:text-white transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {!(isCurrentMonth && weekOffset === 0) && (
              <button onClick={goToday} className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-fuchsia-500/20 text-fuchsia-400 hover:bg-fuchsia-500/30 transition-colors">
                Today
              </button>
            )}

            {/* Mini-month strip — only in month view */}
            {calView === 'month' && (
              <MiniMonthStrip
                releases={releases}
                currentYear={currentYear}
                currentMonth={currentMonth}
                onNavigate={navigateToMonth}
              />
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* View toggle */}
          {!isInitialLoading && (
            <div className="flex items-center rounded-md border border-white/[0.08] overflow-hidden">
              {VIEW_TOGGLE_OPTIONS.map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => { setCalView(id); setWeekOffset(0); }}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors',
                    calView === id ? 'bg-fuchsia-500/20 text-fuchsia-400' : 'text-white/40 hover:text-white hover:bg-white/[0.06]',
                  )}
                  title={label}
                >
                  <Icon className="w-3 h-3" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          )}

          {loading && <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />}

          {/* Toggle Coming Soon sidebar */}
          {!isInitialLoading && !sidebarOpen && calView === 'month' && (
            <button
              onClick={toggleSidebar}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-white/40 hover:text-white hover:bg-white/10"
              title="Show Coming Soon"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
              <span className="text-[10px] font-medium">TBD</span>
              {tbdReleases.length > 0 && (
                <span className="text-[9px] text-fuchsia-400/80 bg-fuchsia-500/15 px-1.5 py-0.5 rounded-full font-medium">{tbdReleases.length}</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Filter chips ──────────────────────────────────────────────── */}
      {!isInitialLoading && (
        <FilterChips
          platformFilter={platformFilter}
          setPlatformFilter={setPlatformFilter}
          genreFilter={genreFilter}
          setGenreFilter={setGenreFilter}
          topGenres={topGenres}
          radarActive={radarActive}
          setRadarActive={setRadarActive}
        />
      )}

      {/* ── This Week banner — month view only ────────────────────────── */}
      {!isInitialLoading && calView === 'month' && (
        <ThisWeekBanner releases={filteredReleases} libraryIds={libraryIds} goToGame={goToGame} />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400 mb-3">{error}</div>
      )}

      {/* ── Layout ────────────────────────────────────────────────────── */}
      <div ref={gridRef} className="flex gap-3" style={{ height: gridHeight }}>

        {/* ── Month View ───────────────────────────────────────────────── */}
        {calView === 'month' && (
          <div className="border border-white/[0.06] rounded-xl overflow-hidden flex flex-col flex-1 min-w-0 transition-all duration-300 ease-in-out">
            <div className="grid grid-cols-7 bg-white/[0.03] flex-shrink-0">
              {DAY_NAMES.map((day) => (
                <div key={day} className="px-2 py-2 text-center text-[10px] font-medium text-white/30 uppercase tracking-wider border-b border-white/[0.06]">{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 flex-1 min-h-0" style={{ gridTemplateRows: `repeat(${weekRows}, 1fr)` }}>
              {isInitialLoading
                ? Array.from({ length: 35 }).map((_, idx) => (
                    <div key={idx} className="border-b border-r border-white/[0.04] p-1.5 overflow-hidden">
                      <div className="w-4 h-3 rounded bg-white/[0.06] animate-pulse mb-1.5" />
                      {SKEL_TILE_CELLS.has(idx) && (
                        <>
                          <div className="w-full h-8 rounded bg-white/[0.04] animate-pulse mb-1" />
                          {SKEL_DOUBLE_CELLS.has(idx) && <div className="w-full h-8 rounded bg-white/[0.03] animate-pulse" />}
                        </>
                      )}
                    </div>
                  ))
                : Array.from({ length: totalCells }).map((_, idx) => {
                    const dayNum = idx - firstDay + 1;
                    const isValidDay = dayNum >= 1 && dayNum <= daysInMonth;
                    const cellDate = isValidDay ? new Date(currentYear, currentMonth, dayNum) : null;
                    const isTodayCell = cellDate ? isToday(cellDate) : false;
                    const dayReleases = isValidDay ? datedReleases.get(dayNum) || [] : [];
                    const isPast = cellDate !== null && cellDate < today && !isTodayCell;

                    // Heat-map density
                    const density = dayReleases.length > 0 && !isPast ? Math.min(dayReleases.length / 8, 1) : 0;

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
                        style={density > 0 && !isTodayCell ? { backgroundColor: `rgba(217, 70, 239, ${density * 0.08})` } : undefined}
                      >
                        {isValidDay && (
                          <>
                            <div className={cn('text-[11px] font-medium mb-1 flex items-center gap-1.5', isTodayCell ? 'text-fuchsia-400' : 'text-white/30')}>
                              {isTodayCell ? (
                                <>
                                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-fuchsia-500 text-white text-[10px]">{dayNum}</span>
                                  <span className="text-[9px] font-bold text-fuchsia-400 uppercase tracking-wider">Today</span>
                                </>
                              ) : (
                                dayNum
                              )}
                            </div>
                            <div className="space-y-0.5">
                              {dayReleases.slice(0, 5).map((game) => {
                                const owned = isReleaseInLibrary(game.id, libraryIds);
                                const countdown = owned ? getCountdownLabel(game.parsedDate) : null;
                                return (
                                  <GameTile
                                    key={game.id}
                                    game={game}
                                    inLibrary={owned}
                                    onNavigate={goToGame}
                                    onAddToLibrary={handleAddToLibrary}
                                    radarDimmed={radarActive && !owned}
                                    countdownLabel={countdown}
                                  />
                                );
                              })}
                              {dayReleases.length > 5 && (
                                <button
                                  onClick={() => setDayDetail({ day: dayNum, releases: dayReleases })}
                                  className="w-full text-[8px] text-fuchsia-400/70 text-center py-0.5 rounded hover:bg-fuchsia-500/10 hover:text-fuchsia-400 transition-colors cursor-pointer"
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
        )}

        {/* ── Week View ────────────────────────────────────────────────── */}
        {calView === 'week' && (
          <WeekViewGrid
            weekStart={weekStart}
            releases={filteredReleases}
            libraryIds={libraryIds}
            goToGame={goToGame}
            onAddToLibrary={handleAddToLibrary}
            radarActive={radarActive}
          />
        )}

        {/* ── Agenda View ──────────────────────────────────────────────── */}
        {calView === 'agenda' && (
          <AgendaListView
            releases={filteredReleases}
            libraryIds={libraryIds}
            goToGame={goToGame}
            onAddToLibrary={handleAddToLibrary}
            radarActive={radarActive}
          />
        )}

        {/* ── Coming Soon sidebar — month view only ────────────────────── */}
        {calView === 'month' && (
          <ComingSoonSidebar
            releases={tbdReleases}
            loading={isInitialLoading}
            goToGame={goToGame}
            open={sidebarOpen}
            onToggle={toggleSidebar}
            libraryIds={libraryIds}
          />
        )}
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
            libraryIds={libraryIds}
          />
        )}
      </AnimatePresence>

      {/* Empty state */}
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
