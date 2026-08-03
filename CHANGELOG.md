# Changelog

All notable changes to Ark (Game Tracker) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.69] - 2026-08-03

### Added
- **Rust native sidecar (`native/ark-native`), Phase 3 of the perf plan.** A `napi-rs` crate compiled to `ark-native.win32-x64-msvc.node`, replacing the session tracker's Windows process enumeration. `session_enumerate()` calls `EnumProcesses`/`OpenProcess`/`QueryFullProcessImageNameW` (`windows-sys`) directly — no PowerShell subprocess spawn, no `Get-Process | Select-Object Path` parse. Benchmarked at ~18ms for 567 real processes (340 with resolved paths) vs. hundreds of ms for a PowerShell round-trip.
- **`electron/native-bridge.ts`** — safe wrapper around the addon. Every export degrades to `null`/`false` instead of throwing if the native module fails to load (missing binary, wrong arch, AV quarantine) or the loaded module's shape doesn't match — callers always have a working JS/PowerShell fallback path, never a crash.
- **`electron/session-tracker.ts`** — `refreshProcessSnapshot()`'s Windows branch now tries `nativeSessionEnumerate()` first; falls back to the existing PowerShell path when native is unavailable OR returns an empty result (a real Windows system always has hundreds of processes running, so an empty native result can only mean the underlying syscall failed — treated as "native unavailable," not "nothing is running"). The `tasklist`-based basename fallback (for permission-denied processes PowerShell/native can't resolve a path for) is unchanged.
- **`npm run rust:build`** script (`cd native/ark-native && napi build --platform --release`) to rebuild the addon from source.

### Fixed
- **`build:app` script had the wrong step order.** `tsc && tsc -p tsconfig.node.json` ran the frontend typecheck BEFORE building the electron/node project — but `tsconfig.json` references `tsconfig.node.json` for the shared `src/overlay/detail-level.ts` file, and TypeScript's project-reference redirect requires that referenced project's declaration output to already exist on a truly clean build (`npm run clean` wipes `dist-electron` as the first step of the same script). This only surfaced on a genuinely clean build — a stale `dist-electron` left over from a previous run masked it in most day-to-day invocations. Fixed by building `tsconfig.node.json` first. Affects `test:electron`/`test:electron:headed`/`test:electron:debug` (the only scripts that invoke `build:app`); the shipping `release`/`build` scripts were unaffected (they never ran the frontend `tsc` step at all, relying on `vite build`'s transpile-only pipeline).

### Under the hood
- Test-only seam added to `native-bridge.ts` (`__resetNativeBridgeForTests`, overridable module loader) so `nativeSessionEnumerate`/`nativeBridgeStatus`'s fallback contract is covered by real unit tests without needing an actual `.node` binary present.
- 7 new tests in `src/test/electron/native-bridge.test.ts`: load failure, malformed-module shape, call-time throw, and successful-load paths.
- `package.json`: `build.files`/`build.asarUnpack` updated so the `.node` binary ships outside `app.asar` (native modules must be unpacked to be `require()`-able) — same treatment as `preload.cjs`.
- Full suite: 1066 → 1073 passing under `--no-isolate`. Typecheck clean on both `tsconfig.json` and `tsconfig.node.json`.

## [1.0.68] - 2026-08-03

### Fixed
- **"Waiting for embeddings" progress stuck indefinitely** (live user reports following v1.0.67). Root cause: `embedding-service.ts`'s LevelDB migration gate (`migrateEmbeddingsFromIdbIfNeeded`), on a failed attempt, deliberately left both `_embedMigrationChecked` and the localStorage marker unset so "a later call retries the full stream" — matching the retry policy already shipped for `catalog-store.ts` in v1.0.65. That policy is safe there because catalog-store's dual-pathed methods are called infrequently (top-level sync orchestration). It is NOT safe in `embedding-service.ts`: `getChunksForTierGame`/`writeGameChunksAndPool` are invoked from `embedAndPersistChunkedGame`, which runs **once per game** inside the catalog embedding loop — up to ~163k iterations for a full Steam+Epic pass. A single transient migration failure early in that loop meant every one of those thousands of subsequent per-game calls independently kicked off a brand-new full re-migration attempt (re-streaming the entire library+catalog+chunks IDB data each time) — and since the underlying cause typically fails again too, this became an unbounded retry storm that manifested as the whole embedding pass — and by extension the Galaxy view's "Waiting for embeddings" status, which blocks behind it — hanging indefinitely.
  - Fixed: once a migration attempt fails, `_embedMigrationChecked` is now set immediately (no per-call retry storm) and a new `_embedMigrationFailedThisSession` flag makes `useLevelDB()` report `false` for the rest of the session — every dual-pathed read/write function correctly falls back to the complete, untouched legacy IndexedDB data instead of silently operating on a LevelDB namespace a failed migration may have only partially populated. A fresh app launch retries migration cleanly from scratch.
  - This is a narrower, call-pattern-aware retry policy than catalog-store.ts's (session-level here vs. call-level there) — documented inline so a future migration doesn't copy the wrong one for its own call pattern.

### Under the hood
- 2 of the existing migration-retry tests were rewritten: the old "second call after failure succeeds" expectation was itself the encoded bug — replaced with tests verifying (a) 20 simulated per-game-loop calls after one failure trigger zero additional migration attempts and consistently return the correct data via IDB fallback, and (b) a fresh module load (simulating app restart) retries and succeeds normally.
- Full suite: 1065 → 1066 passing under `--isolate` (3x repeat-verified clean in isolation; the full-suite run shows the same pre-existing, unrelated `--isolate` flake documented in earlier releases — different tests fail nondeterministically across repeat runs, consistent with environmental test-order sensitivity, not a regression from this fix).

## [1.0.67] - 2026-08-03

### Migrated to LevelDB
- **`src/services/embedding-service.ts`** — the last IndexedDB-backed store. Four IDB object stores (database `ark-embeddings`) migrated:
  - `embeddings` (Tier 1 library pooled embeddings) → namespace `embed-library`, key = gameId.
  - `catalog-embeddings` (Tier 2 catalog pooled embeddings) → namespace `embed-catalog`, key = gameId (steam-/epic- prefixed).
  - `chunk-embeddings` (facet chunks) → namespace `embed-chunks`, **denormalized**: one row per `(tier,gameId)` holding the full array of that game's chunks, keyed `${tier}:${gameId}`. This replaces IDB's `byTierGame` index (4 call sites) with a direct point lookup. IDB's `byGame` index (cross-tier — backing the exported `getChunksForGame`, confirmed to have zero callers anywhere in the codebase) is not separately replicated; the LevelDB path implements it via a full-namespace scan + filter, which is fine since nothing calls it.
  - `embedding-meta` (small KV: `embeddingContentEpoch`, rechunk-job watermark, `steam-catalog`/`epic-catalog` embedding-pass watermarks) → namespace `embed-meta`.
- **`ann-index.ts` needed no migration** — confirmed via full-file read that it's a pure IPC wrapper around a main-process usearch native index; it holds no renderer-side persistence at all.
- **`src/services/game-graph-store.ts`** — its `readAllEmbeddings()` used to open the shared embedding IndexedDB handle directly and hardcode the `'embeddings'`/`'catalog-embeddings'` store name strings, bypassing every public method on `embedding-service.ts`. Replaced with a call to the new exported `getAllPooledEmbeddingsForGraph()`, which handles both the LevelDB and legacy-IDB paths internally — this file no longer has any storage-backend-specific code at all.

### Fixed (encoding correctness, caught before any data hit LevelDB)
- **Int8Array does not survive `JSON.stringify`/`parse` as an array** — it round-trips as a plain object with numeric string keys (`{"0":1,"1":2,...}`), which fails every branch of `coerceInt8Q` (no `.length` property). Every LevelDB write path converts a row's `q` field to a plain `number[]` via `Array.from()` before storing (`toLevelPooled`/`toLevelChunk`); no special handling is needed on read, since `coerceInt8Q`'s array-like branch already accepts a real `Array`.

### Fixed (found by adversarial review before ship)
- **Chunk-grouping migration could silently lose chunks when one game's id is a byte-prefix of another's.** The first draft grouped chunk rows during migration by comparing the STRING `` `${tier}:${gameId}` `` while iterating IDB's cursor in primary-key (`chunkId`) order, reasoning that chunks sharing a gameId share an identical chunkId prefix and are therefore contiguous. That's false whenever one game's id is a proper prefix of another's — e.g. gameId `"42"` and gameId `"42::ghost"` produce chunkIds that *interleave* in ascending string order (`lib:42::facets#0` < `lib:42::ghost::facets#0` < `lib:42::notes#0`), causing game `"42"`'s chunks to be flushed twice, with the later flush silently overwriting — and losing — the earlier one's chunks. Fixed by iterating the `byTierGame` **compound index** instead of the primary key: IDB's compound-index comparison is on the actual `[tier, gameId]` field values, not a synthesized string, so two rows share the same index key if and only if their `tier` and `gameId` are literally equal — no prefix/separator collision is possible regardless of what characters either field contains.
- **`refreshCachedTimestamps`'s LevelDB path could burst past the IPC rate limiter on a large catalog pass.** Unlike its sibling `getCatalogEmbeddingsForIds` (already chunked to 400 ids/round-trip), this function fired every `window.store.get()` in one unchunked `Promise.all` — for the thousands of ids a full catalog scan can accumulate, calls beyond the rate limiter's burst budget silently returned `rate_limited` and were dropped, meaning those entries' TTL never got refreshed. Fixed to chunk identically to `getCatalogEmbeddingsForIds`.

### Under the hood
- Same hardened migration pattern established in v1.0.65 (and refined after that release's adversarial review found 6 real bugs): no `store.has()`-based "already migrated" shortcut, no trust in a single meta value's presence as proof data exists, marker + counts stamped only after a full successful stream using actual migrated counts, a failed attempt never permanently blocks retry, concurrent callers share one in-flight migration via a memoized promise.
- `writeGameChunksAndPool` (previously one atomic IDB transaction spanning `chunk-embeddings` + a pooled store) now issues one atomic `window.store.batch()` call spanning both LevelDB namespaces — same all-or-nothing guarantee, callers still correctly skip ANN-upsert/watermark-advance on rejection.
- 9 new unit tests using `fake-indexeddb` against the real migration/cursor code, including a dedicated regression test reproducing the exact `"42"` / `"42::ghost"` adjacency-collision scenario found by review.
- Full suite: 1056 → 1065 passing under `--isolate`. Typecheck clean.
- Adversarially reviewed (3 dimensions, 2 independent skeptical verifiers per finding, 2 candidates found and both confirmed real) before ship.

## [1.0.66] - 2026-08-02

### Fixed
- **"Catalog Embeddings" progress stuck at 0 after updating to 1.0.65** (live user reports). Root cause: v1.0.65 added a `'migrating'` stage to `CatalogSyncProgress` (`catalog-store.ts`) for the one-time IDB→LevelDB migration, but `system-status.ts`'s `getSnapshot()` never learned to handle it — the Steam Catalog widget's `detail`/`percent` ternary chains had no branch for `'migrating'`, so it fell through to a blank string / 0%, while `stage` still reported `'running'`. Because the embedding pipeline (`startCatalogEmbeddingPipeline` in `oracle-view.tsx`) awaits `catalogStore.sync()` — which now blocks on this migration — before it can even start, and that migration can take noticeably longer than the old raw-IDB-cursor path (155k rows streamed through ~310 sequential `store:batch` IPC round-trips), the whole subsystem looked frozen with zero explanation during what is otherwise ordinary one-time migration work.
  - `system-status.ts`: Steam Catalog and Epic Catalog widgets now show `Migrating storage — N copied` and a non-zero indicative percent while `stage === 'migrating'`.
  - `system-status.ts`: the Catalog Embeddings widget now shows `Waiting for Steam Catalog sync…` instead of a bare blank string while it's genuinely blocked behind catalog sync/migration.
  - `epic-catalog-store.ts`: added a `'migrating'` stage to `EpicCatalogSyncProgress` and wired `_syncProgress` updates into its migration loop — it previously published no progress at all during migration (Steam's migration already did; this brings Epic to parity).
  - `catalog-store.ts` + `epic-catalog-store.ts`: a failed migration attempt now resets `_syncProgress`/`stage` back to `'idle'` in the catch block — previously a failure left the widget stuck displaying `'migrating'` indefinitely until a later successful retry, with no visible indication anything had gone wrong.
- **Pre-existing cosmetic gap** (not introduced in v1.0.65, but fixed while investigating): once catalog embeddings are fully up to date and a pass finds nothing new to embed, `embedding-service.ts`'s `_catalogProgress` was never updated to reflect the scanned total — the widget showed a blank/stale value instead of the real vector count. Fixed for both the Steam and Epic catalog embedding passes.

### Under the hood
- 5 new unit tests in `system-status.test.ts` covering the `'migrating'` stage for both catalogs and the "waiting on sync" messaging.
- Full suite: 1051 → 1056 passing under `--isolate`. Typecheck clean.

## [1.0.65] - 2026-08-02

### Added
- **`store:getChunk` IPC** — paginated chunk-read surface for large LevelDB namespaces. `electron/storage/level-store.ts`'s `getChunkImpl` iterates with `gt`/`gte` bounds (exclusive `startAfter` cursor when supplied), returning `{ rows, nextKey, done }`; `done` is true whenever the returned slice is shorter than `limit`, so callers loop until a short/empty page. Wired through `electron/ipc/store-handlers.ts` (`store:getChunk`, same rate-limit middleware as every other store channel) and `electron/preload.cjs` (`window.store.getChunk`). `src/vite-env.d.ts` gains `StoreChunkResult<T>` + the `getChunk` method on `StoreAPI`.

### Migrated to LevelDB
- **`src/services/catalog-store.ts`** — the ~155k-row Steam catalog. Two new namespaces: `catalog-entries` (per-appid rows, key = `String(appid)`) and `catalog-meta` (`tag-name-map`, `sync-state`). One-shot migration (`migrateFromIdbIfNeeded`) streams every legacy IDB row via a cursor (500-row async-batched hops that don't `cursor.continue()` until the LevelDB batch write resolves) and copies both meta rows; guarded by a `localStorage` marker (`ark-steam-catalog-migrated-v1`) plus a `store.has()` check so a missed marker never double-migrates. `queryForCandidates` and `getAllEntries` page through the namespace via `store.getChunk` (1000 rows/hop) instead of an IDB cursor; `getEntries` (point lookups) fans out to parallel `store.get` calls. IndexedDB (`ark-steam-catalog`) is left in place, untouched, as a one-release rollback path.
- **`src/services/epic-catalog-store.ts`** — the Epic catalog (~2-8k games). Namespaces `epic-catalog-entries` (key = `epicId`, i.e. `namespace:offerId`) and `epic-catalog-meta` (`sync-state`). Same migration pattern and marker convention (`ark-epic-catalog-migrated-v1`) as the Steam catalog.

### Fixed (found by adversarial multi-pass review before ship)
The one-shot IDB→LevelDB migration went through an independent multi-agent adversarial review pass (3 dimensions × 2 skeptical verifiers per finding) before release. Six real bugs were confirmed and fixed in both `catalog-store.ts` and `epic-catalog-store.ts`:
- **`store.has()`-true no longer proves a prior migration fully completed.** The original migration skipped re-migrating if the LevelDB entries namespace was merely non-empty — but a crashed prior attempt that wrote only a few batches also makes `has()` return true, permanently orphaning every un-migrated row. Fixed: the migration no longer trusts `has()` as a completeness signal at all. It always re-streams the full IDB `entries` store while the marker is unset; this is safe because `levelPutBatch`/writes are keyed overwrites (by `appid` / `epicId`), so re-migrating already-present rows is a no-op in effect, not a duplicate.
- **A missing/zero legacy `sync-state` meta no longer skips real data.** The old code trusted IDB's `sync-state.totalEntries` (written non-atomically, after all entry batches) as a proxy for "any rows exist." A crash between the last entry write and that trailing meta write left real rows in IDB with no meta to prove it — and migration silently skipped them forever. Fixed: migration no longer gates on `sync-state` at all; it always attempts the real cursor stream, which correctly costs near-nothing when IDB is genuinely empty.
- **`sync-state` written to LevelDB now uses the actual migrated count**, not whatever the legacy IDB meta claimed (which could be stale or absent).
- **The IDB cursor's `onerror` handler now rejects** (with the real `IDBRequest.error`) instead of silently resolving with a truncated count and letting the caller believe migration fully succeeded.
- **A failed migration attempt no longer permanently disables retries.** The in-session guard is only set after real success (or a confirmed-already-migrated marker) — a transient IPC hiccup no longer locks the store into treating IDB-only reads as "already migrated: nothing more to do" for the rest of the process lifetime.
- **Concurrent callers now share a single in-flight migration** via a memoized promise, instead of each independently racing its own `has()` check and one prematurely declaring victory while another is still streaming.
- **`getEntries()` (point lookups) now internally chunks to 400 ids per IPC round-trip**, regardless of how many ids a caller passes in one call — `galaxy-cache.ts`'s embedding-enrichment pass was calling it with chunks of 5,000, 10x the rate-limiter's per-tick burst budget.

### Under the hood
- Both catalog stores keep a `useLevelDB()` gate checked per-call (not cached at construction) since these are lazily-constructed singletons with no async init step — the check is a cheap `typeof window.store !== 'undefined'`.
- `CatalogStore` and `EpicCatalogStore` classes exported (previously module-private) to allow direct instantiation in tests.
- Added `fake-indexeddb` as a devDependency so the migration's real cursor/error-handling paths could be exercised against an actual (fake) IndexedDB in tests, rather than only mocked shortcuts.
- 24 new unit tests: chunked-pagination correctness (exact multiples of `LEVEL_CHUNK_SIZE`, partial final page), `queryForCandidates` genre/developer/publisher/popularity filtering, point-lookup `getEntries`, sync-state freshness/TTL, and 10 dedicated migration-regression tests (partial-data-doesn't-shortcut, missing-meta-doesn't-skip, actual-count-not-legacy-count, retry-after-failure, concurrent-callers-share-one-attempt) against real fake-indexeddb state.
- Full suite: 1031 → 1051 passing under `--isolate`. Typecheck (both tsconfig.json and tsconfig.node.json) clean.

### Deferred to v1.0.66+
- Remaining IDB-backed stores: embeddings, `ann-index.ts`.
- Phase 2 (Node-side heavy work): catalog dedup+sort move to main process; `SharedArrayBuffer` for embedding IPC.

## [1.0.64] - 2026-08-02

### Migrated to LevelDB
- **`src/services/reco-store.ts`** — the Oracle 15-minute cold-start result cache. Single row `results` under namespace `reco-cache`. `saveResultsToCache` fire-and-forgets an async LevelDB put on the LevelDB path (same contract as the localStorage path — errors ignored). `loadResultsFromCache` is now async; it awaits a LevelDB `get`, falls back to the localStorage row on IPC error, and runs a one-shot migration copying `ark-oracle-results` -> LevelDB the first time the row is missing (stamped with marker `ark-oracle-results-migrated-v1`). `clearResultsCache` wipes both paths.
- **Caller updated**: `compute()` now `await`s the async cache load. This was the only call site.

### Under the hood
- Reco-store had no constructor, so `_useLevelDB` is captured lazily on first access via a getter (`_useLevelDBCached`). Matches the same gate semantics as the constructor-based stores from prior releases.
- Legacy TTL semantics preserved — 15-minute window, library-signature check, pipeline-stage-gain check. Restore is still refused when any of them fails.

### Deferred to v1.0.65+
- IDB-backed stores: `catalog-store.ts` (155k rows, chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.
- No new unit tests for `reco-store.ts` in this release — the cache paths are integration-heavy and would require mocking ~15 dependent stores. Coverage will be added as part of the catalog-store migration when the test scaffolding for cross-store IPC settles.

## [1.0.63] - 2026-08-02

### Migrated to LevelDB
- **`src/services/library-store.ts`** → namespace `library`. Per-entry rows keyed by `gameId`; legacy key `ark-library-data` preserved with marker `ark-library-data-migrated-v1`. Ingest path (`ingestEntries`) is shared between the LevelDB hydrate path and the localStorage fallback so v5 migration (numeric→string gameId) + Dropped→On Hold rewrite semantics stay identical. 10 new tests.
- **`src/services/custom-game-store.ts`** → namespace `custom-game`. Entry rows keyed as `e:{id}`; the `nextCounter` sequence stored as a meta row `m:nextCounter` under the same namespace, so ID monotonicity survives across restarts and entry deletions. Legacy key `ark-custom-games` preserved with marker `ark-custom-games-migrated-v1`. 9 new tests.

### Fixed
- **Pre-existing timeline.test.tsx flake under `--no-isolate` mode.** The lightweight `motion.div`-only mock was being shadowed by `journey-view.test.tsx`'s richer Proxy mock depending on test collection order under `pool: 'forks', isolate: false`. Replaced timeline's mock with the same Proxy pattern journey-view uses. Baseline flake existed even without the v1.0.63 changes — the fix is an unrelated but necessary robustness upgrade.

### Under the hood
- Both stores follow the v1.0.61 canonical pattern (`session-store.ts`, `status-history-store.ts`): `_useLevelDB` gate at construction, sync reads via in-memory cache, async LevelDB hydrate on init, one-shot migration with marker + legacy-key preservation, fallback on IPC error or missing `window.store`, `clear()` wipes namespace + legacy key + marker.
- Library-store: hours-listener channel and cross-store status-propagation logic untouched — only the persistence path swapped.
- Custom-game-store: `nextCounter` meta row is a shared-namespace design that avoids polluting LevelDB with extra top-level namespaces for tiny scalars. `initializeFromLevelDB` filters rows by prefix (`e:` vs `m:nextCounter`).
- Under `--isolate` mode: full suite 1031/1031 passing.

### Deferred to v1.0.64+
- `reco-store.ts` (2122 lines, most surface area next).
- IDB-backed stores: `catalog-store.ts` (155k rows, needs chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.

## [1.0.62] - 2026-08-02

### Migrated to LevelDB
- **`src/services/journey-store.ts`** → namespace `journey`. Per-entry rows keyed by `gameId`; carries the version marker; migration key `ark-journey-history-migrated-v1`. 14 new tests.
- **`src/services/reco-history-store.ts`** → namespace `reco-history`. Two collections (dismissals + conversion) sharing the namespace via key prefixes `d:` and `h:`; two legacy keys carried (`ark-reco-dismissed-v1`, `ark-reco-history-v1`) with separate markers; added 300 ms debounce (none existed prior). 11 new tests.
- **`src/services/shelf-bandit-store.ts`** → namespace `shelf-bandit`. Row keys are shelf-type strings; single legacy key `ark-shelf-bandit-v1`; added 300 ms debounce. 11 new tests.
- **`src/services/transmissions-history-store.ts`** → namespace `transmissions-history`. Per-id rows, `MAX_IDS=2000` cap preserved via Set-order trimming; legacy key `ark-transmissions-decoded`. 10 new tests.
- **`src/services/transmissions-archive-store.ts`** → namespace `transmissions-archive`. Per-id rows carrying full `SavedTransmission` value; legacy key `ark-transmissions-archive`. 11 new tests.
- **`src/services/badge-unlock-timestamps.ts`** → namespace `badge-unlock-timestamps`. Per-badge-id timestamp rows; legacy key `ark-badge-unlock-timestamps`. 11 new tests.
- **`src/services/user-marks-store.ts`** → namespace `user-marks`. Banners + constellations demuxed by prefix; legacy banner key `ark.userMarks.banners.v1`. 15 new tests.

### Fixed
- **Cross-test mock leak in v1.0.61's new test files.** The 8 new test files created in v1.0.61 used `vi.restoreAllMocks()` in `afterEach`, which resets ALL `vi.fn()` mocks globally under `--no-isolate` mode — breaking `similar-titles-reco.test.ts`'s `annIndex.queryWithDistances` mock when that test ran after any of them (test-ordering dependent). Replaced with the narrower `vi.unstubAllGlobals()` across all 8 new test files. Verified full suite runs green: 1012/1012.

### Under the hood
- Migration pattern is now stable and reference implementations are `session-store.ts` + `status-history-store.ts` from v1.0.61.
- Every migrated store: `_useLevelDB` gate captured at construction, sync reads via in-memory cache, async LevelDB hydrate on init, one-shot migration with marker + legacy-key preservation, fallback to legacy path on IPC error or when `window.store` is undefined, `clear()` wipes namespace + legacy key + marker.
- Full test suite: 929 → 1012 passing (+83 net).

### Deferred to v1.0.63+
- Larger stores that need extra care: `library-store.ts`, `custom-game-store.ts`, `reco-store.ts`.
- IDB-backed stores: `catalog-store.ts` (155k rows, needs chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.

## [1.0.61] - 2026-08-02

### Added
- **LevelDB storage foundation.** New main-process module `electron/storage/level-store.ts` — single-owner `classic-level` instance at `%APPDATA%/ark/leveldb` with a namespace-prefixed key layout (`{namespace}::{key}`). Public API: `get`, `getAll`, `put`, `del`, `batch`, `stream`, `has`, `clearNamespace`, `close`. Values are JSON-encoded; errors surface as envelope shapes (`{ error }`) so the renderer can distinguish `null` values from transport failures. Graceful shutdown on `app.will-quit`.
- **`store:*` IPC surface** (`electron/ipc/store-handlers.ts`) — wires the LevelStore API to the renderer via Electron IPC. Per-channel token-bucket rate limiting (500 calls/sec/channel keyed by `event.sender.id`) as a safety net against runaway renderer loops (Gap #25 fold-in).
- **`window.store` preload exposure** (`electron/preload.cjs`) — matches the pattern of `window.ollama` / `window.updater`. TypeScript declarations in `src/vite-env.d.ts`.
- **Two proof-of-concept store migrations.**
  - `src/services/session-store.ts` — namespace `session`. Public API unchanged (sync reads via in-memory cache; async hydrate on `initialize()`). One-shot migration from `localStorage['ark-session-history']` to LevelDB on first boot after upgrade, stamped with `localStorage['ark-session-history-migrated-v1']`. Original key preserved for one release as rollback. Fallback to localStorage path when `window.store` is undefined (dev browser, tests, boot window before preload).
  - `src/services/status-history-store.ts` — namespace `status-history`. Same pattern.
- **Test coverage for the migration paths** — `session-store.test.ts` (11 new tests, previously 0) and `status-history-store.test.ts` (7 new tests). Full suite grew 911 → 929 passing.

### Under the hood
- `classic-level ^3.0.0` added to `package.json:dependencies`. Ships prebuilt Windows x64 binaries; no rebuild step needed at electron-builder time.
- Session-store write path still 300 ms-debounced; delta batch includes `del` ops for entries that disappeared. Fire-and-forget async so `importData()`'s sync contract is preserved.
- Status-history-store constructor is fully sync for boot-time consumers; `initializeAsync()` runs the LevelDB hydrate + `notifyListeners()` so any subscriber that rendered off stale localStorage repaints.

### Deferred
- Chunked streaming for large namespaces — the `store:stream` IPC handler ships in a follow-up release when catalog-store (155k rows) migrates.
- Other renderer stores (library, journey, custom-game, reco, catalog, epic-catalog, ann-index, tracker-overhead) migrate in subsequent v1.0.62+ releases.

## [1.0.60] - 2026-08-01

### Fixed
- **Tracker sessions never end when PowerShell path snapshot fails.** `electron/session-tracker.ts:149-176` — the PS `Get-Process | Select-Object Path` catch block used to `return` early "to avoid clobbering the previous path set." Meanwhile the `tasklist` basename snapshot on line 136 was already refreshed with fresh data (game absent). `isProcessRunning:191` then hit the primary path-check first and returned `true` from the stale `_runningPaths`, so `missedPolls` never incremented and `MISSES_BEFORE_END` never tripped. Fix: PS-catch now clears `_runningPaths` AND sets a new module-level `_pathSnapshotStale` flag; `isProcessRunning` gates the primary check on `!_pathSnapshotStale`, falling back to basename matching only. Same guard applied to the outer `tasklist`-failed catch. `session:ended` now fires within 60 s (4 × 15 s missed polls) of a real close again. Latent since v1.0.51's async-poll rewrite; v1.0.54/57 patched surface symptoms without touching this branch.
- **Card status selection appeared broken.** `src/hooks/useDeferredFilterSort.ts:35, 498, 472-495` — the memo fingerprint only tracked `currentGames.length | first.id | last.id | filters | sort | viewMode`, with no per-game content signal. A status pill change went through the store correctly but the fingerprint was unchanged (length + endpoint IDs identical), so the deferred effect short-circuited and `output.sortedGames` still held pre-change object references. `GameCard.memo` then saw no change and the pill visually snapped back. Fix: added `LibraryStore.getVersion()` + `CustomGameStore.getVersion()` monotonic counters (bumped on every non-hours mutation), dashboard subscribes via `useSyncExternalStore` and passes the combined number as new `libraryVersion` input, fingerprint folds it in, and small library views (≤500 items) recompute synchronously on version bumps.
- **Reranker took 24 hours to process a normal reco cycle.** `electron/ipc/ollama-handlers.ts:108` — the native `/api/rerank` request body was missing `keep_alive: -1`. `bge-reranker-v2-m3` (~1.2 GB) unloaded after Ollama's default 5-min idle and every subsequent call paid a 30–80 s model reload. On single-GPU boxes it thrash-swapped with pinned arctic-embed2 (v1.0.40 pinned embeddings but this rerank path was missed). The 120 s timeout silently absorbed every reload — nothing ever errored, just ran forever. Wave 3 (v1.0.59) restored ES neighbor rerank at three ann-graph click sites, exposing the latent bug on every user interaction. Fix: `keep_alive: -1` added to the rerank body; neighbor-rerank cache TTL bumped 45 s → 10 min in `src/services/ollama-rerank.ts:15` so ES path-walking stops re-firing IPC for the same anchor. Expected wall-clock: 24 h → ~5 min for a full reco cycle; interactive ES rerank click 30–80 s → <1 s.
- **All FitGirl / piracy-adjacent code removed.** Deleted `src/services/fitgirl-service.ts`. Trimmed all references in `src/pages/game-details.tsx` (11 sites: import, state hooks, reset, fetch effect, prop passing at two sites, type declaration, destructure, render block). Removed test mock in `src/test/pages/game-details.test.tsx`. Emptied `PROXY_FETCH_ALLOWED_DOMAINS` in `electron/ipc/proxy-handlers.ts:14`. `docs/known-gaps.md #2` marked resolved because the TLS bypass existed solely for FitGirl. `CHANGELOG.md` / `changelog-modal.tsx` history entries mentioning FitGirl preserved as past-release record.
- **Stale known-gaps entries corrected** — `#33 (color theme picker not wired)` and `#34 (Azure OpenAI / Anthropic settings not consumed)` both already resolved in-code pre-v1.0.60. Doc updated to reflect reality.

## [1.0.59] - 2026-08-01

Wave 3 + Embedding Space neighbor restore.

### Fixed
- **Embedding Space neighbor lines empty after Phase B.1** — max-sim no longer passes `excludeId` into usearch (chunk self-hits burned top-k); over-fetch `k*16`; draw only neighbors with galaxy `nodeMap` entries; euclidean spatial fallback + status chip when ANN empty/rebuilding.
- **The Path silent no-op** — clearer disabled reasons when journey games lack galaxy positions; Explore Path expands neighbors via the fixed query helper.

### Added
- **Idle/forced re-chunk** — Settings → Ollama → Re-chunk catalog (idle): library first, then Steam/Epic catalog with progress/cancel, watermark-safe cursor, polite pause during sessions; ANN upsert on writes; Rebuild ANN recommended when done.
- **Weight-sweep harness** (Beta) — synthetic MRR over `CHUNK_WEIGHTS` perturbations; does not auto-change production weights without a recorded winner + `CURRENT_POOL_VERSION` bump.
- **MRL-256 flag** — `ollama.embeddingMrl256Enabled` (default off); ANN uses 256-d prefixes; toggling clears the on-disk index for rebuild.

### Changed
- Secondary neighbor web uses the same max-sim over-fetch scale as primary.
- Known-gaps §37 Wave 3 marked shipped (MRL default off).

### Preserved
- Overlay two-level + Shift+Win+D; closes on game exit; no mouse forward.
- No Timeshear / Cartographer / Monuments.
- Oracle/graph stay pooled; Rebuild ANN + What’s New intact.

## [1.0.58] - 2026-08-01

Published ship for the P0 rebuild/graph/overlay work + Phase B.1 (no separate Latest 1.0.57).

### Fixed
- **ANN Rebuild TransactionInactiveError** — `_backfillAnnIndex` collects IDB pages with sync `cursor.continue`, then flushes `addVectors` outside the transaction. Settings shows determinate progress and surfaces failures.
- **Graph build DataCloneError** — metrics worker transfers edge/personalization **copies**; originals stay attached for adjacency + IDB persist.
- **Overlay phantom session after game close** — session-end always destroys the HUD HWND (repairs Settings/hotkey latch desync). Timer does not restart at 0:00 after exit.

### Added
- **Phase B.1 multi-vector ANN max-sim** — Rebuild/backfill ingests facet chunk ids alongside pooled game vectors. Embedding Space + Similar Games aggregate with max-sim when `ollama.chunkAnnMaxSimEnabled` is on (default). Kill switch restores pooled-only. Oracle and graph stay pooled.

### Changed
- **Overlay two levels only** — collapsed ↔ compact; cycle **Shift+Win+D** (`Super+Shift+D`). Legacy `expanded` → compact. Click-through without `{ forward: true }`.
- Settings → Ollama **Chunk ANN max-sim** toggle; Rebuild progress counts pooled + chunk vectors.

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
