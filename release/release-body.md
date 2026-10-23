# Ark v1.0.74 — Wrapped is back, and the stuck spots are gone

This release brings Ark Wrapped back, fixes the problems people reported (a catalog sync stuck at 100%, crashes after Force Re-index, and a jumpy loader while rebuilding), and smooths out the Embedding Space.

## Ark Wrapped

- Rebuilt: animations are smoother, the stats cover your whole year (including games you added in earlier years), saved images work, and it fits small windows.
- From 15 December through 2 January, a banner and a single desktop notification invite you to open your year in review.

## Fixed

- **Steam catalog sync no longer sits at 100%.** You can now see when it is retrying batches Steam rate-limited, and the retry round stops after a short time. The next sync fetches only the games it missed, instead of starting over.
- **Force Re-index no longer crashes Ark.** Rebuilding the similarity index while embeddings are running no longer makes the loader jump back and forth; the two jobs now take turns safely. A damaged index file is detected and rebuilt automatically.
- **The reranker now shows its work.** Oracle, the Embedding Space and System Status show which reranker ran and how many games it moved. A cached "Ollama is down" result no longer switches it off for the whole session.
- **Playtime is tracked from launch**, even when Ark starts hidden, and survives a crash.
- Games you just set to Playing are no longer flipped to On Hold.
- One unreadable item can no longer roll your library back to an old copy.

## Embedding Space

- A new loading screen with a real percentage and plain-language messages.
- No more giant pink glow in Approach view.
- More relevant neighbours: a minimum similarity is required, and a matching brand name or a weak reranker can no longer override real similarity.
- Searching for a game far away now flies you there properly: the camera rises out of the field, travels, and dives in.

## Also new

- Library status changes show instantly.
- Settings has a batch-size slider with a live graphics-memory meter that warns when the setting is too high.
- Setting names are now plain language.
- After repeated crashes, Ark starts in safe mode, which skips heavy background work.

---

**Tests:** 1,284/1,284 passing, with each test file now run in isolation. Both TypeScript projects typecheck cleanly.
**Storage:** No schema changes. New files in the app's data folder: `pending-sessions.json` (sessions queued until saved) and `boot-health.json` (crash counter).
