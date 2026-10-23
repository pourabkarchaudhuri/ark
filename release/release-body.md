# Ark v1.0.75 — Groundwork for better recommendations

This release does **not** change what Oracle recommends. It adds the measuring tools and outcome logging that the upcoming recommendation fixes depend on.

## Added

- **"Oracle Layers" diagnostics** (developer panel / System Status). For the latest recommendation run it shows how many of the engine's scoring layers actually fire, each layer's weight, how many top-20 scores tie, and ML / embedding coverage — so layers that carry weight but never contribute are visible.
- **Private outcome log.** Ark now records, locally, what Oracle showed and what happened next: clicks, dismissals, thumbs, adds to library, play sessions and ratings. It is capped in size, never leaves your computer, and can never affect recommendations or slow the app.
- **Engine versioning for cached recommendations.** Saved recommendations from an older engine version are no longer reused. (One-time effect: the first launch after updating recomputes instead of restoring the old cache.)
- Ratings and finished play sessions now also update Oracle's recommendation history (they were previously never recorded there).

## Under the hood

- The recommendation engine's scoring code moved out of the background worker into a testable module — verified line-for-line identical to v1.0.74.
- 28 new tests, including tests that reproduce six real defects in the current recommendation engine, which the next releases fix one by one.

---

**Tests:** 1312/1312 passing under `vitest --isolate` (run twice). Typecheck clean on both TypeScript projects. Vite build clean.
**Known:** under `--no-isolate`, four UI test files fail on a clean v1.0.74 checkout as well (pre-existing test-order contamination).
**No storage schema changes** other than a new local `oracle-events` store.
