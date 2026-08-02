# Ark v1.0.65 — Steam + Epic catalogs on LevelDB

The two biggest datasets in Ark — the Steam catalog (~155k games) and Epic catalog (~2-8k games) — now live in LevelDB instead of IndexedDB, alongside a new paginated read path built specifically for their scale.

## Added

- **`store:getChunk` IPC** — a paginated chunk-read surface for large LevelDB namespaces. Instead of marshaling a ~75MB single-response payload for 155k catalog rows, callers page through 1,000 rows at a time via an exclusive cursor (`nextKey` → next `startAfter`). This is what makes the Steam catalog migration and every subsequent read safe over IPC.

## Migrated

- **Steam catalog** (`catalog-store.ts`) → LevelDB namespaces `catalog-entries` + `catalog-meta`.
- **Epic catalog** (`epic-catalog-store.ts`) → LevelDB namespaces `epic-catalog-entries` + `epic-catalog-meta`.

Both migrate one-shot from their existing IndexedDB databases the first time Ark touches them after upgrade — no re-download from Steam or Epic. IndexedDB is left in place, untouched, for one release as a rollback path.

## Hardened before ship

The migration logic went through an independent adversarial review (multiple agents, each finding independently verified by two skeptical checkers) before release. Six real bugs were found and fixed:

- The migration no longer trusts a `store.has()` "namespace is non-empty" check as proof of completeness — a crashed prior attempt that wrote a few partial batches was enough to make that check pass and permanently skip the rest. It now always re-streams the full legacy catalog while the marker is unset (safe: writes are keyed overwrites, so re-migrating is a no-op, not a duplicate).
- It no longer trusts IDB's `sync-state` meta as a proxy for "does data exist" — that meta is written non-atomically, after all entries, so a crash could leave real rows with no meta to prove it. Migration now always attempts the real stream.
- `sync-state` written to LevelDB reflects the actual migrated count, not the legacy meta's possibly-stale claim.
- The cursor's error handler now properly rejects instead of silently resolving with a truncated count.
- A failed migration attempt no longer permanently disables retries for the rest of the app session.
- Concurrent callers now share a single in-flight migration instead of racing.
- `getEntries()` (point lookups) internally chunks to 400 ids/round-trip regardless of caller chunk size — fixes a 10x rate-limiter burst from `galaxy-cache.ts`'s embedding pass.

## Under the hood

- Migration streams via an IDB cursor with async-batched writes (each hop waits for the LevelDB batch write before advancing the cursor) — no risk of the cursor racing ahead of a slow write.
- `queryForCandidates` (Oracle's candidate pre-filter) and `getAllEntries` (embedding pipeline) both page through `store:getChunk` instead of an IDB cursor. Point lookups (`getEntries`) chunk internally.
- Added `fake-indexeddb` as a devDependency so the migration's real cursor/error paths could be tested against actual IndexedDB behavior, not just mocks.
- 24 new unit tests: chunk pagination, candidate-query filtering, sync-state freshness, plus 10 dedicated migration-regression tests covering every fix above against real fake-indexeddb state.
- Full suite: 1031 → 1051 passing under `--isolate`.

## Still on the roadmap (v1.0.66+)

- Remaining IDB-backed: embeddings, `ann-index.ts`.
- Phase 2: catalog dedup+sort → main process; `SharedArrayBuffer` for embedding IPC.

---

**Tests:** 1041/1041 passing under `--isolate`. Electron + renderer typecheck clean. Vite build clean.
**Data compatibility:** both legacy IndexedDB catalogs auto-migrate on first launch, preserved for rollback.
