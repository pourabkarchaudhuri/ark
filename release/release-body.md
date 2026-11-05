# Ark v1.0.98 — Steadier built-in AI

A hardening and polish release for the built-in local AI, the AI router and Settings.

## New and improved

- **More reliable built-in AI** — safer startup, a fallback to the processor if the graphics driver crashes, and downloads that resume and explain problems.
- **Settings and AI providers repolished** — clearer wording, better contrast, per-model tests, a keyboard-friendly side drawer.
- **Smoother Oracle and Settings** while your library is indexed, and about 24 MB less memory.
- Downloads and web requests now work behind TLS-inspecting proxies.

## Known limits

AMD and Intel graphics inference are not yet verified on real hardware; CPU-only reranking of very large lists is slow; the first AI-router start takes about 25 seconds.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.98/Ark-Setup-1.0.98.exe

---

**Tests:** 3422 tests (326 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**Measured:** leak and speed checks against v1.0.97 all pass (docs/perf/1.0.98-measurements.md).
**Ranking:** unchanged (Oracle engine 15, embedding version 2).
