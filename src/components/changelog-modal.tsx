import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Current app version — injected from package.json at build time by Vite.
// No manual bumps needed; just update package.json.
export const APP_VERSION: string = __APP_VERSION__;

// Changelog entries - add new versions at the top
const CHANGELOG: Record<string, { title: string; changes: string[] }> = {
  '1.0.31': {
    title: "What's New in Ark 1.0.31",
    changes: [
      'Medals System — Gamified progression with Taste DNA radar, badge vault, skill tree, genre/activity analytics, and commander XP; 40+ badges across Explorer, Completionist, Collector, Analyst, and Veteran branches with Bronze → Diamond tiers',
      'Oracle Recommendations — 17-layer scoring pipeline running in a Web Worker produces themed shelves (Hidden Gems, Genre Deep Dives, Comfort Picks, etc.) with match-score breakdowns; shelf ordering optimized via Thompson Sampling bandit',
      'Ollama Embedding Integration — Auto-detects local Ollama, pulls the required model, and generates semantic embeddings for richer recommendation matching; all orchestrated through new IPC handlers',
      'Year Wrapped — Spotify-Wrapped-style gaming recap accessible from Settings with animated slides showing top games, genre breakdown, and session stats',
      'Showcase View Overhaul — 3D card carousel for "Your Ark" with tilt interaction, status rings, and smooth transitions; replaces the old flat grid default',
      'Voyage View Refactor — Renamed Noob → Captain\'s Log with per-month grouping; new Medals tab alongside Log/OCD; removed standalone Analytics view in favour of Medals Overview',
      'Gantt Virtualization — OCD timeline now uses @tanstack/react-virtual for vertical row virtualization, dramatically reducing DOM nodes for large libraries',
      'Performance Tier 1 — Debounced localStorage writes (300 ms coalescing) in library, journey, and custom-game stores with beforeunload flush; cached sorted arrays invalidated on mutation',
      'Performance Tier 2 — Fingerprint-based early exit in useDeferredFilterSort, stable isPlayingNow ref in dashboard renderGameCard, useCallback for card click/heart handlers, Set-based genre dedup in Epic transform',
      'Performance Tier 3 — Chunked search-index build with requestIdleCallback yielding, splash-screen star count halved (1000 → 500), cold-start wait reduced (1200 → 400 ms), library enrichment guarded by Set lookup',
      'Import/Export Overhaul — Import now performs a full wipe-and-replace across library, journey, session, and status-history stores for deterministic results; merge import option added',
      'UI Components — 3D tilt card, Evervault animated card, database REST badge, BlurText, CountUp, GradientText, and ShinyText animation primitives',
      'Test Fixes — Updated journey-view, library-store, and epic-service tests for new view defaults, mock completeness, and isFree pricing edge case',
    ],
  },
  '1.0.30': {
    title: "What's New in Ark 1.0.30",
    changes: [
      'UI Rebrand — Renamed "Buzz" to "Transmissions" and "Journey" to "Voyage" across all views, navigation, empty states, and changelog entries for a sharper identity',
      'Release Calendar Redesign — Replaced custom poster cards with the shared GameCard component used in Browse and Library for visual consistency; poster-card feed grouped by year/month/week with store filters (Steam / Epic / Both) and smooth Framer Motion layout animations',
      'IPC Architecture Overhaul — Extracted ~1,200 lines from the monolithic electron/main.ts into 12 dedicated handler modules (AI, dialogs, Epic, Metacritic, proxy, RSS, sessions, settings, Steam, webview, window) for maintainability and faster startup',
      'Metacritic Scraper Rewrite — Replaced raw HTTPS + regex scraping with cheerio-based HTML parsing; added user score support, 5 MB response-size guard, and Electron net.fetch for reliable connectivity',
      'Loading Screen Elimination — Streamlined boot sequence from Splash → Loading → Dashboard to Splash → Dashboard; splash screen now preloads game data and the dashboard chunk, gating the "Enter Ark" button until data is ready',
      'Browse ↔ Library Flash Fix — Fixed stale-data flash when switching view modes by synchronously recomputing filters before paint via useLayoutEffect instead of the deferred rAF path',
      'Game Details Refactor — Major restructure of the game details page with improved layout, better error handling, and cleaner component decomposition',
      'Responsive Dashboard — Panel open/close toggles, responsive padding for split-screen and smaller viewports, icon-only nav buttons below lg breakpoint',
      'Safe Logger & Safe Write — New crash-resistant utility modules for structured logging and atomic file writes across the Electron main process',
      'App Icons Refresh — Updated all icon sizes (16–256 px, ICO, and PNG) with the new Ark branding',
      'Online Status Guard — Added unmount safety ref to the useOnlineStatus hook to prevent state updates after teardown',
      'Unhandled Rejection Handler — Main process now catches unhandled promise rejections gracefully instead of crashing',
    ],
  },
  '1.0.29': {
    title: "What's New in Ark 1.0.29",
    changes: [
      'Splash Screen Fix — Fixed crash on startup in packaged Electron builds caused by absolute asset paths not resolving under file:// protocol; 3D scene and custom font now load correctly',
      'Error Boundary — Added error boundary around the Three.js canvas so WebGL or model load failures degrade gracefully instead of crashing the app',
      'Asset Path Hardening — All public directory asset references (GLB model, hardcoded cover images) now use relative paths via import.meta.env.BASE_URL for cross-environment compatibility',
      'Splash Screen Polish — Reduced ARK title font size for better visual balance',
    ],
  },
  '1.0.28': {
    title: "What's New in Ark 1.0.28",
    changes: [
      'Epic Games Store Integration — Browse, filter, and view Epic games alongside Steam; merged catalogs for Top Sellers, Coming Soon, and Free Games; store filter (Steam / Epic / Both) in the filter sidebar',
      'Game Details Overhaul — Full-page /game/:id route with hero section, media carousel, cross-store badges ("Also on Steam" / "Also on Epic"), Epic DLC/add-ons, Epic reviews fallback, and tabbed layout (Overview, My Progress, News & Reviews)',
      '3D Splash Screen — "ARK DEEP STORAGE RECOVERY" boot sequence with Three.js scene, terminal-style output, and three-step flow (Splash → Loading → Ready) that prefetches browse data in the background',
      'Animated Empty States — Contextual empty states for no search results, no matching filters, and empty library with animated caveman GIF and electricity puns; one-click "Clear Search", "Clear Filters", or "Browse Games" actions',
      'Catalog (A-Z) Mode — Full Steam catalog (~155K games) with letter-jump bar, cached in IndexedDB with 6-hour staleness; optimized sort (~300ms vs 5-10s) deferred until catalog mode is opened',
      'Dashboard Performance Fix — Heavy filter/sort/dynamic-filter computation moved off the render phase into a deferred async hook (useDeferredFilterSort) using requestAnimationFrame + startTransition; catalog preload no longer blocks the main thread with a 155K-item localeCompare sort',
      'Session Tracking Improvements — Idle time exclusion via Electron powerMonitor, single process snapshot per poll, live "Playing Now" badge with status events',
      'Filter Sidebar Redesign — Store filter radio group, category-aware filter disabling, dynamic genre/platform/year options derived from current filter set, catalog count indicator',
    ],
  },
  '1.0.27': {
    title: "What's New in Ark 1.0.27",
    changes: [
      'Browse Game Count Fix — Background refresh no longer silently drops cross-store (Steam + Epic) games; the full catalog is preserved across refreshes',
      'Background Refresh Safety Net — If a refresh produces >10% fewer games than the current set, the swap is skipped to prevent games from disappearing mid-session',
      'Custom Game Status Dropdown — Changing status from the card dropdown in Library view now correctly updates custom games instead of silently failing',
      'Custom Game Duplicate Fix — Editing a custom game entry no longer creates a duplicate record; updates route to the correct store on both dashboard and game details page',
      'Spinner Z-Order Fix — The infinite-scroll loading spinner no longer renders behind game cards; it now appears naturally below the grid',
    ],
  },
  '1.0.26': {
    title: "What's New in Ark 1.0.26",
    changes: [
      'Release Calendar Overhaul — 8 new features: "My Radar" library-only filter, Week and Agenda views, countdown chips, genre/platform quick-filters, heat-map density dots, one-click "Add to Library", "This Week" banner, and multi-month mini-map',
      'Game Details for Custom Games — Custom games now open the full game details page with hero section, My Progress tab, and Game Details tab',
      'Edit Library Entry Dialog — GameDialog supports edit mode with pre-filled status, priority, notes, discovery source, and executable path',
      'Consistent Edit Entry Flow — Right-clicking any game card and selecting "Edit Entry" opens the same dialog in edit mode across Steam, Epic, and custom games',
      'Custom Game Card Navigation — Clicking a custom game card navigates to the full game details page instead of a modal',
      'Performance — LazyFadeImage stale state reset, eliminated double library subscription, stable callback refs, module-level constants, and AgendaGameRow memo extraction',
    ],
  },
  '1.0.25': {
    title: "What's New in Ark 1.0.25",
    changes: [
      'Performance & Memory Optimization — LRU eviction caps for detail-enricher sets (5K/500 entries), enrichment map (2K cap), background timer cleanup on unmount, and async disk writes in PersistentCache prevent memory bloat during long sessions',
      'Single-Pass Filtering — Dashboard filter chain collapsed from 7 sequential .filter() calls into one pass with pre-computed values and Set lookups for stores, dramatically reducing intermediate array allocations',
      'Promise Coalescing in Rate Limiter — Identical concurrent API requests (appdetails, featured-categories, player-count) now share a single in-flight promise instead of hitting Steam twice; queue capped at 500 to prevent unbounded growth',
      'Diff-Based Library Refresh — useLibraryGames now caches fetched game details and only makes API calls for newly added games; status/priority updates are applied locally without network requests',
      'Pre-Computed Search Index — Prefetch store builds a parallel lowercase index on load, eliminating thousands of .toLowerCase() calls per keystroke during Browse search',
      'Release Calendar Overhaul — "+X more" button opens a slide-out side panel with smooth framer-motion enter/exit animation; multi-step Steam CDN fallback chain (cover → header → capsule) for thumbnails; fixed popover positioning bug (viewport-relative fix) and added debounced hover timing to prevent flicker',
      "Voyage Thumbnail Fallbacks — All three Voyage views (Captain's Log timeline, OCD Gantt, Analytics) now use a shared buildGameImageChain() utility that walks through Steam CDN URL variants on error instead of showing blank placeholders",
      'Voyage CoverUrl Backfill — Library refresh now patches older voyage entries that have missing coverUrl fields with freshly fetched image URLs',
      'Epic System Requirements Fix — Epic CMS requirements are now handled for all data shapes (string, array, object) instead of breaking when Object.entries() was called on a plain string',
      'Epic Library Bug Fix — Fixed broken GraphQL schema (removed deprecated releaseInfo field), added REST fallback for getGameDetails, and introduced multi-tier offline fallback (cachedMeta → voyageStore → placeholder) so Epic games always appear in Library',
      'Stable View-Mode Handlers — Extracted 5 inline onClick closures to useCallback; memoized hasActiveFilters and activeFilterCount to reduce unnecessary re-renders',
      'Filter Sidebar Type Fix — Added missing "calendar" to ViewMode union, resolving TypeScript compilation error; cleaned up unused Filter import',
    ],
  },
  '1.0.24': {
    title: "What's New in Ark 1.0.24",
    changes: [
      'Improved Notifications — Native Windows notifications now show the Ark icon, fire regardless of window visibility (not only when minimised), de-duplicate per version so the same toast is not repeated every 30 minutes, and a second "Update Ready" notification appears once the download completes',
      'Faster First Update Check — A 2-minute delayed first poll replaces the previous 30-minute wait, so users who minimise to tray still get an early update check',
      'System Tray Icon Fix — Icons are now bundled via extraResources instead of asarUnpack (which was silently failing), and the tray prefers the pre-made 16×16 PNG to avoid blank icons from ICO resize issues',
      'Human-Readable Playtime — Playtime now displays as "X Hrs Y Mins" with proper singular/plural labels across all views (Voyage, Analytics, Gantt, Progress, Reviews, Sessions)',
      'Custom Game Click Fix — Clicking a custom game card now correctly opens the progress dialog instead of navigating to a non-existent game details page; fixed React.memo comparator that was suppressing onClick updates',
      'Custom Game Edit Fix — "Edit Entry" on a custom game now opens the dedicated progress dialog instead of the generic library dialog, so the executable path and all custom fields are properly shown',
      'Voyage View Custom Games — Custom game cards in the Voyage timeline now open the progress dialog instead of navigating to a broken game details route',
    ],
  },
  '1.0.23': {
    title: "What's New in Ark 1.0.23",
    changes: [
      'Custom Game Progress — Clicking a custom game card now opens a dedicated progress dialog with playtime stats, session history, status/hours/rating editing, and executable path management',
      'Human-Readable Playtime — All hour displays across Voyage, Analytics, OCD Gantt, and My Progress now show "Xh Ym" format instead of raw decimals (e.g. "2h 15m" instead of "2.25")',
      'System Tray Icon Fix — Generated proper PNG/ICO icon files from the SVG source; tray now shows the Ark gamepad icon instead of a blank square',
      'Auto-Updater Double-Download Fix — Added guard flags to prevent overlapping update checks and duplicate downloads; removed redundant 5-second initial check that conflicted with the snackbar mount check',
      'Custom Game Dialog Overflow Fix — Restructured the Add Custom Game modal with a scrollable body and pinned footer to prevent UI overflow on smaller screens',
      'Custom Game Executable Persistence Fix — Moved submit button back inside the form element to ensure the executable path is properly included in form submission',
      'Re-render Optimisations — Stabilised onClick callbacks for custom game cards via useCallback; replaced inline arrow functions in progress dialog with memoised handlers',
    ],
  },
  '1.0.22': {
    title: "What's New in Ark 1.0.22",
    changes: [
      'Release Calendar — New "Releases" tab showing upcoming game releases on a monthly grid calendar sourced from Steam Coming Soon + New Releases APIs, with date parsing, TBD section, hover tooltips, and forward-only navigation',
      'System Tray — Discord-style minimize-to-tray behavior: closing and minimizing hide the app to the system tray instead of quitting; tray icon with context menu (Show Ark / Quit); double-click tray to restore',
      'Launch on Startup Hidden — When auto-launch is enabled, the app starts hidden in the system tray (--hidden flag) instead of showing the window',
      'IGDB Cleanup — Removed all unused IGDB service, types, and stale preload script; cleaned up legacy references across the codebase',
      'Upcoming Releases Caching — 1-hour in-memory cache for the upcoming releases IPC handler prevents repeated Steam API calls on tab switches',
      'Steam Rate Limit Mitigation — 500ms inter-batch delay when fetching game details to reduce 429 rate limit errors from Steam',
      'Test Fixes — Updated test mocks for subscribe methods and fixed assertions to match current component behavior; all 214 tests passing',
    ],
  },
  '1.0.21': {
    title: "What's New in Ark 1.0.21",
    changes: [
      'Analytics UX Polish — Standardised font sizes (3-tier system), stroke widths, and bar thicknesses across all SVG charts for visual consistency',
      'Activity Chart Improvements — Thinner lines, smaller X-axis labels, and native SVG tooltips on all data points (hover for exact "added" / "completed" counts)',
      'Area Chart Redesign — Taller chart (160px), increased padding, distinct solid/dashed lines for Added vs Completed series with vertical drop lines and Y-axis labels',
      'Session Histogram — Increased height, larger bucket labels, hover-to-reveal counts',
      'Recent Activity Fade — Scrollable activity list now has a fade-out gradient at the bottom to signal more content',
      'Custom Game Session Tracking — Custom games with executable paths are now tracked by the session monitor (previously only library games were tracked)',
      'Custom Game Hours — Play hours from tracked sessions are now written back to custom game entries (new hoursPlayed field on CustomGameEntry)',
      'Performance — VoyageGameCard and AnimatedValue wrapped with React.memo; StarRating array extracted to module-level constant; store snapshots cached via useRef to prevent new-array-reference re-renders',
      'OCD View — Sticky sidebar with synchronised vertical scroll for game labels; improved hover highlighting across sidebar and timeline',
      'Transmissions View — Webview opens on card click (removed separate View button); portrait cards restored; viewport height adjusted to prevent scrolling',
      'Removed Platform Breakdown chart from Analytics',
    ],
  },
  '1.0.20': {
    title: "What's New in Ark 1.0.20",
    changes: [
      'Advanced Analytics Dashboard — Fully redesigned Analytics tab with animated visualisations: play schedule heatmap, streak tracking, session length histogram, priority breakdown, recommendation source chart, and release year distribution',
      'Radar & Spider Charts — Gaming Profile (6-axis) and Genre Radar with animated polygon fills',
      'Animated Chart Components — Count-up numbers, draw-on sparklines, sweep-in donuts, radial gauges, completion funnel, and staggered card entry animations',
      'Gantt Chart Redesign — Interactive timeline bars with status-colored segments, session overlays, and improved scrolling',
      'OCD View Performance — Throttled scroll updates, ref-driven hover/tooltip (zero re-renders), memoized footer stats',
      'Transmissions View — Switched news cards from portrait (9:16) to square (1:1) to reduce image clipping; removed Reddit as a news source',
      'Battlefield 6 Cover Fix — Hardcoded local cover image across all views since API images were broken',
      'Bug Fix — "Clear All" now also removes custom games (previously only cleared library entries)',
    ],
  },
  '1.0.19': {
    title: "What's New in Ark 1.0.19",
    changes: [
      'Session Tracking — Automatic play-time tracking by monitoring game executables; detects launches, exits, and accumulates active play hours',
      'Idle Detection — System idle time (5-minute threshold) is subtracted from sessions using Electron powerMonitor for accurate play-time reporting',
      'Playing Now Status — Live "Playing Now" badge with pulse animation appears on game cards when a tracked game\'s executable is running',
      'Executable Path Picker — Native OS file explorer dialog (Browse button) in Edit Entry to select game executables for tracking — no copy-pasting paths',
      'Session History Store — Persistent session log with import/export support, integrated with library data backup',
      'Removed "Dropped" Status — Replaced with "On Hold"; existing Dropped entries are auto-migrated on startup',
    ],
  },
  '1.0.18': {
    title: "What's New in Ark 1.0.18",
    changes: [
      'Removed auto-detection of installed Steam games — games are no longer auto-added to your library based on local installs',
      'Removed Installed badge from game cards for a cleaner look',
    ],
  },
  '1.0.17': {
    title: "What's New in Ark 1.0.17",
    changes: [
      'Steam News & Updates — Game details page now shows a carousel of the latest news articles from Steam with thumbnails, auto-scroll, and source labels',
      'Recommended by Steam — Similar games section redesigned with content-based recommendations specific to each game',
      'Voyage View — New timeline view that persists your entire gaming history, even after removing games from the library',
      'AI Chat with Web Search — Ollama-powered chat now uses DuckDuckGo grounding for real-time answers about awards, releases, and current events',
      'Live Player Counts — Real-time "playing now" counts shown on dashboard cards, game details, and voyage cards, consistent across all views',
      'My Progress Skeleton — Dedicated skeleton loader for the progress tab eliminates flicker when navigating to game details',
      'Status Change History — Every status transition is now persisted with game, previous/new state, and timestamp for future tracking features',
      'Image Fallback Overhaul — Robust multi-step fallback chains with placeholder detection for game thumbnails across all views',
      'Performance Audit — Reduced re-renders in game cards, voyage view, and game store; optimized memo comparators and batch state updates',
      'Test Suite Reorganization — All 18 test files consolidated into src/test/ with consistent folder structure mirroring source',
    ],
  },
  '1.0.16': {
    title: "What's New in Ark 1.0.16",
    changes: [
      'Hyperlinks now open in your default OS browser - Steam, Metacritic, FitGirl, and all in-page links no longer open inside the Electron window, keeping your site logins intact',
      'Pricing displayed in INR - Game details show Indian Rupee pricing directly from the Steam API (cc=in)',
      'Library view cleanup - Heart icon removed from Library cards since you already have the ellipsis menu and right-click to manage games',
      'Cleaner game lists - Games without developer or publisher info (e.g. FiveM) are filtered out from Browse and Library',
      'Navigation guards - Added will-navigate and window-open handlers to prevent Electron from ever navigating away from the app',
    ],
  },
  '1.0.15': {
    title: "What's New in Ark 1.0.15",
    changes: [
      'Electron app now starts correctly - fixed main process crash when running as ESM (__dirname)',
      'Electron e2e tests pass - window opens, dashboard, Library, search, and Settings tested',
      'Changelog modal no longer blocks clicks - tests dismiss it before interacting with the app',
    ],
  },
  '1.0.14': {
    title: "What's New in Ark 1.0.14",
    changes: [
      'Pricing in INR - Game details and Steam data now show Indian Rupee (₹) from the Steam API',
      'Links open in your browser - Steam, Metacritic, FitGirl, and in-page links open in your default OS browser so your logins stay intact',
      'Cleaner game lists - Games without developer or publisher (e.g. FiveM) are no longer shown in Browse or Library',
      'Library view - Heart and Library badge are hidden in Library view (use menu or right-click to remove)',
      'Performance - Fewer unnecessary re-renders on game cards for smoother scrolling',
    ],
  },
  '1.0.13': {
    title: "What's New in Ark 1.0.13",
    changes: [
      'Export your library - Save all your games to a file for backup',
      'Import library - Restore your games from a backup file (only adds new games or updates changed ones)',
      'Clear library - Remove all games at once with a single click in Library view',
      'Better game images - More fallback options when game covers are not available',
      'Search bar clears when switching to Library view',
    ],
  },
  '1.0.12': {
    title: "What's New in Ark 1.0.12",
    changes: [
      'Fixed game card navigation in production builds',
      'Switched to hash-based routing for Electron compatibility',
      'Navigation now works correctly in installed app',
    ],
  },
  '1.0.11': {
    title: "What's New in Ark 1.0.11",
    changes: [
      'Fixed auto-update snackbar - now performs manual check on startup with full logging',
      'Fixed game card clicks - cards now navigate to details page correctly',
      'Fixed library view - now shows all games in your library, not just top 100',
    ],
  },
  '1.0.10': {
    title: "What's New in Ark 1.0.10",
    changes: [
      'Test release to verify auto-update functionality',
      'If you see this changelog, the auto-update worked!',
    ],
  },
  '1.0.9': {
    title: "What's New in Ark 1.0.9",
    changes: [
      'Fixed auto-update notifications - update snackbar now appears when new versions are available',
      'Added updater API to the preload script for proper IPC communication',
      'Improved update detection and download progress tracking',
    ],
  },
  '1.0.8': {
    title: "What's New in Ark 1.0.8",
    changes: [
      'Renamed application branding from "Game Tracker" to "Ark" throughout the app',
      'Added version display in the navbar',
      'Improved loading screen with updated branding',
      'Added this changelog modal to show updates after each release',
      'Fixed various bugs and improved stability',
    ],
  },
  '1.0.7': {
    title: "What's New in Ark 1.0.7",
    changes: [
      'Added version number display next to app title',
      'Improved auto-update functionality',
    ],
  },
  '1.0.6': {
    title: "What's New in Ark 1.0.6",
    changes: [
      'Added custom app icon with gamepad design',
      'Fixed node-fetch module error in packaged builds',
      'Improved build process with clean step',
      'Updated installer branding to "Ark"',
    ],
  },
};

const STORAGE_KEY = 'ark_last_seen_version';

export function ChangelogModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogData, setChangelogData] = useState<{ title: string; changes: string[] } | null>(null);

  useEffect(() => {
    // Check if we should show the changelog
    try {
      const lastSeenVersion = localStorage.getItem(STORAGE_KEY);
      if (lastSeenVersion !== APP_VERSION && CHANGELOG[APP_VERSION]) {
        setChangelogData(CHANGELOG[APP_VERSION]);
        setIsOpen(true);
      }
    } catch {
      // localStorage may be unavailable (private browsing, storage full, etc.)
    }
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const handleClose = () => {
    try { localStorage.setItem(STORAGE_KEY, APP_VERSION); } catch { /* ignore */ }
    setIsOpen(false);
  };

  if (!isOpen || !changelogData) {
    return null;
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm"
            onClick={handleClose}
          />
          
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="fixed inset-0 z-[201] flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="bg-gradient-to-b from-gray-900 to-gray-950 border border-white/10 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] pointer-events-auto overflow-hidden flex flex-col">
              {/* Header with gradient — pinned */}
              <div className="flex-shrink-0 bg-gradient-to-r from-fuchsia-500/20 to-purple-500/20 px-6 py-4 border-b border-white/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-gradient-to-br from-fuchsia-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-fuchsia-500/30">
                      <Gift className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-white">{changelogData.title}</h2>
                      <p className="text-xs text-white/50">Version {APP_VERSION}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleClose}
                    className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                    aria-label="Close changelog"
                  >
                    <X className="h-5 w-5 text-white/60" />
                  </button>
                </div>
              </div>

              {/* Content — scrollable */}
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                <ul className="space-y-3">
                  {changelogData.changes.map((change, index) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="flex items-start gap-3 text-sm text-white/80"
                    >
                      <Sparkles className="h-4 w-4 text-fuchsia-400 mt-0.5 flex-shrink-0" />
                      <span>{change}</span>
                    </motion.li>
                  ))}
                </ul>
              </div>

              {/* Footer — pinned */}
              <div className="flex-shrink-0 px-6 py-4 border-t border-white/10 bg-white/5">
                <Button
                  onClick={handleClose}
                  className="w-full bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700 text-white font-medium"
                >
                  Got it, let's go!
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
