# Ark v1.0.88 — Smarter automatic On Hold

## Changed

- **4 weeks without play moves a game to On Hold** (it was 30 days). Ark counts your real play sessions, and never touches a game that is running.
- **You get a notice with Undo** listing the games that moved.
- **Play it again and it's back to Playing** automatically. Games you put On Hold yourself are left alone.
- **Custom games are included.**
- **New switches in Settings → Application:** Auto On Hold (on) and Auto Playing (off).

## Fixed

- Automatic status changes no longer pad your badge or Year Wrapped totals, and no longer count against a game in your recommendations. Badges you already earned are unchanged.

Recommendations are recalculated once after you update.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.88/Ark-Setup-1.0.88.exe

---

**Tests:** 1651 tests (143 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
