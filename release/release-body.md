# Ark v1.0.71 — Hotfix: embeddings progress stuck + a Force Re-index button

Fixes live reports that "Catalog Embeddings" / "Embedding Space" progress bars get stuck below 100% and never finish, and adds a Settings escape hatch for whenever that (or suspected data corruption) happens.

## Root cause

Five separate exit paths in the catalog-embedding pipeline never wrote a terminal progress value — a network hiccup, a mid-run cancel, or even a perfectly normal "nothing changed since last time" shortcut could all leave a stale partial reading on screen forever, with no error and no way to retry short of restarting the whole app. On top of that, Steam and Epic passes shared one progress field, so Epic starting its own run could silently erase the fact Steam had just finished. The ANN index's internal "building" flag had its own version of the same bug.

## Fixed

- Every exit path in the catalog embedding pipeline (success, cancelled, skipped, and errored) now leaves progress in a clean, coherent state — either fully done or fully idle, never stuck partway.
- Steam and Epic catalog embedding progress are now tracked independently, so one can't overwrite the other's just-finished state.
- The ANN index's "building" indicator can no longer get stuck on — it's now guaranteed to clear on every exit path, including zero-work and error cases.
- A background pipeline trigger (`oracle-view.tsx`) had no error handling around its re-entry guard — a single hiccup could permanently disable it for the rest of your session. Fixed.

## Added

- **Force Re-index Catalog Embeddings** (Settings). Cancels anything in-flight and regenerates every Steam/Epic catalog embedding from scratch — including entries whose cached data might have quietly gone bad. Your library, playtime, and journey data are never touched.

## Under the hood

- 6 new tests covering the progress-state fixes and the Force Re-index bypass logic.
- Full suite: 1085 → 1091 passing. Typecheck clean on both TypeScript projects.

---

**Tests:** 1091/1091 passing under `--no-isolate` (one unrelated, pre-existing environmental flake observed and confirmed via a clean repeat run — not caused by this change). Electron + renderer typecheck clean. Vite build clean.
**No storage schema changes** — this is a pure state-management and UX fix.
