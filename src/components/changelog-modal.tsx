import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Current app version — injected from package.json at build time by Vite.
// No manual bumps needed; just update package.json.
export const APP_VERSION: string = __APP_VERSION__;

export type ChangelogEntry = { title: string; changes: string[] };

// Changelog entries - add new versions at the top
const CHANGELOG: Record<string, ChangelogEntry> = {
  '1.0.58': {
    title: "What's New in Ark 1.0.58",
    changes: [
      'Phase B.1 multi-vector ANN — Rebuild indexes facet chunk embeddings alongside pooled game vectors; Embedding Space + Similar Games use max-sim neighbor expand (default on).',
      'Kill switch: Settings → Ollama → Chunk ANN max-sim (off = pooled-only queries). Oracle shelves and graph edges stay pooled.',
      'Rebuild ANN progress counts pooled + chunk vectors; What’s New / Rebuild blocks unchanged.',
    ],
  },
  '1.0.57': {
    title: "What's New in Ark 1.0.57",
    changes: [
      'ANN Rebuild fixed — index backfill no longer hangs with TransactionInactiveError; Settings shows real progress and surfaces failures.',
      'Graph build fixed — no more DataCloneError from transferring edge buffers; Oracle/Embedding Space can reach graph-ready again.',
      'Overlay closes when the game exits — HUD HWND is destroyed (no phantom 0:00 timer). Cycle is Shift+Win+D; levels are collapsed + compact only. Click-through still without mouse forward.',
      'Rebuild ANN and What’s New blocks remain in Settings; Timeshear / Cartographer / Monuments stay removed.',
    ],
  },
  '1.0.56': {
    title: "What's New in Ark 1.0.56",
    changes: [
      'Ark Wrapped soft-lock fixed — navigation hit-tests the full overlay (not tiny calendar cells), with always-visible Back / Continue / Done chrome so you can finish without restarting.',
      'Guided tour stuck dimmer fixed — generation-scoped Joyride leftover cleanup, Escape clears orphan portals after Finish, and spotlight no longer paints a full-screen blocker shadow.',
      'Overlay detail levels restored (from the 1.0.53 line) — Ctrl+Shift+D cycles collapsed → compact → expanded and resizes the HUD; Ctrl+Shift+O still dismisses / re-enables. Lazy HWND + no mouse-forward click-through preserved.',
      'Always-visible overlay shortcut hints on compact/expanded (O dismiss · D cycle), with matching Settings copy under In-game overlay.',
      'Embedding Space declutter — Timeshear, Cartographer HUD, and Monuments removed from the galaxy map. Codex stays via C (Curator).',
    ],
  },
  '1.0.55': {
    title: "What's New in Ark 1.0.55",
    changes: [
      'Embedding Space neighbors fixed after Phase A int8 embeddings — pooled vectors decode reliably from IDB (ArrayBuffer / plain-array shapes), so ANN queries no longer return an empty neighbor list (selected game only).',
      'Library embeddings that are already cached now backfill the ANN index when it is empty or not ready (same recovery path as catalog).',
      'Settings → Ollama → Rebuild ANN index — clears the on-disk HNSW index and rebuilds from cached pooled embeddings. Use this after upgrading if neighbors still look empty.',
      'ANN single-vector query can exclude the focus game id (Embedding Space + Similar Games), matching batch-query behavior so self is not the only hit.',
    ],
  },
  '1.0.54': {
    title: "What's New in Ark 1.0.54",
    changes: [
      'Performance hotfix — reduces ~15s hitch / lag while gaming from heavy PowerShell path parsing and sync main-process work on the session poll cadence.',
      'Active sessions: tasklist every 15s; full path snapshots ~every 60s with chunked parse. Metrics/persist and UI notify storms coalesced; system-status heavy polls only while splash/status UI is open.',
    ],
  },
  '1.0.53': {
    title: "What's New in Ark 1.0.53",
    changes: [
      'Ark Wrapped soft-lock fix, live telemetry mid-session, overlay detail levels (Ctrl+Shift+D) + dismiss hotkey, Qwen listing in status/settings, Scenes/Audit polish, and session/embedding polling quieter while playing.',
    ],
  },
  '1.0.52': {
    title: "What's New in Ark 1.0.52",
    changes: [
      'Critical startup fix — 1.0.50 installers shipped a corrupted app package that made Ark exit immediately on open. Reinstall this build (or update to it) to restore a working app; in-app update could not recover from a build that never launched.',
      'Includes the overlay mouse-lag hotfix from 1.0.51 — lazy HUD window (no idle topmost shell), click-through without mouse forwarding, async session polling, leaner HUD (no blur/pulse).',
      'Includes chunked embeddings Phase A from 1.0.50 — facet chunks with int8 pooled vectors, dual-format upgrade, kill switch in Settings → Ollama.',
    ],
  },
  '1.0.51': {
    title: "What's New in Ark 1.0.51",
    changes: [
      'In-game overlay no longer causes mouse lag — click-through without mouse forwarding, lazy create/destroy of the HUD window (no idle topmost shell), and async session process polling so tasklist/PowerShell never blocks the main thread.',
      'Leaner overlay HUD — no backdrop blur or pulsing badge animation; opacity-only fade. Always-on-top and background-throttling off only while the HUD is actually visible.',
      'Overlay hotkey (Ctrl+Shift+O) only shows the HUD when a tracked game session is active and the setting is enabled.',
    ],
  },
  '1.0.50': {
    title: "What's New in Ark 1.0.50",
    changes: [
      'Chunked embeddings (Phase A) — library and catalog rewrites can persist facet chunks (lib:/cat: ids) with int8 pooled game vectors. Existing installs upgrade lazily (dual-format); no forced full re-embed. Kill switch in Settings → Ollama → Facet chunk embeddings.',
      'Embeddings IDB v4 adds chunk-embeddings store. Readers decode int8 or legacy float at the boundary for ANN / reco / galaxy / graph. Failed writes surface errors and do not advance catalog watermarks.',
      'Galaxy cache freshness keys on pooled count + embeddingContentEpoch. Progress reporting stays in game units.',
    ],
  },
  '1.0.49': {
    title: "What's New in Ark 1.0.49",
    changes: [
      'Qwen3 reranker pull fixed — default tag is now dengcao/Qwen3-Reranker-0.6B:Q8_0; legacy qwen3-reranker:0.6b installs auto-migrate on load. Failed pulls surface the real Ollama error. When graded scores are unavailable, Ark tiers down to arctic-embed cosine honestly — status UI reports the resolved tier, not a broken Qwen3 claim.',
      'Oracle Why drawer polish — score breakdown opens expanded by default; scroll-into-view is instant to avoid shelf jank; Taste DNA panel memoized; blast-radius evidence chips when graph metrics are ready; thumbs-up refreshes shelves without closing the drawer.',
      'Voyage Scenes analytics — session-length histogram, weekday×hour rhythm heatmap, play cadence, streak counters, plus Session Analytics and Pacing panels shared with Insights & Telemetry.',
      'Voyage Audit analytics — data-quality dashboard with record-quality trend, status distribution, open-items chart, and aggregate gauges above the existing health rings and rule queue.',
      'In-game overlay HUD (opt-in) — transparent click-through corner badge with live session timer while a game runs; disabled by default, toggle in Settings, Ctrl+Shift+O hotkey. Non-injecting Electron window, zero anti-cheat risk.',
      'Oracle feedback & graph scoring — thumbs-up mined into positive taste profiles; graph resolver prefers cache restore and non-blocking cold builds; new tests for migration, blast-radius, thumbs-up re-rank, and graph scores.',
    ],
  },
  '1.0.48': {
    title: "What's New in Ark 1.0.48",
    changes: [
      'Insights & Telemetry always available — the tab no longer hides behind a session gate; it shows an empty state at zero sessions and live-updates when a session is recorded mid-view via sessionStore subscription.',
      'Game-details hero backgrounds — Steam and Epic pages share the same header-image chain with onError fallthrough, so both stores get consistent 460×215-class art instead of a flat backdrop or a wide page wash.',
      'Tiered Oracle reranker — probes native /api/rerank, then Qwen3 graded logprobs (or binary on older Ollama), then arctic-embed cosine; auto-downloads Qwen3 with its own splash/navbar progress row and honest tier badges.',
      'Broadcast cards streamlined — fixed height, single shell, blurred-fill letterbox backdrop for any aspect ratio, and TransmissionCard-style load/error handling.',
      'Oracle explanation drawer — one right-side drawer (shared Taste DNA chrome) replaces the clipped popovers; scroll-into-view, focus management, and a one-line headline verdict.',
      'Voyage Scenes & Audit — two competing replacements for OCD Mode: episode-clustered Scenes with gap content and log-scaled magnitude, plus record-grading Audit with health rings, rule queue, snooze/dismiss persistence, and inline fixes.',
    ],
  },
  '1.0.47': {
    title: "What's New in Ark 1.0.47",
    changes: [
      'Oracle similar titles are real ANN neighbors — survivors hydrate similar-game titles from embedding neighbors (distance-gated), not Steam recommendation counts. Steam details still fill metacritic / studio / coming-soon only.',
      'Dismiss mutes the franchise live — thumbs-down / Not Interested hides same-franchise and same-developer shelf siblings immediately. Oracle cache fingerprint includes dismiss + playtime buckets so a short cache restore cannot bring muted siblings back.',
      'Franchise aliases — Halo Infinite ↔ Halo, DOOM Eternal ↔ DOOM, Resident Evil Village / biohazard ↔ Resident Evil, Far Cry Primal / numbered ↔ Far Cry (Halo Wars stays its own line).',
      'Hard ANN taste ceiling — only neighbors within cosine distance 0.45 enter the semantic pool; no soft fallback to far matches.',
      'Engagement weights aligned — worker seed weights use the same shared engagement function as retrieve; decay multiplies, it does not re-floor Want-to-Play.',
      'History soft caps — dismiss list ≤ 500 and conversion history ≤ 200 (oldest pruned); neighbor rerank cache drops expired entries.',
    ],
  },
  '1.0.46': {
    title: "What's New in Ark 1.0.46",
    changes: [
      'Oracle accuracy overhaul — BM25 lexical hybrid retrieve, franchise/umbrella shelf gates, ANN distance gating, engagement-weighted taste (idle-quality + Want-to-Play caps), hard-negative franchise/developer mute after dismiss, smarter MMR diversity, evidence-vs-intent hero ranking, cold-start Top Sellers seed, and honest Taste Match explanations.',
      'Oracle reranker reliability — silent background pull of the cross-encoder model, structured IPC results, arctic-embed cosine fallback when /api/rerank is unavailable, and cache-restore still applies shelf rerank when enabled.',
      'Draggable carousels — Oracle shelves and the Scheduled Broadcasts strip now support mouse click-and-drag. Grab and pan horizontally with a 5 px activation threshold so plain clicks still open the card. Buttons and links inside cards are respected.',
      'Right-click a recommendation to see "Why recommended?" — Cursor-anchored popover on Oracle cards shows the game title, best-matching taste cluster, similar-to titles, shared genres, and the top 5 layer scores as proportional bars. Close with outside click, Escape, scroll, or another right-click.',
      'Cross-store status sync on 100% title match — If a game is Playing, Playing Now, or Completed on one store (Steam or Epic), the same title on the other store now auto-mirrors the status. Never overwrites Completed or Playing Now on the other side; a one-shot startup sweep reconciles any pre-existing inconsistencies.',
      'Backlog excludes unannounced games — Want-to-Play entries with no confirmed release date, "TBA" / "TBD" / "Coming Soon" / "To Be Announced" markers, or sentinel-future dates (year ≥ 2090) no longer show up in the backlog list. Add a real release date to re-include them.',
      'Epic API dummy pages excluded — Epic\'s catalog was returning offers with no description AND no image (empty stubs). These are now filtered out at every list-returning API path and at the persist-time boundary. Release-date presence is intentionally ignored — a page is dummy iff both description AND image are absent.',
      'Insights & Telemetry tab (from 1.0.45) — the tab now actually renders next to My Progress for games with recorded sessions.',
    ],
  },
  '1.0.45': {
    title: "What's New in Ark 1.0.45",
    changes: [
      'Insights & Telemetry tab now actually appears. The tab shipped in 1.0.44 was wired into the wrong build of game-details.tsx and never rendered. Fixed — the tab now shows up next to My Progress and Game Details for any game with at least one recorded session.',
    ],
  },
  '1.0.44': {
    title: "What's New in Ark 1.0.44",
    changes: [
      'Insights & Telemetry tab — New third tab on every game with recorded session history. Six analytical panels: Session Analytics (length distribution + weekday×hour heatmap + last-30 strip), Immersion Index (active-input ratio with radial gauge + trend), Engagement Pacing (weekly frequency vs length scatter with median reference lines), Fatigue Point (session length decay + linear regression + signed 4-week % change), App Stability & Overhead (ARK CPU/RAM/hook-latency sparklines), and Friction Detection (correlation of tracker latency spikes vs game idle time). Purely analytical, no wellness-coach language.',
      'Voyage/OCD Gantt row → Insights & Telemetry — Clicking a game row on the OCD timeline now deep-links to that game\'s Insights & Telemetry tab via `/game/{id}#telemetry`.',
      'Session tracker telemetry sampling — Every 15-second poll now records ARK\'s own CPU % (sum across processes via app.getAppMetrics()), RSS memory in MB, and hook probe latency (performance.now() around the tasklist/PowerShell snapshot). Emitted to the renderer over a new `session:telemetrySample` IPC channel.',
      'Active-input tracking per session — Sessions now record `activeInputMinutes` (time when powerMonitor.getSystemIdleTime() < 15 s), so the new Immersion panel can show the fraction of a session where you were actually giving input.',
      'Oracle → game-details now hydrates fully. Previously, clicking an Oracle recommendation opened a half-empty details page (no description, no gallery, no cross-store links). Root cause: Oracle built a minimal Game stub that lacked `epicSlug` / `epicNamespace` / `epicOfferId` / `availableOn` / `secondaryId`, and the details-page enrichment call had no keys to fetch with. Fix: Oracle now prefers the fully-hydrated Game from the Browse prefetch cache (with all cross-store metadata) and, as a fallback, parses `epicNamespace`/`epicOfferId` from the game id so the details page can still call `epicService.getGameDetails()` live.',
      'Oracle hero card also primes nav-transfer. Fixed a subtler bug where clicking the featured hero recommendation navigated without setting `_navTransfer`, forcing the details page onto a slow catalog-cache fallback path.',
      'Steam game-details hero gradient removed. The wide Steam `page_bg_generated_v6b.jpg` backdrop no longer bleeds through as a colorful atmospheric wash. Both Steam and Epic pages now use a clean flat-black hero with subtle dark fade overlays — no store-specific colour, no parity gap between the two stores.',
    ],
  },
  '1.0.43': {
    title: "What's New in Ark 1.0.43",
    changes: [
      'Scheduled Broadcast cards redesigned — Cover images now render as a dimmed atmospheric backdrop across the whole card with a dark gradient wash + subtle top-right accent, instead of the harsh 128 px logo-banner strip from v1.0.42. Plain product logos (Steam, Nintendo, MAGFest, …) become tasteful color washes rather than blocky product tiles.',
      'Broadcast cards ~35% shorter — Removed the dedicated image row, tightened padding and typography. Cards now hold their information densely without towering above the rest of the strip.',
      'Card width tightened from 280 px → 260 px so more events fit in view before you need to scroll.',
    ],
  },
  '1.0.42': {
    title: "What's New in Ark 1.0.42",
    changes: [
      'Update flow reliability — Differential (blockmap) downloads are now disabled; every update pulls the full installer. This eliminates the per-block SHA drift that could abort downloads on large releases.',
      'Real update-error messages surfaced — When an update fails, the snackbar and Settings About tab now show the actual electron-updater error instead of a generic "Failed to download update". The real message from the update event is preserved even after the download promise settles.',
      'Manual "Download from GitHub" fallback — If the auto-update ever fails, both the snackbar error state and the Settings About tab now include a one-click link that opens the GitHub releases page. Your data is preserved when you install manually.',
      'Structured error diagnostics in the main-process log — Auto-updater errors now log name, message, and stack (previously only message). Easier to diagnose from user log dumps.',
      'Download IPC returns structured result — `window.updater.downloadUpdate()` now returns `{ success, error?, errorName? }`. The renderer no longer clobbers a specific update-event error with a generic catch-all message.',
      'Oracle shelf cards fixed — Reverted the v1.0.41 horizontal virtualization attempt on Oracle shelves. The virtualizer\'s absolute-positioned wrapper had no explicit height and its 264 px fixed size fought OracleCard\'s min-w-[200px]/max-w-[320px] clamp, causing cards to collapse or misalign. Restored the original flex-gap-4 layout.',
      'Epic game details now match Steam hero — Epic games use their CMS gallery hero image as the wide backdrop (with a stylized fuchsia-tinted gradient fallback when no image is available), matching the look Steam pages already had. No more flat black hero on Epic.',
      'Live Transmissions image extraction expanded — RSS parser now checks `<content:encoded>` (full WordPress post HTML), `<itunes:image>`, protocol-relative URLs (`//host/pic.jpg`), and a channel-level `<image><url>` fallback. Warns in the log per item that still ends up imageless.',
      'Browse search no longer refreshes the grid on every keystroke — Typing updates only the dropdown; the browse grid rebuilds only on Enter, clicking a suggestion, or 400 ms of no typing. Dropdown itself now scrolls with a sticky "+N more results" footer and a `↵ to see all` hint.',
      'Auto Playing → On Hold — Games in Playing that have not been played for 30+ days now automatically move to On Hold. Runs on startup and every 60 min. Opt-out via `preferences.autoOnHoldTransition` (default on).',
      'Launcher-aware auto-transitions — When the exe path looks like a launcher (EA/Riot/Steam/Ubisoft/etc. or basename contains launcher/bootstrap/loader), the Want-to-Play → Playing auto-transition is skipped and the entry is stamped `launcherDetected: true`. Playtime tracked via a launcher is unreliable, so we no longer promote games based on it.',
    ],
  },
  '1.0.41': {
    title: "What's New in Ark 1.0.41",
    changes: [
      'Voyage / OCD Mode overhaul — Hero band with Playing Now cards and 14-day activity ribbons; Focus row with 12-week ridgelines for your top 3 games; the timeline archive now hides Want-to-Play and On-Hold clutter, shows Completions as gold chevron milestones, and scales bar opacity to session intensity so real playtime finally stands out.',
      'Voyage unified scroll — The sidebar and Gantt timeline now share one vertical scroll container. No more panels drifting apart when you scroll. Sidebar auto-collapses to a thumbnail strip after scrolling past 200px.',
      'Captain\'s Log dates fixed — Cards no longer render "Invalid Date" for entries with corrupt legacy timestamps.',
      'Auto Want-to-Play → Playing — Behind an opt-in Preferences toggle, sessions longer than 10 minutes automatically move a game out of your Want-to-Play backlog into Playing. Only fires from Want-to-Play; never overwrites Completed, On-Hold, or an explicit Playing-Now state.',
      'On-Hold suggestions — New helper hook detects games sitting in Playing with no session for 14+ days so the UI can gently suggest pausing them.',
      'Session tracker no longer misses launchers — Full exe-path matching added on top of basename matching. Games sharing the same executable name (common in indie Unity titles) no longer double-count. A one-shot warning fires when only the basename matches.',
      'Session hiccup tolerance — Bumped MISSES_BEFORE_END from 2 to 4 polls (~60 s) so heavy GPU load, AV scans, and PowerShell contention no longer split one play block into many.',
      'Exe metadata analysis — New IPC (window.exeInfo.analyze) reads exe mtime, size, digital signature, and detects known launchers (EA, Riot, Steam, Valve, Rockstar, Ubisoft, Epic, Bethesda, Blizzard, Battle.net, GOG, Uplay, Origin) so future UI can warn "That looks like a launcher, not a game" before tracking silently fails.',
      'Playing-since dates now correct — First-play timestamps now derive from your earliest recorded session (or first Want-to-Play → Playing status transition), not from when the game was added to the library. Fixes 5 code paths that used the library-add date.',
      'Update popup no longer silently fails — When GitHub is unreachable at startup, the snackbar now shows a "Couldn\'t reach GitHub — will try again in 2 min." toast with Retry now / Dismiss actions instead of failing silently.',
      'Check for Updates button — About tab in Settings now has a manual "Check for Updates" button that surfaces the latest version and offers a one-click download.',
      'Update version comparison accepts pre-release tags — Releases tagged 1.0.42-rc1 vs 1.0.41 are now compared correctly. No more silent "no update" when a pre-release ships.',
      'Random-offline banner fixed — The connectivity probe is now whitelisted through the adblocker, uses a 12 s timeout, and requires 2 consecutive failures before flipping. Corporate networks and adblocked probes no longer flap.',
      'Transmissions cover art — Scheduled Broadcast cards now show real cover images extracted from event pages (og:image → twitter:image → JSON-LD → link rel image_src → first hero img fallback chain).',
      'Session-tick perf — Library store now has a separate hours-only subscription channel. 15-second session-tracker ticks no longer wake every subscriber in the app; the master games memo, Oracle signature rebuild, and Medals view all skip the wake-up.',
      'Oracle shelf virtualization — Shelf carousels now use @tanstack/react-virtual (horizontal). Only the visible ~10 cards render per shelf instead of all 40+.',
      'ann-graph RAF leak fixed — Supernova and shockwave animation IDs are now removed from the tracking set as each frame fires, not just on unmount. Set no longer grows unbounded during long play sessions.',
      'Session + status-history writes debounced — Persistence to localStorage is now 300 ms-debounced (matching library-store), eliminating the every-15-second JSON.stringify freeze during play.',
      'Journey store sanitizes dates on load, record, and import — "undefined" strings and unparseable timestamps no longer get re-persisted; the invalid-date bug can\'t regress.',
      'beforeunload listeners are now idempotent — Library, journey, and custom-game stores no longer stack beforeunload handlers under HMR / tests.',
      'useLibraryHours hook — New per-card hook that subscribes to hours-only changes so individual game cards can show live playtime without invalidating the whole games list.',
    ],
  },
  '1.0.40': {
    title: "What's New in Ark 1.0.40",
    changes: [
      'Embedding speed — Switched to single-request array batching, GPU mode auto-detected at boot, full layer offload forced (num_gpu=999), Ollama internal batch raised to 2048, and concurrent in-flight requests on GPU. Catalog embedding passes are dramatically faster on machines with a GPU and stay polite on CPU-only setups.',
      'Polite background mode — When you alt-tab or minimize Ark, embedding work automatically throttles to a small batch, single in-flight request, and 100 ms cooldown between bursts. The foreground app (game, browser, anything) gets uncontended GPU time. Returning to Ark snaps embedding back to full throughput.',
      'VRAM auto-fallback — On GPUs with tight VRAM, the embedding worker now silently steps the internal batch size down (2048 → 1024 → 512 → Ollama default) on the first all-null response. No more silent zero-embed runs.',
      'Length-sorted batching — Embedding sub-batches are now sorted by text length so similar-length items cluster together. Tighter per-batch timing; small throughput win when running 2 concurrent batches.',
      'Embed diagnostic — New IPC probe (`window.ollama.embedDiagnostic()`) returns GPU mode, VRAM bytes, embeds/sec, ms/embed, and the live profile (num_batch, sub_batch, polite flag). Use from devtools when speed feels off.',
      'Auto-install embedding model — First-launch updaters get the 1.2 GB arctic-embed2 model pulled automatically during splash. The "Enter Ark" button is gated while the pull is in progress so you do not enter into a half-ready reco engine. Already-installed users see no extra wait.',
      'Configurable model quantization — Power users can override the embedding model tag via the `ARK_EMBEDDING_MODEL_TAG` env var (e.g. a manually quantized Q8 GGUF) for ~2× faster inference at near-zero accuracy loss. Default is unchanged; only opt-in.',
      'Model kept hot — Ollama embedding model now pinned with `keep_alive: -1` so you never pay the ~80 s reload cost between embedding bursts.',
    ],
  },
  '1.0.39': {
    title: "What's New in Ark 1.0.39",
    changes: [
      'Galaxy View — Graph-powered star map now uses graphology for community detection (Louvain), PageRank, Personalized PageRank, HITS authority/hub scores, and betweenness centrality',
      'Stellar Classification — Stars are visually classified (Quasar, Pulsar, Hypergiant, Neutron Star, M-Dwarf) based on graph signals; each class has a distinct glyph and color',
      'Fault Lines — Edges with high betweenness pulse as visible fault lines, revealing the bridges between game clusters in your library',
      'Community Color Fills — Louvain communities are color-coded by golden-angle hue, making genre territories immediately visible',
      'Frontier Aurora — High-prDelta nodes emit a soft cyan-to-magenta aurora, spotlighting games that punch above their PageRank weight',
      'Whisper Layer — Hovering on a high-betweenness broker node triggers a brief ambient phrase describing its role as a bridge between worlds',
      'Codex — Press C on any selected game to open a two-page spread narrated by the Curator with graph-derived context',
      'Banners — Place colored banner markers on any star; organize and manage them from the banner menu',
      'Constellations — Draw, name, and save custom star groupings; constellations persist across sessions',
      'Lasso — Press L to draw a freehand selection; capture any cluster of stars and save it as a named constellation',
      'Year Wrapped → Galaxy Flythrough — The Year Wrapped finale now has a "Watch your year in the Galaxy" button that launches a 60-second cinematic camera flight through your year\'s key games with animated title callouts',
      'Galaxy performance — One shared DataTexture for all graph signals, sampled betweenness with fixed predecessor-list bug, and RAF-throttled appearance updates across 60K nodes',
    ],
  },
  '1.0.38': {
    title: "What's New in Ark 1.0.38",
    changes: [
      'Add to Library fixed — The dialog now reliably closes after you add a game, whether from the dashboard or a game details page',
      'Dev Logs fixed — The construction log opens correctly again; it now tolerates older journal formats and is reliably bundled into the installed app',
      'Playtime no longer resets to zero — A stray zero-length tracking update can never wipe your accumulated hours',
      'Tracking works everywhere — Session tracking keeps running as you navigate between screens, so play sessions are no longer lost when you leave the dashboard',
      'More accurate durations — Brief process hiccups no longer split or cut short a session, idle time is measured more fairly, and sessions interrupted by a crash are recovered on the next launch',
      'Voyage / OCD timeline stability — Large libraries and long histories no longer freeze or crash the timeline; corrupt or missing data is handled gracefully',
      'Crash isolation — An error in one view (e.g. Voyage or Dev Logs) now shows a contained, recoverable message instead of taking down the whole app',
    ],
  },
  '1.0.37': {
    title: "What's New in Ark 1.0.37",
    changes: [
      'Similar Games — Game details uses Ark embedding neighbors (Steam, Epic, cross-store) with real titles, art, and cosine distance; replaces Steam-only recommendations',
      'Browse search alignment — Grid matches search dropdown order; 400ms debounce; no Top Sellers leak while typing; toolbar shows Search results when searching',
      'Neighbor dedupe — Hides duplicate store twins and same-title duplicates in Similar Games',
    ],
  },
  '1.0.36': {
    title: "What's New in Ark 1.0.36",
    changes: [
      'Guided tour spotlight — Tours now highlight the element being referenced with a crisp cutout glow instead of uniform dimming',
      'Rerank status badges — Oracle and Embedding Space show compact inline badges for rerank status (off, unavailable, no scores) instead of standalone warning paragraphs',
      'Tour flow fixes — Deterministic event handling, data-tour anchors for loading/empty states, lazy-loaded view retry timing, and Settings Guide tab redesign',
      'AI chat improvements — Enhanced chat provider support, availability detection, and panel UX',
      'Ollama reranking pipeline — Full reranker integration for Oracle recommendations and Embedding Space neighbors with score normalization and graceful fallback',
      'Journey display titles — Smarter display names for Voyage timeline entries',
      'removeChild crash eliminated — No more DOM mutation errors when ending guided tours',
    ],
  },
  '1.0.35': {
    title: "What's New in Ark 1.0.35",
    changes: [
      'Playtime no longer resets — Custom or manually entered hours are preserved when the app tracks your game exe; total hours = baseline (your past/manual hours) + session-tracked time',
      'Library and custom games — Both use a baseline so editing hours in My Progress and then playing tracked sessions adds on top instead of overwriting',
      'Transmissions — Scheduled Broadcasts strip has Previous/Next buttons, broadcast card glow, and event location (city or Online) on cards',
    ],
  },
  '1.0.34': {
    title: "What's New in Ark 1.0.34",
    changes: [
      'Transmissions — Scheduled Broadcasts strip now has Previous/Next buttons to scroll event tiles on desktop; horizontal scroll no longer relies on touchpad or hidden scrollbars',
      'Broadcast card glow — Live and imminent event cards use a theme-aligned static magenta glow instead of the rotating edge effect; padding in the strip prevents glow clipping',
      'Event location metadata — Transmission cards show city (e.g. San Francisco, Boston) or "Online" for each gaming event, with MapPin/Globe icons',
    ],
  },
  '1.0.33': {
    title: "What's New in Ark 1.0.33",
    changes: [
      'Galaxy Map Scale Fix — Stream-project 1024D embeddings to 100D via random projection during IDB read, eliminating a 456 MB allocation; Embedding Space now builds 111K nodes in seconds at ~1.05 GB instead of crashing with OOM',
      'Recommendation Pipeline 100x Speedup — Memoized genre lookup, pre-computed semantic scores, dense Float32Array cosine similarity, and smart pre-filter (25K → 3K candidates) slash Oracle recommendation time',
      'Oracle Cross-Store Dedup — Completed games no longer leak into recommendation shelves when the same game exists under different store IDs; candidate pool now checks secondaryId against the exclusion set',
      'Embedding Space Visual Upgrade — Anti-aliasing enabled, bloom resolution bumped from quarter to half, HDR nebula skybox restored via XHR-to-Blob pipeline that bypasses fetch() limitation with file:// in Electron',
      'Library Navigation Snappier — View switch wraps in startTransition so the UI stays responsive while the heavy filter/sort pipeline computes in the background',
      'Voyage Thumbnail Fix — Three.js texture loader CORS mode set to passthrough for Electron file:// context; cover images now memo on stable gameId + coverUrl instead of full entry reference, preventing backfill-triggered resets',
      'ML Model Status Fix — Status panel auto-loads the recommendation model on first poll with up to 3 retry attempts; users see "Loaded" within seconds of startup instead of permanent "Not loaded"',
      'Galaxy Neighbour Tightening — Cosine distance threshold reduced from 0.9 to 0.7 so connections show genuinely similar games instead of loose associations',
      'Galaxy Cache Stability — Cache tolerates small embedding count drift when freshly built, preventing instant invalidation from background catalog embedding',
      'Lazy View Loading — Four heavy views lazy-imported with async filter/sort path to eliminate view-switching lag',
      'Resource Pressure Fixes — Crash circuit breaker, event-driven IPC, lazy ML model loading, HDR texture cleanup, and ONNX Runtime warning silencing',
      'Ollama NSIS Installer Step — Optional Ollama installation during setup with GPU recommendation, existing install detection, and graceful failure paths',
    ],
  },
  '1.0.32': {
    title: "What's New in Ark 1.0.32",
    changes: [
      'Embedding Space Galaxy Map — Interactive 3D galaxy visualization of your game library using PCA-projected embeddings; each game is a star with genre-based coloring, neighbor connections, and orbit controls',
      'Catalog Embedding Pipeline — Background pipeline generates semantic embeddings for browse catalog games via local Ollama, stored in IndexedDB with progress tracking',
      'System Status Panel — Real-time dashboard showing Ollama connectivity, embedding progress, ML model state, and memory usage across main and renderer processes',
      'Guided Tour — Interactive onboarding walkthrough highlighting key features for new users via react-joyride',
      'Data Flow View — Visual pipeline diagram showing how data moves between stores, workers, and the UI',
      'ML Recommendation Model — ONNX-based scoring model bundled with the app for offline recommendation inference',
    ],
  },
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

/** Latest release notes for the running app version (Settings / About). */
export function getLatestChangelog(): ChangelogEntry | null {
  return CHANGELOG[APP_VERSION] ?? null;
}

export function ChangelogModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogData, setChangelogData] = useState<ChangelogEntry | null>(null);

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
                  className="w-full bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-600 text-white font-medium"
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
