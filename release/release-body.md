# Ark v1.0.45 — Insights & Telemetry tab fix

Hotfix for v1.0.44.

## Insights & Telemetry tab was never rendering

**Symptom.** v1.0.44's release notes described a new "Insights & Telemetry" tab on game-details, but the tab never showed up in the app.

**Root cause.** The v1.0.44 commit shipped all of the supporting code — the six analytical panels, the pure derivations module, session-tracker instrumentation (CPU/RAM/hook-latency sampling, active-input tracking), the `window.telemetryAPI` preload bridge, and the OCD Gantt deep-link — but the actual integration into `src/pages/game-details.tsx` (the lazy import, the `sessionStore` import, the `TelemetryTab` lazy const, the `hasSessions`/`defaultTab` derivation, the third `TabsTrigger`, and its matching `TabsContent`) did not make it into that commit. A concurrent editing session touching the same file for an unrelated Oracle-hydration fix landed its changes last, and the tab wiring was silently dropped. Nothing in the test suite asserted on tab *count*, so it passed clean.

**Fix.** Re-applied all six integration edits in isolation, verified via `git diff --stat` that only `game-details.tsx` was touched, and confirmed the tab now renders as a third `TabsTrigger` ("Insights & Telemetry") next to My Progress and Game Details — gated on `sessionStore.getForGame(id).length > 0`.

---

**Tests:** Full suite + isolated `game-details.test.tsx` (29/29) passing. tsc clean.
**Data compatibility:** No IDB migration required. No new dependencies.
