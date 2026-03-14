# Porn vs M-Rated: Catalog Filter Analysis

**Goal:** Filter out **porn / sexual-content-focused games** from catalog and Top Sellers, while **keeping** proper M-rated games (e.g. GTA, horror, violent games).

---

## 1. Data sources inspected

- **Steam:** Store API `appdetails` (used in `electron/steam-api.ts`). We also inspected a live GTA V response and ran `scripts/inspect-catalog-for-adult-filter.mjs` for top-seller samples.
- **Epic / egdata:** GraphQL catalog and `api.egdata.app/offers/top-sellers` (used in `electron/epic-api.ts`, `electron/egdata-api.ts`, `src/services/epic-service.ts`, `src/services/egdata-adapter.ts`).

---

## 2. Steam catalog: what we have

From `appdetails?appids=...&cc=us&l=english`:

| Field | Type | Notes |
|-------|------|--------|
| `required_age` | string or number | e.g. `"17"`, `0`. Not sufficient: GTA is 17, many porn games may also be 17 or 18. |
| `categories` | `Array<{ id, description }>` | Store categories (Single-player, Multi-player, Co-op, Steam Cloud, etc.). No "Adult Only" category in Steam's list. |
| `genres` | `Array<{ id, description }>` | Action, Adventure, RPG, etc. Same genres for M-rated and adult games. |
| `content_descriptors` | `{ ids: number[], notes: string \| null }` | Steam's mature-content filter buckets. In sampled data, **ids 2 and 5** appear on **M-rated violence/gore** games (e.g. "Frequent Violence or Gore, General Mature Content"). So these IDs are **not** sexual-only; they cover general maturity. **Do not** filter on "has content_descriptor" alone. |
| `ratings` | `{ esrb?, pegi?, usk?, ... }` | **Not** in our current `SteamAppDetails` type but **present in API response**. `ratings.esrb.rating` is `"m"`, `"t"`, `"ao"`, etc. `ratings.esrb.descriptors` is a string (e.g. "Intense Violence\\r\\nBlood and Gore\\r\\nStrong Language"). |

**GTA V (271590) from live API:**  
- `required_age`: `"17"`  
- `content_descriptors.ids`: `[5]`  
- `ratings.esrb`: `rating: "m"`, `descriptors: "Intense Violence, Blood and Gore, Nudity, Mature Humor, Strong Language, Strong Sexual Content, Use of Drugs and Alcohol"`  

So M-rated games can have both violence and sexual content descriptors; the **rating** is what separates: **ESRB "ao" (Adults Only)** is the store’s designation for adult-only (including porn) titles.

---

## 3. Steam: recommended filter (porn vs M-rated)

- **Use:** `ratings?.esrb?.rating === 'ao'` (case-insensitive).  
  **Action:** Exclude games where ESRB rating is **Adults Only**.  
- **Do not use:**  
  - `required_age` (17 vs 18 is not reliable for porn vs M-rated).  
  - `content_descriptors.ids` (ids 2 and 5 appear on violence/mature games; not sexual-specific).  
  - `categories` / `genres` (no store category that means "porn" only).

**Implementation notes:**

- The codebase does **not** currently type or persist `ratings` from `appdetails`. Add `ratings` to the Steam app-details type (e.g. in `electron/steam-api.ts` and `src/types/steam.ts`) and ensure it’s passed through to the game model or filter step.
- Apply the filter where Steam games are added to catalog/Top Sellers (e.g. in `steam-service.ts` when building the list, or in a shared filter used by `game-service.getTopSellers()`). Exclude any game whose app-details have `ratings?.esrb?.rating === 'ao'`.

---

## 4. Epic / egdata catalog: what we have

- **tags:** `Array<{ id, name?, groupName? }>`. In egdata top-sellers, tags often have only `id` and `name` (e.g. "Action", "Horror", "Single Player", "Windows"). Epic GraphQL can return `groupName` (e.g. `"genre"`, `"feature"`).
- **categories:** `Array<{ path: string }>` or string array. Observed paths: `games/edition/base`, `games/edition`, `games`, `applications`. No "adult" or "sexual" path in the top-sellers sample.
- **customAttributes:** Key/value (e.g. productSlug, platform). No standard maturity/rating key in sampled data.

Top-sellers are mainstream; **no sexual-content tag names** appeared in the inspection. To build a sexual-content filter we need either:

- A list of **Epic tag names** that explicitly mean sexual/adult-only content (e.g. "Sexual Content", "Strong Sexual Content", "Adult Only", "Nudity" — exact strings from Epic’s tag list), or  
- Sample known adult titles from Epic/egdata and record their `tags` and `categories`.

---

## 5. Epic / egdata: recommended filter (porn vs M-rated)

- **Use:** Blocklist of **tag names** (and optionally tag **IDs**) that mean **sexual / adult-only** content.  
  Only exclude when the item has at least one such tag. **Do not** block on generic "Mature", "Violence", or "Adult" if they are used for normal M-rated games.
- **Optional:** If Epic exposes a category path or customAttribute that clearly means "adult only" or "sexual content", add that to the same filter.
- **Optional:** Maintain a small **blocklist** of `namespace:offerId` or product slugs for titles that are clearly porn but lack the above tags.

**Implementation notes:**

- Filter in one place used for both Epic GraphQL and egdata (e.g. in `epic-service.ts` when transforming an `EpicCatalogItem` to `Game`, or in `egdata-adapter.ts` before returning, or in `game-service` when merging Top Sellers). Use a shared helper e.g. `isSexualContentGame(item)` that checks tags (and optionally categories/customAttributes) against the blocklist.
- Build the tag blocklist by: (1) running the inspection script with a known adult Epic offer ID if available, or (2) consulting Epic’s tag list / docs, or (3) adding tag names as you discover them (e.g. "Sexual Content", "Strong Sexual Content", "Adult Only", "Nudity").

---

## 6. Summary table

| Store   | Reliable signal for “exclude”      | Do not use for exclusion        |
|---------|------------------------------------|----------------------------------|
| Steam   | `ratings?.esrb?.rating === 'ao'`   | required_age, content_descriptor ids, categories, genres |
| Epic    | Tag names (and optionally IDs) that mean sexual/adult-only content; optional category path or blocklist | Generic "Mature", "Violence", "Adult" tags used for normal M-rated games |

---

## 7. Script and output

- **Script:** `scripts/inspect-catalog-for-adult-filter.mjs`  
  - Fetches Steam featured top-seller app IDs and their `appdetails` (required_age, categories, genres, content_descriptors, ratings).  
  - Fetches egdata top-sellers and aggregates all tag names, tag IDs, and category paths.  
  - Writes `docs/catalog-adult-filter-inspection.json` for further analysis.
- **Optional:** Run with extra Steam app IDs:  
  `node scripts/inspect-catalog-for-adult-filter.mjs 271590 1234567`  
  to include GTA or known adult app IDs in the Steam sample.

After adding the Steam `ratings` field and the Epic sexual-content tag blocklist, use the same inspection script periodically to confirm no mainstream titles are excluded and that new adult tags are accounted for.

---

## 8. Full-catalog test (150K Steam + ~6K Epic)

To run the filter logic against the **entire** Steam catalog (~150K games) and Epic catalog (~6K games) and get a list of all excluded titles for review:

1. **Requires:** `STEAM_API_KEY` in `.env` (for Steam app list). Epic catalog uses the same GraphQL as the app (no key).
2. **Run (CLI, no window):**
   ```bash
   npm run test:adult-filter-full
   ```
   This compiles the Electron main process, starts the app with `--run-adult-filter-test`, runs the test, writes output files, then exits. **Steam takes ~50–90 minutes** (150K apps in batches of 20 with rate limiting).

3. **Output files (in `docs/`):**
   - `excluded-steam-adult-filter.json` — list of `{ appid, name }` for every Steam game with ESRB rating **Adults Only**.
   - `excluded-epic-adult-filter.json` — list of `{ title, id, namespace, matchingTags }` for every Epic item that has a sexual-content tag.
   - `adult-filter-full-catalog-summary.json` — run timestamp, totals, excluded counts, and the same lists.

4. **From inside the app:** Open DevTools and run:
   ```js
   await window.catalog.runFullCatalogAdultFilterTest()
   ```
   The promise resolves with the summary; the same three files are written to `docs/`. The window stays open; Steam will run in the background (~50–90 min) so keep the app open until it finishes.
