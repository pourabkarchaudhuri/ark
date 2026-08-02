# Ark v1.0.68 — Hotfix: "Waiting for embeddings" stuck indefinitely

Fixes a live issue reported after updating to v1.0.67: the Embedding Space status showed "Waiting for embeddings" indefinitely, with catalog embedding generation appearing to hang.

## Root cause

v1.0.67's storage migration for embeddings retried itself on every call after a failure — a policy that's safe for infrequently-called storage functions (like the catalog stores) but dangerous here: the affected functions run once per game during a full catalog embedding pass, up to ~163,000 times. A single transient hiccup early in that pass meant every subsequent per-game call independently kicked off a brand-new full re-migration attempt, and since the underlying cause typically failed again too, this became an unbounded retry storm — turning a one-time hiccup into an effectively permanent hang.

## Fixed

- A failed migration attempt now settles cleanly after one try per app session — no more retry storm.
- The app correctly falls back to reading your existing data through the old storage path for the rest of that session (never silently working from a partially-migrated, incomplete copy).
- The next time you launch Ark, migration retries fresh from a clean slate.

## Under the hood

- 2 tests that encoded the old (buggy) "retry on every call" expectation were rewritten to verify the fix: one simulating the exact per-game-loop retry-storm scenario (confirms zero additional migration attempts and consistently correct data across 20 repeated calls after a failure), one confirming a fresh app restart retries and succeeds normally.
- Full suite: 1065 → 1066 passing, verified clean across repeated isolated runs.

---

**Tests:** 1066/1066 passing under `--isolate` (verified via repeated isolated runs of the affected test file). Electron + renderer typecheck clean. Vite build clean.
**No storage schema changes** — this is a pure retry-logic correctness fix.
