# Changelog

All notable changes to Ark (Game Tracker) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.56] - 2026-08-01

### Fixed
- **Ark Wrapped soft-lock** — slide navigation uses full-overlay hit-testing (not tiny calendar cells); always-visible Back / Continue / Done chrome so you can finish without restarting the app.
- **Guided tour stuck dimmer** — generation-scoped Joyride leftover sweep (sync + deferred), Escape clears orphan portals after Finish, spotlight no longer uses a full-screen `9999px` box-shadow blocker.
- **Overlay detail levels restored on main** — Ctrl+Shift+D cycles collapsed → compact → expanded (ported from the 1.0.53 line) with HWND resize; lazy create/destroy and click-through without mouse forward preserved.

### Added
- **Always-visible overlay shortcut hints** on compact/expanded HUD (`O dismiss · D cycle`) plus Settings copy for Ctrl+Shift+O / Ctrl+Shift+D. Rebuild ANN / What’s New from 1.0.55 unchanged.

### Changed
- **Embedding Space declutter** — removed Timeshear, Cartographer HUD, and Monuments from the galaxy map. Codex remains via the C hotkey (Curator voice).

## [1.0.55] - 2026-08-01

### Fixed
- **Embedding Space ANN “self-only” neighbors after Phase A int8 embeddings.** `readPooledVector` now coerces IDB-revived `q` shapes (ArrayBuffer / plain arrays) so `getEmbeddingById` and ANN queries work again. Library all-cached path backfills ANN when the index is not ready. Single-vector `query` accepts optional `excludeId` (wired for Embedding Space + Similar Games).

### Added
- **Settings → Ollama → Rebuild ANN index** — clear + backfill from cached pooled embeddings. Latest release notes also shown under Settings → About → What’s New.

## [1.0.54] - 2026-08-01

### Fixed
- Performance hotfix for ~15s hitch while gaming (PowerShell path parse / main-process work on poll cadence; coalesced notifies; lazy system-status polling).

## [1.0.53] - 2026-08-01

### Added / Fixed
- Ark Wrapped soft-lock, live telemetry, overlay detail levels, Qwen listing UI, Scenes/Audit polish, quieter session/embedding polling while playing.

## [1.0.52] - 2026-08-01

### Fixed
- **Critical: app would not start after installing 1.0.50.** The published 1.0.50 installer shipped a corrupted `package.json` inside the app archive, so Electron exited immediately on launch (no window, no in-app update path). Fresh downloads of 1.0.50 were affected. This release rebuilds and republishes a clean package so Latest installs boot normally.
- Includes the 1.0.51 overlay mouse-lag fixes (lazy HUD window, no mouse-forward click-through, async session polling) on top of 1.0.50 chunked embeddings.

## [1.0.51] - 2026-08-01

### Fixed
- **In-game overlay mouse lag.** Overlay click-through no longer uses `{ forward: true }` (Chromium mouse hit-testing into the overlay process). The HUD HWND is created only while a tracked session is active and the setting is on; deactivate fully destroys the window instead of leaving a topmost idle shell. Session process snapshots run async (no sync `tasklist`/PowerShell on the main thread) with overlap skip.
- **Overlay HUD compositor cost.** Removed backdrop blur and the infinite pulse animation; fade is opacity-only. Background throttling stays on until the HUD is shown; always-on-top is elevated only while visible.

### Changed
- Overlay settings/hotkey paths call `activateOverlay` / `deactivateOverlay` (lazy create + destroy). Hotkey show requires an active tracked session, not an empty topmost window.

## [1.0.50] - 2026-08-01

### Added
- **Chunked embeddings (Phase A).** Library and catalog rewrites can persist facet chunks (`lib:` / `cat:` prefixed ids) with int8 pooled game vectors. Upgrade is lazy dual-format — existing installs are not wiped and do not force a full re-embed. Progress stays in game units. Kill switch: Settings → Ollama → “Facet chunk embeddings” (default on). Galaxy cache freshness now keys on pooled count + `embeddingContentEpoch`.

### Changed
- **Embeddings IDB v4** adds `chunk-embeddings` (additive). Readers decode int8 or legacy float at the boundary before ANN / reco / galaxy / graph. Failed writes surface errors and do not advance catalog watermarks.

### Notes (user risk)
- First rewrite of a previously float-pooled game may change that game’s ANN neighbors (weighted pool vs concat embed). Unchanged content still skips Ollama entirely.


## [1.0.47] - 2026-08-01

### Fixed
- **Oracle survivor similar titles from ANN.** Prefilter survivors now hydrate `similarGameTitles` from ANN neighbor display titles (distance-gated), not Steam `recommendations.total` fakes. Steam details still supply metacritic / studio / coming-soon only.
- **Live hard-negative shelf mute.** Dismiss / thumbs-down expands franchise+developer mute against the current shelf catalog immediately; Oracle disk-cache signature includes dismiss fingerprint + coarse hours buckets, and cache is invalidated on dismiss so a 15‑minute restore cannot resurrect muted siblings (no full recompute on every dismiss).
- **Franchise aliases.** `canonicalFranchiseBase` maps Halo Infinite → Halo, DOOM Eternal → DOOM, Resident Evil Village / biohazard → Resident Evil, Far Cry Primal / numbered → Far Cry (Halo Wars stays separate). Wired into hard-neg, MMR, detect/boost, and prefilter.
- **Hard ANN distance ceiling.** Taste retrieval keeps only neighbors with cosine distance ≤ 0.45 — no soft top‑N fallback when the under-ceiling set is empty.
- **Engagement alignment.** Worker library-seed weights use shared `computeEngagementWeight`; temporal decay is a multiplier only (Want-to-Play no longer re-inflated via `0.2*decay+0.05`).
- **Soft growth bounds.** Dismissals capped at 500 and conversion history at 200 (oldest pruned); Ollama neighbor rerank cache prunes expired entries on read/write.

## [1.0.46] - 2026-08-01

### Added
- **Oracle accuracy overhaul (BM25 + Phase A–F).** Hybrid MiniSearch BM25 retrieve into the Oracle pool; franchise umbrella gates + shelf contracts; ANN cosine-distance gate; shared engagement weight with idle-quality (F7) and Want-to-Play caps; hard-negative franchise (14d) / developer (7d) mute from dismiss metadata; smarter MMR (franchise/dev similarity); evidence-vs-intent hero ranking; survivor metadata hydrate; cold-start Top Sellers ∩ genre seed; offline vitest eval harness.
- **Oracle reranker reliability.** Silent background pull of the cross-encoder model, structured IPC `{ results, via }` / `{ error }`, arctic-embed cosine fallback, cache-restore still runs shelf rerank when enabled.
- **Draggable carousels (mouse click-and-drag).** New shared hook `src/hooks/useDraggableScroll.ts` — pointer-based click-and-drag horizontal panning wired into Oracle shelf carousels and the Scheduled Broadcasts strip. 5 px activation threshold so plain clicks still fire card `onClick`. Skips drag when the pointer starts on `<button>` / `<a>` / `<input>` / `[data-no-drag]` descendants. Uses `setPointerCapture` for reliable pan even when the pointer briefly leaves the container. Installs a one-shot capture-phase click-swallow on release so a drag doesn't accidentally navigate.
- **Right-click Oracle recommendation → "Why recommended?" popover.** New `RecoWhyPopover` (portal-rendered, cursor-anchored, viewport-clamped) attached to Oracle cards. Right-click reveals the game title, best-cluster label, similar-to titles (up to 3), shared genres (up to 4), and the top 5 non-zero layer signals with proportional bars. Skips when the right-click lands on a `<button>` / `<a>` / `<input>` / `[data-no-drag]` descendant. Closes on outside mousedown, Escape, scroll, or another context-menu event.
- **Cross-store status sync on 100% title match.** New `libraryStore.propagateStatusByTitle(source, newStatus)` fires from `updateEntry` whenever the new status is Playing / Playing Now / Completed. Siblings across other stores (Steam/Epic) with the same `normalizeTitle` mirror the status. Rules: Completed can overwrite anything not-Completed; Playing can only overwrite Want-to-Play / On-Hold. Never overwrites Completed or Playing-Now. Stamps `crossStoreSyncedFrom` + `autoTransitionedAt`. Also runs a one-shot idempotent startup sweep `syncCrossStoreStatusesOnce()` so upgraders reconcile any pre-existing inconsistencies on first `getAllEntries()`.
- **Backlog excludes unannounced games.** New `libraryStore.getBacklogEntries()` (and matching `useLibraryBacklog()` hook in `useGameStore.ts`) returns Want-to-Play entries with a confirmed release date. `isReleaseDateConfirmed(entry)` gates on: date present + non-whitespace, not containing `tba` / `tbd` / `coming soon` / `to be announced` / `unknown` (case-insensitive), and not sentinel-future (year < 2090).
- **`LibraryGameEntry.crossStoreSyncedFrom?: string`** field — diagnostic trace of the sibling entry that drove a cross-store status propagation.

### Fixed
- **Epic API dummy pages excluded.** Epic's catalog scrapers were including offers with no description AND no image — pure stubs sitting in your Coming Soon / Browse lists. New `isDummyEpicOffer(item)` predicate + `filterDummyOffers()` helper is applied at every list-returning path in `electron/epic-api.ts` (`getPromotionalCatalog`, GQL `searchGames`, `getGameDetails`, `getNewReleases`, `getComingSoon`, `getFreeGames`, `browseCatalog`, `getTopSellersFromCollection`), plus a defence-in-depth pass in `src/services/epic-service.ts` at every `transformEpicGame` call site, plus a persist-time skip in `src/services/epic-catalog-store.ts`. Release-date presence is intentionally ignored — a page is dummy iff both description AND image are absent. Drops are logged as `[Epic] Filtered N dummy pages from result`.

## [1.0.45] - 2026-07-31

### Fixed
- **Insights & Telemetry tab was never rendering.** The v1.0.44 commit shipped every supporting file (panels, derivations, session-tracker instrumentation, preload API, Gantt deep-link) but the six-edit integration into `src/pages/game-details.tsx` (lazy import, `sessionStore` import, `TelemetryTab` lazy const, `hasSessions`/`defaultTab` derivation, the third `TabsTrigger`, and the matching `TabsContent`) did not make it into that commit — a concurrent session editing the same file for the Oracle-hydration fix landed its changes last, silently dropping the tab wiring with no test coverage on tab *count* to catch it. Re-applied all six edits in isolation (verified via `git diff --stat` showing only `game-details.tsx` touched) and confirmed the tab now renders for any game with `sessionStore.getForGame(id).length > 0`.

## [1.0.44] - 2026-07-31

### Added
- **Insights & Telemetry tab on game-details.** New third tab (gated on `sessionStore.getForGame(id).length > 0`) with six analytical panels stacked top-to-bottom:
  - **Session Analytics** — histogram of session length (0-15/15-30/30-60/60-120/120-240/240+ minutes via `bucketSessionLengths`), 7×24 weekday×hour heatmap via `weekdayHourHeatmap`, last-30 SVG stacked strip (duration bar overlaid with per-session active-input ratio). Tiles: mean, P95, longest gap (days), sessions last 7 days.
  - **Immersion Index** — ratio of active-input time to total session length. Radial arc gauge for trailing-5 index, `immersionRollingSeries` AreaChart with rolling-5 mean overlay, stacked BarChart for last 20 sessions. Tiles: all-time / trailing-5 / highest / lowest.
  - **Engagement Pacing** — ScatterChart of `pacingWeeklyPoints` (X = sessions/week, Y = avg minutes, Z = total minutes) with ReferenceLines at both medians; 12-week cadence BarChart.
  - **Fatigue Point Identification** — LineChart with three series (weekly avg solid, weekly max dashed, linear-regression trend dotted). Signed % change tile via `percentChange` comparing last-4-week avg to prior-4-week avg. No color-coded verdict.
  - **App Stability & Overhead** — driven by `useTrackerOverhead(gameId)`. Two AreaCharts (ARK CPU %, RSS MB) + LineChart of hook probe latency with ReferenceLines at inline-computed p50 and p95.
  - **Friction Detection** — `frictionAnomalies(samples, sessions)` ScatterChart (X = latency ms, Y = idle Δ minutes, colored by session) + compact anomaly table. `pearson` correlation tile.
- **Session tracker telemetry sampling.** Every 15 s poll now wraps the process-snapshot probe with `performance.now()` to record `hookLatencyMs`, reads `process.memoryUsage().rss` for `rssMb`, and sums `app.getAppMetrics()[*].cpu.percentCPUUsage` for `cpuPercent`. When any session is active it emits per-session-per-tick `session:telemetrySample` events over IPC.
- **Active-input tracking per session.** `ActiveSession.activeInputMs` accumulates each tick where `powerMonitor.getSystemIdleTime() < 15 s`. Persisted on the completed record as `CompletedSession.activeInputMinutes` (optional, added to `GameSession` in `src/types/game.ts`).
- **`window.telemetryAPI.onSample(cb)` renderer subscription.** Exposed in `electron/preload.cjs` via `contextBridge`. Returns an unsubscribe function. Fed straight into `trackerOverheadStore` (a 4096-sample renderer-side ring buffer) which the OverheadPanel/FrictionPanel read via `useSyncExternalStore`.
- **OCD Gantt row → Insights & Telemetry deep-link.** Clicking a row in `journey-gantt-view.tsx` now navigates via wouter to `/game/{gameId}#telemetry`; `game-details.tsx` reads `window.location.hash` at mount to select the telemetry tab directly.
- **`src/services/telemetry-derivations.ts`** — pure math (no store imports): `weeklyAggregate`, `immersionForSession`, `immersionRollingSeries`, `linearRegression`, `percentChange`, `bucketSessionLengths`, `weekdayHourHeatmap`, `frictionAnomalies`, `pearson`, `pacingWeeklyPoints`. Unit-tested in `src/test/services/telemetry-derivations.test.ts`.

### Fixed
- **Oracle → game-details incomplete data.** Clicking an Oracle recommendation opened a details page missing description, gallery, requirements, and cross-store metadata (compared to opening the same game from Browse). Root cause: `scoredGameToGame` at [src/components/oracle-view.tsx:624](src/components/oracle-view.tsx:624) built a minimal Game stub lacking `epicSlug` / `epicNamespace` / `epicOfferId` / `availableOn` / `secondaryId`, and because `prefetch-store._navTransfer` short-circuits `findGameById`, the details page received the stub and skipped both `epicService.getGameDetails()` and `getProductContent()` — no data to enrich with. Fix: `scoredGameToGame` now looks up the fully-hydrated Game from the Browse prefetch cache first (via `getPrefetchedGames().find(g => g.id === sg.gameId || g.secondaryId === sg.gameId)`). If not found, it parses `epicNamespace` / `epicOfferId` from the id shape `epic-{ns}:{offerId}` so the details-page Epic enrichment call can still run live and hydrate the missing fields.
- **Oracle hero card now primes nav-transfer.** Fixed a related bug at [src/components/oracle-view.tsx:1060](src/components/oracle-view.tsx:1060) where clicking the featured `HeroCard` navigated without calling `setNavigatingGame`, so the details page had to fall back to a `prefetchedGames.find` lookup and could silently return null. Hero click now stashes the hydrated Game via `setNavigatingGame(scoredGameToGame(game))` before navigating — same fast path as shelf cards.
- **Steam game-details hero gradient removed.** The wide Steam `page_bg_generated_v6b.jpg` backdrop no longer bleeds through as a colorful atmospheric wash on Steam pages. Both Steam and Epic pages now render a flat-black hero with the same two dark fade overlays for depth. No store-specific colour, no parity gap. Also removed the fuchsia/purple fallback wash from v1.0.42 and the now-unused `heroBgLoaded` state.

## [1.0.43] - 2026-07-31

### Fixed
- **Scheduled Broadcast cards look tasteful** — Cover images now render as a dimmed atmospheric backdrop across the whole card (55% opacity, saturate 0.85, plus a top-to-bottom black gradient wash from 0.45 → 0.92 and a subtle top-right radial highlight for a brand cue) instead of the harsh 128 px logo-banner strip from v1.0.42. Plain product logos (Steam, Nintendo, MAGFest, PAX West) become tasteful colour washes rather than sterile product tiles. Text remains fully readable regardless of image contents.
- **Broadcast cards ~35% shorter** — Removed the dedicated image row, tightened outer padding (`px-5 py-5` → `px-4 py-4`), gap (`gap-4` → `gap-2.5`), and typography (title 15 px → 14 px, date 20 px → 16 px, countdown 17 px → 14 px). Footer padding also trimmed.
- **Card width tightened** — 280 px → 260 px, scroll step updated to match (296 → 276) so more events fit in view before you need to scroll.

## [1.0.42] - 2026-07-31

### Fixed
- **Update flow — "Failed to update" bug** — Differential (blockmap) downloads disabled; every update now pulls the full installer via `autoUpdater.disableDifferentialDownload = true`. This eliminates the per-block SHA drift that could abort downloads on releases with large diffs.
- **Real update-error messages preserved** — Update-snackbar and Settings About tab no longer overwrite the electron-updater `onError` event's real message with the generic "Failed to download update" from `handleDownload`'s catch. `setErrorMessage((prev) => prev ?? …)` pattern preserves the earlier, more specific message.
- **Structured download IPC result** — `updater:download` no longer throws on failure; returns `{ success, error?, errorName? }`. Renderer preserves specific errors from the download-progress error event.
- **Main-process auto-updater logs full error details** — `name`, `message`, and `stack` now logged (previously only `message`).
- **Steam/Epic game-details hero parity** — `epicToSteamDetails` now prefers `productContent.gallery` hero images (with a `/hero|background/i` URL match preferred over first-image) for both `header_image` and `background`. Render also gets a stylized fuchsia-tinted gradient fallback behind the hero image so Epic games without any art still match Steam's stylized look instead of a flat black gap.
- **Live Transmissions cover images** — RSS extractor now checks `<content:encoded>` (WordPress full-post HTML) BEFORE description; adds `<itunes:image href="...">` (podcast RSS); adds channel-level `<image><url>` per-item fallback; normalizes protocol-relative URLs (`//host/pic.jpg`) to `https:`; logs a warning tagged with source when a feed item ends up imageless after all attempts.
- **Browse search no longer rerenders the whole grid on every keystroke** — Split `searchQuery` into `typingQuery` (drives dropdown) and `committedQuery` (drives grid filter). Grid rebuilds only on Enter (instant), suggestion click, or 400 ms of typing idle. Prevents the visible flicker/jump of the grid while a user is typing.

### Added
- **"Download from GitHub" fallback button** in update-snackbar's error state and Settings About tab. One click opens `github.com/pourabkarchaudhuri/ark/releases/latest` for manual install when auto-update fails. Data is preserved when the installer is run manually.
- **Auto Playing → On Hold sweep** — New `useAutoOnHold` hook runs on app startup + every 60 min. Any library entry in `Playing` whose `lastPlayedAt` (or `addedAt` as fallback) is 30+ days old is auto-transitioned to `On Hold` and stamped with `autoTransitionedAt`. Gated by new `preferences.autoOnHoldTransition` setting (default TRUE — the user asked for this explicitly). Never overwrites `Completed`, `Playing Now`, `Want to Play`, or `On Hold`. `useOnHoldSuggestions` kept intact as a 14-day read-only surface.
- **Launcher-aware auto-state gate** — The v1.0.41 Want-to-Play → Playing transition now invokes `window.exeInfo.analyze(exePath)` before promoting. When the signer matches a known launcher publisher (EA / Riot / Steam / Valve / Rockstar / Ubisoft / Epic / Bethesda / Blizzard / Battle.net / GOG / Uplay / Origin) or the basename contains `launcher`/`bootstrap`/`loader`, auto-transition is skipped and `launcherDetected: true` is stamped on the library entry. Playtime tracked via a launcher process is unreliable.
- **`LibraryGameEntry.launcherDetected?: boolean`** — new optional field so UIs can later surface a "this looks like a launcher" warning.
- **Search suggestions dropdown +N indicator** — Sticky-bottom "+N more results" footer with a `↵ to see all` kbd hint when the dropdown has more than the ~8 visible rows. Container grew from `max-h-80` to `max-h-[28rem]` so it actually scrolls to the full result count.

### Reverted
- **Oracle shelf virtualization** — v1.0.41's horizontal `useVirtualizer` on shelf carousels wrapped cards in an absolute-positioned container with no explicit height, and its fixed 264 px `estimateSize` fought `OracleCard`'s `min-w-[200px]`/`max-w-[320px]` clamp — cards visually collapsed or misaligned. Restored the original `flex gap-4` layout. Perf impact is negligible (shelves usually <40 cards) and store-level session-tick fixes already carry the load.

## [1.0.41] - 2026-06-29

### Added
- **Voyage OCD hero band + focus row** — Sticky Playing Now section (cover, elapsed minutes, 14-day activity ribbon) plus a focus strip of the top 3 games by rolling 30-day playtime, each rendered as a 12-week SVG ridgeline.
- **Completion chevron milestones** — Completed segments now render as gold chevrons anchored at the completion timestamp instead of wide grey wall-clock bars. Legend toggle still hides them.
- **Sidebar auto-collapse** — Voyage sidebar collapses to a 44px thumbnail strip after 200px of vertical scroll and expands on scroll back.
- **Auto Want-to-Play → Playing (opt-in)** — Sessions ≥10 min automatically promote a game from Want-to-Play to Playing when `preferences.autoStatusTransition` is enabled. `autoTransitionedAt` timestamped for potential undo. Never overwrites Completed / On-Hold / Playing-Now.
- **`useOnHoldSuggestions` hook** — Returns games in Playing with no session for 14+ days for future "Suggest pausing?" UI.
- **`window.exeInfo.analyze(exePath)` IPC** — Reads mtime, file size, digital-signature signer + validity via PowerShell `Get-AuthenticodeSignature`, and computes `isLikelyLauncher` from known launcher publishers (EA, Riot, Steam, Valve, Rockstar, Ubisoft, Epic, Bethesda, Blizzard, Battle.net, GOG, Uplay, Origin) + basename keywords.
- **`sessionStore.getFirstSessionStart(gameId)` and `statusHistoryStore.getFirstPlayingTransition(gameId)` helpers** — Reliable "first played" signals used across all 5 previously-buggy fallback chains.
- **`libraryStore.subscribeHours(cb)` channel** — Separate subscription channel for hours-only mutations; `updateHoursFromSessions` no longer wakes status/collection subscribers.
- **`useLibraryHours(gameId)` hook** — Per-card live hours subscription without invalidating the master games memo.
- **"Check for Updates" button** — About tab in Settings now has a manual check button with `RefreshCw` spinner, latest-version display, and one-click Download.
- **Update snackbar error state** — Reachability failures now show a dismissible "Couldn't reach GitHub — will try again in 2 min." toast with Retry-now action instead of silent `console.error`.
- **Transmissions cover art** — Scheduled Broadcast cards extract images from event pages via `og:image` → `twitter:image` → JSON-LD → `link rel=image_src` → hero `<img>` precedence chain and render them at the top of the card.

### Fixed
- **Voyage / OCD scroll desync** — Unified sidebar + Gantt into one vertical scroll container. Deleted the one-way scroll-sync `useEffect`. Wheel events anywhere in the chart now drive both columns together.
- **Voyage / OCD bar crowding** — Timeline now filters out Want-to-Play and On-Hold segments entirely. Playing and Playing-Now bars scale opacity to per-segment session intensity, so real playtime dominates visual weight instead of wall-clock duration.
- **Captain's Log "Invalid Date"** — Journey-view card date rendering now uses the existing `parseJourneyIso` guard. Journey store additionally sanitizes `addedAt` / `firstPlayedAt` / `lastPlayedAt` / `removedAt` on load, record, and import so garbage strings can't be re-persisted.
- **Session tracker missing launcher-only games** — Full-path matching added on top of basename matching. Games sharing a basename (common in Unity indie titles) no longer double-count. First-time basename-only match logs a one-shot warning.
- **`MISSES_BEFORE_END` bumped 2 → 4** — Sessions no longer fragment when AV scans, heavy GPU load, or PowerShell contention delays two consecutive tasklist polls.
- **`firstPlayedAt` derived from library-add date** — 5 code paths (library-store Completed transition, journey-store post-import backfill, useGameStore useLibraryGames + ensureArkBackfill, custom-game-store add/update/backfill) now use `sessionStore.getFirstSessionStart` → `statusHistoryStore.getFirstPlayingTransition` → `lastPlayedAt` → `addedAt` fallback chain.
- **Random-offline banner** — Adblocker no longer intercepts `connectivitycheck.gstatic.com` (whitelist bypass added before FiltersEngine matching). Probe timeout raised 5 s → 12 s. Requires 2 consecutive failures before flipping offline.
- **Update version comparison** — Pre-release tags (e.g. `1.0.42-rc1`) now compare correctly against release tags. Silent "no update" on suffixed releases is fixed.

### Performance
- **Master games memo no longer rebuilds on session ticks** — `useGameStore`'s 6000+-entry merged games array is now driven by the non-hours library channel. 15-second `updateHoursFromSessions` writes no longer invalidate the memo or cascade through every subscriber.
- **Oracle library-signature rebuild filtered** — Signature check subscribes to the non-hours channel; session ticks no longer trigger it.
- **Session-store + status-history-store writes debounced** — 300 ms scheduler (matching library-store) replaces synchronous `JSON.stringify` + `localStorage.setItem` on every session end and status change.
- **Oracle shelf virtualization** — `useVirtualizer` (horizontal, 264 px card width, 3 overscan) applied to shelf carousels. Only ~10 cards render per shelf instead of 40+.
- **`ann-graph-view` RAF ID leak** — Supernova + shockwave animation ID sets no longer grow unbounded during long play sessions. IDs are removed each frame as ticks fire.
- **Idempotent `beforeunload` listeners** — Library, journey, custom-game store singletons no longer stack handlers under HMR / tests.

## [1.0.40] - 2026-06-28

### Performance
- **Embedding throughput** — Single-request array batching to Ollama (replaces 20-way parallel requests). GPU mode auto-detected at boot; full layer offload forced (`num_gpu=999`); Ollama internal batch raised to 2048; two concurrent in-flight requests on GPU. Catalog embedding passes are dramatically faster on GPU-capable machines and stay polite on CPU-only setups.
- **Length-sorted batching** — Embedding sub-batches sorted by text length so similar-length items cluster together, improving worker-queue utilisation when concurrent in-flight is active.
- **Model kept hot** — Ollama embedding model pinned with `keep_alive: -1` so the ~80 s reload cost between bursts is gone.

### Added
- **Polite background mode** — When Ark is unfocused/minimised for ≥2 s (or instantly on hide), embedding work drops to a small sub-batch + single in-flight + 100 ms cooldown so a foreground game gets uncontended GPU time. Snaps back to full throughput on refocus.
- **VRAM auto-fallback** — On tight-VRAM GPUs, the embedding worker silently steps the internal batch size down (2048 → 1024 → 512 → Ollama default) on the first all-null response. No more silent zero-embed runs.
- **Embed diagnostic IPC** — `window.ollama.embedDiagnostic()` returns GPU mode, VRAM bytes, embeds/sec, ms/embed, and the live profile. Run from devtools to get concrete throughput numbers.
- **Auto-install embedding model in splash** — First-launch updaters get the 1.2 GB arctic-embed2 model pulled automatically during splash. "Enter Ark" is gated while the pull is in progress so the reco engine isn't half-ready when the user enters. Already-installed users see no extra wait.
- **Configurable model quantization (opt-in)** — `ARK_EMBEDDING_MODEL_TAG` env var overrides the embedding model tag (validation enforces `snowflake-arctic-embed2:*` prefix to preserve embedding-space compatibility). Power users running their own quantized GGUF can opt in without touching code.

### Fixed
- **`getTopSellers` Epic catalog tests** — Stubbed global fetch in test setup so `fetchEgdataTopSellersFromRenderer` returns empty deterministically instead of hitting api.egdata.app over the live network. Catalog mock now fires reliably; both `epic catalog when egdata unavailable` and `epic catalog when egdata would throw` tests pass.

## [1.0.37] - 2026-04-13

### Added
- **Similar Games** on game details — Ark ANN nearest neighbors with Steam/Epic metadata enrichment, embedding distance badge, loading states, and cross-store / same-title deduplication.

### Fixed
- **Browse search** — Grid and dropdown use the same debounced query and ranking; no Top Sellers ordering shown under an active search; toolbar shows Search results while searching.

## [1.0.27] - 2026-02-09

### Fixed
- **Browse Game Count After View Switch** — Background refresh no longer silently drops cross-store (Steam + Epic) games. The Epic data filter now includes games the dedup worker merged into Steam entries (`availableOn` includes 'epic'), preserving the full catalog across refreshes.
- **Background Refresh Safety Net** — If a background refresh produces >10% fewer games than the current set (e.g., a data source failed silently), the swap is skipped entirely to prevent games from disappearing mid-session.
- **Custom Game Status Dropdown in Library** — Changing the status of a custom game via the card dropdown in Library view now correctly updates `customGameStore` instead of silently failing (the previous code only checked `libraryStore`, which doesn't hold custom games).
- **Custom Game Duplicate on Edit** — Editing a custom game entry no longer creates a duplicate record in `libraryStore`; updates now route to `customGameStore.updateGame()` on both the dashboard and game details page.
- **Infinite-Scroll Spinner Behind Cards** — The loading spinner no longer renders at `y=0` behind the first row of game cards. The footer sentinel is now placed outside the absolutely-positioned virtual grid container so it flows naturally below the last row.

## [1.0.26] - 2026-02-09

### Added
- **Release Calendar Overhaul** — Complete rework with 8 new features: "My Radar" filter (library-only toggle), Week and Agenda views with virtualised lists, countdown chips showing days until release, genre/platform quick-filter chips, heat-map density dots on calendar cells, one-click "Add to Library" from any game tile, a "This Week" banner highlighting imminent releases, and a multi-month mini-map strip for fast navigation.
- **Game Details for Custom Games** — Custom games (`custom-*` IDs) now open the full `/game/:id` details page with hero section, My Progress tab, and Game Details tab instead of a limited modal. The page builds a minimal details view from `customGameStore` and `libraryStore` without any API calls.
- **Edit Library Entry Dialog** — `GameDialog` now supports an edit mode via an `initialEntry` prop. When editing, the dialog pre-fills status, priority, notes, discovery source, and executable path from the existing library entry, auto-expands the advanced section if any advanced field is populated, and shows "Edit Library Entry" / "Save Changes" instead of "Add to Library".
- **Dashboard Filter Badge Redesign** — Active filter badge in Browse view now shows only the filter icon and count (e.g., filter icon + "1") for a more compact display.
- **Matching Percentage Indicator** — The "matching" count in Browse view is now a circular progress bar with a percentage label and a tooltip showing the full matching numbers.

### Changed
- **Consistent Edit Entry Flow** — Right-clicking any game card (Steam, Epic, or custom) and selecting "Edit Entry" now opens the same `GameDialog` in edit mode, pre-filled with the current library values. Previously, it opened a separate progress-only dialog.
- **Custom Game Card Navigation** — Clicking a custom game card now navigates to `/game/:id` (the full game details page with My Progress) instead of opening a modal. This matches the behavior of Steam and Epic game cards.
- **Journey View Navigation** — Custom game cards in the Journey timeline now navigate to `/game/:id` instead of opening a modal, consistent with store game behavior.

### Fixed
- **Release Calendar Toast Provider** — Fixed `useToast must be used within a ToastProvider` crash when the calendar's one-click-add feature was used.
- **Epic Game Store Badge** — Fixed "View on Epic Games" link not rendering for Epic-primary games when `epicSlug` metadata was available.
- **Custom Game Click Handler** — Removed the custom game special-case in `GameCard.handleCardClick` that was inconsistent with the unified navigation model.

### Performance
- **LazyFadeImage Stale State** — `loaded`, `attempt`, and `errored` states now reset synchronously via `useRef` comparison when the `src` prop changes, preventing stale fade-in artifacts.
- **Eliminated Double Library Subscription** — Removed redundant `useLibrary()` hook from the calendar; direct `libraryStore` calls avoid an extra subscription and internal re-render loop.
- **Toast Context Ref** — Stored `useToast()` context in a `useRef` so toast-array state changes don't trigger calendar re-renders.
- **GameTile Memo Dependencies** — Narrowed `fallbackChain` `useMemo` deps from `[game]` to `[game.id, game.image]` to prevent unnecessary recomputations.
- **Module-Level Constants** — Moved `COMING_SOON_CAP` and `VIEW_TOGGLE_OPTIONS` out of the component body to avoid re-allocation on every render.
- **AgendaGameRow Extraction** — Extracted virtualised agenda row rendering from an inline IIFE into a dedicated `memo` component, enabling React to skip unchanged rows.
- **Stable Callback Refs** — Wrapped `onSwitchToBrowse` (dashboard → JourneyView) and `onOpenChange` (game-details → GameDialog) in `useCallback` to prevent memo-busting re-renders.

### Removed
- **EditProgressDialog from Dashboard** — The standalone edit progress modal is no longer opened from the dashboard. All edit actions route through `GameDialog` in edit mode, and progress tracking remains on the game details page.

## [1.0.24] - 2026-02-09

### Added
- **Improved Native Notifications** — Windows notifications now display the Ark icon, fire regardless of window visibility (not only when minimised to tray), de-duplicate per version to avoid repeated toasts on every 30-minute poll, and a second "Update Ready" notification appears once the download completes with click-to-install.
- **Faster First Update Check** — A 2-minute delayed first poll replaces the previous 30-minute wait, ensuring users who minimise to tray shortly after launch still get an early update check.
- **Journey View Custom Game Support** — Custom game cards in the Journey timeline now open the progress dialog instead of navigating to a broken game details route.

### Changed
- **Human-Readable Playtime Format** — Playtime labels changed from abbreviated (`2h 15m`) to descriptive (`2 Hrs 15 Mins`) with proper singular/plural handling across Journey, Analytics, Gantt, My Progress, Reviews, and Sessions.
- **Custom Game Edit Flow** — "Edit Entry" on a custom game card now opens the dedicated progress dialog (with executable path, status, hours, sessions) instead of the generic library dialog that couldn't read custom game data.

### Fixed
- **System Tray Icon Blank** — Icons are now bundled via `extraResources` instead of `asarUnpack` (which was silently failing because `build/` was not in the `files` list); tray prefers the pre-made 16×16 PNG to avoid blank images from ICO resize issues on Windows.
- **Custom Game Card Click** — Fixed React.memo comparator on GameCard that was suppressing `onClick` prop updates, causing custom game cards to navigate to a non-existent game details page instead of opening the progress dialog.
- **Custom Game Executable Path Not Shown on Edit** — The generic library dialog was looking up the executable path from `libraryStore` instead of `customGameStore`; now routes to the correct dialog.

### Performance
- **Stable onClick Callbacks** — Custom game card click handlers use ref-backed maps for stable function references, preventing unnecessary React.memo invalidation.

## [1.0.23] - 2026-02-08

### Added
- **Custom Game Progress Dialog** — New dedicated progress view for custom (non-Steam) games. Clicking a custom game card in the library opens a dialog showing playtime stats (total hours, session count, last played), editable status/hours/rating, executable path management with browse/clear, platform tags, and the 10 most recent tracked sessions with dates and durations.
- **`formatHours` Utility** — Shared function in `src/lib/utils.ts` that converts decimal hours (e.g. `2.25`) into human-readable `"2h 15m"` format, used across all views.

### Changed
- **Human-Readable Playtime** — All hour displays across Journey View, Journey Analytics (overview + top games + avg session), OCD Gantt View (sidebar, tooltip, footer, aria-labels), and My Progress tab now use `formatHours()` for `"Xh Ym"` display instead of raw decimal numbers.
- **System Tray Icon** — Generated `build/icon.png` (256×256) and `build/icon.ico` from the existing SVG. Updated `electron/main.ts` tray icon resolution to search a prioritised candidate list (`.ico` → `.png` → sized variants) with logging, instead of a single hardcoded path that silently failed.
- **Auto-Updater Guards** — Added `isCheckingForUpdate`, `isDownloading`, and `updateAlreadyDownloaded` flags in `auto-updater.ts` to prevent overlapping `checkForUpdates()` calls and duplicate `downloadUpdate()` invocations. Removed the redundant 5-second initial check (the snackbar mount already triggers one). The `updater:download` IPC handler now returns early if a download is already running or completed.
- **Custom Game Card Click** — `GameCard.handleCardClick` now detects custom games (negative `steamAppId` or `isCustom` flag) and routes to the `onClick` callback instead of navigating to the non-existent `/game/-1` details page.

### Fixed
- **Custom Game Dialog Overflow** — Restructured the Add Custom Game modal: the `<form>` now wraps both the scrollable body and the footer, with an inner `<div>` handling `overflow-y-auto`. This keeps the submit button inside the form (fixing the `form="..."` attribute issue that silently broke form submission in Radix Dialog portals) and prevents the modal from overflowing the viewport.
- **Custom Game Executable Path Persistence** — The "Add to Library" submit button was moved outside the `<form>` in a prior overflow fix, relying on the HTML `form` attribute which was unreliable inside React portals. Moved it back inside the form so `type="submit"` triggers `handleSubmit` natively, ensuring `executablePath` is included in the saved data.
- **Auto-Updater Double Download** — When clicking "Download Now", the update would download twice (once from the user action, once from a redundant `checkForUpdates` call) before showing "Ready to Install". Fixed by the guard flags and removing the duplicate initial check.
- **System Tray Blank Icon** — The tray code looked for `icon.ico`/`icon.png` but only `icon.svg` existed. `nativeImage.createFromPath()` doesn't support SVG, so it silently created an empty image.

### Performance
- **Re-render Optimisations** — Stabilised `onClick` prop for custom game `GameCard` instances via `useCallback`. Replaced inline arrow functions in `CustomGameProgressDialog` (`onValueChange`, `onClick`) with memoised `useCallback` handlers to prevent unnecessary child re-renders.

---

## [1.0.22] - 2026-02-08

### Added
- **Release Calendar** — New "Releases" tab on the dashboard showing upcoming game releases on a monthly grid calendar. Powered by Steam's Coming Soon + New Releases APIs with batch `getAppDetails` enrichment. Features date parsing for various Steam date formats, forward-only month navigation, "Today" button, game tile hover tooltips with cover image/genres/platforms, and a "Coming Soon (TBD)" section for games without exact dates.
- **System Tray** — Discord-style minimize-to-tray behavior. Closing and minimizing now hide the app to the system tray instead of quitting. Tray icon with context menu (Show Ark / Quit), double-click to restore, and `before-quit` lifecycle management.
- **Hidden Auto-Start** — When Launch on Startup is enabled, the app starts hidden in the system tray via `--hidden` flag instead of showing the main window.
- **Upcoming Releases IPC** — New `steam:getUpcomingReleases` handler that combines `getComingSoon()` + `getNewReleases()`, deduplicates, and batch-fetches `getAppDetails()` with enriched release date, genre, and platform data.
- **Preload Bridge** — `getUpcomingReleases` added to the Steam bridge in `preload.cjs`.

### Changed
- **IGDB Cleanup** — Deleted `igdb-service.ts`, `igdb` types, and stale `preload.ts`. Replaced IGDB-typed interfaces in `cache-store.ts` with generic cached types. Removed legacy `useIGDBGames`, `useIGDBFilters`, `useRateLimitWarning` exports. Cleaned up `igdbId` field references across game types, library store, dashboard, and custom game components.
- **Upcoming Releases Caching** — 1-hour in-memory TTL cache on the `getUpcomingReleases` IPC handler prevents repeated Steam API calls on tab switches or React re-renders.
- **Steam Rate Limit Mitigation** — Added 500ms delay between `getAppDetails` batch requests (5 at a time) to reduce 429 errors.
- **`asarUnpack`** — Added `build/icon.png` and `build/icon.ico` so the tray icon is accessible in packaged builds.
- **Dashboard Navigation** — Extended `ViewMode` with `'calendar'`, added "Releases" tab with `CalendarDays` icon. Search, filters, and game count hidden in calendar view.

### Fixed
- **Test Mocks** — Added missing `subscribe` mock to `statusHistoryStore`, `sessionStore`, and `libraryStore` in journey-view tests. Added `onAutoDownload` mock to update-snackbar tests.
- **Test Assertions** — Fixed journey-view tests: used `getAllByText` for duplicate game titles, corrected Analytics stat card label expectations, updated Mock/Live toggle visibility test to match actual component behavior.
- **Legacy `igdbId` in tests** — Replaced all `igdbId` references with `gameId` in library-store tests.

### Performance
- All 214 tests passing across 17 test files.

---

## [1.0.21] - 2026-02-08

### Added
- **Activity Chart Tooltips** – Native SVG `<title>` tooltips on every data point in the Activity area chart; hover any dot to see exact "added" / "completed" counts for that month.
- **Custom Game Session Tracking** – `useSessionTracker` now includes custom games (negative IDs) with executable paths in the tracked-games list sent to the main process; subscribes to `customGameStore` changes for live resync.
- **Custom Game Hours Persistence** – When a tracked custom game session ends, `hoursPlayed` is written back to the `CustomGameEntry` (new optional field added to the type).
- **Recent Activity Fade Gradient** – Bottom of the scrollable Recent Activity list fades out to signal more content below.

### Changed
- **Font Size Standardisation** – Established a 3-tier font system across all analytics SVG charts: primary sub-labels (10 px), secondary details (9 px), micro/axis labels (8 px). Donut center number reduced from 22 → 20; donut sub-label 9 → 10; histogram bucket labels 7 → 8 px; histogram hover counts 8 → 9 px; area chart month labels 5.5 → 4.5; Y-axis labels 4 → 4.5.
- **Stroke Width Consistency** – Radar grid/axis lines 1 → 0.5; radar polygon outline 2 → 1.5; radar dots r 3.5 → 3, stroke 1 → 0.6. Area chart primary line 1.5 → 1; secondary (dashed) line 1.2 → 0.8. All chart grid lines now uniformly 0.5.
- **Bar & Histogram Heights** – Top Games progress bars h-1 → h-1.5 (matches Recommendation Source bars); histogram container h-16 → h-20. Stagger delays normalised to 0.08 across all animated bars.
- **Area Chart Layout** – SVG height 140 → 160; left padding 8 → 10 for Y-axis label clearance.
- **Buzz View UX** – Clicking a news card now opens the webview directly (removed separate "View" button); viewport height adjusted to prevent outer scrollbar; `allowpopups` fixed to boolean.
- **OCD Gantt View** – Sticky left sidebar with synchronised vertical scroll; improved hover highlighting across sidebar and timeline rows.
- **Removed Platform Breakdown** chart from Analytics dashboard.

### Fixed
- **Custom games not session-tracked** – `syncTrackedGames()` previously only called `libraryStore.getTrackableEntries()`, completely omitting custom games with executable paths.
- **Custom game hours never updated** – Session-end handler only called `libraryStore.updateHoursFromSessions()` which ignores negative IDs; now routes to `customGameStore.updateGame()` for custom games.

### Performance
- `JourneyGameCard` wrapped with `React.memo`; click handler memoised with `useCallback`.
- `StarRating` wrapped with `React.memo`; star-index array extracted to module-level constant.
- `AnimatedValue` (analytics) wrapped with `React.memo`.
- Store `getAll()` snapshots in `JourneyView` cached via `useRef` + subscriptions to avoid new-array-reference re-renders on every render cycle.
- `useSessionTracker.syncTrackedGames` has stable `[]` dependency array — no subscription churn.

---

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
