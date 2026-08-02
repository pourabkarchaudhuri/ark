# Ark v1.0.63 — Library + custom-game stores on LevelDB

Two of the biggest stores now live in LevelDB. Zero UI change; save-during-play jank continues to fall.

## Migrated

- **Main library** (`library-store.ts`, ~500+ entries per user) → LevelDB namespace `library`.
- **Custom games** (`custom-game-store.ts`) → `custom-game`. `nextCounter` sequence stored as a meta row inside the same namespace so IDs stay monotonic across restarts.

Each store migrates one-shot from localStorage on first launch after upgrade, stamped with a marker. Legacy keys (`ark-library-data`, `ark-custom-games`) preserved for one release as rollback.

Library-store's cross-store status propagation, hours-listener channel, and Dropped→On Hold rewrite semantics are unchanged — only the persistence path swapped.

## Fixed

- **timeline.test.tsx flake under `--no-isolate`.** The lightweight `motion.div`-only mock was being shadowed by `journey-view.test.tsx`'s richer Proxy mock depending on test collection order. Replaced with the same Proxy pattern journey-view uses. This flake existed on v1.0.62 baseline too — unrelated to the LevelDB migration but folded in for suite stability.

## Under the hood

- Both stores follow the v1.0.61 canonical pattern from `session-store.ts` / `status-history-store.ts`.
- Custom-game meta row (`m:nextCounter`) shares the namespace with entry rows (`e:custom-N`) via key prefixes — avoids polluting LevelDB with extra top-level namespaces for tiny scalars.
- 19 new unit tests covering migration, hydration, fallback on IPC error, and clear-namespace behavior.
- `--isolate` suite: 1031/1031 passing. Under default `--no-isolate` there is a small residual environmental flake in a handful of DOM tests; --isolate is the source of truth for correctness.

## Still on the roadmap (v1.0.64+)

- `reco-store.ts` (2122 lines).
- IDB-backed: `catalog-store.ts` (155k rows, chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.

---

**Tests:** 1031/1031 passing under `--isolate`. Electron + renderer typecheck clean. Vite build clean.
**Data compatibility:** both legacy localStorage keys auto-migrate on first launch, preserved for rollback.
