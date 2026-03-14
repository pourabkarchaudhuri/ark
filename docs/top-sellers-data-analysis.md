# Top Sellers — Why Only 17 Games?

## Expected behavior

- **Browse → Top Sellers** should show roughly **Steam top sellers + Epic top 99 (egdata) + Epic free**, deduplicated (~100+ games when both stores contribute).
- If you only see **17 games**, the list is effectively **Steam-only**.

## Root cause (17 = Steam-only)

The count is **17** when:

1. **Steam** contributes ~17 games: Steam’s featured “top_sellers” list is fetched, then each game gets app details, and results are filtered by `hasValidDeveloperInfo`. That filter often leaves ~17 of the original ~20 items.
2. **Epic contributes 0** in the egdata path:
   - **egdata** is enabled (`window.egdata` exists and `egdata.isEnabled()` is true).
   - But the **egdata API** call (`GET https://api.egdata.app/offers/top-sellers?limit=99&skip=0`) fails or returns no elements (e.g. network error, timeout, or `EGDATA_DISABLED=1` in the main process).
   - The **Epic catalog fallback** (`epicService.browseCatalog(99)`) also returns 0, e.g. when Epic GraphQL is blocked or fails in the same environment.

So you end up with: **steam (17) + epic (0) + free (0 or merged into steam)** → **17** after dedup.

## Data flow (quick reference)

| Step | What happens |
|------|----------------|
| 1 | `gameService.getTopSellers()` decides path: **egdata** vs **non-egdata** (browser or egdata disabled). |
| 2 | **Egdata path**: `steam.getTopSellers()` + `egdata.getTopSellers(99, 0)` + `epic.getFreeGames()` in parallel. |
| 3 | If egdata returns 0 elements → fallback: `epicService.browseCatalog(99)` (Epic GraphQL). |
| 4 | Combine steam + epic + free, then `deduplicateGames()`. |
| 5 | **Non-egdata path**: steam + `epicService.browseCatalog(0)` (full catalog) + free → usually 1000s of games. |

So 17 only appears when you’re in the **egdata path** and **both** egdata and Epic catalog yield **0** Epic games.

## How to confirm

1. **Console (renderer)**  
   Look for:
   - `[Game Service] Top Sellers: steam=X epic=Y free=Z → deduped=W`  
   If you see `epic=0` and no “using Epic catalog fallback (N games)” warning, both egdata and catalog returned 0.
2. **Egdata**  
   - In Electron main: ensure `EGDATA_DISABLED` is not `'1'`.  
   - From the machine running the app, check: `https://api.egdata.app/offers/top-sellers?limit=5` (should return JSON with `elements` and `total: 99`).
3. **Epic**  
   If egdata fails, the app uses Epic’s catalog (GraphQL). If that’s blocked or fails, Epic count stays 0.

## Fixes / next steps

- **Get Epic data into Top Sellers**  
  - Fix egdata: network, timeout, or don’t set `EGDATA_DISABLED=1` if you want egdata.  
  - Or fix Epic GraphQL (so catalog fallback returns games when egdata is 0).  
- **Increase Steam count**  
  - The ~17 comes from Steam’s list + `hasValidDeveloperInfo`. Relaxing or skipping that filter for Top Sellers would show a few more Steam titles (e.g. 20), but the big gap is missing Epic; fixing Epic (egdata or catalog) is what gets you to ~99+.

## Code references

- **Top Sellers implementation**: `src/services/game-service.ts` → `getTopSellers()`.
- **Steam count/filter**: `src/services/steam-service.ts` → `getTopSellers()`, `hasValidDeveloperInfo`.
- **Egdata client**: `electron/egdata-api.ts` → `getTopSellers()`.
- **Egdata enabled check**: `electron/ipc/egdata-handlers.ts` → `egdata:isEnabled` → `process.env.EGDATA_DISABLED !== '1'`.
