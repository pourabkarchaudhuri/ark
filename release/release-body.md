# Ark v1.0.97 — Brings its own AI

Ark now runs its own local AI, so you do not need to install Ollama. It uses your graphics card when it can and falls back to the processor when it cannot.

## New

- **Built-in local AI** — Oracle's models download on first launch and run privately on your machine.
- **Pick your AI provider** — built-in, Ollama, Gemini, Azure, Anthropic, OpenAI or any compatible service, from the redesigned Settings.
- **Analytics are off by default**, with a switch in Settings.

## Fixed

- The installer no longer includes your private keys.
- Safer links, chat and embedded pages.
- About 250 fixes, and much less memory use over long sessions.

After updating, Oracle re-indexes your games once, so the first launch can take a little longer.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.97/Ark-Setup-1.0.97.exe

---

**Tests:** 3232 tests (317 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**Measured:** leak and speed checks against v1.0.96 all pass (docs/perf/1.0.97-measurements.md).
**Ranking:** Oracle engine version 15 (rankings can shift) and embedding version 2 (one re-index).
