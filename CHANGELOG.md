# Changelog

All notable changes to Ark (Game Tracker) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.20] - 2026-02-08

### Added
- **Advanced Analytics Dashboard** – Fully redesigned Analytics tab with 10 rows of animated, interactive visualisations built with custom SVG and Framer Motion:
  - **Play Schedule Heatmap** – GitHub-contributions-style 7×24 grid (day-of-week × hour) showing when you play, replacing the simpler day-of-week bar chart.
  - **Streak Tracking** – Current and longest play-streak computed from session history, displayed as a flame/trophy accent row below key metrics.
  - **Session Length Distribution** – Histogram with 6 duration buckets (<15 m to 4 h+) embedded inside the Session Insights card.
  - **Priority Breakdown** – Donut chart of High/Medium/Low priority games with per-priority completion rates.
  - **Recommendation Source** – Horizontal bar chart showing where your games come from, with average rating per source.
  - **Release Year Distribution** – Full-width histogram of games by release year (auto-groups by decade when >15 years).
  - **SVG Tooltips** – Native `<title>` tooltips on donut segments, radar dots, heatmap cells, and area-chart data points for exact values on hover.
- **Radar & Spider Charts** – Gaming Profile (6-axis: Dedication, Variety, Commitment, Speed, Consistency, Quality) and Genre Radar with animated polygon fill.
- **Animated Chart Components** – Count-up numbers, draw-on sparklines, sweep-in donut rings, radial gauges, completion funnel, and staggered card entry animations.
- **Gantt Chart Redesign** – Interactive timeline bars with status-colored segments, session overlays, and improved scrolling.
- **Buzz News View** – Aggregated gaming news carousel on the dashboard with source labels, thumbnails, and dark-gradient overlays.
- **Dark Veil UI Component** – Reusable glassmorphic overlay component.

### Changed
- **Library data in Analytics** – `libraryEntries` prop plumbed from `libraryStore` through `journey-view.tsx` into the analytics view, unlocking priority and recommendation-source fields.

### Fixed
- **Battlefield 6 cover image** – Hardcoded local cover for Battlefield 6 / Battlefield™ 6 across all views (game card, journey timeline, analytics, Gantt, detail panel) since API-provided images were broken.
- **Framer Motion test mocks** – Proxy-based `motion` mock handles all SVG tags; added `useMotionValue`, `useInView`, and `animate` mocks so all 214 tests pass.

---

## [1.0.19] - 2026-02-07

### Added
- **Session time tracking** – Automatic tracking via executable process polling (any app, not Steam-specific).
- **Idle detection** – Electron powerMonitor integration (5-min threshold, subtracted from session duration).
- **"Playing Now" status** – Live badge with pulse animation when a game's exe is running.
- **Native file picker** – Browse button for selecting game executables.
- **Cost-per-hour badge** – Shown on game details (green <$1, yellow $1–5, red >$5).
- **SessionStore** – Persistent session history with import/export support.
- **useSessionTracker hook** – Renderer-side session event handling.

### Changed
- Replaced "Dropped" status with "On Hold" (auto-migration on startup).
- Added "Playing Now" as system-managed transient status.

---

## [1.0.18] - 2026-02-07

### Removed
- **Auto-detection of installed Steam games** – Removed `installed-games.ts`, `useInstalledGames` hook, related IPC handlers, preload bridge, types, and dashboard auto-add logic. Simplifies codebase; manual library management only.

---

## [1.0.17] - 2026-02-07

### Added
- **Steam News carousel** – Auto-scrolling news cards on the game details page with thumbnails, source labels, dark-gradient overlay, lazy loading, and pause-on-hover.
- **Steam Recommendations** – Content-based "Recommended by Steam" section per game.
- **Journey View** – Persistent gaming timeline that survives library removal, grouped by year.
- **AI web search grounding** – Ollama chat uses DuckDuckGo for real-time answers.
- **Live player counts** – Displayed on dashboard, game details, and journey cards.
- **Status change history** – Persisted per-game state transitions for analytics.
- **"In Library" badge** – Shown on journey cards for games still in the library.

### Changed
- Image fallback overhaul: multi-step deduplicated chains with placeholder detection.
- My Progress skeleton loader eliminates flicker.
- Performance audit: reduced re-renders via batch state updates, stable deps, memo comparators.

### Infrastructure
- Test files reorganised into `src/test/` with consistent folder structure.
- Import/export includes journey and status history.
- Vite dev proxy for Steam News API (CORS bypass).
- Custom DuckDuckGo HTML scraper replacing rate-limited npm package.

---

## [1.0.15] - 2025-02-05

### Fixed
- **Electron main process** – Define `__dirname` from `import.meta.url` in ESM so the app starts when run as a module (fixes crash and "window never opens" in tests and packaged app).
- **Electron e2e tests** – Longer timeouts for launch/firstWindow; dismiss changelog before clicking Library/Settings; use role-based locators for Browse/Library tabs so all 21 tests pass.

---

## [1.0.14] - 2025-02-05

### Added
- **INR pricing** – Game details and Steam data now show Indian Rupee (₹) from the Steam API (`cc=in`).
- **External links in default browser** – Steam store, Metacritic, FitGirl, and in-page links (description, requirements, languages) open in your default OS browser so your logins stay intact (`shell.openExternal`).

### Changed
- **Cleaner game lists** – Games without developer or publisher (e.g. FiveM) are no longer shown in Browse or Library; `hasValidDeveloperInfo` filters them out in Steam service and library games.
- **Library view** – Heart and Library badge are hidden in Library view; use the ellipsis menu or right-click to remove games.
- **Performance** – Game cards use a value-based memo comparison so they re-render only when game data or display flags change, reducing unnecessary re-renders during scrolling.

### Fixed
- Removed duplicate `declare global` Window type declarations from dashboard, window-controls, and title-bar so `openExternal` is correctly typed and used.

---

## [1.0.13]

- Export/import library, Clear library, better game images, search bar clears when switching to Library view.

## [1.0.12]

- Fixed game card navigation in production; hash-based routing for Electron.

## [1.0.11]

- Auto-update snackbar, game card clicks, library view shows all games.

## [1.0.10]

- Test release for auto-update.

## [1.0.9]

- Auto-update notifications and preload updater API.

## [1.0.8]

- Renamed to Ark, version in navbar, changelog modal.

## [1.0.7] – 1.0.6

- Version display, auto-update, custom icon, build fixes.
