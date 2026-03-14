# Playtime baseline implementation — gap analysis

## Summary

The implementation preserves user-entered and past hours by storing a **hoursBaseline** (hours not from session tracker) and computing **effective hours** = baseline + session total when the session tracker runs.

## Verified (no gaps)

1. **Session tracker** — Only path that writes from sessions is `updateHoursFromSessions` (library and custom). Both use migration + formula; no direct overwrite.
2. **User edits** — My Progress and any `updateEntry` / `updateGame` with `hoursPlayed` set baseline via `input.hoursPlayed - sessionStore.getTotalHours()` and store the new total.
3. **Journey store** — Only receives `hoursPlayed` from library/custom `syncProgress`/`record`; those callers pass effective hours. No direct writes.
4. **Import**
   - Library: `importData` and `importDataWithDelta` use `...entry`, so `hoursBaseline` is preserved when present in JSON.
   - Custom: load uses `...entry`; saved entries include all fields (saveToStorage writes `Array.from(this.entries.values())`).
5. **Export / persist** — Library and custom serialize full entry objects; `hoursBaseline` is included.
6. **Load from storage**
   - Library: initialize sets `{ ...entry, gameId, status, hoursPlayed, rating, addedAt, updatedAt }`; `hoursBaseline` from `...entry` is kept.
   - Custom: initialize sets `{ ...entry, id, addedAt, updatedAt }`; `hoursBaseline` is kept.
7. **Consumers** — Reco-store, galaxy-cache, journey view, showcase, badges, etc. read `hoursPlayed` from library/custom/journey; those values are effective. No code path recomputes from baseline + session.
8. **Electron/main** — No main-process code writes hours; ML handlers only consume data from renderer.

## Edge cases

- **User sets hours below session total** — Baseline is clamped to 0, so effective = session total (tracked time cannot be “erased” by editing down). Acceptable.
- **New game with initial hours** — addToLibrary/addGame do not set baseline; first `updateHoursFromSessions` migrates (baseline = max(0, hoursPlayed - sessionTotal)). Works; optional improvement below.

## Implemented improvement

When **addToLibrary** or **addGame** is called with initial `hoursPlayed` > 0, baseline is set at add-time so the model is consistent before any session update:  
`hoursBaseline = max(0, hoursPlayed - sessionStore.getTotalHours(gameId))`.  
This avoids relying only on migration for “add with initial hours” (e.g. import or future Steam sync).
