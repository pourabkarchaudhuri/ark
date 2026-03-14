# Planet of Lana II fix — gap check

**Fix:** `steamService.searchGames()` in `src/services/steam-service.ts` no longer filters results with `hasValidDeveloperInfo`. All games returned by Steam search (after fetching details) are now shown in Browse search. Category lists (Top Sellers, New Releases, Most Played, Coming Soon) still filter by `hasValidDeveloperInfo`.

**Gap check:**

| Area | Result |
|------|--------|
| **Callers** | Only `gameService.searchGames()` uses Steam search; it merges Steam + Epic and deduplicates. No code assumes Steam returns only "valid" developer games. |
| **UI** | Game cards show developer with a fallback; "Unknown Developer" / "Unknown Publisher" display correctly. |
| **Tests** | No test asserts that search results are filtered by developer. `hasValidDeveloperInfo` is still tested in isolation and is still used in category methods. `steam-service.test.ts` (19 tests) passes. |
| **Adult filter** | `adult-content-filter` does not use developer/publisher; no interaction. |
| **Single-game fetch** | `getGameDetails(appId)` returns `transformSteamGame(details)` with no developer filter; unchanged. |

**Optional follow-up:** Preserve Steam search relevance order when building the returned array (currently order follows `getMultipleAppDetails` response order, which may differ from Steam’s search order).
