# Ark v1.0.93 — Honest Oracle signals

## Fixed

- **Recommendations focus on signals that work.** A thumbs-up signal used to take part of the scoring budget even if you'd never pressed thumbs-up. That share now goes to the signals that actually have data.
- **Your feedback always counts.** Thumbs-up, thumbs-down and dismissed games are used even when they aren't in the current batch of candidates.
- **Developer panel:** signals that only apply sometimes (franchises, favourite studios, thumbs, time of day) are shown as "sparse" instead of "dead", and a counter shows how much feedback you've given and how much was used.

Recommendations are recalculated once after you update.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.93/Ark-Setup-1.0.93.exe

---

**Tests:** 1696 tests (149 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
