# Ark v1.0.72 — Embedding Space, rebuilt

The Embedding Space has been rebuilt from the ground up. It's now one continuous dive from a view of the whole galaxy down to a single game and its closest matches.

## New

- **Three depths.** Scroll from **Cosmos** (the whole catalog as a galaxy) through **Approach** into **Node** view. The depth rail and zone pills show where you are and jump between depths.
- **Neighbour webs.** Pick a game to see its 12 most similar games as glowing links with orbiting systems. Step through them with ← / →, dive deeper with ↓, and come back with ↑. Each focused neighbour shows its own secondary web.
- **The Path.** Every game you've played, in the order you first played it, drawn as a ribbon through the galaxy. See the whole route at once, then hop stop by stop.
- **Tools.** Lasso (L) a region to see which genres live there. Probe mode (P) lets you fly freely. You can also filter by genre, jump in from your library, and save a high-resolution screenshot.

## Faster and lighter

- Shaders warm up in the background, so the first approach, selection and hop don't stutter.
- Quality adapts automatically on slower GPUs.
- The view drops to almost no GPU use while Ark is in the background (for example, while you're in a game).
- About 158 MB of unused sky textures were removed from the install.

## Under the hood

- New feature module at `src/features/embedding-space/` replaces `ann-graph-view.tsx`. Removed features that aren't part of the new design: constellation namer, narrator, scanner selection and user marks.
- Local build outputs now go to `release/builds/<version>/`. A new `npm run release:prune` command cleans up old ones.
- 17 new tests. Typecheck is clean on both TypeScript projects.

---

**Tests:** All new tests pass. In the full suite, 2 timing-sensitive tests in unrelated, unchanged files failed under parallel load; both pass when re-run on their own.
**Storage:** No schema changes. Two IndexedDB stores used only by the removed features (`ark-user-marks`, `ark-constellations`) are no longer read.
