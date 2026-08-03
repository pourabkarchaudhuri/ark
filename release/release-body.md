# Ark v1.0.69 — Rust native sidecar for session tracking (Phase 3)

Replaces the session tracker's Windows process enumeration with a small native Rust module, removing the PowerShell subprocess spawn from the hot polling path.

## Added

- **`ark-native`** — a `napi-rs` Rust addon calling `EnumProcesses`/`OpenProcess`/`QueryFullProcessImageNameW` directly via `windows-sys`. Benchmarked at ~18ms to enumerate 567 real processes (vs. hundreds of ms for the previous `Get-Process | Select-Object Path` PowerShell round-trip).
- **Safe fallback by design** — if the native module fails to load for any reason (missing binary, wrong architecture, antivirus quarantine, corrupted install), Ark automatically falls back to the existing PowerShell-based path. No crash, no user-visible failure — just the same behavior as before this release.
- The `tasklist`-based basename-matching fallback (used for permission-denied processes neither PowerShell nor the native path can resolve a full path for) is unchanged.

## Fixed

- A build-tooling step-order bug in `build:app` (used only by the `test:electron` developer/CI test path, not the shipping build) — no user-facing impact.

## Under the hood

- New test-only seam in `native-bridge.ts` lets the fallback contract be verified with real unit tests without needing the actual compiled binary present.
- 7 new tests covering load failure, malformed module shape, call-time failure, and the successful-load path.
- Full suite: 1066 → 1073 passing. Typecheck clean on both the renderer and electron/node TypeScript projects.

---

**Full download, not incremental.** Adding the native module changes the installer's contents enough that this update downloads as a complete ~300 MB installer rather than a small differential patch — same as every Ark release (differential downloads have been off since v1.0.42).

**Tests:** 1073/1073 passing under `--no-isolate`. Electron + renderer typecheck clean. Vite build clean. Installer size delta: +~0.3 MB (native binary is 229 KB).
**Rollback:** if this release ever regresses on your machine, the native module's failure path is exercised automatically — Ark will keep working via the PowerShell fallback with only a log warning, never a crash.
