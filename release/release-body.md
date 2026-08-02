# Ark v1.0.64 — Oracle result cache on LevelDB

The Oracle 15-minute cold-start cache now lives in LevelDB. One less localStorage row on the write path.

## Migrated

- **Oracle result cache** (`reco-store.ts`) → LevelDB namespace `reco-cache`, row key `results`. Single row; TTL 15 min. Migrates one-shot from `ark-oracle-results` (localStorage) on first launch after upgrade so an existing cached run isn't lost.

Behavior otherwise unchanged: same 15-min window, same library-signature check, same pipeline-stage-gain check. Restore is refused when any of those fail, same as before.

## Under the hood

- `saveResultsToCache` fire-and-forgets the async LevelDB put (matches legacy localStorage "errors ignored" contract).
- `loadResultsFromCache` is now async; the only caller (`compute()`) already `await`s.
- `clearResultsCache` wipes both LevelDB row and legacy localStorage key.
- No test coverage added — reco-store has ~15 dependent stores; test scaffolding will land with the catalog-store migration.

## Still on the roadmap (v1.0.65+)

- IDB-backed: `catalog-store.ts` (155k rows, chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.

---

**Tests:** unchanged — no new tests. Full suite still 1031/1031 under `--isolate`. Electron + renderer typecheck clean. Vite build clean.
**Data compatibility:** `ark-oracle-results` in localStorage is auto-migrated on first launch, preserved for rollback.
