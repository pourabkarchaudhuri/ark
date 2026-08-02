# Ark v1.0.60 — Phase 0 hotfix: tracker, card status, reranker, FitGirl removal

Four production-blocking bugs fixed in one release. Phase 0 of the "optimise everything except the visuals" roadmap.

## Fixed

- **Tracker sessions never end when PowerShell path snapshot fails.** After v1.0.51's async-poll rewrite, any PS timeout under AV/GPU load left `_runningPaths` populated with a stale snapshot. `isProcessRunning` returned `true` from that stale set — `missedPolls` never accumulated, `session:ended` never fired, hours climbed forever. Fix: PS-catch now clears `_runningPaths` and sets a new `_pathSnapshotStale` flag; `isProcessRunning` falls back to basename matching only when the flag is set. `session:ended` fires reliably again within 60 s of a real close.
- **Card status changes now update the grid immediately.** `useDeferredFilterSort`'s memo fingerprint had no per-game content signal, so a status pill flip left the grid rendering pre-change references — the pill snapped back until you touched a filter or reloaded. Library and custom-game stores now expose a `getVersion()` monotonic counter, dashboard folds it into the fingerprint, small library views recompute synchronously on version bumps.
- **Reranker no longer thrashes for 24 hours.** Native `/api/rerank` was missing `keep_alive: -1`. On single-GPU boxes bge-reranker unloaded every 5 min and every subsequent call paid a 30–80 s model reload — thrash-swapping with pinned arctic-embed2. Wave 3 (v1.0.59) restored ES neighbor rerank on every graph click, exposing the latent bug on every user interaction. Fix: `keep_alive: -1` in the rerank body; neighbor-rerank cache TTL bumped 45 s → 10 min so path-walking stops re-firing IPC. Expected: 24 h → ~5 min per reco cycle; interactive rerank clicks 30–80 s → <1 s.
- **FitGirl integration completely removed.** Ark no longer carries any piracy-adjacent code. `src/services/fitgirl-service.ts` deleted. All 11 reference sites in `game-details.tsx` trimmed. Test mock removed. Proxy allow-list emptied. `docs/known-gaps.md #2 (TLS bypass)` marked resolved — the bypass existed solely for FitGirl.

## Housekeeping

- `docs/known-gaps.md #33 (dead theme picker)` and `#34 (Azure/Anthropic settings not consumed)` marked resolved — both had already been fixed in-code pre-v1.0.60; the doc was stale.

---

**Tests:** 911/911 passing. Electron and renderer typecheck clean.
**Data compatibility:** No IDB migration. No user-visible resets. Existing sessions, library, embeddings all preserved.
