# Ark v1.0.99 — Sturdier AI and downloads

A hardening release for the built-in local AI, model downloads, the AI router and Settings.

## Improved

- **Sturdier built-in AI** — clean stops, a smarter fallback when the graphics card runs out of memory, and tidy exits.
- **Downloads** explain folder and network-sign-in problems correctly and never leave temporary files behind.
- **AI providers** say "Needs model" when a model is missing; the role tabs and picker work with the keyboard.
- Search and Oracle stay consistent while a model change is being re-indexed.

## Known limits

Orphaned AI servers after a crash rely on the Windows job object; AMD and Intel graphics inference are not yet verified on real hardware; CPU-only reranking of very large lists is slow.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.99/Ark-Setup-1.0.99.exe

---

**Tests:** 3486 tests (332 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**Measured:** leak and speed checks against v1.0.98 all pass (docs/perf/1.0.99-measurements.md).
**Ranking:** unchanged (Oracle engine 15, embedding version 2).
