/**
 * Release Calendar Component
 *
 * Year / Month / Week calendar showing upcoming game releases from Steam
 * and Epic Games Store APIs. Forward-only navigation starting from the
 * current month.
 *
 * Features:
 *  - Three view modes: Year (default), Month, Week
 *  - Poster-card feed — games displayed directly as visual poster cards
 *  - Grouped by time period with sticky section headers
 *  - "My Radar" filter — highlights library / Want-to-Play games
 *  - Genre / platform quick-filter chips
 *  - Heat-map density on section headers
 *  - Countdown chips (3d, Tomorrow, Today!) for library games
 *  - One-click "Add to Library" from poster hover
 *  - Multi-month mini-map for quick navigation (month view)
 *  - Coming Soon sidebar with virtualized list
 *  - Skeleton loader during initial fetch
 *  - Dynamic viewport-fill height so the feed always fits the screen
 */

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CalendarDays,
  Loader2,
  Clock,
  Monitor,
  Apple,
  Terminal,
  PanelRightClose,
  PanelRightOpen,
  Crosshair,
  List,
  Grid3X3,
  Calendar,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimateIcon } from '@/components/ui/animate-icon';
import { useLocation } from 'wouter';
import { FaSteam } from 'react-icons/fa';
import { SiEpicgames } from 'react-icons/si';
import { getPrefetchedGames, isPrefetchReady } from '@/services/prefetch-store';
import { getSteamHeaderUrl } from '@/types/steam';
import { libraryStore } from '@/services/library-store';
import { getCanonicalGenres, toCanonicalGenres } from '@/data/canonical-genres';
import { useToast } from '@/components/ui/toast';
import { GameCard } from '@/components/game-card';
import type { CachedGameMeta, Game, GameStatus } from '@/types/game';

// ─── Lazy fade-in image ─────────────────────────────────────────────────────

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
  fallbackChain?: string[];
}) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [errored, setErrored] = useState(false);

  const prevSrcRef = useRef(src);
  if (prevSrcRef.current !== src) {
    prevSrcRef.current = src;
    setLoaded(false);
    setAttempt(0);
    setErrored(false);
  }

  const urls = useMemo(() => {
    const chain = [src];
    if (fallbackChain) chain.push(...fallbackChain);
    else if (fallbackSrc) chain.push(fallbackSrc);
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

function extractSteamAppId(id: string | number): number | null {
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && id.startsWith('steam-')) {
    const n = parseInt(id.replace('steam-', ''), 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function buildImageFallbackChain(game: UpcomingRelease): string[] {
  // For Steam games: use CDN URL variants
  const appId = extractSteamAppId(game.id);
  if (appId) {
  const cdnBase = 'https://cdn.akamai.steamstatic.com/steam/apps';
  return [
      game.headerImage,
    `${cdnBase}/${appId}/library_600x900.jpg`,
    `${cdnBase}/${appId}/header.jpg`,
    `${cdnBase}/${appId}/capsule_616x353.jpg`,
    `${cdnBase}/${appId}/capsule_231x87.jpg`,
    ].filter((url): url is string => !!url && url !== game.image);
  }

  // For Epic games: use headerImage + screenshots as fallbacks
  const chain: string[] = [];
  if (game.headerImage && game.headerImage !== game.image) chain.push(game.headerImage);
  if (game.screenshots) {
    for (const s of game.screenshots) {
      if (s && s !== game.image && !chain.includes(s)) chain.push(s);
    }
  }
  return chain;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface UpcomingRelease {
  id: number | string;
  name: string;
  image: string;
  headerImage?: string;
  screenshots?: string[];
  epicNamespace?: string;
  epicOfferId?: string;
  epicSlug?: string;
  releaseDate: string;
  comingSoon: boolean;
  genres: string[];
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  store?: 'steam' | 'epic';
}

interface ParsedRelease extends UpcomingRelease {
  parsedDate: Date | null;
  _fallbackChain: string[];
  _stores: Set<string>;
}

type CalendarView = 'year' | 'month' | 'week';

interface FeedGroup {
  key: string;
  label: string;
  sublabel?: string;
  isCurrentPeriod: boolean;
  isPast?: boolean;
  releases: ParsedRelease[];
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

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

// ─── Human-readable date formatter ───────────────────────────────────────────

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// ─── Layout constants ───────────────────────────────────────────────────────

const COMING_SOON_CAP = 300;
const INITIAL_CARD_COUNT = 12;

const VIEW_TOGGLE_OPTIONS: { id: CalendarView; icon: typeof Grid3X3; label: string }[] = [
  { id: 'year', icon: Grid3X3, label: 'Year' },
  { id: 'month', icon: Calendar, label: 'Month' },
  { id: 'week', icon: List, label: 'Week' },
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

function releaseToGameId(game: ParsedRelease): string {
  const strId = String(game.id);
  if (strId.startsWith('steam-') || strId.startsWith('epic-')) return strId;
  if (typeof game.id === 'number' || /^\d+$/.test(strId)) return `steam-${strId}`;
  return strId;
}

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

// ─── ParsedRelease → Game adapter ────────────────────────────────────────────
// Converts a ParsedRelease into a Game-shaped object so we can reuse the
// shared GameCard component for visual consistency with browse / library views.

function releaseToGame(release: ParsedRelease, inLibrary: boolean): Game {
  const platformArr: string[] = [];
  if (release.platforms.windows) platformArr.push('Windows');
  if (release.platforms.mac) platformArr.push('Mac');
  if (release.platforms.linux) platformArr.push('Linux');

  const appId = extractSteamAppId(release.id);

  const availableOn: ('steam' | 'epic')[] = [];
  if (release._stores.has('steam')) availableOn.push('steam');
  if (release._stores.has('epic')) availableOn.push('epic');

  const displayDate = release.parsedDate && isToday(release.parsedDate)
    ? 'Today'
    : release.releaseDate;

  return {
    id: releaseToGameId(release),
    title: release.name,
    developer: '',
    publisher: '',
    genre: release.genres,
    platform: platformArr,
    metacriticScore: null,
    releaseDate: displayDate,
    coverUrl: release.image || undefined,
    headerImage: release.headerImage || undefined,
    screenshots: release.screenshots,
    epicNamespace: release.epicNamespace,
    epicOfferId: release.epicOfferId,
    epicSlug: release.epicSlug,
    store: release.store,
    steamAppId: appId ?? undefined,
    comingSoon: release.comingSoon,
    availableOn: availableOn.length > 0 ? availableOn : undefined,
    status: 'Want to Play' as GameStatus,
    priority: 'Medium' as any,
    publicReviews: '',
    recommendationSource: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isInLibrary: inLibrary,
  } as Game;
}

// ─── Filter Chips ────────────────────────────────────────────────────────────

type StoreFilter = 'all' | 'steam' | 'epic' | 'both';

const STORE_FILTER_OPTIONS: { id: StoreFilter; label: string; icon?: typeof FaSteam }[] = [
  { id: 'all', label: 'All' },
  { id: 'steam', label: 'Steam', icon: FaSteam },
  { id: 'epic', label: 'Epic', icon: SiEpicgames },
  { id: 'both', label: 'Both' },
];

const FilterChips = memo(function FilterChips({
  platformFilter,
  setPlatformFilter,
  storeFilter,
  setStoreFilter,
  genreFilter,
  setGenreFilter,
  topGenres,
  radarActive,
  setRadarActive,
}: {
  platformFilter: string;
  setPlatformFilter: (v: string) => void;
  storeFilter: StoreFilter;
  setStoreFilter: (v: StoreFilter) => void;
  genreFilter: string | null;
  setGenreFilter: (v: string | null) => void;
  topGenres: readonly string[];
  radarActive: boolean;
  setRadarActive: (v: boolean) => void;
}) {
  const hasActiveFilters = storeFilter !== 'all' || platformFilter !== 'all' || genreFilter !== null;

  const handleResetFilters = useCallback(() => {
    setStoreFilter('all');
    setPlatformFilter('all');
    setGenreFilter(null);
    setRadarActive(false);
  }, []);

  return (
    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
      {hasActiveFilters && (
        <>
          <button
            onClick={handleResetFilters}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors"
            title="Reset all filters"
            aria-label="Reset all filters"
          >
            <AnimateIcon hover="spin"><RotateCcw className="w-3 h-3" /></AnimateIcon>
            Reset
          </button>
          <div className="w-px h-4 bg-white/10" />
        </>
      )}
      <button
        onClick={() => setRadarActive(!radarActive)}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
          radarActive
            ? 'bg-fuchsia-500/25 text-fuchsia-300 ring-1 ring-fuchsia-500/40'
            : 'bg-white/[0.04] text-white/40 hover:bg-white/10 hover:text-white/70',
        )}
      >
        <Crosshair className="w-3 h-3" />
        My Radar
      </button>

      <div className="w-px h-4 bg-white/10" />

      {/* Store filter */}
      {STORE_FILTER_OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setStoreFilter(id)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
            storeFilter === id
              ? 'bg-fuchsia-500/25 text-fuchsia-300 ring-1 ring-fuchsia-500/40'
              : 'bg-white/[0.04] text-white/40 hover:bg-white/10 hover:text-white/70',
          )}
        >
          {Icon && <Icon className="w-3 h-3" />}
          {label}
        </button>
      ))}

      <div className="w-px h-4 bg-white/10" />

      {/* Platform filter */}
      {(['all', 'windows', 'mac', 'linux'] as const).map((p) => (
        <button
          key={p}
          onClick={() => setPlatformFilter(p)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
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
                'px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
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

// ─── Grouped Feed ────────────────────────────────────────────────────────────
// A scrolling feed of FeedGroups. Each group has a sticky header and a
// responsive grid of GameCard (reused from browse/library). Groups with many
// releases show a "Show all" button.

const NOOP_EDIT = () => {};
const NOOP_DELETE = () => {};

const GroupedFeed = memo(function GroupedFeed({
  groups,
  libraryIds,
  onAddToLibrary,
}: {
  groups: FeedGroup[];
  libraryIds: Set<string>;
  onAddToLibrary: (game: ParsedRelease) => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Build a lookup map so the gameId-only onAddToLibrary from GameCard
  // can find the original ParsedRelease for the full add-to-library flow.
  const releaseMap = useMemo(() => {
    const map = new Map<string, ParsedRelease>();
    for (const g of groups) {
      for (const r of g.releases) {
        map.set(releaseToGameId(r), r);
      }
    }
    return map;
  }, [groups]);

  const handleAddToLibrary = useCallback((gameId: string) => {
    const release = releaseMap.get(gameId);
    if (release) onAddToLibrary(release);
  }, [releaseMap, onAddToLibrary]);

  const hasAnyReleases = groups.some(g => g.releases.length > 0);

  if (!hasAnyReleases) {
  return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <CalendarDays className="w-10 h-10 text-white/[0.06] mb-3" />
        <p className="text-sm text-white/20">No releases match your filters</p>
      </div>
    );
  }

          return (
    <div data-calendar-feed className="overflow-y-auto h-full pr-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
      {groups.map((group) => {
        const isExpanded = expandedGroups.has(group.key);
        const hasMore = group.releases.length > INITIAL_CARD_COUNT;
        const visible = isExpanded ? group.releases : group.releases.slice(0, INITIAL_CARD_COUNT);
        const remaining = group.releases.length - INITIAL_CARD_COUNT;
        const density = Math.min(group.releases.length / 10, 1);

        return (
          <div key={group.key} className="mb-6 last:mb-2">
            {/* Sticky section header — opaque bg avoids GPU-heavy backdrop-blur */}
            <div
              className={cn(
                'sticky top-0 z-10 flex items-center gap-3 py-2 px-1 -mx-1',
                group.isCurrentPeriod ? 'bg-[#0d0b10]' : 'bg-[#0a0a0c]',
              )}
            >
              <h3 className={cn(
                'text-sm font-semibold flex-shrink-0',
                group.isCurrentPeriod ? 'text-fuchsia-400' : 'text-white/60',
              )}>
                {group.label}
              </h3>
              {group.sublabel && (
                <span className="text-[10px] text-white/25 flex-shrink-0">{group.sublabel}</span>
              )}
              {group.releases.length > 0 && (
              <span className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0',
                  group.isCurrentPeriod
                    ? 'bg-fuchsia-500/20 text-fuchsia-400'
                    : 'bg-white/[0.06] text-white/40',
                )}>
                  {group.releases.length}
              </span>
              )}
              {/* Heat bar */}
              <div className="flex-1 h-px relative">
                <div className="absolute inset-0 bg-white/[0.06]" />
                {density > 0 && (
                  <div
                    className="absolute left-0 top-0 h-full bg-fuchsia-500/40 rounded-full"
                    style={{ width: `${density * 100}%` }}
                  />
                )}
              </div>
            </div>

            {/* Card grid — reuses the same GameCard as browse/library for visual consistency */}
            {group.releases.length === 0 ? (
              group.isPast ? null : (
                <div className="py-6 text-center">
                  <p className="text-[11px] text-white/15">No releases</p>
                </div>
              )
            ) : (
              <div style={{ contentVisibility: 'auto', containIntrinsicBlockSize: '400px' }}>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 mt-2">
                  <AnimatePresence mode="popLayout">
                    {visible.map((release) => {
                      const owned = isReleaseInLibrary(release.id, libraryIds);
                      const gameObj = releaseToGame(release, owned);
                      return (
                        <motion.div
                          key={release.id}
                          layout="position"
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{
                            opacity: { duration: 0.18 },
                            scale: { duration: 0.18 },
                            layout: { duration: 0.25, type: 'spring', bounce: 0.12 },
                          }}
                          className="min-w-0"
                        >
                          <GameCard
                            game={gameObj}
                            isInLibrary={owned}
                            onEdit={NOOP_EDIT}
                            onDelete={NOOP_DELETE}
                            onAddToLibrary={handleAddToLibrary}
                            hideLibraryBadge={false}
                          />
                        </motion.div>
          );
        })}
                  </AnimatePresence>
                </div>
                {hasMore && !isExpanded && (
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className="mt-3 flex items-center gap-1.5 mx-auto px-4 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] text-white/40 hover:bg-white/[0.08] hover:text-white/70 transition-colors"
                  >
                    <ChevronDown className="w-3 h-3" />
                    Show all {group.releases.length} releases
                    <span className="text-white/20">(+{remaining})</span>
                  </button>
                )}
                {hasMore && isExpanded && (
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className="mt-3 flex items-center gap-1.5 mx-auto px-4 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] text-white/40 hover:bg-white/[0.08] hover:text-white/70 transition-colors"
                  >
                    Show less
                  </button>
        )}
      </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

// ─── Year Feed ───────────────────────────────────────────────────────────────
// Groups releases by month for the selected year.

const YearFeed = memo(function YearFeed({
  releases,
  year,
  libraryIds,
  onAddToLibrary,
}: {
  releases: ParsedRelease[];
  year: number;
  libraryIds: Set<string>;
  onAddToLibrary: (game: ParsedRelease) => void;
}) {
  const groups = useMemo((): FeedGroup[] => {
    const buckets: ParsedRelease[][] = Array.from({ length: 12 }, () => []);
    for (const r of releases) {
      if (!r.parsedDate) continue;
      if (r.parsedDate.getFullYear() === year) {
        buckets[r.parsedDate.getMonth()].push(r);
      }
    }
    const nowMonth = new Date().getMonth();
    const nowYear = new Date().getFullYear();
    return buckets.map((games, i) => ({
      key: `month-${i}`,
      label: MONTH_NAMES[i],
      isCurrentPeriod: year === nowYear && i === nowMonth,
      isPast: year < nowYear || (year === nowYear && i < nowMonth),
      releases: games,
    }));
  }, [releases, year]);

  return (
    <GroupedFeed
      groups={groups}
      libraryIds={libraryIds}
      onAddToLibrary={onAddToLibrary}
    />
  );
});

// ─── Month Feed (by week) ────────────────────────────────────────────────────

const MonthFeed = memo(function MonthFeed({
  releases,
  year,
  month,
  libraryIds,
  onAddToLibrary,
}: {
  releases: ParsedRelease[];
  year: number;
  month: number;
  libraryIds: Set<string>;
  onAddToLibrary: (game: ParsedRelease) => void;
}) {
  const groups = useMemo((): FeedGroup[] => {
    const lastDay = new Date(year, month + 1, 0);
    const weeks: { start: Date; end: Date; releases: ParsedRelease[] }[] = [];

    let ws = new Date(year, month, 1);
    ws.setDate(ws.getDate() - ws.getDay());

    while (ws <= lastDay) {
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      weeks.push({ start: new Date(ws), end: new Date(we), releases: [] });
      ws = new Date(ws);
      ws.setDate(ws.getDate() + 7);
    }

    for (const r of releases) {
      if (!r.parsedDate || r.parsedDate.getMonth() !== month) continue;
      for (const w of weeks) {
        const rd = new Date(r.parsedDate);
        rd.setHours(12, 0, 0, 0);
        const wStart = new Date(w.start); wStart.setHours(0, 0, 0, 0);
        const wEnd = new Date(w.end); wEnd.setHours(23, 59, 59, 999);
        if (rd >= wStart && rd <= wEnd) {
          w.releases.push(r);
          break;
        }
      }
    }

    const today = new Date();
    today.setHours(12, 0, 0, 0);

    const fmt = (d: Date) => `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
    return weeks.map((w, i) => {
      const wStart = new Date(w.start); wStart.setHours(0, 0, 0, 0);
      const wEnd = new Date(w.end); wEnd.setHours(23, 59, 59, 999);
      return {
        key: `week-${i}`,
        label: `Week ${i + 1}`,
        sublabel: `${fmt(w.start)} – ${fmt(w.end)}`,
        isCurrentPeriod: today >= wStart && today <= wEnd,
        isPast: today > wEnd,
        releases: w.releases,
      };
    });
  }, [releases, year, month]);

  return (
    <GroupedFeed
      groups={groups}
      libraryIds={libraryIds}
      onAddToLibrary={onAddToLibrary}
    />
  );
});

// ─── Week Feed (by day) ──────────────────────────────────────────────────────

const WeekFeed = memo(function WeekFeed({
  weekStart,
  releases,
  libraryIds,
  onAddToLibrary,
}: {
  weekStart: Date;
  releases: ParsedRelease[];
  libraryIds: Set<string>;
  onAddToLibrary: (game: ParsedRelease) => void;
}) {
  const groups = useMemo((): FeedGroup[] => {
    const days: { date: Date; releases: ParsedRelease[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      days.push({ date: d, releases: [] });
    }
    for (const r of releases) {
      if (!r.parsedDate) continue;
      for (const day of days) {
        if (isSameDay(r.parsedDate, day.date)) {
          day.releases.push(r);
          break;
        }
      }
    }
    return days.map((day, i) => {
      const d = day.date;
      const isPast = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return d < t; })();
      return {
        key: `day-${i}`,
        label: DAY_NAMES_FULL[d.getDay()],
        sublabel: `${d.getDate()}${ordinalSuffix(d.getDate())} ${MONTH_NAMES_SHORT[d.getMonth()]}`,
        isCurrentPeriod: isToday(d),
        isPast,
        releases: day.releases,
      };
    });
  }, [weekStart, releases]);

  return (
    <GroupedFeed
      groups={groups}
      libraryIds={libraryIds}
      onAddToLibrary={onAddToLibrary}
    />
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
                        'flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-colors duration-150 h-full',
                        owned
                          ? 'bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30 hover:bg-fuchsia-500/25 hover:ring-fuchsia-500/50'
                          : 'bg-white/[0.04] hover:bg-white/10 hover:ring-1 hover:ring-fuchsia-500/40',
                      )}
                      title={owned ? `${game.name} (In Library)` : game.name}
                    >
                      <div className={cn('w-5 h-5 rounded-sm overflow-hidden flex-shrink-0', owned ? 'bg-fuchsia-500/10' : 'bg-white/5')}>
                        {game.image ? (
                          <LazyFadeImage src={game.image} fallbackChain={game._fallbackChain} className="w-full h-full object-cover" />
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

// ─── Skeleton Feed ───────────────────────────────────────────────────────────

function SkeletonFeed({ sections }: { sections: number }) {
            return (
    <div className="overflow-y-auto h-full pr-1 space-y-6">
      {Array.from({ length: sections }).map((_, s) => (
        <div key={s}>
          <div className="flex items-center gap-3 py-2">
            <div className="h-4 w-24 rounded bg-white/[0.06] animate-pulse" />
            <div className="h-4 w-8 rounded-full bg-white/[0.04] animate-pulse" />
            <div className="flex-1 h-px bg-white/[0.04]" />
                </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 mt-2">
            {Array.from({ length: s === 0 ? 6 : 3 }).map((_, i) => (
              <div key={i} className="rounded-xl bg-white/[0.03] animate-pulse">
                <div className="aspect-[3/4]" />
                <div className="p-3 space-y-2">
                  <div className="h-4 w-3/4 rounded bg-white/[0.04]" />
                  <div className="h-3 w-1/2 rounded bg-white/[0.03]" />
                  </div>
                  </div>
            ))}
                </div>
              </div>
      ))}
        </div>
  );
}

// ─── Main Calendar Component ────────────────────────────────────────────────

export const ReleaseCalendar = memo(function ReleaseCalendar() {
  const [, navigate] = useLocation();
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
  const isInitialLoading = loading && releases.length === 0;

  const [calView, setCalView] = useState<CalendarView>(() => {
    const saved = sessionStorage.getItem('ark-calendar-view');
    if (saved && ['year', 'month', 'week'].includes(saved)) return saved as CalendarView;
    return 'year';
  });
  const [radarActive, setRadarActive] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [storeFilter, setStoreFilter] = useState<StoreFilter>('all');
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  // Persist calendar navigation state for scroll restore after back-navigation
  useEffect(() => {
    sessionStorage.setItem('ark-calendar-view', calView);
  }, [calView]);

  const [libraryIds, setLibraryIds] = useState(() => buildLibraryIdSet());
  useEffect(() => {
    const unsub = libraryStore.subscribe(() => setLibraryIds(buildLibraryIdSet()));
    return unsub;
  }, []);

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(600);

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);

  const goToGame = useCallback(
    (id: string | number) => navigate(`/game/${encodeURIComponent(String(id))}`),
    [navigate],
  );

  // Continuously persist feed scroll position so it survives navigation to game details
  useEffect(() => {
    if (isInitialLoading) return;
    let saveTimer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const feed = document.querySelector('[data-calendar-feed]');
        if (feed) {
          sessionStorage.setItem('ark-calendar-scroll', String(Math.round(feed.scrollTop)));
        }
      }, 150);
    };
    const flushSave = () => {
      const feed = document.querySelector('[data-calendar-feed]');
      if (feed) {
        sessionStorage.setItem('ark-calendar-scroll', String(Math.round(feed.scrollTop)));
      }
    };
    // Defer attachment so the feed DOM is available after the render
    const raf = requestAnimationFrame(() => {
      const feed = document.querySelector('[data-calendar-feed]');
      if (feed) feed.addEventListener('scroll', onScroll, { passive: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(saveTimer);
      flushSave();
      const feed = document.querySelector('[data-calendar-feed]');
      if (feed) feed.removeEventListener('scroll', onScroll);
    };
  }, [isInitialLoading, calView]);

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

  const topGenres = useMemo(() => [...getCanonicalGenres()] as string[], []);

  const filteredReleases = useMemo(() => {
    const now = new Date();
    const tY = now.getFullYear(), tM = now.getMonth(), tD = now.getDate();
    let result = releases.filter((r) => {
      if (!r.parsedDate) return true;
      const y = r.parsedDate.getFullYear(), m = r.parsedDate.getMonth(), d = r.parsedDate.getDate();
      return y > tY || (y === tY && (m > tM || (m === tM && d >= tD)));
    });
    if (storeFilter === 'steam') {
      result = result.filter((r) => r._stores.has('steam'));
    } else if (storeFilter === 'epic') {
      result = result.filter((r) => r._stores.has('epic'));
    } else if (storeFilter === 'both') {
      result = result.filter((r) => r._stores.has('steam') && r._stores.has('epic'));
    }
    if (platformFilter !== 'all') {
      result = result.filter((r) => r.platforms[platformFilter as keyof typeof r.platforms]);
    }
    if (genreFilter) {
      result = result.filter((r) => (toCanonicalGenres(r.genres) as string[]).includes(genreFilter));
    }
    if (radarActive) {
      result = result.filter((r) => isReleaseInLibrary(r.id, libraryIds));
    }
    return result;
  }, [releases, storeFilter, platformFilter, genreFilter, radarActive, libraryIds]);

  const tbdReleases = useMemo(() => {
    return filteredReleases.filter(r => !r.parsedDate);
  }, [filteredReleases]);

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

      // Extra image fields for GameCard's fallback chain
      const headerImage = game.headerImage || undefined;
      const screenshots = game.screenshots && game.screenshots.length > 0 ? game.screenshots : undefined;
      const epicNamespace = game.epicNamespace;
      const epicOfferId = game.epicOfferId;
      const epicSlug = game.epicSlug;

      if (game.comingSoon && game.releaseDate === 'Coming Soon') {
        if (comingSoonCount < COMING_SOON_CAP) {
          results.push({ id: game.id, name: game.title, image, headerImage, screenshots, epicNamespace, epicOfferId, epicSlug, releaseDate: 'Coming Soon', comingSoon: true, genres, platforms, store });
          comingSoonCount++;
        }
        continue;
      }

      const ts = (game as any)._releaseTs ?? new Date(game.releaseDate).getTime();
      if (isNaN(ts) || ts === 0) continue;
      if (ts < pastCutoff || ts > futureCutoff) continue;

      results.push({ id: game.id, name: game.title, image, headerImage, screenshots, epicNamespace, epicOfferId, epicSlug, releaseDate: game.releaseDate, comingSoon: ts > now, genres, platforms, store });
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
            epicNamespace: r.namespace,
            epicOfferId: r.offerId,
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
      const storesByKey = new Map<string, Set<string>>();
      for (let i = 0; i < allReleases.length; i++) {
        const r = allReleases[i];
        const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(key)) {
          seen.set(key, r);
          storesByKey.set(key, new Set(r.store ? [r.store] : []));
        } else if (r.store) {
          storesByKey.get(key)!.add(r.store);
        }
      }

      const dedupArr = Array.from(seen.entries());
      const parsed: ParsedRelease[] = new Array(dedupArr.length);
      for (let i = 0; i < dedupArr.length; i++) {
        const [key, r] = dedupArr[i];
        parsed[i] = {
          ...r,
          parsedDate: parseReleaseDate(r.releaseDate),
          _fallbackChain: buildImageFallbackChain(r),
          _stores: storesByKey.get(key) ?? new Set(),
        };
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
    if (calView === 'year') { setCurrentYear(y => y + 1); return; }
    if (calView === 'week') { setWeekOffset(w => w + 1); return; }
    setCurrentMonth((m) => {
      if (m === 11) { setCurrentYear((y) => y + 1); return 0; }
      return m + 1;
    });
  }, [calView]);

  const goPrev = useCallback(() => {
    if (calView === 'year') { if (currentYear <= minYear) return; setCurrentYear(y => y - 1); return; }
    if (calView === 'week') { setWeekOffset((w) => Math.max(w - 1, 0)); return; }
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

  const canGoPrev = calView === 'year'
    ? currentYear > minYear
    : calView === 'week'
      ? weekOffset > 0
      : (currentYear > minYear || currentMonth > minMonth);

  const isCurrentPeriod = calView === 'year'
    ? currentYear === minYear
    : calView === 'week'
      ? (currentYear === minYear && currentMonth === minMonth && weekOffset === 0)
      : (currentYear === minYear && currentMonth === minMonth);

  const weekStart = useMemo(() => {
    const d = new Date(currentYear, currentMonth, 1);
    d.setDate(d.getDate() + weekOffset * 7);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }, [currentYear, currentMonth, weekOffset]);

  const weekLabel = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const fmt = (d: Date) => `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
    return `${fmt(weekStart)} – ${fmt(end)}, ${end.getFullYear()}`;
  }, [weekStart]);

  const headerLabel = useMemo(() => {
    if (calView === 'year') return String(currentYear);
    if (calView === 'week') return weekLabel;
    return `${MONTH_NAMES[currentMonth]} ${currentYear}`;
  }, [calView, currentYear, currentMonth, weekLabel]);

  // Restore feed scroll position after returning from game details
  useEffect(() => {
    if (isInitialLoading) return;
    const saved = sessionStorage.getItem('ark-calendar-scroll');
    if (!saved) return;
    sessionStorage.removeItem('ark-calendar-scroll');
    const pos = parseInt(saved, 10);
    if (isNaN(pos) || pos <= 0) return;
    // Wait for the feed DOM to render, then restore scroll
    let attempts = 0;
    const tryRestore = () => {
      const feed = document.querySelector('[data-calendar-feed]');
      if (feed) {
        feed.scrollTop = pos;
        if (Math.abs(feed.scrollTop - pos) > 10 && attempts < 10) {
          attempts++;
          requestAnimationFrame(tryRestore);
        }
      } else if (attempts < 10) {
        attempts++;
        requestAnimationFrame(tryRestore);
      }
    };
    requestAnimationFrame(tryRestore);
  }, [isInitialLoading]);

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
            <div className="flex items-center gap-1">
              <button
                onClick={goPrev}
                disabled={!canGoPrev}
                className={cn('p-1.5 rounded-md transition-colors', canGoPrev ? 'hover:bg-white/10 text-white/60 hover:text-white' : 'text-white/15 cursor-not-allowed')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h2 className="text-lg font-semibold text-white min-w-[180px] text-center">
                {headerLabel}
              </h2>
              <button onClick={goNext} className="p-1.5 rounded-md hover:bg-white/10 text-white/60 hover:text-white transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {!isCurrentPeriod && (
              <button onClick={goToday} className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-fuchsia-500/20 text-fuchsia-400 hover:bg-fuchsia-500/30 transition-colors">
                Today
              </button>
            )}

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

          {!isInitialLoading && !sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-white/40 hover:text-white hover:bg-white/10"
              title="Show Coming Soon"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
              <span className="text-[10px] font-medium">TBA</span>
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
          storeFilter={storeFilter}
          setStoreFilter={setStoreFilter}
          genreFilter={genreFilter}
          setGenreFilter={setGenreFilter}
          topGenres={topGenres}
          radarActive={radarActive}
          setRadarActive={setRadarActive}
        />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400 mb-3">{error}</div>
      )}

      {/* ── Layout ────────────────────────────────────────────────────── */}
      <div ref={gridRef} className="flex gap-3" style={{ height: gridHeight }}>

        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {isInitialLoading ? (
            <SkeletonFeed sections={calView === 'year' ? 4 : calView === 'month' ? 5 : 7} />
          ) : calView === 'year' ? (
            <YearFeed
              releases={filteredReleases}
              year={currentYear}
              libraryIds={libraryIds}
                                    onAddToLibrary={handleAddToLibrary}
            />
          ) : calView === 'month' ? (
            <MonthFeed
            releases={filteredReleases}
              year={currentYear}
              month={currentMonth}
            libraryIds={libraryIds}
            onAddToLibrary={handleAddToLibrary}
            />
          ) : (
            <WeekFeed
              weekStart={weekStart}
            releases={filteredReleases}
            libraryIds={libraryIds}
            onAddToLibrary={handleAddToLibrary}
          />
        )}
        </div>

          <ComingSoonSidebar
            releases={tbdReleases}
            loading={isInitialLoading}
            goToGame={goToGame}
            open={sidebarOpen}
            onToggle={toggleSidebar}
            libraryIds={libraryIds}
          />
                    </div>

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
