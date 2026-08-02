# Ark v1.0.67 — Embeddings on LevelDB (Phase 1 complete)

The last IndexedDB-backed store — your library embeddings, catalog embeddings, and the facet chunks Oracle uses to score recommendations — now lives in LevelDB. This completes the storage migration started in v1.0.61: every part of Ark now shares one consistent storage layer.

## Migrated

- **Library embeddings** (Tier 1) → LevelDB namespace `embed-library`.
- **Catalog embeddings** (Tier 2, Steam + Epic) → `embed-catalog`.
- **Facet chunks** → `embed-chunks`, denormalized to one row per (tier, game) holding that game's full chunk array — replaces an IndexedDB index with a direct storage lookup.
- **Embedding metadata** (content-change counter, re-chunk progress, sync watermarks) → `embed-meta`.

`ann-index.ts` needed no migration — it's a pure IPC bridge to a native index that lives entirely in the main process, with nothing persisted in the renderer.

One file (`game-graph-store.ts`) used to read the embeddings database directly, bypassing the normal code path — it now goes through the same public interface as everything else, so it can never silently drift out of sync with a future storage change.

## Hardened before ship

An independent adversarial review found and fixed two real issues before this release went out:

- **A data-loss edge case in the migration itself.** The chunk-data migration grouped a game's data by comparing text strings during a database scan. In a rare case — if one game's internal ID happened to be a exact starting substring of another's — this could cause part of a game's chunk data to be silently dropped during the one-time copy. Fixed by switching to a lookup method that compares the actual values, not their string representation, which is immune to this class of collision no matter what a game's ID contains.
- **A rate-limiting edge case in the background maintenance path** for very large catalogs (only relevant with many thousands of unchanged entries in one pass) — a background "keep this entry fresh" step could silently skip some entries once too many fired in the same instant. Fixed to process in smaller batches, matching the pattern already used elsewhere.

## Under the hood

- Same hardened migration pattern from v1.0.65: no premature "already migrated" shortcuts, real counts only recorded after a full successful copy, a failed attempt never permanently blocks a retry, and simultaneous requests share one in-progress migration instead of racing each other.
- 9 new tests using a real (simulated) database to exercise the actual migration and cursor code, including a dedicated test reproducing the exact ID-collision scenario found by review.
- Full suite: 1056 → 1065 passing under `--isolate`. Typecheck clean.

## Milestone: Phase 1 complete

With this release, every piece of Ark's persistent storage — library, sessions, journey, custom games, recommendations, catalogs, and now embeddings — runs on LevelDB. No more IndexedDB writes blocking the render thread; save-during-play jank is gone everywhere it used to happen.

---

**Tests:** 1065/1065 passing under `--isolate`. Electron + renderer typecheck clean. Vite build clean.
**Data compatibility:** all four legacy IndexedDB embedding stores auto-migrate on first launch, preserved for rollback.
