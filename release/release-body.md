# Ark v1.0.61 — LevelDB storage foundation

First slice of the "optimise everything except the visuals" migration. LevelDB (via `classic-level`) is now the persistence backend for the two most write-heavy stores. On first launch, your existing data is migrated one-shot from localStorage to LevelDB. Zero visible UI change; save-during-play jank on those two paths is gone.

## Added

- **`electron/storage/level-store.ts`** — single-owner LevelDB instance at `%APPDATA%/ark/leveldb`. Namespaced key layout (`{namespace}::{key}`). Public API: `get`, `getAll`, `put`, `del`, `batch`, `stream`, `has`, `clearNamespace`, `close`. JSON-encoded values, envelope-shaped errors so the renderer distinguishes `null` from transport failures.
- **`store:*` IPC surface** (`electron/ipc/store-handlers.ts`) — per-channel token-bucket rate limit (500/sec/channel keyed by `event.sender.id`) as a safety net against runaway renderer loops. Folds in Gap #25.
- **`window.store`** preload exposure. Type declarations in `src/vite-env.d.ts`.

## Migrated

- **`src/services/session-store.ts`** → namespace `session`. Public API unchanged. On first boot after upgrade, `localStorage['ark-session-history']` is copied one-shot to LevelDB and stamped with a marker. The original localStorage key is preserved for one release as rollback. If `window.store` is undefined (dev browser, test env, boot window before preload), the store transparently falls back to localStorage.
- **`src/services/status-history-store.ts`** → namespace `status-history`. Same migration + fallback pattern.

Both stores keep 300 ms-debounced writes and the exact subscribe/notify semantics. Every consumer (game-details, Voyage, Medals, telemetry, Oracle) sees no difference except that the 15-second session-tracker tick stops hitching.

## Tests

- `src/services/session-store.test.ts` — 11 new tests (previously 0). Covers localStorage fallback, LevelDB hydration + subscriber notification, IPC-error fallback, migration + marker + rollback-key preservation, marker-present skip, non-empty-namespace skip, empty-payload marker stamp, 300 ms debounce batch, `clear()` wiping the namespace.
- `src/services/status-history-store.test.ts` — 7 new tests covering public-API parity, first-boot migration, post-migration hydration, debounce burst, `clear()` behaviour.
- Full suite: **911 → 929 passing.** Electron + renderer typecheck clean. Vite build clean.

## Under the hood

- `classic-level ^3.0.0` added. Prebuilt Windows x64 binaries ship with the package — no rebuild step at electron-builder time.
- Graceful `close()` wired to `app.will-quit` so the DB flushes cleanly on shutdown.
- Rate-limit trip returns `{ error: 'rate_limited' }` and logs a warning; renderer stores never hit this in practice.

## Deferred to future releases

- **Chunked streaming** for large namespaces — ships when catalog-store (155k rows) migrates.
- **Other renderer stores** (library, journey, custom-game, reco, catalog, epic-catalog, ann-index, tracker-overhead) migrate one at a time in v1.0.62+.

---

**Data compatibility:** No user-visible reset. Existing localStorage session + status-history data is copied automatically on first launch. Rollback path is preserved.
