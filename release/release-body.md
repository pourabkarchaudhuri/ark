# Ark v1.0.66 — Hotfix: Catalog Embeddings progress stuck at 0

Fixes a live issue reported by users right after updating to v1.0.65: the "Catalog Embeddings" status widget appeared frozen at 0.

## Root cause

v1.0.65 added a one-time storage migration (IndexedDB → LevelDB) for the Steam and Epic game catalogs. That migration reports its own progress (`stage: 'migrating'`), but the status panel's display logic had no branch for this new stage — it silently fell through to a blank progress bar and 0%. Since catalog embedding generation waits for catalog sync to finish before it can start, and that migration can take noticeably longer than the old direct-IndexedDB read it replaced (155k rows streamed through ~310 sequential IPC round-trips), the whole subsystem looked stuck with zero explanation.

## Fixed

- Steam Catalog and Epic Catalog status widgets now show `Migrating storage — N copied` with a visible in-progress indicator while the one-time migration runs.
- The Catalog Embeddings widget now explicitly says `Waiting for Steam Catalog sync…` instead of showing a bare blank line while it's genuinely blocked behind catalog sync.
- A failed migration attempt no longer leaves the widget stuck showing "migrating" forever — it resets to idle so a retry is visible, not silently hung.
- Epic catalog migration now publishes progress at all (previously it updated nothing during migration; Steam's did).
- Bonus fix (pre-existing, unrelated to v1.0.65, caught during this investigation): once catalog embeddings are fully up to date, the widget now shows the real vector count instead of a blank/stale value.

## Under the hood

- 5 new regression tests directly exercising `getSnapshot()`'s stage-handling for both catalogs.
- Full suite: 1051 → 1056 passing under `--isolate`. Typecheck clean.

---

**Tests:** 1056/1056 passing under `--isolate`. Electron + renderer typecheck clean. Vite build clean.
**No data migration in this release** — pure display/status-reporting fix, no storage schema changes.
