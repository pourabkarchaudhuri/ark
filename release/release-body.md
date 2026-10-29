# Ark v1.0.86 — Accurate player counts

## Fixed

- **No more "1 playing now" on huge games.** Some Steam store pages (recent Call of Duty titles) play through a shared launcher, so Steam reports almost no players for the page itself. Ark now shows the launcher's real count for those, and hides counts that can't be right (a handful of players on a game with hundreds of reviews).
- **Missing counts stay blank** instead of being treated as zero.
- **Counts stay fresh:** they refresh every 10 minutes and load for cards further down Browse as you scroll.
- **Better recommendations:** a missing or wrong player count no longer makes a famous game look like an obscure hidden gem.

Recommendations are recalculated once after you update.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.86/Ark-Setup-1.0.86.exe

---

**Tests:** 1628 tests (140 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
