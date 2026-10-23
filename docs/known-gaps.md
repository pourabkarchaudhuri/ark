# Known Gaps

Items identified during security and architecture reviews that are **not safe to fix** without risking regressions, or that require significant effort / design decisions before implementation.

Last updated: 2026-08-01 (Wave 3 + ES neighbor restore → v1.0.59)

---

## CRITICAL (Deferred)

### 1. Hardcoded Steam API Key
The Steam Web API key is hardcoded in `electron/steam-api.ts`. Moving it to user-provided input requires a UI for key entry, migration logic for existing users, and validation against the Steam API.

**Why deferred:** Needs new UI flow (settings panel entry + validation), migration path for existing installs, and fallback behavior if no key is provided.

### 2. SSL Certificate Validation Disabled — RESOLVED in v1.0.60
`NODE_TLS_REJECT_UNAUTHORIZED=0` was set in `electron/main.ts` solely for `fitgirl-repacks.site`. With the FitGirl integration fully removed in v1.0.60, the bypass has been reverted and strict TLS is enforced globally again.

### 3. No Content Security Policy (CSP)
The application loads resources from many external origins (Steam CDN, Epic CDN, IGDB, YouTube embeds, etc.). A strict CSP would require an exhaustive allowlist that is difficult to maintain and could break image/video loading.

**Why deferred:** The number of external CDN origins used by game cover images, trailers, and news articles makes a tight CSP impractical without significant refactoring (e.g., proxying all images through the main process).

---

## HIGH (Deferred)

### 4. Settings Encryption Key Derivation
The encryption key for API keys in `electron/settings-store.ts` is derived deterministically from `app.getPath('userData')`. Changing the derivation would invalidate all existing encrypted API keys stored by users.

**Why deferred:** Any change to key derivation requires a migration that decrypts with the old key and re-encrypts with the new key, plus handling the case where migration fails (corrupted settings file).

### 5. Auto-Updater Signature Verification Config
The `electron-updater` library handles update signature verification internally via its `app-update.yml` configuration. No additional code-level changes are needed; this is handled by the build/publish pipeline.

**Why deferred:** Already handled by `electron-builder` / `electron-updater` internals. Manual intervention could break the existing update flow.

---

## MEDIUM

### 6. `tsconfig.node.json` strict: false
TypeScript strict mode is disabled for the Electron (Node) side of the project. Enabling it would surface hundreds of type errors that need manual fixes.

### 7. No Crash Reporting / Telemetry
There is no crash reporting service (e.g., Sentry) integrated. Crashes in production are only visible if the user reports them manually.

### 8. No Data Backup Before Writes
Cache and settings files are overwritten in place (now with atomic writes via `.tmp` + rename). There is no versioned backup of previous file states.

### 9. IndexedDB Cache Unbounded Size
The renderer-side IndexedDB caches (prefetch store, image cache) have no eviction policy. On long-running installs with large libraries, this could consume significant disk space.

**Oracle note (1.0.47):** Embeddings IDB remains unbounded this pass — no LRU eviction for the embedding store yet (deferred with this item).

### 10. Three.js Bundle Weight
The splash screen uses `@react-three/fiber` + `@react-three/drei` which adds ~500 KB to the initial bundle. This is only used for the 3D splash screen animation.

### 11. Accessibility Gaps
Missing ARIA labels on interactive elements, insufficient color contrast in some themes, and no keyboard-only navigation testing has been performed.

### 12. No i18n Framework
All user-facing strings are hardcoded in English. Adding internationalization would require extracting ~500+ strings and integrating a library like `react-i18next`.

### 14. Test Coverage Gaps
The following modules have no unit tests: `session-tracker.ts`, `auto-updater.ts`, `prefetch-store.ts`, `web-search.ts`. Current test coverage is focused on data transformation and cache logic.

**Why deferred:** These are Electron main-process or complex infrastructure modules that require extensive mocking (OS-level process detection, Electron auto-updater, IDB, network). The effort-to-value ratio is low given the current stability.

---

## LOW

### 15. No Rollback Procedure in Release Docs
The release process documentation (`docs/release-process.md`) does not include steps for rolling back a bad release on GitHub or reverting the `latest.yml` pointer.

### 17. No Cross-Platform CI
The CI/CD pipeline only builds for Windows (NSIS). macOS (`.dmg`) and Linux (`.AppImage`) builds are not configured.

### 20. `game-details.tsx` Monolith (~3300 lines)
The game details page is a single massive component. Splitting it into sub-components (hero section, tabs, media carousel, reviews, etc.) would improve maintainability, code splitting, and testability.

**Why deferred:** Large refactor touching a critical user-facing page. Requires careful extraction of shared state and props threading.

### 25. No IPC Rate Limiting from Renderer
There is no rate limiting on IPC calls from the renderer process. A misbehaving renderer could flood the main process with rapid IPC calls (e.g., thousands of `steam:getAppDetails` per second).

**Why deferred:** Adding rate limiting requires deciding per-channel limits, queuing strategy, and error responses. Could break legitimate rapid-fire calls (e.g., virtual scroll loading many game details).

### 26. `sandbox: false` in BrowserWindow Configuration
The main `BrowserWindow` is created with `sandbox: false` to allow the preload script to access Node.js APIs. Electron best practices recommend `sandbox: true`.

**Why deferred:** Enabling sandbox would break the `preload.cjs` script which uses `require('electron')` and other Node APIs via `contextBridge`. Would require migrating to a fully sandboxed preload approach.

### 27. AI Chat Module-Level Mutable State
`electron/ai-chat.ts` uses module-level mutable variables (e.g., `currentModel`, `chatHistory`) that could race if multiple `ai:chat` IPC calls arrive concurrently.

**Why deferred:** Fixing requires restructuring the module to use per-request state or a proper state machine. The current single-user desktop context makes actual races unlikely.

### 28. Metacritic `reviewsCache` Unbounded
The in-memory `reviewsCache` Map in `electron/metacritic-api.ts` has no maximum size. Over very long sessions with many unique game lookups, this could grow indefinitely.

**Why deferred:** Low risk in practice (each entry is small, and users rarely look up thousands of unique games). Adding LRU eviction requires choosing a cache size and eviction policy.

### 29. Session Tracker Windows-Only
The session tracking implementation in `electron/session-tracker.ts` uses Windows-specific process detection (executable name matching). It does not work on macOS or Linux.

**Why deferred:** Cross-platform process detection requires platform-specific implementations (e.g., `ps` on macOS/Linux). The app currently only ships for Windows.

### 30. News Service Lacks Cancellation Support — DEFERRED (already mitigated at UI layer)
The service still accepts no `AbortSignal`, but the sole caller `buzz-view.tsx:1028` uses an `abortedRef.current` guard around all `setState` calls so late responses no longer cause stale-state bugs. Adding `AbortSignal` plumbing would free network sockets ~2 s sooner on nav-away but has no observable user impact. Re-evaluate if the fetches ever become expensive.

### 31. Epic Catalog Limited Luminance Signals
Epic Games Store does not expose review scores or review counts via its API. Epic nodes in the galaxy map lack `steamPositivity` / `steamReviewCount` signals, but still benefit from `userRating`, `mlRecRate`, and `metacriticScore` when available. Luminance falls back to a neutral 0.5 only when all signals are absent.

**Why accepted:** Data limitation of the Epic API. Three of five luminance signals still apply to Epic games — the gap is narrower than originally documented.

### 32. Cross-Store Deduplication in Embedding Pipeline
Games available on both Steam and Epic get separate embeddings (`steam-<appid>` and `epic-<namespace>:<offerId>`). This uses extra embedding storage and ANN index space but doesn't cause incorrect behavior — both entries appear as separate nodes in the galaxy and the recommendation engine handles them as distinct candidates.

**Why accepted:** The overhead of double-embedding ~2–5K cross-listed games is <5% of the total index. Implementing cross-store dedup requires maintaining a title-matching table with fuzzy matching for name variations. The current behavior is correct, just slightly wasteful.

### 37. Chunked Embeddings Phase A — Accepted Tradeoffs / Deferred
Phase A ships lazy dual-format facet chunks (`chunk-embeddings` + int8 pooled rows) without bumping `EMBEDDING_TEXT_VERSION` / `EMBEDDING_MODEL_VERSION` and without forcing a catalog rebuild.

**Upgrade behavior (user risk):** Existing float pooled rows keep serving until that game’s whole-text hash misses. The first rewrite for a game replaces concat-embed geometry with a weighted chunk pool for that id only — ANN neighbors for that game may shift. Unchanged games make zero Ollama calls. Kill switch: Settings → Ollama → “Facet chunk embeddings” (`ollama.embeddingChunkingEnabled`, default on).

**Phase A ANN fix (Aug 2026):** Hardened int8 pooled decode (`coerceInt8Q` for ArrayBuffer / plain arrays), library-path ANN backfill when all-cached but index not ready, and Settings → Rebuild ANN index (clear + backfill from IDB). Addresses Embedding Space “self-only” neighbors from strict decode / empty ANN.

**P0 rebuild/graph/overlay (v1.0.57):** ANN backfill collects then flushes outside IDB cursors (no `TransactionInactiveError`). Graph metrics worker transfers edge/personalization **copies** so IDB persist never sees detached buffers. Overlay is collapsed+compact only with `Super+Shift+D` / Shift+Win+D cycle.

**Phase B.1 max-sim (v1.0.58):** Chunk vectors are dual-indexed in ANN (`lib:`/`cat:` ids with `::`). Embedding Space + Similar Games use max-sim aggregation behind `ollama.chunkAnnMaxSimEnabled` (default on). Oracle taste-centroid and graph edge build stay pooled (chunk hits ignored). No forced catalog re-chunk.

**Wave 3 (v1.0.59) — shipped:**
- **ES neighbor restore** — max-sim omit usearch `excludeId`, over-fetch `k*16`, nodeMap-only draw, euclidean fallback + status chip; The Path disabled reasons hardened.
- **Idle/forced re-chunk** — Settings → Re-chunk catalog (idle); library→Steam→Epic watermarks; cancel/progress; polite during sessions; ANN upsert on write.
- **Weight-sweep harness** — Beta Settings action; synthetic MRR; does **not** auto-bump `CURRENT_POOL_VERSION` / production `CHUNK_WEIGHTS` without a recorded winner.
- **MRL-256** — `ollama.embeddingMrl256Enabled` default **off**; ANN dims 256 when on; toggle clears on-disk index (Rebuild ANN after).

---

### 33. Color Theme Picker Not Wired — RESOLVED (already removed pre-v1.0.60)
No `ark-accent-color` writes remain in the codebase and the Appearance tab does not surface a picker. Only `--ark-accent` CSS vars in `src/overlay/overlay.css` remain, and they are static (not user-configurable). No action needed.

### 34. Azure OpenAI / Anthropic Settings Not Consumed — RESOLVED (already wired pre-v1.0.60)
`electron/ai-chat.ts` now handles both providers (`azure-openai` branch at ~line 111, `anthropic` branch at ~line 138). Both providers ship as first-class picks in the chat provider dropdown. No action needed.

---

## Resolved (Blast-radius / graph feedback loop — Aug 2026)

- **#35 Graph scores reliability** — `resolveGraphScores` now prefers restore, uses a single wait deadline (8s) while building, and fire-and-forgets cold ANN builds so Oracle compute is not double-blocked. Optional background PPR seed repair when a restored graph lacks a seeded PPR buffer. Graph signals remain optional (no hard dependency); Why panel surfaces blast-radius neighbor chips when the graph is ready.
- **#36 Thumbs-up → ranking** — `getThumbsUpIds` feeds `RecoWorkerInput.thumbsUpIds`; worker mines a positive profile (`W_POSITIVE = 0.05`) mirroring thumbs-down. Oracle library signature includes a thumbs-up fingerprint; thumbs-up in the Why panel invalidates cache and refreshes. LTR / positive-example training still deferred. PPR still not wired into worker score weights.

## Resolved (Round 7 — Feb 23 2026)

The following gaps were found and fixed in the post-implementation audit:

- **Settings viewMode UI leak** — Search bar, filter button, and results header count were visible when `viewMode === 'settings'`, overlapping the settings screen. Fixed by adding `settings` to all three header guard conditions in `dashboard.tsx`.
- **Backlog Advisor >100% scores** — `genreOverlap` and `themeOverlap` were raw `.length` counts (not 0-1 ratios), causing scores >1.0. Fixed by normalizing to `count / total` and wrapping in `clamp01()`.
- **Unclamped semanticSim in layerScores** — Backlog Advisor stored raw cosine similarity (could be negative or >1) in `layerScores.semanticSimilarity`. Fixed with `clamp01()`.
- **Malformed HTML entity crash risk** — `&#0;` or `&#xFFFFFFF;` could produce invalid code points or null chars. Both decoders (renderer + Electron) now validate `cp > 0 && cp <= 0x10FFFF` before converting.
- **Unused `useMemo` import** — Removed from `settings-screen.tsx`.

## Resolved (Round 6 — Feb 23 2026)

The following gaps were fixed and removed from the active list:

- **#13** Dashboard Not Memoized — heavy child components (`GameCard`, `BuzzView`, `ReleaseCalendar`, `MedalsView`, `FilterPanel`) are all wrapped in `React.memo`.
- **#16** Tray Icon Failure Silent — error handling with `nativeImage.createEmpty()` fallback and logging added.
- **#18** Forms Lack Double-Submit Prevention — submit buttons disabled during in-flight requests in both Settings and AI Chat panels.
- **#19** `preload.cjs` Uses Raw `console.log` — single remaining call is gated by `process.env.NODE_ENV !== 'production'`.
- **#21** Duplicate EPIPE Handlers — removed from `main.ts`; canonical handlers live in `safe-logger.ts`.
- **#22** Pre-Existing TypeScript Errors — `displayedGames` removed; `isCrossStoreEpic` type error resolved.
- **#23** `libraryData` Validation in AI Handlers — added array type check and `MAX_LIBRARY_ITEMS` (500) size limit.
- **#24** `release-calendar.tsx` LazyFadeImage State Reset — moved synchronous `setState` calls from render body into a `useEffect` hook.

## Oracle engine gaps (found during R4, scheduled)
- ANN taste retrieval uses the plain taste centroid; a contrast vector (away from rejected games) shifts distances against the 0.45 ceiling. Revisit in R6 with over-fetch → filter → taste-cosine re-rank.
- Persisted graph PPR cache signature is `ann-${vectorCount}`: PPR seeded with old engagement weights is not rebuilt by the engine-version bump alone (R8).
- Stretch Picks still sort by `contentSimilarity + semanticSimilarity` where semantic includes the negative penalty (R5/R7 shelf rework).
- Explanations compare cluster vs penalised semantic percentile; use the pre-penalty percentile (R5).

## Recall gaps (found during R6, scheduled)
- Steam/Epic catalog loaders still choose genres by raw count and `rating >= 3.5` for loyal studios; they are not yet driven by the signed taste profile.
- `normalizeTitleKey` collapses same-named distinct games (e.g. Prey 2006/2017, Mafia/Mafia Definitive Edition); owning one hides the other.
- Catalogue-style shelf cards (Deals/Trending/…) have no per-card prose explanation; they use the layer-derived fallback.
- ANN query still uses a single taste centroid; multi-taste libraries could query per cluster centroid (Stage 7).

## Late-stage gaps (found during R7, scheduled)
- A restored `reranked: true` cache ignores later changes to the rerank blend/enabled settings until the next recompute (15-min TTL).
- MMR sketches are un-centred 128-d count-sketches (cosine noise ≈ ±0.1); centring against the pool mean or 256 dims would sharpen the penalty.
- Pool-wide `mmrVectors` crosses the worker boundary as boxed arrays (~3,000 × 128 numbers); a transferable Float32Array would cut the clone cost.
- Neighbor (Embedding Space) rerank still uses the old position blend and does not tier-gate.

## Feedback-loop gaps (found during R8)
- Neighbour-graph persistence is still several records (restore validates by signature only): make it one versioned record or validate array lengths on restore.
- The Oracle graph path still computes PageRank/hub/authority that only Galaxy uses; drop from the Oracle path or refresh PPR when the library changes.
- Bandit shelf-instance state (`instances`) is in memory: after an app restart the same cached compute re-counts impressions; multiple shelves of one type (several "Because you loved…") share one arm and each adds a failure but earn at most one click each.
- Bumping `EMBEDDING_CHUNK_VERSION` before a re-embed finishes would label a graph built from old vectors as current (signature is version-based, not content-based).
- A pre-hydrate merge keeps the local arm/row wholesale for touched ids (a `strong` flag or count only in the persisted row is lost for those ids).
- The first-library-change baseline logic has no direct unit test (the handler is module-private); covered by the cache-epoch tests and manual reasoning.

## Re-embed foundation gaps (found during Release A review)
- First-run migration state assumes the stored data is current. Fine while stamps are introduced without a layout change; a later release that bumps the layout should infer the data stamp from existing rows (e.g. a sample with no `layout` → legacy) instead of trusting a missing record.
- A forced pass reports `done` even when some games failed (write failures / poison-ledger skips); the library accepts 95%. After a future bump 'done' could hide a few stale rows (they self-heal via the per-row layout check). Surface a 'partial' outcome from `_runCatalogPass`.
- If more than 5% of library games can never embed (empty text / persistent Ollama rejection) a full re-index stays 'interrupted' forever; count permanently skipped games toward the threshold.
- `forceReindexCatalog` is no longer used by the UI; delete it (or fold into `forceReindexAll`) once its tests are ported.
- The 'running' record is per-profile, not per-window: a second renderer window calling `refreshMigrationState` would mark a live run interrupted. Add an owner/heartbeat if the overlay window ever imports the embedding service.
- A downgrade after a future generation bump: an old build ignores `layoutGeneration` and would load a newer index; bump the ANN meta filename together with a generation bump.
- Old builds compare the pass watermark `versionStamp` to the bare `t10m1`; after a rollback one extra cursor rescan per source occurs (nothing is re-embedded).
