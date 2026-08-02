# Ark v1.0.62 — LevelDB store batch migration

Seven more stores moved from localStorage to LevelDB. Zero visible UI change; save-during-play jank continues to fall.

## Migrated

- **Voyage journey** (`journey-store.ts`) → LevelDB namespace `journey`.
- **Oracle reco history** (`reco-history-store.ts`) → `reco-history`. Two collections (dismissals + conversion) share the namespace via key prefixes.
- **Oracle shelf-bandit ordering** (`shelf-bandit-store.ts`) → `shelf-bandit`.
- **Transmissions decoded** (`transmissions-history-store.ts`) → `transmissions-history`.
- **Transmissions archive** (`transmissions-archive-store.ts`) → `transmissions-archive`.
- **Badge-unlock timestamps** (`badge-unlock-timestamps.ts`) → `badge-unlock-timestamps`.
- **User marks** (banners + constellations, `user-marks-store.ts`) → `user-marks`.

Each store migrates one-shot from localStorage on first launch after upgrade, stamped with a marker. Legacy keys preserved for one release as rollback.

## Fixed

- **Cross-test mock leak in v1.0.61's new test files.** The 8 store test files added in v1.0.61 called `vi.restoreAllMocks()` in `afterEach`, which reset ALL `vi.fn()` mocks globally under `--no-isolate` mode. That broke `similar-titles-reco.test.ts`'s `annIndex.queryWithDistances` mock in the full suite run (though it passed in isolation). Fix: replaced with the narrower `vi.unstubAllGlobals()`. Full suite now 1012/1012 green.

## Under the hood

- Migration pattern (from v1.0.61 canonical references `session-store.ts` + `status-history-store.ts`): `_useLevelDB` gate at construction, sync reads via in-memory cache, async LevelDB hydrate on init, one-shot migration with marker + legacy-key preservation, fallback on IPC error or missing `window.store`, `clear()` wipes namespace + legacy key + marker.
- 83 new unit tests. Full suite: 929 → 1012 passing.
- No IDB migration required. No user-visible reset.

## Still on the roadmap (v1.0.63+)

- `library-store.ts` + `custom-game-store.ts` + `reco-store.ts` (bigger surface, needs care).
- IDB-backed: `catalog-store.ts` (155k rows, chunked streaming), `epic-catalog-store.ts`, embeddings, `ann-index.ts`.

---

**Tests:** 1012/1012 passing. Electron + renderer typecheck clean. Vite build clean.
**Data compatibility:** all seven legacy localStorage keys auto-migrated on first launch, preserved for rollback.
