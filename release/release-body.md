# Ark v1.0.44 — Insights & Telemetry + Oracle Hydration

The biggest analytical feature yet, plus two long-standing bugs fixed.

## Insights & Telemetry tab (new)

Every game with recorded session history now has a third tab on its details page: **Insights & Telemetry**. Also reachable by clicking a game row on the OCD/Voyage Gantt (`/game/{id}#telemetry`).

Six analytical panels, top-to-bottom. Purely analytical — no wellness-coach language, no achievement/build/win-loss data.

- **Session Analytics** — Histogram of session length (bucketed 0-15/15-30/30-60/60-120/120-240/240+ minutes), 7×24 weekday-hour heatmap, and a stacked strip of the last 30 sessions showing duration overlaid with active-input ratio. Tiles: mean, P95, longest gap in days, sessions last 7 days.
- **Immersion Index** — Ratio of active-input time to total session length. Radial arc gauge for trailing-5 index, per-session ratio trend with rolling-5 mean overlay, active-vs-idle split for last 20 sessions. Tiles: all-time, trailing-5, highest-index session date, lowest.
- **Engagement Pacing** — Weekly frequency vs average session length as a bubble scatter (bubble size = total minutes that week), reference lines at both medians labeled with numeric thresholds. 12-week cadence bar strip below.
- **Fatigue Point Identification** — Weekly average session length over time with a linear regression trend line. Signed % change tile comparing last-4-week average to prior-4-week average. No color-coded verdict — just the slope.
- **App Stability & Overhead** — ARK's own footprint while this game runs. Two sparklines for CPU % and RSS MB, plus a latency line with p50/p95 reference bars.
- **Friction Detection** — Scatter of tracker latency vs idle-minute deltas around each sample, colored by session. Anomaly table lists rows where latency ≥ 3× median AND idle Δ ≥ 5 min. Pearson r tile.

## New instrumentation (main process)

- Every 15 s poll now wraps the process-snapshot probe with `performance.now()` to record hook latency, reads `process.memoryUsage().rss` for RSS MB, and sums `app.getAppMetrics()[*].cpu.percentCPUUsage` for CPU %.
- When any session is active, main emits a per-tick `session:telemetrySample` event per active session — feeds a 4096-sample renderer-side ring buffer.
- `ActiveSession.activeInputMs` accumulates each tick where `powerMonitor.getSystemIdleTime() < 15 s`. Persisted on the completed record as `activeInputMinutes` (added optionally to `GameSession` — no IDB migration needed).
- New `window.telemetryAPI.onSample(cb)` renderer subscription exposed via `contextBridge`.

## Bug fixes carried over

### Oracle → game-details incomplete data

**Symptom.** Clicking a game from an Oracle recommendation shelf opened a details page missing description, gallery, system requirements, and cross-store links. Clicking the same game from Browse worked fine.

**Root cause.** `scoredGameToGame` built a minimal `Game` stub from the `ScoredGame` (which carries no `epicSlug`, `epicNamespace`, `epicOfferId`, `availableOn`, or `secondaryId`). Because `prefetch-store._navTransfer` short-circuits `findGameById`, the details page received the stub, saw no enrichment keys, and skipped both `epicService.getGameDetails()` and `getProductContent()` — nothing to enrich with.

**Fix.** `scoredGameToGame` now prefers the fully-hydrated Game already in the Browse prefetch cache, merging Oracle's cover/price on top. If the game isn't cached, it parses `epicNamespace` / `epicOfferId` from the id shape `epic-{ns}:{offerId}` so the details-page Epic enrichment call can still run live. Also: `HeroCard.onClick` now calls `setNavigatingGame(scoredGameToGame(game))` before navigating — the featured hero card used to bypass nav-transfer priming.

### Steam vs Epic hero gradient — Steam side removed

Removed the Steam hero background image and the fuchsia/purple gradient fallback entirely. Both stores now share a clean flat-black hero with the same dark fade overlays. No store-specific colour, no parity gap.

---

**Tests:** 690/690 passing. Renderer + electron typecheck clean.
**Data compatibility:** No IDB migration required. No new dependencies. `activeInputMinutes` added optionally to `GameSession`; older sessions read as `undefined` (immersion falls back to `durationMinutes - idleMinutes`).
