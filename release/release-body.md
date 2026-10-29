# Ark v1.0.96 — Smooth again

Today's updates made Ark stutter. This release fixes that without changing what you see.

## Fixed

- **Browse scrolls smoothly** — cards no longer grow when their price appears, which made the list jump.
- **No freeze while recommendations update** — the heavy similarity step now runs in small pieces.
- **Upcoming opens fast** — the Steam catalog is filtered in the background instead of being loaded into the window.
- **Your Ark's 3D boxes are lighter** on your graphics card and free their images when you leave.
- **Fewer background requests** — player counts and prices make far fewer calls, and game details no longer wait behind them.
- **Captain's Log** opens without a flicker.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.96/Ark-Setup-1.0.96.exe

---

**Tests:** 1715 tests (152 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**No ranking change** (Oracle engine version unchanged; golden ranking snapshot identical).
