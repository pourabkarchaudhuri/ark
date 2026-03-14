# Planet of Lana II — Why It Doesn’t Appear in Browse Search

## Summary

When you search for **“Planet of Lana II”** in Browse, the game can be missing for two independent reasons:

1. **Steam path:** The app is found by Steam search and details are fetched, but the **developer/publisher filter** in the app drops it because Steam’s appdetails sometimes have empty or missing `developers`/`publishers`. Those games are intentionally filtered out and never shown.
2. **Epic path:** Epic search (GraphQL or fallback) may simply **not return** this title for that query (e.g. different naming, search index, or limited catalog in the REST fallback). If Epic doesn’t return it and Steam has already dropped it, the game won’t appear.

So the root cause is either **Steam’s developer filter** removing the game after search, and/or **Epic search** not returning it. Below is the exact code path and where each cause applies.

---

## 1. Browse search flow (high level)

- User types in the Browse search box → debounced query is passed to **`useGameSearch`** (`src/hooks/useGameStore.ts`).
- Search runs in two stages:
  1. **In-memory:** `searchPrefetchedGames(query, 20)` — only contains games already loaded in the prefetch store (Top Sellers, New Releases, etc.). “Planet of Lana II” is only here if it was in one of those feeds and passed all filters.
  2. **API:** `gameService.searchGames(query, 20)` — calls **Steam** and **Epic** in parallel, then deduplicates.

So for “Planet of Lana II” to appear, it must either:

- Be in the prefetch store and match the query, or  
- Be returned by **Steam** and pass the Steam filter, and/or be returned by **Epic**.

---

## 2. Steam path (main suspect)

**Code path:**  
`gameService.searchGames` → `steamService.searchGames(query, limit)` → Electron `steam:searchGames` → `steamAPI.searchGames` (Store API `storesearch`) → renderer gets list of `{ id, name, ... }` → `steam:getMultipleAppDetails(appIds)` → for each app, `transformSteamGame(details)` → **`hasValidDeveloperInfo(game)`** → only games that pass are returned.

**Where the game can be dropped:**

1. **Steam Store search**  
   - `electron/steam-api.ts`: `searchGames()` calls  
     `https://store.steampowered.com/api/storesearch?term=...&cc=in&l=english`  
   - Results are filtered by type (`game` / `app`) and by name (DLC, season pass, etc.).  
   - If “Planet of Lana II” is returned here, its `id` is in the list sent to `getMultipleAppDetails`.

2. **App details**  
   - `getMultipleAppDetails(appIds)` fetches full appdetails for each `appId`.  
   - `src/services/steam-service.ts`: for each `{ appId, details }` we call  
     `transformSteamGame(details, libraryEntry)`.

3. **Developer/publisher in `transformSteamGame`**  
   - `src/services/steam-service.ts` (lines 74–75):
     - `developer: details.developers?.[0] || 'Unknown Developer'`
     - `publisher: details.publishers?.[0] || 'Unknown Publisher'`
   - If Steam’s appdetails have **no** `developers` or **no** `publishers` (or empty arrays), the game gets `'Unknown Developer'` and/or `'Unknown Publisher'`.

4. **Filter that removes the game**  
   - Same file, `hasValidDeveloperInfo()` (lines 144–151):
     - Invalid values: `'Unknown Developer'`, `'Unknown Publisher'`, `''`, `undefined`, `null`.
     - The game is kept only if **both** `developer` and `publisher` are valid.
   - After building the list of `Game` objects, we do:
     - `const validGames = games.filter(hasValidDeveloperInfo);`
     - Only `validGames` are returned (see around lines 384–388).

**Conclusion for Steam:**  
If Steam’s appdetails for “Planet of Lana II” have missing or empty `developers` or `publishers`, the game is **always** removed by `hasValidDeveloperInfo` and will **never** appear in Browse search from Steam, even though Steam search did return it.

---

## 3. Epic path

**Code path:**  
`gameService.searchGames` → `epicService.searchGames(query, limit)` → Electron `epic:searchGames` → `epicAPI.searchGames` in `electron/epic-api.ts`. There is **no** `hasValidDeveloperInfo`-style filter on Epic results; whatever Epic returns is transformed and passed through.

**Ways “Planet of Lana II” can be missing from Epic:**

1. **GraphQL search**  
   - Epic uses a GraphQL `searchStore` query with the user’s keyword.  
   - If the Epic catalog/search index doesn’t match “Planet of Lana II” (e.g. different title, or not indexed yet), the game won’t be in `elements` and won’t appear.

2. **Cloudflare / fallback**  
   - If GraphQL is blocked, Epic falls back to `getPromotionalCatalog()` and filters by keyword on title/description/developer.  
   - That catalog is a **subset** of the full store. If “Planet of Lana II” isn’t in that subset, Epic search returns nothing for that query.

So for Epic, the root cause is simply: **Epic search (GraphQL or fallback) does not return this game for the query “Planet of Lana II”.**

---

## 4. Prefetch store (in-memory search)

- Prefetch is filled from **category** APIs: Top Sellers, New Releases, Coming Soon, Free Games, etc.  
- Steam-side for those APIs also uses `hasValidDeveloperInfo` (e.g. `getNewReleases`, `getTopSellers`, `getComingSoon` in `steam-service.ts`).  
- So “Planet of Lana II” is only in the prefetch store if:
  - It was returned by one of those category endpoints, and  
  - It passed the developer filter (and any other filters).  

If it never passes the Steam filter in those flows, it won’t be in prefetch either, so in-memory search won’t show it.

---

## 5. Root cause summary

| Layer | What happens | Effect on “Planet of Lana II” |
|-------|----------------|--------------------------------|
| **Steam search** | Store API `storesearch` returns matching apps. | Game can be in the list. |
| **Steam app details** | `getMultipleAppDetails` returns full appdetails. | If `developers`/`publishers` are empty or missing, `transformSteamGame` sets Unknown Developer/Publisher. |
| **Steam filter** | `hasValidDeveloperInfo` keeps only games with valid developer **and** publisher. | Game is **removed** if either is unknown/empty. |
| **Epic search** | GraphQL or REST fallback returns catalog matches for the query. | Game may **not** be returned (title/index/catalog subset). |
| **Prefetch** | Built from category APIs; Steam side uses same developer filter. | Game only appears if it’s in a category feed and passes the filter. |

So:

- **Steam:** The game can be found by search but **dropped by the developer/publisher filter** when Steam’s appdetails lack developer or publisher.
- **Epic:** The game **may not be returned at all** by Epic search for “Planet of Lana II”.

If both are true, the game will not appear in Browse search. Fixing only one path (e.g. relaxing the Steam filter for search) could be enough to show it if the other store returns it; fixing both gives the best chance.

---

## 6. Code references

- **Steam search + filter:**  
  `src/services/steam-service.ts` — `searchGames()`, `transformSteamGame()`, `hasValidDeveloperInfo()`  
- **Steam IPC + Store API:**  
  `electron/ipc/steam-handlers.ts` (`steam:searchGames`, `steam:getMultipleAppDetails`),  
  `electron/steam-api.ts` — `searchGames()`, `getMultipleAppDetails()`, Store API `storesearch`  
- **Epic search:**  
  `src/services/epic-service.ts` — `searchGames()`,  
  `electron/epic-api.ts` — `searchGames()` (GraphQL + REST fallback)  
- **Unified search:**  
  `src/services/game-service.ts` — `searchGames()` (Steam + Epic in parallel, then dedupe)  
- **UI:**  
  `src/hooks/useGameStore.ts` — `useGameSearch()`, calls `searchPrefetchedGames` then `gameService.searchGames`

---

## 7. Optional next steps (no code change in this doc)

- **Verify Steam:** For the Steam app ID of “Planet of Lana II”, call the Steam appdetails API and inspect `developers` and `publishers`. If they’re empty or missing, that confirms the Steam filter as the cause for the Steam path.
- **Steam search only:** Relax or bypass `hasValidDeveloperInfo` **only for search** (e.g. in `steamService.searchGames`) so that search results still show games with unknown developer/publisher, while category lists (Top Sellers, New Releases) can keep the current filter if desired. **Implemented:** `steamService.searchGames()` no longer filters by `hasValidDeveloperInfo`; category lists still do.
- **Epic:** If Epic GraphQL/REST doesn’t return the title, that’s a data/index/catalog limitation; improving Epic search coverage would be a separate change (e.g. different query, or including more catalog sources in fallback).

This document is the re-done analysis for the “Planet of Lana II” Browse search case.
