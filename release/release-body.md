# Ark v1.0.94 — Smarter "games like yours"

## Fixed

- **Recommendations link more games to the ones you love.** The "similar to games in your library" signal used to reach only a few percent of candidates. It now finds similar games directly among the candidates, so it works for far more of them.
- **Epic games count fully.** Their game descriptions were never used for matching before; now they are.

Recommendations are recalculated once after you update.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.94/Ark-Setup-1.0.94.exe

---

**Tests:** 1701 tests (150 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
