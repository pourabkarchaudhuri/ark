# Ark v1.0.87 — A truer Captain's Log

## Fixed

- **Games you move from Want to Play to Playing now get a "first played" date**, so they show up in the right month of the Captain's Log. Games already in your library that were missing this date are repaired from your play history when you start Ark.
- **First-played dates can't drift later** when a game is re-synced or a backup is imported.

## New in the Captain's Log

- Each month shows when a game was **Started**, put **On Hold**, **Resumed** or **Completed**.
- Changes Ark made for you (for example, the automatic On Hold after weeks without play) are tagged **auto**.
- Games with no recorded history are marked **estimated date**.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.87/Ark-Setup-1.0.87.exe

---

**Tests:** 1638 tests (141 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**No ranking change.**
