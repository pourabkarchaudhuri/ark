# Ark v1.0.70 — Play button: launch games from Ark (Phase 4a)

Ark can now launch your games directly — no more alt-tabbing to Steam, Epic, or a desktop shortcut first.

## Added

- **Play button** on library/custom game cards (ellipsis menu + right-click menu) and on the game details page, shown for any game with a saved executable path (set via Edit Entry → Executable).
- Launching goes through the OS shell, and Ark's existing session tracker picks it up automatically — it already polls every game with a saved executable path, so there's nothing new to configure.
- Friendly error messages (via toast) if a game can't be launched — missing file, no application associated with it, etc. — instead of the click silently doing nothing.

## Fixed

- Two places that build a game's in-memory representation from its library/custom entry were silently dropping the saved executable path during the merge, which would have made the new Play button invisible outside the dedicated Library tab. Caught before shipping, not after a bug report.
- `GameCard`'s render-memoization comparator didn't account for the executable path, so setting one for the first time wouldn't have repainted an already-visible card — the same class of staleness bug fixed for status pills in v1.0.60. Fixed proactively.

## Under the hood

- `Game`'s `executablePath` field is now a real part of the type (previously reached the runtime object only through a cast that bypassed the type checker).
- New `game:launch` IPC handler validates the path (absolute, `.exe`), confirms the file exists, then calls `shell.openPath` — same validation rule session tracking already enforces.
- 12 new tests covering the launch handler's validation/success/failure contract and the Play button's render/gating/click behavior.
- Full suite: 1073 → 1085 passing. Typecheck clean on both TypeScript projects.

---

**Tests:** 1085/1085 passing under `--no-isolate`. Electron + renderer typecheck clean. Vite build clean.
**No storage schema changes.**
