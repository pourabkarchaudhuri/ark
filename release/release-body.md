# Ark v1.0.73 — No more "stuck for hours"

This release fixes the slowness and hangs people reported in catalog syncing, embeddings and Oracle recommendations.

## Fixed

- **Oracle no longer sits on "Generating semantic embeddings…" for hours.** Before scoring, it used to send thousands of candidate games through Ollama with no time limit. Now it only prepares your own games and starts scoring within a couple of minutes at most. It also no longer pauses at 92%: the final re-ordering happens in the background.
- **Embeddings no longer stall or crawl.**
  - Ollama now processes many games per request instead of one at a time.
  - If Ollama stops answering, Ark notices within minutes instead of waiting for hours, and picks the work back up by itself when Ollama recovers.
  - One game that keeps failing is skipped after three tries instead of blocking everything.
- **Catalog syncs no longer hang or quietly come up short.**
  - A download that stalled midway used to freeze the whole sync forever.
  - Steam's "too many requests" replies used to drop batches of games. They are now retried.
  - An incomplete sync is no longer treated as complete for the day.
- **Internal storage no longer drops data.** A built-in safety limit was so tight that large reads and writes were silently rejected. This made the storage upgrade fail and restart on every launch, and caused lookups to come back mostly empty.
- **"Force re-index" really restarts.** "Pause" can no longer leave embeddings stopped after a restart, and there is now a Resume button in System Status.

## Faster everyday use

- Editing your library triggers fewer full refreshes.
- Your current recommendations stay on screen while new ones are calculated.
- Game details load without holding up the page.

## Under the hood

- New bulk-read channel for local storage. The similar-games index is saved safely (written to a temp file, then swapped in) without freezing the app.
- About 30 new regression tests. Typecheck is clean on both TypeScript projects.

---

**Tests:** All new tests pass. In the full suite, one small UI test file fails per run under parallel load. It's a different file each time, none of them touch this change, and each passes when run on its own.
**Storage:** No schema changes. CPU-only machines now use more threads for embeddings.
