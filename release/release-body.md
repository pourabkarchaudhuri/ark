# Ark v1.0.76 — Oracle's graph and taste-cluster layers now work

Two parts of the recommendation engine that were effectively switched off are now live. **This release changes what Oracle recommends**, so it will recalculate once after updating.

## Fixed

- **Closeness to your favourites is now recognised.** Before, a game only counted as "related" to your library if a pre-built "similar games" list happened to name it, and that list only existed for roughly 80 of ~3,000 candidates. Oracle now also looks at which games sit closest to your strongest library games in the embedding space, so related games are found even without a list linking them.
- **Relating to several favourites now beats relating to one.** The old score hit its maximum on a single match, so one related game tied with eight. It is now weighted by how much you played and rated each game, and scales smoothly.
- **Multi-taste libraries are scored per taste.** If you love cozy farming and soulslikes, candidates are now compared against each of your taste groups instead of one blurred average. This part of the engine was unreachable in production before.
- **Game names match reliably:** editions, ™/®, accents, remasters and non-Latin titles no longer cause misses or false matches.
- **"Similar to…" names your strongest matches** instead of the first three found.
- **Your taste groups no longer reshuffle on every refresh.**
- **Removed dead work:** an old similarity pass that could never match anything is gone.

## Hardened after an independent review
Weak neighbour hits, empty/non-Latin title keys, shallow neighbour retrieval, negative similarities and main-thread cost were all found in review and fixed before this release.

## Under the hood

- The real recommendation worker can now be run end to end in tests on fixture libraries, which later releases use to compare results.
- 50 new tests across the graph layer, cluster layer, weights and the neighbour plumbing.

---

**Tests:** 1362/1362 passing under `vitest --isolate` (run twice). Typecheck clean on both TypeScript projects.
**No storage changes.** Oracle engine version is now 2.
