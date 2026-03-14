# Epic Top Sellers: Current Implementation vs egdata — Test Results & Comparison

**Date:** 2026-03-07  
**Purpose:** Compare what “Top Sellers” shows today vs egdata’s top-sellers API, and outline integration.

---

## 1. What “Top Sellers” Uses Today (Tracker)

In Tracker, the **Top Sellers** category is the **“trending”** filter. The data comes from **prefetched** data, not a dedicated Epic top-sellers API.

**Source (from code):**

- **Prefetch** (`prefetch-store.ts`): Runs at splash. Fetches in parallel:
  - Steam: most-played (500), new releases, **top sellers**, coming soon
  - Epic: **browseCatalog(0)** (full Epic catalog, release-date sorted), getFreeGames()
- **Merged and deduped:** All arrays are concatenated and deduplicated. So “Top Sellers” in the UI = **Steam top sellers + Steam new releases + Steam coming soon + Steam most-played + full Epic catalog + Epic free games** (deduped).

**game-service.getTopSellers():**

- When prefetch is missing, it calls: `steamService.getTopSellers()` + **epicService.browseCatalog(0)** + epicService.getFreeGames(), then dedupes.
- So for Epic, Tracker **never** calls a “top sellers” endpoint. It uses the **full Epic catalog** (browseCatalog) and labels the whole combined set as “Top Sellers.”

**Result:** The **5,183** games you see under “Top Sellers” are:

- Steam top sellers (hundreds)
- Steam new releases, coming soon, most-played
- **Full Epic catalog** (thousands, sorted by release date in the Epic API, not by sales)
- Epic free games  
→ All merged and deduped. So **Epic’s contribution is the full catalog, not a top-sellers list.** Epic does not expose a public “top sellers” ranking in the GraphQL we use; Tracker has no way to show “Epic’s top 99” with the current implementation.

---

## 2. egdata Top-Sellers API — Live Call Results

**Endpoint:** `GET https://api.egdata.app/offers/top-sellers?limit=20`  
**Called:** 2026-03-07 (no auth)

**Response shape:**

- `elements`: array of full offer objects (id, namespace, title, description, keyImages, tags, seller, developerDisplayName, publisherDisplayName, releaseDate, urlSlug, **position**, etc.)
- `page`: 1  
- `limit`: 20  
- **`total`: 99**

**Top 10 (by position):**

| position | title |
|----------|--------|
| 1 | Resident Evil Requiem |
| 2 | ARC Raiders |
| 3 | Grand Theft Auto V Enhanced |
| 4 | Dead by Daylight |
| 5 | EA SPORTS FC™ 26 Standard Edition |
| 6 | Crimson Desert Standard Edition |
| 7 | World War Z Aftermath |
| 8 | WRC 10 FIA World Rally Championship |
| 9 | DEATH STRANDING 2: ON THE BEACH |
| 10 | Battlefield™ 6 |

**Conclusion:** egdata returns a **real ranked list of 99 Epic top-selling offers**, with `position` and one API call (or a few if paginating). No Epic GraphQL pagination (no 200 requests).

---

## 3. Side-by-Side Comparison

| Aspect | Tracker (current) | egdata |
|--------|-------------------|--------|
| **What “Top Sellers” shows for Epic** | Full Epic catalog (release-date sorted), mixed with Steam lists. | Ranked top **99** offers by sales (GamePosition collection). |
| **Count (Epic slice)** | Thousands (full catalog). | **99** (explicit top sellers). |
| **Epic API calls** | browseCatalog(0) = up to **200** GraphQL requests (when cache cold). | **1** (or 2–10 if paginating). |
| **Ranking** | By release date (Epic), not by sales. | By sales rank (`position`). |
| **Semantics** | “Top Sellers” label is misleading for Epic (it’s full catalog). | Matches user expectation: actual top-selling list. |

---

## 4. Test Results Summary

| Test | Tracker (current) | egdata |
|------|-------------------|--------|
| **Total items under “Top Sellers”** | ~5,183 (Steam + full Epic + dedup). | N/A (Epic-only). Epic slice = **99** when using egdata. |
| **Epic top-sellers count** | Not available (no Epic top-sellers API used). | **99** (from `total`). |
| **Sample top 5 Epic** | Undefined (Epic list is full catalog, order = release date). | Resident Evil Requiem, ARC Raiders, GTA V Enhanced, Dead by Daylight, EA SPORTS FC 26. |
| **API calls (Epic) for this view** | Up to 200 (browseCatalog) when cache miss. | 1 (or a few with pagination). |

---

## 5. Which Is Better for “Epic Top Sellers”?

- **For correctness and semantics:** **egdata is better.** It provides a real Epic top-sellers list (99 items, ranked). Tracker today does not have that; it shows the full Epic catalog under the same “Top Sellers” label.
- **For API cost and reliability:** **egdata is better.** One (or few) REST call(s) vs up to 200 Epic GraphQL requests; no Cloudflare in front of egdata.
- **For “all games” / discovery:** Tracker’s current approach (full Epic catalog in prefetch) is still useful for Browse “All” and mixed Steam+Epic; the issue is only the **label** “Top Sellers” when the Epic portion is not a top-sellers list.

So for **“Epic top selling games”** specifically: **egdata is better.** For “everything we have from both stores,” Tracker’s combined prefetch stays; we add egdata to fix the Epic slice when the user chooses Top Sellers (and optionally Epic filter).

---

## 6. How to Integrate Into the Plan

**Goal:** When the user is in **Top Sellers** (and optionally when the store filter includes Epic), show a **real Epic top-sellers list** from egdata instead of treating Epic as “full catalog.”

**Steps (no breaking changes):**

1. **New data path for Epic top sellers**
   - When category is “Top Sellers” (trending) and we need the Epic slice: call `GET https://api.egdata.app/offers/top-sellers?limit=99` (or paginate with `limit` + `skip`).
   - Map each egdata offer to Tracker’s `Game` via the adapter in `docs/egdata-api-comparison.md` (§8.11, §8.13).

2. **Merge with existing Top Sellers**
   - Keep Steam top sellers (and other Steam lists) as today.
   - For Epic: **if** we have an egdata client and the user is in Top Sellers, use egdata top-sellers for the **Epic portion** instead of the full Epic catalog from prefetch.
   - Combine: Steam top sellers + **egdata Epic top 99** (and optionally Epic free games if desired), then dedupe. So “Top Sellers” = Steam top sellers + **real Epic top 99** + any other lists you still want (e.g. Epic free), without replacing the rest of prefetch for other categories.

3. **Fallback**
   - If egdata is down or disabled: fall back to current behavior (Epic = full catalog from prefetch), so nothing breaks.

4. **Optional: filter by store**
   - When store filter is “Epic only” and category is “Top Sellers,” show **only** egdata top-sellers (99 games). When “Both,” show Steam top sellers + egdata Epic top 99 (merged/deduped).

**Result:**

- “Top Sellers” shows a **real** Epic top-sellers list (99 games from egdata) instead of 5,183 mixed games where the Epic part is the full catalog.
- No change to Library, Steam, or other categories; only the **source of the Epic slice** for Top Sellers changes when egdata is used.

---

## 7. Synopsis

- **Current:** “Top Sellers” = prefetched mix of Steam lists + **full Epic catalog** → 5,183 games. Epic part is **not** a top-sellers list; it’s the whole catalog. Your doubt is correct: 5,183 is not “how many top selling games are on Epic.”
- **egdata:** One API call returns **99** ranked Epic top sellers with correct semantics and ranking.
- **Better for Epic top sellers:** egdata. Integrate by using egdata for the **Epic slice** when category is Top Sellers (and optionally when store filter includes Epic), keep Steam and the rest of the app as-is, and fall back to current behavior if egdata is unavailable.
