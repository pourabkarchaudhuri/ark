# Ark v1.0.46 — Oracle Accuracy + Drag, Popovers, Cross-store Sync

Combines the unshipped 1.0.45 telemetry tab fix, 1.0.46 UX/sync work, and the full Oracle BM25 accuracy replan (Phases A–F).

## Oracle accuracy

- **BM25 hybrid retrieve** — MiniSearch lexical taste query unions into the Oracle candidate pool (`QUOTA_LEXICAL ≈ 400`).
- **Shelf correctness** — Franchise umbrella gates; deep-in uses primary genre; coming-soon requires a real future date or `comingSoon` flag; shelf subtitles state the admission contract.
- **ANN distance gate** — Taste retrieval keeps neighbors under a cosine-distance ceiling (top‑500).
- **Engagement weight** — Shared centroid/ANN weight caps Want-to-Play and applies idle-quality (`activeToIdleRatio`).
- **Hard-negative mute** — Dismiss / thumbs-down stores franchise + developer; expands suppress set (franchise 14d, developer 7d, cap 200).
- **Smarter MMR** — Diversity similarity = max(genre Jaccard, same franchise → 1.0, same developer → 0.8).
- **Evidence vs intent** — Hero / Next Obsession ranks by evidence-aligned score; wishlist keeps High-priority intent boost; Stretch prefers far-from-evidence variety.
- **Cold-start** — Thin evidence libraries (<5) seed Top Sellers ∩ top genres.
- **Reranker** — Silent model pull, structured IPC, arctic-embed cosine fallback, cache-restore rerank.

## Added (UX / library)

- **Draggable carousels** — Oracle shelves + Scheduled Broadcasts strip (5 px threshold, respects buttons/links).
- **Right-click "Why recommended?"** — Cursor-anchored popover with cluster, similar-to, genres, top layer bars.
- **Cross-store status sync** — Playing / Playing Now / Completed mirrors on 100% title match across Steam/Epic.
- **Backlog excludes unannounced games** — Missing / TBA / sentinel-future dates filtered from Want-to-Play backlog.

## Fixed

- **Insights & Telemetry tab** (1.0.45) — Tab wiring restored on game-details for games with sessions.
- **Epic API dummy pages** — Offers with no description AND no image filtered at API, transform, and persist boundaries.
- **ML scoring** — No 0.5 placeholders; Completed/Playing casing; requires a real Steam-backed profile.

## Under the hood

- New services: `bm25-index`, `franchise`, `reco-shelf-rules`, `engagement-weight`, `linked-ids`, `hard-negative`, `mmr-diversity`.
- Offline eval harness: `src/test/oracle/oracle-eval.test.ts`.
- Dismiss persistence migrates bare ids → `{ gameId, at, franchiseBase?, developer? }`.

---

**Tests:** 734/734 passing.
**Data compatibility:** Dismiss localStorage migrates in-place from string[] to metadata objects. Additive library field `crossStoreSyncedFrom`.
