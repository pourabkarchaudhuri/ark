# Ark 1.0.49

Broader release shipping the full working tree — reranker fixes, Oracle drawer polish, Voyage analytics dashboards, in-game overlay HUD, and Oracle feedback/graph-scoring groundwork.

## Qwen3 reranker pull, migration, and honest fallback
- Default Qwen3 tag corrected to `dengcao/Qwen3-Reranker-0.6B:Q8_0` (the old `qwen3-reranker:0.6b` tag never existed in the Ollama registry and silently 404'd).
- Existing installs auto-migrate the legacy tag on load; custom user tags are left alone.
- Background pull progress now surfaces the **real** Ollama error when a download fails (HTTP code, network message, timeout) instead of a generic "could not download".
- Tier ladder still probes native `/api/rerank`, then Qwen3, then arctic-embed cosine — but when the runtime or model cannot produce usable graded scores, Ark tiers down to cosine honestly. Status UI reports the resolved tier; we do **not** claim graded Qwen3 scoring is working end-to-end yet.

## Oracle Why drawer polish
- Score breakdown opens expanded by default so layer bars are visible without an extra click.
- Drawer scroll-into-view uses instant positioning (`behavior: 'auto'`) to avoid jank when opening from shelf cards.
- Taste DNA drawer body memoized so toggling Why/DNA panels does not re-render the radar chart and cluster chips.
- Blast-radius evidence chips appear in the Why drawer when graph metrics are ready (hidden silently otherwise).
- Thumbs-up in the drawer invalidates and refreshes Oracle so positive feedback re-ranks shelves while the drawer stays open.

## Voyage Scenes & Audit analytics dashboards
- **Scenes** — new analytics band: session-length histogram, weekday×hour rhythm heatmap, play cadence, streak counters, and shared Session Analytics / Pacing panels from Insights & Telemetry.
- **Audit** — data-quality dashboard: record-quality trend, status distribution, open-items chart, and aggregate quality gauges layered above the existing health rings and rule queue.

## In-game overlay HUD (opt-in)
- Transparent, click-through, always-on-top corner badge showing game name + live session timer while a tracked game runs.
- Non-injecting Electron window (same trust class as Discord/OBS overlays). Disabled by default; toggle in Settings. Global hotkey `Ctrl+Shift+O` while enabled.
- Reuses the existing preload/session bridge; `backgroundThrottling: false` keeps the HUD clock alive when the game has focus.

## Oracle feedback & graph scoring groundwork
- Thumbs-up feedback mined into a positive feature profile (shared with worker scoring); Oracle cache fingerprint includes thumbs-up IDs.
- Graph metrics resolver extracted (`resolveGraphScores`): prefers restore, single capped wait, fire-and-forget on cold miss — Oracle compute no longer blocks on an 8 s ANN graph build every run.
- New vitest coverage: rerank model tag migration, blast-radius evidence, thumbs-up re-rank, graph-score resolution.

## Tests
- 808/808 vitest passing; tsc clean.
