# Known Gaps

Items identified during security and architecture reviews that are **not safe to fix** without risking regressions, or that require significant effort / design decisions before implementation.

Last updated: 2026-02-23 (Review rounds 1–6)

---

## CRITICAL (Deferred)

### 1. Hardcoded Steam API Key
The Steam Web API key is hardcoded in `electron/steam-api.ts`. Moving it to user-provided input requires a UI for key entry, migration logic for existing users, and validation against the Steam API.

**Why deferred:** Needs new UI flow (settings panel entry + validation), migration path for existing installs, and fallback behavior if no key is provided.

### 2. SSL Certificate Validation Disabled
`NODE_TLS_REJECT_UNAUTHORIZED=0` is set in `electron/main.ts` to allow HTTPS requests to `fitgirl-repacks.site`, which has certificate issues. Re-enabling strict TLS would break FitGirl repack lookups.

**Why deferred:** The target site (`fitgirl-repacks.site`) intermittently serves invalid certificates. Fixing requires either a site-scoped TLS override (custom agent per request) or dropping FitGirl integration entirely.

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

### 30. News Service Lacks Cancellation Support
The news service (`src/services/news-service.ts`) does not support cancellation of in-flight fetch requests. If the user navigates away from the Buzz view while news is loading, the requests continue in the background.

**Why deferred:** Adding cancellation requires changing the service API signature to accept an `AbortSignal`, plus updating all call sites. The requests are lightweight and complete quickly.

### 31. Epic Catalog Limited Luminance Signals
Epic Games Store does not expose review scores or review counts via its API. Epic nodes in the galaxy map lack `steamPositivity` / `steamReviewCount` signals, but still benefit from `userRating`, `mlRecRate`, and `metacriticScore` when available. Luminance falls back to a neutral 0.5 only when all signals are absent.

**Why accepted:** Data limitation of the Epic API. Three of five luminance signals still apply to Epic games — the gap is narrower than originally documented.

### 32. Cross-Store Deduplication in Embedding Pipeline
Games available on both Steam and Epic get separate embeddings (`steam-<appid>` and `epic-<namespace>:<offerId>`). This uses extra embedding storage and ANN index space but doesn't cause incorrect behavior — both entries appear as separate nodes in the galaxy and the recommendation engine handles them as distinct candidates.

**Why accepted:** The overhead of double-embedding ~2–5K cross-listed games is <5% of the total index. Implementing cross-store dedup requires maintaining a title-matching table with fuzzy matching for name variations. The current behavior is correct, just slightly wasteful.

---

### 33. Color Theme Picker Not Wired
The Appearance tab in settings saves the selected accent color to `localStorage('ark-accent-color')`, but no code reads this value to apply it to the UI. The app uses hardcoded Tailwind fuchsia classes. Wiring the theme requires either CSS custom properties or a React context that maps the stored color to Tailwind class variants.

**Why deferred:** Requires a theme provider that dynamically swaps Tailwind classes across all components. Significant refactor touching dozens of files.

### 34. Azure OpenAI / Anthropic Settings Not Consumed
The AI Models tab saves Azure OpenAI and Anthropic configuration to localStorage, but the AI chat backend (`electron/ai-chat.ts`) only supports Ollama and Gemini providers. The settings are persisted but have no effect on AI behavior.

**Why deferred:** Integrating Azure OpenAI requires `@langchain/openai` with Azure-specific config, and Anthropic requires `@langchain/anthropic`. Both need changes to the unified LLM proxy in `ai-chat.ts` to add provider selection logic.

---

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
