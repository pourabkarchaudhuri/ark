# Known Gaps

Items identified during security and architecture reviews that are **not safe to fix** without risking regressions, or that require significant effort / design decisions before implementation.

Last updated: 2026-02-09 (Review rounds 1–5)

---

## CRITICAL (Deferred)

### 1. Hardcoded Steam API Key
The Steam Web API key is hardcoded in `electron/steam-api.ts`. Moving it to user-provided input requires a UI for key entry, migration logic for existing users, and validation against the Steam API.

**Why deferred:** Needs new UI flow (settings panel entry + validation), migration path for existing installs, and fallback behavior if no key is provided. - THIS IS NOT REQUIRED. IGNORE THIS

### 2. SSL Certificate Validation Disabled
`NODE_TLS_REJECT_UNAUTHORIZED=0` is set in `electron/main.ts` to allow HTTPS requests to `fitgirl-repacks.site`, which has certificate issues. Re-enabling strict TLS would break FitGirl repack lookups.

**Why deferred:** The target site (`fitgirl-repacks.site`) intermittently serves invalid certificates. Fixing requires either a site-scoped TLS override (custom agent per request) or dropping FitGirl integration entirely. - THIS IS NOT REQUIRED. IGNORE THIS

### 3. No Content Security Policy (CSP)
The application loads resources from many external origins (Steam CDN, Epic CDN, IGDB, YouTube embeds, etc.). A strict CSP would require an exhaustive allowlist that is difficult to maintain and could break image/video loading.

**Why deferred:** The number of external CDN origins used by game cover images, trailers, and news articles makes a tight CSP impractical without significant refactoring (e.g., proxying all images through the main process). - - THIS IS NOT REQUIRED. IGNORE THIS

---

## HIGH (Deferred)

### 4. Settings Encryption Key Derivation
The encryption key for API keys in `electron/settings-store.ts` is derived deterministically from `app.getPath('userData')`. Changing the derivation would invalidate all existing encrypted API keys stored by users.

**Why deferred:** Any change to key derivation requires a migration that decrypts with the old key and re-encrypts with the new key, plus handling the case where migration fails (corrupted settings file). - THIS IS NOT REQUIRED. IGNORE THIS

### 5. Auto-Updater Signature Verification Config
The `electron-updater` library handles update signature verification internally via its `app-update.yml` configuration. No additional code-level changes are needed; this is handled by the build/publish pipeline.

**Why deferred:** Already handled by `electron-builder` / `electron-updater` internals. Manual intervention could break the existing update flow. - THIS IS NOT REQUIRED. IGNORE THIS

---

## MEDIUM

### 6. `tsconfig.node.json` strict: false
TypeScript strict mode is disabled for the Electron (Node) side of the project. Enabling it would surface hundreds of type errors that need manual fixes.
- THIS IS NOT REQUIRED. IGNORE THIS

### 7. No Crash Reporting / Telemetry
There is no crash reporting service (e.g., Sentry) integrated. Crashes in production are only visible if the user reports them manually.
- THIS IS NOT REQUIRED. IGNORE THIS

### 8. No Data Backup Before Writes
Cache and settings files are overwritten in place (now with atomic writes via `.tmp` + rename). There is no versioned backup of previous file states.
- THIS IS NOT REQUIRED. IGNORE THIS

### 9. IndexedDB Cache Unbounded Size
The renderer-side IndexedDB caches (prefetch store, image cache) have no eviction policy. On long-running installs with large libraries, this could consume significant disk space.
- THIS IS NOT REQUIRED. IGNORE THIS

### 10. Three.js Bundle Weight
The splash screen uses `@react-three/fiber` + `@react-three/drei` which adds ~500 KB to the initial bundle. This is only used for the 3D splash screen animation.
- THIS IS NOT REQUIRED. IGNORE THIS

### 11. Accessibility Gaps
Missing ARIA labels on interactive elements, insufficient color contrast in some themes, and no keyboard-only navigation testing has been performed.

### 12. No i18n Framework
All user-facing strings are hardcoded in English. Adding internationalization would require extracting ~500+ strings and integrating a library like `react-i18next`.
- THIS IS NOT REQUIRED. IGNORE THIS

### 13. Dashboard Not Memoized
The main `Dashboard` component re-renders on every state change. Heavy child components (charts, game grids) could benefit from `React.memo` and `useMemo` to reduce unnecessary re-renders.
- THIS NEEDS FIX

### 14. Test Coverage Gaps
The following modules have no unit tests: `session-tracker.ts`, `auto-updater.ts`, `prefetch-store.ts`, `web-search.ts`. Current test coverage is focused on data transformation and cache logic.
- THIS NEEDS FIX

---

## LOW

### 15. No Rollback Procedure in Release Docs
The release process documentation (`docs/release-process.md`) does not include steps for rolling back a bad release on GitHub or reverting the `latest.yml` pointer.
- THIS IS NOT REQUIRED. IGNORE THIS

### 16. Tray Icon Failure Silent
If the system tray icon fails to load (e.g., missing icon file), the error is caught but no fallback is provided. The app continues without a tray icon.
- THIS NEEDS FIX

### 17. No Cross-Platform CI
The CI/CD pipeline only builds for Windows (NSIS). macOS (`.dmg`) and Linux (`.AppImage`) builds are not configured.
- THIS IS NOT REQUIRED. IGNORE THIS

### 18. Forms Lack Double-Submit Prevention
Settings forms and the AI chat input do not disable the submit button while a request is in-flight, allowing accidental duplicate submissions.
- THIS NEEDS FIX


### 19. `preload.cjs` Uses Raw `console.log`
The preload script (`electron/preload.cjs`) uses `console.log` directly instead of the `safe-logger` wrapper because it runs in a sandboxed context before the logger module is available. **Partially fixed:** the API listing log is now gated behind `process.env.NODE_ENV !== 'production'`.
- THIS NEEDS FIX

---

## Additions from Review Rounds 3–5 (Feb 2026)

### 20. `game-details.tsx` Monolith (~3000 lines)
The game details page is a single massive component. Splitting it into sub-components (hero section, tabs, media carousel, reviews, etc.) would improve maintainability, code splitting, and testability.

**Why deferred:** Large refactor touching a critical user-facing page. Requires careful extraction of shared state and props threading.

### 21. Duplicate EPIPE Handlers
Both `electron/main.ts` and `electron/safe-logger.ts` install `process.stdout.on('error')` / `process.stderr.on('error')` handlers. Only one set is needed.

**Why deferred:** Low severity — duplicate handlers are harmless (both swallow EPIPE). Removing one requires deciding which module "owns" the handler.

### 22. Pre-Existing TypeScript Errors
Two TypeScript errors exist in the codebase:
- `src/pages/dashboard.tsx:229` — `displayedGames` declared but never read
- `src/pages/game-details.tsx:1110` — `Type 'boolean' is not assignable to type 'string | false | null | undefined'`

**Why deferred:** Both are pre-existing (not introduced by recent changes). The `game-details.tsx` error requires understanding the intended type and may cascade.

### 23. `libraryData` Validation in AI Handlers
The `ai:chat` IPC handler receives `libraryData` from the renderer but does not validate its structure or size before passing it to the LLM context. A malicious or buggy renderer could send arbitrarily large payloads.

**Why deferred:** Validating the full `libraryData` schema requires defining a strict interface and could break the AI chat feature if validation is too aggressive.

### 24. `release-calendar.tsx` LazyFadeImage State Reset
The `LazyFadeImage` component in the release calendar resets state during render (calling setState synchronously from the render function body), which can cause extra re-renders.

**Why deferred:** Fixing requires restructuring the image loading lifecycle. Risk of breaking the fade-in animation.

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
