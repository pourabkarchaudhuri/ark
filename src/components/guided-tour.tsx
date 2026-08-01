import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import Joyride, { CallBackProps, STATUS, ACTIONS, EVENTS, Step, TooltipRenderProps } from 'react-joyride';
import {
  Sparkles,
  ChevronRight,
  ChevronLeft,
  X,
  Rocket,
  Compass,
  ScanSearch,
  Library,
  Calendar,
  Route,
  Radio,
  Search,
  Orbit,
  SlidersHorizontal,
  Settings,
  Gamepad2,
  Newspaper,
  Crosshair,
  Workflow,
  ScrollText,
  Filter,
  PlusCircle,
  Trophy,
  type LucideProps,
} from 'lucide-react';

/** Persists per-tour completion. Legacy `ark-tour-completed` maps to `overview` / `welcome`. */
export const LEGACY_TOUR_COMPLETED_KEY = 'ark-tour-completed';

export type TourId =
  | 'welcome'
  | 'browse'
  | 'library'
  /** @deprecated Use `welcome`; kept so old keys / URLs still resolve. */
  | 'overview'
  | 'journey'
  | 'buzz'
  | 'calendar'
  | 'oracle'
  | 'ann-graph'
  | 'data-flow'
  | 'devlog'
  | 'settings'
  | 'game-details';

export function tourStorageKey(tourId: TourId): string {
  return `ark-tour-completed-${tourId}`;
}

export function migrateLegacyTourCompletion(): void {
  if (typeof localStorage === 'undefined') return;
  const legacy = localStorage.getItem(LEGACY_TOUR_COMPLETED_KEY);
  if (legacy === 'true' && localStorage.getItem(tourStorageKey('overview')) !== 'true') {
    localStorage.setItem(tourStorageKey('overview'), 'true');
  }
  // First-run welcome tour: treat completed legacy "overview" as done for welcome too
  if (localStorage.getItem(tourStorageKey('overview')) === 'true' && localStorage.getItem(tourStorageKey('welcome')) !== 'true') {
    localStorage.setItem(tourStorageKey('welcome'), 'true');
  }
}

export function isTourCompleted(tourId: TourId): boolean {
  if (typeof localStorage === 'undefined') return false;
  migrateLegacyTourCompletion();
  return localStorage.getItem(tourStorageKey(tourId)) === 'true';
}

/** Map dashboard view mode to the tour shown when the user taps the help button. */
export type DashboardViewForTour =
  | 'browse'
  | 'library'
  | 'journey'
  | 'buzz'
  | 'calendar'
  | 'oracle'
  | 'ann-graph'
  | 'data-flow'
  | 'devlog'
  | 'settings';

export function viewModeToTourId(view: DashboardViewForTour): TourId {
  switch (view) {
    case 'browse':
      return 'browse';
    case 'library':
      return 'library';
    case 'journey':
      return 'journey';
    case 'buzz':
      return 'buzz';
    case 'calendar':
      return 'calendar';
    case 'oracle':
      return 'oracle';
    case 'ann-graph':
      return 'ann-graph';
    case 'data-flow':
      return 'data-flow';
    case 'devlog':
      return 'devlog';
    case 'settings':
      return 'settings';
    default:
      return 'welcome';
  }
}

const STEP_ICONS: Record<string, FC<LucideProps>> = {
  'Welcome to Ark': Rocket,
  'Your command strip': Compass,
  'Discover the catalog': ScanSearch,
  'Your collection': Library,
  'Find anything': Search,
  'Refine and configure': SlidersHorizontal,
  'Go deeper': Sparkles,
  'Navigation Bar': Compass,
  'Browse Games': ScanSearch,
  'Oracle Recommendations': Sparkles,
  'Release Calendar': Calendar,
  'Voyage Timeline': Route,
  'Transmissions': Radio,
  'Search': Search,
  'Embedding Space': Orbit,
  'Filters & Sorting': SlidersHorizontal,
  'Settings': Settings,
  "You're Ready!": Gamepad2,
  "Captain's Log & timeline": Route,
  'Signal stream': Newspaper,
  'Scheduled broadcasts': Radio,
  'Release radar': Calendar,
  'Calendar feed': Crosshair,
  'The Oracle': Sparkles,
  'Refresh recommendations': Sparkles,
  'Galaxy map': Orbit,
  'Find a game': Search,
  'Preferences': Settings,
  'Settings areas': Settings,
  'Construction log': ScrollText,
  'Data pipeline': Workflow,
  'Live systems map': Workflow,
  'Game details': Gamepad2,
  'Back to the Ark': Compass,
  'Media & details': Gamepad2,
  'Browse the catalog': ScanSearch,
  'Your library shelf': Library,
  'Quick status filters': Filter,
  'Add custom games': PlusCircle,
  'Medals & milestones': Trophy,
};

/** Render inline markdown: **bold** and *italic*. Returns React nodes. */
function renderInlineMarkdown(text: React.ReactNode): React.ReactNode {
  if (typeof text !== 'string') return text;
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1]) {
      parts.push(<strong key={key++} style={{ color: '#e4e4e7', fontWeight: 600 }}>{match[1]}</strong>);
    } else if (match[2]) {
      parts.push(<em key={key++}>{match[2]}</em>);
    }
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

function TourTooltip({
  continuous,
  index,
  step,
  size,
  backProps,
  closeProps,
  primaryProps,
  skipProps,
  isLastStep,
  tooltipProps,
}: TooltipRenderProps) {
  const progress = ((index + 1) / size) * 100;
  const Icon = STEP_ICONS[step.title as string] || Sparkles;

  return (
    <div
      {...tooltipProps}
      className="no-drag"
      style={{
        maxWidth: 380,
        minWidth: 300,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(24,24,27,0.97) 0%, rgba(9,9,11,0.98) 100%)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(217,70,239,0.25)',
          borderRadius: 16,
          boxShadow: '0 0 30px rgba(217,70,239,0.15), 0 0 60px rgba(217,70,239,0.05), 0 25px 50px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          position: 'relative' as const,
        }}
      >
        <div
          style={{
            height: 2,
            background: 'linear-gradient(90deg, #d946ef, #a855f7, #6366f1, #22d3ee)',
            opacity: 0.8,
          }}
        />

        <div style={{ height: 2, background: 'rgba(255,255,255,0.05)' }}>
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #d946ef, #a855f7)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        <div style={{ padding: '20px 22px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon size={18} color="#ffffff" strokeWidth={1.5} />
              <h3
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#fafafa',
                  letterSpacing: '0.01em',
                  margin: 0,
                }}
              >
                {step.title}
              </h3>
            </div>
            <button
              {...closeProps}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.4)',
                transition: 'all 0.2s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.15)';
                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)';
                e.currentTarget.style.color = '#ef4444';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
              }}
            >
              <X size={14} />
            </button>
          </div>

          <p
            style={{
              fontSize: 12.5,
              lineHeight: 1.65,
              color: 'rgba(161,161,170,0.9)',
              margin: '0 0 18px',
              fontWeight: 400,
            }}
          >
            {renderInlineMarkdown(step.content)}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              {...skipProps}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(113,113,122,0.8)',
                fontSize: 11,
                cursor: 'pointer',
                padding: '4px 0',
                fontFamily: "'JetBrains Mono', monospace",
                transition: 'color 0.2s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#a1a1aa'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(113,113,122,0.8)'; }}
            >
              Skip tour
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  fontSize: 11,
                  color: 'rgba(161,161,170,0.5)',
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {index + 1}/{size}
              </span>

              {index > 0 && (
                <button
                  {...backProps}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    height: 32,
                    width: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    color: 'rgba(255,255,255,0.5)',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.currentTarget.style.color = 'rgba(255,255,255,0.5)';
                  }}
                >
                  <ChevronLeft size={16} />
                </button>
              )}

              {continuous && (
                <button
                  {...primaryProps}
                  style={{
                    background: isLastStep
                      ? 'linear-gradient(135deg, #d946ef, #a855f7)'
                      : 'linear-gradient(135deg, #d946ef, #c026d3)',
                    border: 'none',
                    borderRadius: 8,
                    height: 32,
                    padding: '0 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                    transition: 'all 0.2s',
                    boxShadow: '0 0 16px rgba(217,70,239,0.3)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 0 24px rgba(217,70,239,0.5)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = '0 0 16px rgba(217,70,239,0.3)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  {isLastStep ? (
                    <>
                      <Sparkles size={13} />
                      <span>Finish</span>
                    </>
                  ) : (
                    <>
                      <span>Next</span>
                      <ChevronRight size={14} />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** First-run onboarding: orientation only. Deeper behaviour lives in browse / library / per-tab tours. */
const welcomeSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content:
      'Welcome to Ark — a single place to browse the catalog, curate your library, follow releases, read news, and see how your taste evolves over time.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Welcome to Ark',
  },
  {
    target: '[data-tour="view-toggle"]',
    content:
      'Use this strip to switch the whole app. **Browse** and **Library** show game grids; **Oracle**, **Upcoming**, **Voyage**, and **Transmissions** open focused tools — each has its own ? tour when you are there.',
    placement: 'bottom',
    title: 'Your command strip',
  },
  {
    target: '[data-tour="browse-button"]',
    content:
      '**Browse** searches Steam’s catalog: trending lists, free picks, new releases, and a full A–Z index. Open a card for trailers, prices, and one-click add to your library.',
    placement: 'bottom',
    title: 'Discover the catalog',
  },
  {
    target: '[data-tour="library-button"]',
    content:
      '**Library** is your shelf — Playing, backlog, completed, ratings, hours, notes, and games you added manually. Everything here syncs with Voyage and the Oracle.',
    placement: 'bottom',
    title: 'Your collection',
  },
  {
    target: '[data-tour="search-input"]',
    content:
      'Search follows you: in Browse it queries the catalog with live suggestions; in Library it filters your shelf. Try it after this tour.',
    placement: 'bottom',
    title: 'Find anything',
  },
  {
    target: '[data-tour="filter-trigger"]',
    content:
      'Filters narrow by genre, platform, store, year, and more — different presets in Browse vs Library. Pair them with search for precise lists.',
    placement: 'left',
    title: 'Refine and configure',
  },
  {
    target: '[data-tour="settings-button"]',
    content:
      'Settings cover AI providers (Ollama, cloud keys), data import/export, adult-content rules, startup behaviour, and Year in Review.',
    placement: 'left',
    title: 'Settings',
  },
  {
    target: '[data-tour="app-logo"]',
    content:
      'You are oriented. Switch to **Browse** or **Library** and tap **?** again for a full walkthrough of that mode — Oracle, Voyage, Transmissions, and Upcoming each have their own tour too.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Go deeper',
  },
];

/** Browse mode: discovery, catalog controls, galaxy entry, grid behaviour. */
const browseSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content:
      'This is **Browse** — explore Steam’s catalog without leaving Ark. Use categories, search, and filters together to narrow from hundreds of thousands of games to a short list.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Browse the catalog',
  },
  {
    target: '[data-tour="browse-button"]',
    content: 'You are in the right tab. Switch to Library anytime to see only games you track.',
    placement: 'bottom',
    title: 'Browse Games',
  },
  {
    target: '[data-tour="browse-toolbar"]',
    content:
      'The count and category label reflect your current preset — trending, most played, new releases, free games, or the full **Catalog** with A–Z jumps when that mode is active.',
    placement: 'bottom',
    title: 'Browse the catalog',
  },
  {
    target: '[data-tour="search-input"]',
    content:
      'Type to search the catalog; suggestions open as you go. Pick a row to jump straight to that game’s detail page.',
    placement: 'bottom',
    title: 'Search',
  },
  {
    target: '[data-tour="filter-trigger"]',
    content:
      'Open the panel for sort order, genres, platforms, store, release year, and category chips. Reset clears everything so you can start fresh.',
    placement: 'left',
    title: 'Filters & Sorting',
  },
  {
    target: '[data-tour="embedding-space"]',
    content:
      '**Embedding Space** builds a 3D galaxy from game similarity (needs Ollama). Fly between neighbours, inspect paths, and see how titles cluster by taste.',
    placement: 'bottom',
    title: 'Embedding Space',
  },
  {
    target: '[data-tour="game-grid"]',
    content:
      'Each card opens full details on click. Use the heart to add to your library. Switch to **Catalog** for A–Z letter jumps, or scroll to load more from trending and curated feeds.',
    placement: 'top',
    title: 'Browse Games',
  },
];

/** Library mode: shelf management, custom games, status chips, voyage link. */
const librarySteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content:
      '**Library** is your personal shelf — everything you have committed to track, including non-Steam games you add by hand.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Your library shelf',
  },
  {
    target: '[data-tour="library-button"]',
    content: 'Stay on this tab to manage status, hours, and ratings; Browse is for discovering new titles.',
    placement: 'bottom',
    title: 'Your Library',
  },
  {
    target: '[data-tour="library-add-custom"]',
    content:
      'Add DRM-free, console, or emulated titles that are not on Steam — they behave like any other library game for sessions and Voyage.',
    placement: 'bottom',
    title: 'Add custom games',
  },
  {
    target: '[data-tour="search-input"]',
    content:
      'Search narrows **your** games by title — pair it with the status chips and filters for fast triage.',
    placement: 'bottom',
    title: 'Search',
  },
  {
    target: '[data-tour="library-status-chips"]',
    content:
      'Tap a chip to filter by play state — combine with the filter panel for genre, platform, priority, and sort.',
    placement: 'bottom',
    title: 'Quick status filters',
  },
  {
    target: '[data-tour="filter-trigger"]',
    content:
      'Same panel as Browse, but tuned for ownership: priority, library-only sorts, and genre filters on games you already have.',
    placement: 'left',
    title: 'Filters & Sorting',
  },
  {
    target: '[data-tour="journey-button"]',
    content:
      '**Voyage** keeps a historical timeline even if you remove a game from the library — open it to see Captain’s Log, Scenes, Audit, and medals.',
    placement: 'bottom',
    title: 'Voyage Timeline',
  },
  {
    target: '[data-tour="game-grid"]',
    content:
      'Cards reflect live session status when you are playing. Click through to edit progress, notes, and store links.',
    placement: 'top',
    title: 'Your Library',
  },
];

const journeySteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content:
      'Voyage is your persistent gaming history — Ark, Captain’s Log, Scenes, Audit, and Medals — even after you remove a game from the library.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Voyage Timeline',
  },
  {
    target: '[data-tour="journey-button"]',
    content: 'Switch to Voyage from here anytime; it sits beside Browse, Library, Oracle, and Transmissions.',
    placement: 'bottom',
    title: 'Voyage Timeline',
  },
  {
    target: '[data-tour="journey-view-styles"]',
    content:
      '**Your Ark** showcases active play; **Log** is the yearly timeline; **Scenes** replays your play episodes; **Audit** checks how complete and accurate your records are. Open **Medals** for Taste DNA, badge vault, and streak analytics.',
    placement: 'bottom',
    title: "Captain's Log & timeline",
  },
  {
    target: '[data-tour="journey-medals-tab"]',
    content:
      'Medals turns your real play history into progression: badges, heatmaps, and taste insights — separate from the timeline views.',
    placement: 'bottom',
    title: 'Medals & milestones',
  },
  {
    target: '[data-tour="journey-main"]',
    content:
      'Scroll years and months, open cards for details, and follow hours and status. Removed games stay visible with a badge so history is never lost.',
    placement: 'top',
    title: "Captain's Log & timeline",
  },
];

const buzzSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'Transmissions aggregates news and RSS signals so you can read them inside the Ark.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Transmissions',
  },
  {
    target: '[data-tour="buzz-button"]',
    content: 'Use this tab whenever you want headlines without opening a browser.',
    placement: 'bottom',
    title: 'Transmissions',
  },
  {
    target: '[data-tour="buzz-refresh"]',
    content: 'Pull the latest articles and refresh scheduled broadcast data on demand.',
    placement: 'left',
    title: 'Signal stream',
  },
  {
    target: '[data-tour="buzz-broadcasts"]',
    content: 'Live and upcoming events appear here — click a card to filter the stream by that event.',
    placement: 'bottom',
    title: 'Scheduled broadcasts',
  },
  {
    target: '[data-tour="buzz-stream"]',
    content: 'Pick a transmission to open the Decode Bay reader beside the stream. Resize the split or focus the reader full screen.',
    placement: 'top',
    title: 'Signal stream',
  },
];

const calendarSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'The release calendar merges Steam and Epic upcoming data with filters tailored for planning what to play next.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Release Calendar',
  },
  {
    target: '[data-tour="calendar-button"]',
    content: 'Upcoming lives next to Voyage — one click from the main navigation.',
    placement: 'bottom',
    title: 'Release Calendar',
  },
  {
    target: '[data-tour="calendar-header"]',
    content: 'Move between Year, Month, and Week, jump with arrows, snap back to Today, and open the TBA sidebar when you need undated titles.',
    placement: 'bottom',
    title: 'Release radar',
  },
  {
    target: '[data-tour="calendar-feed"]',
    content: 'Poster cards group by time period. Hover to add to your library or open full game details.',
    placement: 'left',
    title: 'Calendar feed',
  },
];

const oracleSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'The Oracle runs a deep recommendation pipeline on your library and catalog embeddings.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'The Oracle',
  },
  {
    target: '[data-tour="oracle-button"]',
    content: 'Return here after browsing — recommendations improve as your library grows.',
    placement: 'bottom',
    title: 'The Oracle',
  },
  {
    target: '[data-tour="oracle-view-root"]',
    content:
      'Watch the engine compute, then explore hero picks, themed shelves, Taste DNA, and per-game reasons. When results are ready, use Refresh to re-run after big library changes.',
    placement: 'bottom',
    title: 'The Oracle',
  },
];

const annGraphSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'Embedding Space plots tens of thousands of games in 3D from learned embeddings — explore clusters and neighbours.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Galaxy map',
  },
  {
    target: '[data-tour="ann-graph-back"]',
    content: 'When you are done exploring, head back to Oracle or the main dashboard from here.',
    placement: 'bottom',
    title: 'Galaxy map',
  },
  {
    target: '[data-tour="ann-graph-search"]',
    content: 'Search jumps the camera to a game. Select a star to see neighbours, paths, and filters.',
    placement: 'bottom',
    title: 'Find a game',
  },
  {
    target: '[data-tour="ann-graph-canvas"]',
    content: 'Orbit with the mouse, use the side panels for library and genre filters, and follow “Show path” suggestions.',
    placement: 'left',
    title: 'Galaxy map',
  },
];

const settingsSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'Settings cover integrations, AI providers, feature toggles, and data export.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Preferences',
  },
  {
    target: '[data-tour="settings-button"]',
    content: 'This gear opens the full-screen settings workspace you are in now.',
    placement: 'left',
    title: 'Settings',
  },
  {
    target: '[data-tour="settings-sidebar"]',
    content: 'Switch between General, AI Models, Guide, Features, and About — each tab groups related controls.',
    placement: 'right',
    title: 'Settings areas',
  },
  {
    target: '[data-tour="settings-content"]',
    content: 'Scroll the pane to configure Ollama, API keys, rerank options, adult content, import/export, and more.',
    placement: 'left',
    title: 'Preferences',
  },
];

const devlogSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'The construction log is a developer journal shipped with dev builds — daily entries and file touches.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Construction log',
  },
  {
    target: '[data-tour="devlog-header"]',
    content: 'Back returns to Browse. Reload pulls the latest journal from disk.',
    placement: 'bottom',
    title: 'Construction log',
  },
  {
    target: '[data-tour="devlog-timeline"]',
    content: 'Expand days to read narrative, tags, and milestones from the project journal.',
    placement: 'top',
    title: 'Construction log',
  },
];

const dataFlowSteps: Step[] = [
  {
    target: '[data-tour="app-logo"]',
    content: 'Data Flow visualises live status across sources, caches, AI, and UI surfaces.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Data pipeline',
  },
  {
    target: '[data-tour="dataflow-back"]',
    content: 'Exit back to the dashboard when you are finished inspecting the graph.',
    placement: 'bottom',
    title: 'Data pipeline',
  },
  {
    target: '[data-tour="dataflow-panel"]',
    content: 'Nodes light up as subsystems run — use it to see what is syncing, embedding, or idle.',
    placement: 'bottom',
    title: 'Live systems map',
  },
];

const gameDetailsSteps: Step[] = [
  {
    target: '[data-tour="game-details-back"]',
    content: 'Return to the dashboard; your last view mode is restored from session memory.',
    placement: 'bottom',
    disableBeacon: true,
    title: 'Back to the Ark',
  },
  {
    target: '[data-tour="game-details-hero"]',
    content: 'Hero art, title, and store badges sit up top. Scroll down for trailers, screenshots, and long-form description.',
    placement: 'bottom',
    title: 'Game details',
  },
  {
    target: '[data-tour="game-details-main"]',
    content:
      'Use tabs when present for My Progress, add or edit library entries from the side column, and open store pages from links.',
    placement: 'top',
    title: 'Media & details',
  },
];

const TOUR_STEPS: Record<TourId, Step[]> = {
  welcome: welcomeSteps,
  browse: browseSteps,
  library: librarySteps,
  /** @deprecated Alias for `welcome` — same steps. */
  overview: welcomeSteps,
  journey: journeySteps,
  buzz: buzzSteps,
  calendar: calendarSteps,
  oracle: oracleSteps,
  'ann-graph': annGraphSteps,
  'data-flow': dataFlowSteps,
  devlog: devlogSteps,
  settings: settingsSteps,
  'game-details': gameDetailsSteps,
};

export function getTourSteps(tourId: TourId): Step[] {
  return TOUR_STEPS[tourId] ?? welcomeSteps;
}

interface GuidedTourProps {
  run: boolean;
  tourKey: number;
  tourId: TourId;
  steps: Step[];
  onFinish: () => void;
}

/**
 * Remove orphaned Joyride portal containers that React/Joyride didn't clean up.
 *
 * Only targets **direct children of document.body** — never descendants inside
 * portal containers. React's portal cleanup calls removeChild on children
 * internally; if we remove those children first, React crashes with
 * "The node to be removed is not a child of this node."
 *
 * Runs after a double-rAF + setTimeout to ensure React's full commit and
 * Joyride's componentWillUnmount have both completed.
 */
export function removeJoyrideLeftovers() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          for (const el of Array.from(document.body.children)) {
            const id = el.id || '';
            const cls = el.className || '';
            if (
              id.startsWith('react-joyride') ||
              (typeof cls === 'string' && (cls.includes('react-joyride') || cls.includes('__floater')))
            ) {
              try { el.remove(); } catch { /* already gone */ }
            }
          }
        } catch { /* safe */ }
      }, 0);
    });
  });
}

/**
 * Keep only steps whose CSS selector matches at least one mounted element.
 * Prevents Joyride from hitting TARGET_NOT_FOUND for missing conditional UI.
 */
export function resolveStepsWithExistingTargets(steps: Step[]): Step[] {
  return steps.filter((step) => {
    const raw = step.target;
    if (typeof raw !== 'string') return false;
    try {
      return document.querySelector(raw) !== null;
    } catch {
      return false;
    }
  });
}

/**
 * After switching dashboard view (often via startTransition), tour targets may not exist yet.
 * Poll until every step target is in the DOM or `timeoutMs` elapses — then GuidedTour’s own
 * retries still filter if something is still missing.
 */
export async function waitForTourDomReady(
  tourId: TourId,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  if (typeof document === 'undefined') return;
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const intervalMs = options?.intervalMs ?? 50;
  const full = getTourSteps(tourId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resolved = resolveStepsWithExistingTargets(full);
    if (resolved.length === full.length) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function GuidedTour({ run, tourKey, tourId, steps, onFinish }: GuidedTourProps) {
  const finishedRef = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const [effectiveSteps, setEffectiveSteps] = useState<Step[] | null>(null);

  const endTour = useCallback(
    (opts?: { persistCompletion?: boolean }) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      clearTimeout(safetyTimerRef.current);
      if (opts?.persistCompletion !== false) {
        try {
          localStorage.setItem(tourStorageKey(tourId), 'true');
        } catch {
          /* ignore */
        }
      }
      setEffectiveSteps(null);
      removeJoyrideLeftovers();
      onFinish();
    },
    [onFinish, tourId],
  );
  const endTourRef = useRef(endTour);
  endTourRef.current = endTour;

  /** Parent set `run={false}` (stopTour, route change) — clear state and schedule orphan cleanup. */
  useEffect(() => {
    if (run) return;
    clearTimeout(safetyTimerRef.current);
    finishedRef.current = false;
    setEffectiveSteps(null);
    removeJoyrideLeftovers();
  }, [run]);

  /** After paint + retries (handles lazy Suspense views), only mount Joyride with steps in the DOM. */
  useEffect(() => {
    if (!run) {
      return;
    }
    finishedRef.current = false;
    setEffectiveSteps(null);
    let cancelled = false;
    const timers: number[] = [];

    /** Extra tail delays for lazy-loaded views (Suspense chunks). */
    const RETRY_DELAYS = [0, 80, 200, 450, 800, 1400, 2400, 3800];

    const attempt = (idx: number) => {
      if (cancelled) return;
      const resolved = resolveStepsWithExistingTargets(stepsRef.current);
      if (cancelled) return;
      if (resolved.length > 0) {
        setEffectiveSteps(resolved);
        return;
      }
      if (idx + 1 < RETRY_DELAYS.length) {
        const t = window.setTimeout(() => attempt(idx + 1), RETRY_DELAYS[idx + 1]);
        timers.push(t);
      } else {
        endTourRef.current({ persistCompletion: false });
      }
    };

    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const t0 = window.setTimeout(() => attempt(0), RETRY_DELAYS[0]);
        timers.push(t0);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      timers.forEach(clearTimeout);
    };
  }, [run, tourKey]);

  useEffect(() => {
    if (!run || !effectiveSteps?.length) return;
    clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      if (!finishedRef.current) endTour({ persistCompletion: true });
    }, 5 * 60 * 1000);
    return () => clearTimeout(safetyTimerRef.current);
  }, [run, tourKey, effectiveSteps, endTour]);

  useEffect(() => {
    return () => {
      removeJoyrideLeftovers();
    };
  }, []);

  /** Escape always exits and clears dimming (same as force-dismiss). */
  useEffect(() => {
    if (!run || !effectiveSteps?.length) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      endTour({ persistCompletion: false });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run, effectiveSteps, endTour]);

  const handleCallback = useCallback(
    (data: CallBackProps) => {
      const { status, action, type } = data;

      if (status === STATUS.ERROR || type === EVENTS.ERROR) {
        endTour({ persistCompletion: false });
        return;
      }

      if (type === EVENTS.TARGET_NOT_FOUND) {
        endTour({ persistCompletion: false });
        return;
      }

      if (type === EVENTS.TOUR_END) {
        endTour({ persistCompletion: status === STATUS.FINISHED || status === STATUS.SKIPPED });
        return;
      }

      // X button on a non-last step fires STEP_AFTER with action=CLOSE but no TOUR_END.
      // Skip button triggers SKIPPED status → TOUR_END above will handle it, but the
      // STEP_AFTER may arrive first with the new status.
      if (type === EVENTS.STEP_AFTER) {
        if (action === ACTIONS.CLOSE) {
          endTour({ persistCompletion: true });
          return;
        }
        if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
          endTour({ persistCompletion: true });
          return;
        }
      }
    },
    [endTour],
  );

  if (!run || !effectiveSteps?.length) return null;

  return (
    <Joyride
      key={tourKey}
      steps={effectiveSteps}
      run
      continuous
      showSkipButton
      showProgress
      disableOverlayClose
      disableScrolling
      tooltipComponent={TourTooltip}
      callback={handleCallback}
      spotlightPadding={6}
      styles={{
        options: {
          zIndex: 10000,
          overlayColor: 'rgba(0, 0, 0, 0.75)',
        },
        spotlight: {
          borderRadius: 12,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.75)',
        },
      }}
      floaterProps={{
        styles: {
          arrow: {
            length: 8,
            spread: 14,
          },
          floater: {
            filter: 'none',
          },
        },
      }}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Finish',
        next: 'Next',
        skip: 'Skip tour',
      }}
    />
  );
}

export function useTourState(options?: { autoStartOverview?: boolean }) {
  const autoStartOverview = options?.autoStartOverview !== false;

  const [tourRunning, setTourRunning] = useState(false);
  const [tourKey, setTourKey] = useState(0);
  const [activeTourId, setActiveTourId] = useState<TourId>('welcome');

  useEffect(() => {
    if (!autoStartOverview) return;
    migrateLegacyTourCompletion();
    if (!isTourCompleted('welcome')) {
      const timer = setTimeout(() => {
        setActiveTourId('welcome');
        setTourRunning(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [autoStartOverview]);

  const startTour = useCallback((id: TourId = 'welcome') => {
    setActiveTourId(id);
    setTourKey((k) => k + 1);
    setTourRunning(true);
  }, []);

  const stopTour = useCallback(() => setTourRunning(false), []);

  return { tourRunning, tourKey, activeTourId, startTour, stopTour };
}
