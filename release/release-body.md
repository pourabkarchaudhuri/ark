# Ark v1.0.95 — Recommendations for more games

## Fixed

- **The recommendation model now scores far more games.** It used to know only Steam games up to 2023. Now it also scores Epic games and newer Steam games from their store details (reviews, price, platforms, genres). Those scores count for a bit less, because there is less to go on.

Recommendations are recalculated once after you update.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.95/Ark-Setup-1.0.95.exe

---

**Tests:** 1707 tests (151 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects. Synthesis gate (`scripts/ml/verify-synth.ts`) passed.
