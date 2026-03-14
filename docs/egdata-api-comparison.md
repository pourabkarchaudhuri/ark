# egdata-api vs Tracker — Exploratory & Comparative Analysis

**Date:** 2026-03-07  
**egdata-api:** [https://github.com/egdata-app/egdata-api](https://github.com/egdata-app/egdata-api)  
**Live API:** [https://api.egdata.app](https://api.egdata.app)  
**Tracker:** This repo (Steam + Epic catalog, enrichment, recommendations)

---

## 1. Overview

### egdata-api (egdata.app)

- **Stack:** Hono, GraphQL (Apollo), MongoDB, Redis, TypeScript, Bun.
- **Focus:** Epic Games Store data only (offers, items, prices, promotions, profiles, achievements).
- **Deployment:** Public at `https://api.egdata.app` and `https://api-gcp.egdata.app`; health: Redis + MongoDB.
- **Auth:** Optional (Discord, Epic launcher); many endpoints work without auth.

### Tracker (this app)

- **Stack:** Electron + React, Vite, Steam Web API + Epic GraphQL/REST, local stores (IndexedDB/SQLite).
- **Focus:** Multi-store (Steam + Epic), library management, recommendations (Oracle: LightGBM + HNSW embeddings), release calendar, journey tracking.
- **Data sources:** Direct Steam API; Epic store GraphQL (behind Cloudflare) + REST fallback (`freeGamesPromotions`); no third-party Epic aggregator.

---

## 2. Actual API Calls to egdata.app

All calls below were made to the **live** API (no auth).

### 2.1 Root / health

| Endpoint | Result |
|----------|--------|
| `GET https://api.egdata.app/` | `200` — app name, version, list of all routes. |
| `GET https://api.egdata.app/health` | `200` — `{"status":"ok","services":{"redis":{"status":"ok","latency":1},"mongodb":{"status":"ok","latency":3}}}` |

### 2.2 Top sellers

| Endpoint | Result |
|----------|--------|
| `GET https://api.egdata.app/offers/top-sellers?limit=5` | `200` — Paginated list of **99** top-selling Epic offers. |

**Sample response (first item):**

- `id`, `namespace`, `title`, `description`, `offerType`, `effectiveDate`, `keyImages`, `seller`, `tags`, `developerDisplayName`, `publisherDisplayName`, `releaseDate`, `urlSlug`, etc.
- **Top 5 titles returned:** Resident Evil Requiem, ARC Raiders, Grand Theft Auto V Enhanced, Dead by Daylight, EA SPORTS FC™ 26 Standard Edition.
- **Total:** `"total":99` (egdata exposes 99 top sellers; Tracker does not have a dedicated “Epic top sellers” list from Epic’s own API).

### 2.3 Latest games (catalog slice)

| Endpoint | Result |
|----------|--------|
| `GET https://api.egdata.app/latest-games?country=US` | `200` — 25 offers, sorted by `creationDate` desc, with **regional price** (PriceEngine) for US. |

- Same offer shape as top-sellers; includes `price` object (e.g. `discountPrice`, `originalPrice`, `currencyCode`).

### 2.4 Featured

| Endpoint | Result |
|----------|--------|
| `GET https://api.egdata.app/featured` | `200` — Curated featured games (e.g. Resident Evil Requiem, Docked, John Carpenter’s Toxic Commando, Honkai: Star Rail, Out of Words). |

- No pagination in response; fixed featured set.

### 2.5 Enrichment: price + related

| Endpoint | Result |
|----------|--------|
| `GET https://api.egdata.app/offers/03c9e4679725466891f8d72c832dcc01/price?country=US` | `200` — Single offer’s price for US: `discountPrice: 6999`, `originalPrice: 6999`, `currencyCode: "USD"`, `region: "US"`. |
| `GET https://api.egdata.app/offers/03c9e4679725466891f8d72c832dcc01/related` | `200` — **Related offers** (e.g. Resident Evil Requiem Deluxe Edition, other editions, DLC). Each with embedded `price` for the region. |

- **Related:** Returns same namespace/franchise (editions, DLC); useful for “More like this” or “Editions” on a detail page.

### 2.6 Other relevant endpoints (from root list)

- `GET /offers/upcoming` — upcoming releases.
- `GET /offers/latest-released` — latest released.
- `GET /sales?country=US` — current sales (discounts).
- `GET /autocomplete?query=resident` — search autocomplete.
- `GET /search` or `POST /search/v2/search` — full search.
- `GET /offers/:id/achievements`, `/offers/:id/igdb`, `/offers/:id/hltb` — extra enrichment (achievements, IGDB, HowLongToBeat).
- `GET /offers/:id/reviews`, `/offers/:id/reviews-summary` — reviews.
- `GET /game-awards` — game awards data.
- `GET /free-games`, `/free-games/history` — free games.

---

## 3. Tracker’s Current Implementation (Summary)

### 3.1 Catalog

| Source | How |
|--------|-----|
| **Steam** | `steam-api.ts`: Store API categories (`top_sellers`, `new_releases`, `coming_soon`, etc.); `getTopSellers()` returns Steam top sellers; catalog built from these + `getAppList` + details. |
| **Epic** | `epic-api.ts`: Epic GraphQL (`searchStore`, `browseCatalog` by release date, etc.) + REST fallback (`freeGamesPromotions`). **No** dedicated “Epic top sellers” query — Epic’s public GraphQL doesn’t expose a top-sellers surface the same way; Tracker uses `browseCatalog(0)` (paginated GraphQL) and merges with Steam “trending” (prefetch: top sellers + coming soon + epic catalog). |

### 3.2 Enrichment

| Area | Tracker |
|------|--------|
| **Steam** | `detail-enricher.ts` + IPC `getMultipleAppDetails`; Steam API app details (genres, platforms, Metacritic, release date, screenshots, price). |
| **Epic** | `epic-api.ts`: `getGameDetails(namespace, offerId)` (GraphQL catalogOffer) + `getProductContent(slug)` (store-content.ak.epicgames.com for description, requirements, gallery). No Metacritic; no IGDB/HLTB. |
| **Price** | Steam: in app details. Epic: from GraphQL/REST offer (totalPrice); no separate regional-price API. |

### 3.3 Top sellers

| Store | Tracker |
|-------|--------|
| **Steam** | Yes — `steam-api.ts` `getTopSellers()` from store categories. |
| **Epic** | No dedicated list. “Trending” / “Top Sellers” in UI = Steam top sellers + Epic **full catalog** (browseCatalog), not a real “Epic top sellers” list. |

### 3.4 Recommendations

| Component | Tracker |
|----------|---------|
| **Oracle** | `reco-store.ts` + `reco.worker.ts`: LightGBM (41M reviews), HNSW on genre embeddings, taste profile, shelves (e.g. “Trending now”, “Critics’ choice”). Candidates from `catalogStore` + `epicCatalogStore`; no external recommendation API. |
| **Related games** | Game detail page can show “similar” or cross-store; no dedicated “related offers” from an API. |

---

## 4. Comparative Summary

| Dimension | egdata-api | Tracker |
|-----------|------------|--------|
| **Catalog** | Epic-only; MongoDB-backed; curated endpoints (top-sellers, latest, featured, upcoming, sales). | Steam + Epic; Steam from Steam API; Epic from GraphQL + REST; no Epic top-sellers list. |
| **Epic top sellers** | **Yes** — `GET /offers/top-sellers` (99 items, paginated). | **No** — only Steam top sellers + Epic full catalog. |
| **Enrichment** | Per-offer: price (per country), related, achievements, IGDB, HLTB, reviews. | Steam: app details + enricher. Epic: catalogOffer + product content (description, requirements, gallery). No IGDB/HLTB for Epic. |
| **Price** | Regional price engine (MongoDB); `GET /offers/:id/price?country=US`. | Epic price from catalog/offer (single locale); Steam from app details. |
| **Related / recommendations** | **Related:** `GET /offers/:id/related` (editions/DLC same namespace). No ML recommendations. | **Recommendations:** Oracle (ML + embeddings). No “related offers” API for Epic. |
| **Search** | `/autocomplete`, `/search`, `/multisearch` (offers, items, sellers). | Steam: store search; Epic: GraphQL search + REST fallback (promo catalog). |
| **Reliability** | No Cloudflare in front of API; stable REST. | Epic GraphQL behind Cloudflare; Tracker uses REST fallback when blocked. |
| **Stores** | Epic only. | Steam + Epic. |

---

## 5. Which Gives Better Data, and How

### 5.1 Catalog

- **Epic catalog:** egdata has a **pre-indexed, queryable** Epic catalog (MongoDB) with clear endpoints (top-sellers, latest, featured, upcoming, sales). Tracker’s Epic catalog is **live** from Epic’s GraphQL + REST and is subject to Cloudflare and rate limits; Tracker also has no “Epic top sellers” list.
- **Steam catalog:** Only Tracker has it (Steam API); egdata does not cover Steam.
- **Verdict:** For **Epic-only** catalog and **Epic top sellers**, egdata gives **better** data (stable, no CF, explicit top-sellers). For **unified Steam + Epic** catalog, Tracker is the only option.

### 5.2 Enrichment

- **Epic enrichment:** egdata adds **regional price** (per country), **related offers** (editions/DLC), and optional **achievements, IGDB, HLTB, reviews**. Tracker has Epic description, requirements, gallery, and inline price from catalog, but no regional price API and no IGDB/HLTB/reviews for Epic.
- **Verdict:** egdata gives **richer** Epic enrichment (price by country, related, optional extras). Tracker is stronger for **Steam** (Metacritic, recommendations count, etc.) and for **unified** game detail UX.

### 5.3 Top sellers

- **Epic top sellers:** egdata **wins** — dedicated `GET /offers/top-sellers` (99 items). Tracker has no equivalent; “Top Sellers” in UI is Steam top sellers + full Epic catalog.
- **Improvement for Tracker:** Use egdata `GET /offers/top-sellers` when “Epic only” or “Top Sellers” is selected to show a **real** Epic top-sellers list instead of the full Epic catalog.

### 5.4 Recommendations

- **Related games (Epic):** egdata exposes **related offers** (same product family). Tracker does not call any “related” API for Epic; could use egdata `GET /offers/:id/related` on the game detail page for “Editions & DLC” or “More like this.”
- **ML recommendations:** Only Tracker has Oracle (LightGBM + embeddings); egdata has no recommendation engine.
- **Verdict:** Tracker is better for **personalized recommendations**; egdata is better for **Epic-related offers** (editions/DLC).

---

## 6. Recommendations for Tracker

1. **Epic top sellers:**  
   - Add an optional data source: `GET https://api.egdata.app/offers/top-sellers?limit=...` when Epic store filter or “Top Sellers” is selected.  
   - Map egdata offer shape to Tracker’s `Game` type (same as existing Epic transform) and merge or replace Epic slice for that view.

2. **Epic enrichment:**  
   - Optionally call egdata for **regional price** (`GET /offers/:id/price?country=...`) and **related** (`GET /offers/:id/related`) on the Epic game detail page.  
   - Keeps Steam flow unchanged; improves Epic detail (price by region, editions/DLC).

3. **Resilience:**  
   - Use egdata as a **fallback** when Epic GraphQL fails (Cloudflare): e.g. search via `GET /autocomplete` or `POST /search/v2/search`, and offer details from `GET /offers/:id` so Epic data still loads.

4. **No replacement for Steam or Oracle:**  
   - egdata is Epic-only; Tracker should keep Steam API and Oracle as-is.  
   - Use egdata to **augment** Epic catalog, enrichment, and top sellers, not to replace Steam or recommendations.

---

## 7. Data Shape Mapping (egdata → Tracker)

egdata offer fields map to Tracker’s `Game` / `EpicCatalogItem` roughly as follows:

| egdata (offer) | Tracker (Game / EpicCatalogItem) |
|----------------|-----------------------------------|
| `id` | `id` (offerId) |
| `namespace` | `epicNamespace` |
| `title` | `title` |
| `description` | `description` / `summary` |
| `keyImages` | `keyImages` → `coverUrl`, `headerImage`, `screenshots` |
| `seller.name` | `developer` / `publisher` |
| `developerDisplayName` / `publisherDisplayName` | same |
| `tags` | genre/tag mapping (Tracker already has EPIC_GENRE_IDS) |
| `releaseDate` / `effectiveDate` | `releaseDate` |
| `urlSlug` / `productSlug` | `epicSlug` |
| `price` (from `/offers/:id/price`) | `price.finalFormatted`, `price.discountPercent` |

Tracker’s `transformEpicGame()` in `epic-service.ts` already normalizes Epic catalog items to `Game`; the same mapper can be used for egdata offers with a thin adapter (field renames if any). See **§8.11** for the full field-level mapping and **§8.12** for gaps and considerations.

---

## 8. In-Depth Analysis

### 8.1 egdata-api architecture

**Data model (MongoDB):**

- **Offer** — Epic offer document (id, namespace, title, description, keyImages, tags, seller, releaseDate, urlSlug, offerType, customAttributes, etc.). Mirrors Epic’s catalog shape; can include `longDescription` (full HTML).
- **GamePosition** — Curated ranked lists: `{ collectionId, offerId, position }`. Used for:
  - `collectionId: "top-sellers"` → **99** ranked offers (paginated).
  - `collectionId: "top-wishlisted"` → top wishlisted.
  - Featured uses a similar position map (no collectionId filter in featured path; featured IDs come from `getFeaturedGames()`).
- **PriceEngine** (`pricev2`) — Per-region price: `offerId`, `region`, `price.discountPrice`, `price.originalPrice`, `currencyCode`, `appliedRules` (active promos with `discountSetting`, `endDate`).
- **AchievementSet** — Epic achievements per sandbox: list of achievements with `unlockedDisplayName`, `unlockedDescription`, `unlockedIconLink`, `completedPercent`, `xp`, `hidden`.
- **Review** / **Ratings** — User reviews and aggregate ratings (egdata can host its own review layer; Epic store reviews may be pulled or mirrored).
- **Hltb**, **Changelog**, **Item**, **Sandbox**, **Seller**, **TagModel** — Supporting entities for HLTB data, changelogs, items, sandboxes, sellers, tags.

**Top-sellers implementation (from `src/routes/offers.ts`):**

```ts
// GET /offers/top-sellers
const result = await GamePosition.find({
  collectionId: "top-sellers",
  position: { $gt: 0 },
})
  .sort({ position: 1 })
  .limit(limit)
  .skip(skip);

const offers = await Offer.find({ id: { $in: result.map((o) => o.offerId) } });
// Merge position into each offer, sort by position, return { elements, page, limit, total }.
```

So top-sellers is **not** live from Epic; it’s a **maintained list** (likely populated by a trigger/cron that syncs Epic’s store data). Total count is 99.

**Caching:** Redis with 60s–3600s TTL on many routes (e.g. `top-sellers` 1h, `latest-games` 60s). Responses often include `Cache-Control: public, max-age=60` and sometimes `X-Cache: HIT`.

---

### 8.2 Response shapes and field-level comparison

**Single offer (GET /offers/:id):**

- egdata returns full offer: `id`, `namespace`, `title`, `description`, **`longDescription`** (full HTML with images), `keyImages`, `tags`, `seller`, `developerDisplayName`, `publisherDisplayName`, `releaseDate`, `effectiveDate`, `urlSlug`, `offerMappings`, `categories`, `customAttributes`, `countriesBlacklist`, `refundType`, etc.
- Tracker’s Epic path: GraphQL `catalogOffer` gives similar base fields; long copy and gallery come from **store-content.ak.epicgames.com** (`getProductContent(slug)`), not from a single offer endpoint. So egdata **single-request** offer detail is richer in one call (including longDescription).

**Achievements (GET /offers/:id/achievements):**

- egdata returns an array of achievement sets; each has `achievements[]` with `unlockedDisplayName`, `unlockedDescription`, `unlockedIconLink`, `lockedIconLink`, `completedPercent`, `xp`, `hidden`. Example: Resident Evil Requiem has **49 achievements** with completion percentages.
- Tracker: **no** Epic achievements API; Steam has achievements via app details.

**Reviews summary (GET /offers/:id/reviews-summary):**

- egdata: `{ totalReviews, averageRating, recommendedPercentage, notRecommendedPercentage }`. For RE Requiem (pre-release) the live response was `{ totalReviews: 0, ... }`.
- Tracker: Steam has `recommendations.total` in app details; Epic has no review summary in Tracker’s current flow.

**Sales (GET /sales?country=US&limit=3):**

- egdata returns offers with **active discount**: each element includes full offer plus `price` and `appliedRules` (e.g. “75% Off”, `endDate`). Prices in cents (e.g. `discountPrice: 74`, `originalPrice: 299`). **210** total current sales in the sample response.
- Tracker: Epic discount comes from catalog `totalPrice`; no dedicated “current sales” list. Steam discounts are in app details.

**Autocomplete (GET /autocomplete?query=resident&limit=5):**

- egdata: `{ elements: Offer[], total }`. **88** matches for "resident"; elements are full offer objects (id, namespace, title, keyImages, tags, urlSlug, etc.).
- Tracker: Epic search is GraphQL `searchStore` (keyword + count) or REST fallback over promotional catalog; no dedicated autocomplete endpoint.

---

### 8.3 Data freshness and reliability

| Aspect | egdata-api | Tracker (Epic) |
|--------|------------|----------------|
| **Source** | MongoDB (periodic sync from Epic/own pipeline). | Live Epic GraphQL + REST. |
| **Freshness** | Depends on sync frequency (not documented; cache TTLs 60s–1h suggest hourly or more frequent). | Real-time when GraphQL works; REST fallback is promo snapshot. |
| **Availability** | No Cloudflare in front; REST; health endpoint. | GraphQL behind Cloudflare; 403 triggers circuit breaker and REST fallback. |
| **Rate limits** | Not documented; typical public API behavior. | Tracker: 300ms between Epic requests, max 2 concurrent. |

---

### 8.4 Tracker Epic pipeline (deep-dive)

**Catalog:**

- **browseCatalog(0)** in `epic-api.ts`: uses `BROWSE_STORE_QUERY` (GraphQL `searchStore` with `sortBy: releaseDate`, `sortDir: DESC`). Fetches in pages of 40, batches of 8 parallel requests, up to 200 pages (8000 games). Dedupes by `namespace:id`. On GraphQL failure, falls back to **getPromotionalCatalog()** (~12 games from `freeGamesPromotions`).
- **Prefetch** (`prefetch-store.ts`): Steam top sellers + coming soon + **epicService.browseCatalog(0)**. So Epic “trending” is the **full** Epic catalog (release-date sorted), not a top-sellers list.

**Search:**

- **searchGames(keyword)** → GraphQL `searchStore` with keyword; fallback: filter promotional catalog by title/description/developer.

**Detail:**

- **getGameDetails(namespace, offerId)** → GraphQL `catalogOffer`; fallback: match in promotional catalog.
- **getProductContent(slug)** → `store-content.ak.epicgames.com` for about, requirements, gallery (no CF).

**Cloudflare:** Epic’s GraphQL is behind CF; Tracker uses a hidden BrowserWindow to obtain `cf_clearance`, then uses that cookie for `net.fetch`. If CF blocks, circuit breaker opens and REST fallback is used (promo catalog only).

---

### 8.5 Tracker Steam and recommendations

- **Steam catalog:** `catalog-store.ts` uses Steam’s GetAppList + GetItems (200 per batch) and persists to IndexedDB (~156K games). Used as the **candidate pool** for Oracle.
- **Oracle (reco.worker.ts):** 17-layer pipeline: taste profile, engagement curve, content/semantic similarity, co-occurrence graph, quality/popularity/debiasing, franchise/studio, diversity re-rank, shelf assembly. Candidates from `catalogStore` + `epicCatalogStore`; **no** external recommendation or “related” API. Tracker has no Epic “related offers” call; egdata’s `GET /offers/:id/related` would fill that gap for Epic.

---

### 8.6 Performance and limits

- **egdata:** Pagination on top-sellers (e.g. limit 10, max 10 per request in code; actual response had `limit=5` and `total=99`). Sales and autocomplete are paginated or limited. Single-offer and related are one-shot. Redis reduces DB load.
- **Tracker:** Epic: 300ms delay, 2 concurrent, persistent cache with TTLs (catalog/releases 30 min, search 10 min, single-offer 5 min, free games 60 min). Steam: separate rate limiting and caching. Recommendation run is offloaded to a worker; catalog sync is batched and resumable.

---

### 8.7 Integration options (concrete)

1. **Epic top sellers in Tracker**  
   - Call `GET https://api.egdata.app/offers/top-sellers?limit=99` (or paginate).  
   - Map each offer with existing `transformEpicGame()` (or a thin egdata→EpicCatalogItem adapter).  
   - When category is “Top Sellers” and store filter is Epic (or “both”), use this list for the Epic slice instead of full browse catalog.

2. **Epic detail enrichment**  
   - On game detail for an Epic game: optional `GET /offers/:id/price?country=...` and `GET /offers/:id/related`.  
   - Optionally `GET /offers/:id/achievements` and `GET /offers/:id/reviews-summary` for new UI sections.

3. **Epic search/autocomplete fallback**  
   - When Epic GraphQL fails: `GET /autocomplete?query=...&limit=10` or POST to `/search/v2/search`; then `GET /offers/:id` for each result to get full offer.  
   - Map to `Game` and show in search results so Epic search still works under CF.

4. **Sales and upcoming**  
   - Optional “Current sales” section: `GET /sales?country=...`.  
   - Optional “Upcoming” from egdata: `GET /offers/upcoming` in addition to or instead of Tracker’s getComingSoon when CF is blocking.

5. **No Tracker changes needed for**  
   - Steam catalog, Steam top sellers, Steam enrichment, Oracle pipeline, library, journey. egdata remains Epic-only; use only to augment Epic data and resilience.

---

### 8.8 Exact limits, pagination, and cache TTLs

| Concern | egdata-api | Tracker (Epic) |
|--------|------------|----------------|
| **Top sellers** | `total=99`, paginated via `limit` + `skip`; typical `limit` 10 per request in code. | N/A — no Epic top-sellers endpoint. |
| **Catalog browse** | N/A (curated endpoints: top-sellers, latest-games 25, featured). | `PAGE_SIZE=40`, `BATCH_SIZE=8`, `MAX_PAGES=200` → up to **8,000** games; `browseCatalog(0)` = “fetch all” (`electron/epic-api.ts` ~1146–1149). IPC cap: `limit` clamped to 1000 (`electron/ipc/epic-handlers.ts` ~104). |
| **Search** | `autocomplete?query=...&limit=5` (sample); full search paginated. | `searchGames`: IPC limit clamped 0–100, default 20 (`epic-handlers.ts` ~21–22). GraphQL `count` passed through; fallback filters promo catalog. |
| **Rate limiting** | Not documented; no explicit headers in responses. | **300 ms** between requests, **max 2** concurrent (`epic-api.ts` ~21–22). Queue cap 500; overfull throws. |
| **Cache TTLs (Tracker)** | N/A. | Catalog/releases: **30 min** (`RELEASES_CACHE_TTL`). Search: **10 min** (`SEARCH_CACHE_TTL`). Single-offer/details: **5 min** (`CACHE_TTL`). Free games: **60 min** (`FREE_GAMES_CACHE_TTL`) (`epic-api.ts` ~396–399). |
| **Cache (egdata)** | Redis; typical route TTLs 60s–3600s; `Cache-Control: public, max-age=60` and `X-Cache: HIT` observed. | In-process `PersistentCache`; no Redis. |

---

### 8.9 Failure modes and recovery

| Scenario | egdata-api | Tracker (Epic) |
|---------|------------|----------------|
| **Epic/upstream down** | API can return 5xx or empty lists; client retries or backs off. No built-in fallback to another Epic source. | Same: GraphQL/network errors surface to caller; browse/search can return [] or throw. |
| **Cloudflare blocks Epic** | N/A — egdata is not behind Epic’s CF. | **403** on GraphQL → **circuit breaker opens** for **30 min** (`GQL_CIRCUIT_RESET_MS`); all GQL calls throw until circuit resets or **Cloudflare solver** runs (`epic-api.ts` ~419–423, 543–556). Solver: hidden BrowserWindow loads store, waits up to **25 s** for `cf_clearance` cookie (`epic-api.ts` ~470–494). |
| **GraphQL browse fails** | N/A. | **Fallback:** `getPromotionalCatalog()` — REST `freeGamesPromotions`, returns ~**12** items (`epic-api.ts` ~1234–1248). Stale cache returned if present before fallback. |
| **Search fails** | N/A. | Fallback: filter promotional catalog by title/description/developer; result set is tiny. |
| **Detail fails** | 404 or 5xx from egdata. | Fallback: match by offer id in promotional catalog; often missing for arbitrary offers. |
| **Health check** | `GET /health` → Redis + MongoDB status. | No dedicated health for Epic; circuit state and `cfInitialized` are internal. |

**Takeaway:** Tracker’s Epic path is fragile under Cloudflare (403 → 30 min circuit, then REST fallback with minimal data). egdata avoids CF entirely and can serve as a **resilience fallback** when the circuit is open.

---

### 8.10 Code-level reference (Tracker)

| Flow | Location | Notes |
|------|----------|--------|
| Epic rate limiter | `electron/epic-api.ts` L21–60 | 300 ms delay, 2 concurrent, queue 500. |
| GraphQL circuit breaker | `electron/epic-api.ts` L419–423, L543–556 | 403 opens circuit; 30 min reset or CF clearance closes it. |
| Cloudflare solver | `electron/epic-api.ts` L442–508 | BrowserWindow → store.epicgames.com, poll for cookie, 25 s timeout. |
| browseCatalog | `electron/epic-api.ts` L1141–1249 | BROWSE_STORE_QUERY, 40/page, 8 parallel, max 200 pages; fallback getPromotionalCatalog. |
| searchGames | `electron/epic-api.ts` L687–720+ | Cache key `epic:search:${keyword}:${limit}`; SEARCH_CACHE_TTL. |
| getGameDetails | `electron/epic-api.ts` L735+ | catalogOffer by namespace+id; fallback promo match. |
| getProductContent | `electron/epic-api.ts` L931+ | store-content.ak.epicgames.com (no CF); about, requirements, gallery. |
| Epic IPC caps | `electron/ipc/epic-handlers.ts` L18–24, L101–106 | search: limit 0–100; browse: limit 0–1000. |
| Epic → Game transform | `src/services/epic-service.ts` L48–120+ | `transformEpicGame()`: id, genre from tags (groupName/genre IDs), platforms, price, keyImages → coverUrl/headerImage, slug from mappings. |

---

### 8.11 Full schema mapping: egdata offer → Tracker Game

egdata’s **Offer** shape is close to Epic’s catalog offer; Tracker’s **EpicCatalogItem** is the GraphQL shape. For an egdata→Tracker adapter, map as below. `transformEpicGame()` in `epic-service.ts` already normalizes EpicCatalogItem→Game; an egdata adapter can either (a) map egdata offer → EpicCatalogItem then call `transformEpicGame`, or (b) map egdata offer → Game directly using this table.

| egdata (Offer) | Tracker Game / EpicCatalogItem | Notes |
|----------------|---------------------------------|--------|
| `id` | `id` (offerId) / `Game.id` = `epic-${namespace}:${id}` | Required. |
| `namespace` | `namespace` / `Game.epicNamespace`, `Game.epicOfferId` | Required. |
| `title` | `title` | Direct. |
| `description` | `description` → `Game.summary` | Short blurb. |
| `longDescription` | `EpicCatalogItem.longDescription` (optional) / `Game.longDescription` | Tracker’s type supports it; GraphQL `catalogOffer` often omits it (about text comes from `getProductContent(slug)`). egdata single offer includes it in one call. |
| `keyImages` | `keyImages` → `resolveEpicImage()` → `coverUrl`, `headerImage`, `screenshots` | Same resolution order as Tracker. |
| `seller.name` | `seller.name` → `Game.developer` | Fallback when developerDisplayName missing. |
| `developerDisplayName` | `Game.developer` | Prefer over seller. |
| `publisherDisplayName` | `Game.publisher` | |
| `tags` | Filter by `groupName === 'genre'` or genre ID set → `Game.genre` | Tracker uses EPIC_GENRE_IDS + groupName. |
| `releaseDate` / `effectiveDate` | `releaseDate` / `effectiveDate` → `Game.releaseDate` (ISO string) | Parse and validate year. |
| `urlSlug` / `productSlug` / mappings | `urlSlug` or mappings `pageType: 'productHome'` → `Game.epicSlug` | For store URL. |
| `price` (from `/offers/:id/price`) | `price.discountPrice`, `originalPrice`, `currencyCode` → `Game.price` (finalFormatted, discountPercent, isFree) | egdata uses cents; format for display. |
| `offerType` | — | Can infer DLC/add-on for filtering. |
| `categories` | `Game.platform` (e.g. Windows/Mac/Linux from category path) | Same as Tracker’s categories/customAttributes. |
| `customAttributes` | Platform, etc. → `Game.platform` | |
| — | `Game.metacriticScore`, `Game.recommendations` | Epic does not expose; leave null / 0. |
| — | `Game.achievements` | From egdata `GET /offers/:id/achievements` count if desired. |

Using this mapping, a thin **egdata→Game** adapter (or egdata→EpicCatalogItem then `transformEpicGame`) keeps Tracker’s UI and types unchanged while consuming egdata for top-sellers, detail, or fallback.

---

### 8.12 Gaps and considerations (did we miss anything?)

| Topic | Notes |
|-------|--------|
| **Auth / API key** | egdata: optional auth (Discord, Epic launcher); all endpoints we used work **without** auth. No API key required for top-sellers, offer detail, price, related, autocomplete, sales, health. If integrating, confirm current egdata docs for any future key or rate limits. |
| **Locale / country** | **Tracker** uses a **fixed** Epic store context: `country: 'IN'`, `locale: 'en-US'` in all GraphQL and REST calls (`epic-api.ts`). So catalog and prices are effectively India + English. **egdata** allows `?country=US` (and similar) on price, sales, latest-games. For regional price or store switching, Tracker would need either (a) a configurable country/locale in Epic calls, or (b) egdata as the source for multi-country price. |
| **Free games / coming soon / upcoming** | **Tracker:** `getFreeGames()`, `getComingSoon()`, `getUpcomingReleases()` from GraphQL (with REST fallback). Used in prefetch, game-service, release calendar. **egdata:** `GET /free-games`, `/free-games/history`, `GET /offers/upcoming`. Both cover the same use cases; egdata can be a fallback when GraphQL is blocked. No count comparison in this doc. |
| **News** | **Tracker** has `getNewsFeed(keyword)` — Epic store-content blog + CMS per product. **egdata** does not expose a news/blog endpoint in the listed routes. Epic news in Tracker stays Tracker-only. |
| **Addons vs related** | **Tracker:** `getAddons(namespace, limit)` returns DLC/add-ons for a game (GraphQL searchStore by namespace); used on game detail. **egdata:** `GET /offers/:id/related` returns related offers (editions/DLC, same namespace/franchise). Similar purpose; egdata’s related can replace or complement getAddons when GraphQL fails. |
| **Product reviews** | **Tracker:** `getProductReviews(slug)` from store-content.ak.epicgames.com productReviews. **egdata:** `GET /offers/:id/reviews` and `/reviews-summary`. Different sources (Epic CMS vs egdata’s layer). Both can feed a “reviews” section; if using egdata for detail, reviews-summary is a single extra call. |
| **Top wishlisted** | egdata has a **top-wishlisted** collection (GamePosition); we did not call it. Tracker has no Epic wishlist concept. Optional future enhancement if Tracker adds wishlist. |
| **CORS** | Tracker’s Epic calls run in the **Electron main** process (`net.fetch`), so browser CORS does not apply. If Tracker ever called egdata from the **renderer** (e.g. from a worker or direct fetch), CORS would apply; egdata would need to allow the origin or calls would need to go via IPC/main. |
| **Licensing / ToS** | Not verified in this doc. Before production use of egdata, check the egdata-api repo and any terms of use for acceptable use, attribution, and rate limits. |

---

### 8.13 Field verification and safety (don’t break the app)

**Status:** The mapping in §7 and §8.11 was derived from **code inspection and the comparison doc**, not from running live egdata responses through `transformEpicGame()`. Before shipping an egdata integration, **verify** the following so the app does not break.

#### Required by `EpicCatalogItem` and `transformEpicGame()`

| Field | Tracker expects | Used in transform | Adapter / egdata |
|-------|------------------|-------------------|-------------------|
| `namespace` | `string` (required) | `gameId = epic-${namespace}:${id}`; `epicNamespace` | egdata has `namespace`. **Must be string.** If egdata ever omits, adapter must not pass item (or skip that offer). |
| `id` | `string` (required) | same; `epicOfferId` | egdata has `id`. **Must be string.** |
| `title` | `string` (required) | `Game.title` | egdata has `title`. **Adapter must guarantee non-empty:** use `title || 'Unknown'` so UI never gets empty title (prefetch index and filters use `game.title`). |

#### Optional but affect correctness

| Field | Tracker expects | Risk if wrong / missing |
|-------|------------------|--------------------------|
| `developer` / `publisher` | string (optional) | Transform uses `item.developer \|\| item.seller?.name \|\| 'Unknown Developer'`. **egdata uses `developerDisplayName` / `publisherDisplayName`** — adapter must set `developer` and `publisher` from these (or seller.name). If all missing, transform yields "Unknown Developer" / "Unknown Publisher" (safe). |
| `price` | `price.totalPrice.discountPrice`, `originalPrice` (numbers); `price.totalPrice.fmtPrice.discountPrice`, `originalPrice` (strings, optional) | egdata price from `/offers/:id/price` is **flat**: `discountPrice`, `originalPrice`, `currencyCode` (cents). **Adapter must build** `price: { totalPrice: { discountPrice, originalPrice, fmtPrice: { discountPrice: formattedString, originalPrice: formattedString, intermediatePrice: '' } } }`. If you omit `fmtPrice`, transform falls back to **₹**-formatted price (see epic-service.ts L125–131). For non-India, build `fmtPrice` from `currencyCode` + cents. **Never pass a different shape** (e.g. top-level discountPrice) or transform will read `tp` as undefined and price will be wrong. |
| `tags` | `Array<{ id: number; name?: string; groupName?: string \| null }>` | Transform uses `tag.id` in `EPIC_GENRE_IDS.has(tag.id)` (Set of **numbers**). **If egdata returns tag id as string**, adapter must coerce: `id: Number(tag.id)` or filter out non-numeric. Otherwise genre extraction may miss. |
| `keyImages` | `Array<{ type: string; url: string }>` | Optional. If missing, coverUrl/headerImage/screenshots are undefined/empty — safe. If present, **each element must have `type` and `url`**; resolveImage only reads those. |
| `effectiveDate` | ISO date string (optional) | Used for `releaseDate` and `comingSoon`. egdata has `releaseDate` and/or `effectiveDate`. Adapter should set `effectiveDate` from whichever egdata provides (prefer one that parses to valid Date). |
| `categories` | `Array<{ path: string }>` | Optional. Transform iterates `cat.path`. If egdata uses a different shape (e.g. `name`), adapter must map to `path`. |
| `customAttributes` | `Array<{ key: string; value: string }>` | Optional. Same shape as Epic; no change if egdata matches. |
| `offerMappings` / `catalogNs.mappings` | `Array<{ pageSlug: string; pageType: string }>` | Used for `epicSlug`. If egdata uses different keys, adapter must map to these so store URLs work. |
| `url` / `urlSlug` / `productSlug` | strings (optional) | Fallbacks for epicSlug. url is parsed with regex `/p\/([^/]+)/`. |

#### Game required fields (all set by transform)

Transform always sets: `id`, `title`, `developer`, `publisher`, `genre`, `platform`, `metacriticScore`, `releaseDate`, `status`, `priority`, `publicReviews`, `recommendationSource`, `createdAt`, `updatedAt`. It uses library entry or defaults. **So as long as the adapter produces a valid `EpicCatalogItem` (namespace, id, title + optional above), the resulting `Game` will have all required fields.** The only way to break is to pass an item with missing `namespace`/`id`/`title` or wrong types so that the transform or downstream code throws (e.g. `releaseDate.slice(0, 4)` on undefined).

#### Defensive adapter checklist

1. **Validate before transform:** `if (!egdataOffer?.id || !egdataOffer?.namespace) return null;` (or skip). Ensure `title = (egdataOffer.title ?? '').trim() || 'Unknown'`.
2. **Map developer/publisher:** `developer: egdataOffer.developerDisplayName ?? egdataOffer.seller?.name ?? 'Unknown Developer'`, same for publisher.
3. **Build `price` from egdata:** If using egdata price (from offer or `/price`), build exactly `{ totalPrice: { discountPrice: number, originalPrice: number, fmtPrice: { discountPrice: string, originalPrice: string, intermediatePrice: '' } } }`. Format strings using `currencyCode` (e.g. USD → `$X.XX`) so you don’t hardcode ₹.
4. **Coerce `tags`:** Ensure each `tag.id` is a number: `id: typeof tag.id === 'number' ? tag.id : Number(tag.id)`; drop tags where `Number.isNaN(tag.id)`.
5. **Test with live data:** Before merge, fetch at least one real egdata offer (e.g. `GET /offers/03c9e4679725466891f8d72c832dcc01`) and one from top-sellers, run through the adapter → `transformEpicGame(adapter(egdataOffer))`, and assert: no throw, `game.id` starts with `epic-`, `game.title` non-empty, `game.developer`/`game.publisher` non-empty, `game.genre` and `game.platform` arrays (can be default `['Game']`/`['Windows']`), `game.releaseDate` string (can be empty), and optional `game.price`, `game.coverUrl` present when egdata has price/keyImages.

Adding a unit test that mocks an egdata offer (minimal required fields + one with full price/tags/keyImages) and asserts the adapter + transform output is a valid `Game` is recommended.

---

## 9. Conclusion

- **egdata-api** provides a **stable, Epic-only** API with **top sellers** (GamePosition-backed, 99 items), **regional pricing** (PriceEngine), **related offers**, and optional **achievements/IGDB/HLTB/reviews**, without Cloudflare issues.
- **Tracker** provides **Steam + Epic** catalog, **Steam top sellers**, **Epic browse/search** (with CF fallback), and **Oracle recommendations**; it does **not** have Epic top sellers or Epic-related offers from an API.
- **Actual calls** to egdata confirmed: top-sellers (99), latest-games (25), featured, price by country, and related offers all return usable data.
- **Best approach:** Use egdata as an **optional augmentation** for Tracker: Epic top sellers list, Epic detail enrichment (price + related), and optional fallback when Epic GraphQL is blocked.

---

## 10. Benefits of implementing egdata integration

If Tracker implements the optional egdata augmentation described in §6 and §8.7, these are the main benefits.

### 10.1 User-facing benefits

| Benefit | Today (without egdata) | With egdata |
|--------|------------------------|------------|
| **Epic “Top Sellers” is real** | “Top Sellers” for Epic is the full catalog (release-date sorted), not a ranked best-seller list. Users looking for what’s actually selling on Epic get the wrong list. | A real **Epic top 99** from egdata. Choosing “Top Sellers” + Epic (or both stores) shows a true best-seller list for Epic, aligned with user intent. |
| **Epic game detail is richer** | One price (fixed India store), no “Editions & DLC” from an API, no achievements/review summary for Epic. | **Regional price** (e.g. user’s country), **related offers** (editions/DLC) on the same page, and optional **achievements** and **reviews summary** for Epic titles — closer to Steam’s detail depth. |
| **Epic works when Epic’s store is blocked** | If Cloudflare blocks GraphQL, Epic browse/search collapse to a tiny promo list (~12 games); search is effectively broken. | **Fallback:** search via egdata autocomplete + offer detail; browse can use egdata top-sellers/latest/upcoming/sales so Epic discovery still works during CF blocks. |

### 10.2 Product and UX benefits

- **Correct semantics:** “Top Sellers” and “Epic” together mean “Epic’s top sellers.” Delivering that list improves trust and reduces confusion.
- **Parity with Steam:** Steam already has top sellers and rich detail. Adding real Epic top sellers and optional related/achievements/reviews narrows the gap between the two stores in the UI.
- **Fewer “Epic is broken” moments:** When CF blocks Epic, users currently see an empty or nearly empty Epic experience for up to 30 minutes. egdata fallback keeps Epic search and curated lists (top-sellers, sales, upcoming) usable.
- **Optional regional price:** If you later add a “store region” or “country” setting, egdata’s `?country=` support gives a path to show the right price without changing Tracker’s Epic GraphQL (which is fixed to IN today).

### 10.3 Technical and operational benefits

| Area | Benefit |
|------|--------|
| **Reliability** | Epic dependency is split: primary = Epic GraphQL, fallback = egdata. When CF opens the circuit breaker, egdata can serve search, top-sellers, and detail so the Epic surface degrades gracefully instead of to ~12 games. |
| **Simplicity for curated lists** | Top-sellers from egdata = one or a few paginated calls (99 items). No need to maintain your own Epic “top sellers” heuristic or scrape. |
| **Single-call detail** | egdata `GET /offers/:id` can return full offer + longDescription in one request; Tracker today uses GraphQL + separate `getProductContent(slug)` for about/gallery. Optional use of egdata for detail can reduce round-trips when you need full copy. |
| **Observability** | You can add a simple health check (e.g. `GET https://api.egdata.app/health`) and, when using egdata as fallback, show “Epic via egdata” so support and users know the app is using the backup source. |

### 10.4 What stays the same (no downside to existing features)

- **Steam:** Unchanged. Steam catalog, top sellers, and enrichment remain from Steam API.
- **Oracle:** Unchanged. Recommendations still come from catalogStore + epicCatalogStore and the 17-layer pipeline; egdata is not a replacement for ML recommendations.
- **Library, journey, release calendar:** Unchanged. egdata is used only to augment Epic catalog and detail and as an Epic fallback when GraphQL fails.

### 10.5 Summary: is it worth it?

| If you care about… | Benefit level |
|--------------------|----------------|
| **Correct “Epic Top Sellers”** | **High** — only way to show a real Epic best-seller list today. |
| **Epic not breaking under Cloudflare** | **High** — fallback keeps Epic search and key lists working when the circuit is open. |
| **Richer Epic detail (related, price by country, achievements/reviews)** | **Medium** — clear UX upgrade; implementation is optional and can be phased. |
| **Future regional/multi-country support** | **Medium** — egdata’s country parameter is a straightforward path when you add settings. |
| **Operational resilience** | **Medium** — second source for Epic reduces single-point-of-failure when Epic’s GraphQL is blocked. |

**Recommendation:** Implementing **at least** the Epic top-sellers source and the **search + curated-list fallback** when GraphQL fails gives the biggest user and reliability gains for moderate effort (one new data source, thin adapter, and fallback branch in existing Epic flows). Adding detail enrichment (related, regional price, achievements, reviews-summary) is a logical second step for better Epic parity with Steam.

---

## 11. API call reduction analysis (without breaking anything)

This section estimates how many **Epic** API calls can be **reduced** by using egdata in the ways already recommended, without changing behavior or breaking existing flows.

### 11.1 Current Epic API call footprint

| Source | What | Epic calls per occurrence | Cache | When it runs |
|--------|------|----------------------------|--------|--------------|
| **browseCatalog(0)** | Full Epic catalog (paginated GraphQL) | **Up to 200** (1 + 199: 40 per page, 200 pages max) | 30 min | Prefetch (splash), BG refresh (~1h), useGameStore fallback when no prefetch, epic-catalog-store sync |
| **getFreeGames()** | Free games list | 1 (GraphQL or REST) | 60 min | Prefetch, BG refresh, category “Free” |
| **getNewReleases()** | New releases | 1 GraphQL | 30 min | Prefetch, BG refresh, category “New Releases” |
| **getComingSoon()** | Coming soon | 1 GraphQL | 30 min | Prefetch, BG refresh, category “Coming Soon” |
| **searchGames(query)** | Search | 1 GraphQL per search | 10 min per keyword | Each user search (Steam + Epic in parallel) |
| **getGameDetails(ns, id)** | Single offer | 1 GraphQL per game | 5 min per offer | Game detail page (Epic), enrichment, galaxy |
| **getProductContent(slug)** | About / requirements / gallery | 1 REST per slug (store-content) | 5 min per slug | Game detail page (Epic) after getGameDetails |

**Rough totals (no egdata):**

- **Cold prefetch (cache empty):** 200 (browseCatalog) + 1 (freeGames) = **201 Epic requests** (newReleases/comingSoon are Steam in prefetch; Epic slice is browseCatalog + getFreeGames).
- **Per Epic game detail view:** 1 (getGameDetails) + 1 (getProductContent) = **2 Epic requests** (both cached 5 min per key).
- **Per user search (Epic slice):** **1 Epic GraphQL** (cached 10 min per keyword).
- **Background refresh (~1h):** same as prefetch, **201 Epic** when cache was stale.

So the dominant cost is **browseCatalog(0)** (up to 200 calls) whenever the Epic catalog is loaded or refreshed.

### 11.2 Reduction scenarios (conservative, no behavior break)

All scenarios keep existing flows; egdata is used only where the doc already recommends it.

| Scenario | When | Epic calls today | With egdata | Epic reduced | egdata added |
|----------|------|-------------------|-------------|--------------|--------------|
| **A. Fallback when CF blocks** | Circuit breaker open (e.g. after 403) | browseCatalog tries **200** GQL (all fail or time out); then REST fallback (~12 games). Search: **1** failing GQL. | Use egdata for Epic browse + search instead of calling Epic. | **200** (browse) + **1** per search = **201+** per “blocked” refresh; **1** per blocked search | **1** (top-sellers or similar) for browse; **1** autocomplete + **N** GET /offers/:id for search results (e.g. N=20) |
| **B. Epic game detail** | User opens an Epic game’s detail page | **2** (getGameDetails + getProductContent) | Optionally: egdata GET /offers/:id (1) for full offer + longDescription; keep getProductContent only if we still need requirements/gallery from Epic. | **1** per detail view (skip getGameDetails) | **1** per detail view |
| **C. Epic top-sellers view** | User selects “Top Sellers” + Epic (or both) | **0** (today we show full catalog from prefetch; no extra Epic call for “top sellers”) | Show egdata top-sellers (1 call) instead of filtering prefetched catalog. | **0** (no Epic call replaced) | **1** (or paginated, e.g. 2–10) |

So:

- **No change when Epic is healthy:** If we only add “Epic top-sellers from egdata” and “fallback when Epic fails,” then when Epic works we do **not** reduce Epic calls (we might add 1 egdata call for top-sellers view).
- **When Cloudflare blocks:** We avoid **200** Epic browseCatalog requests and **1** per search by using egdata for browse and search. **Reduction: up to 200+ Epic calls per blocked refresh; 1 per blocked search.**
- **If we add “detail from egdata”:** For each Epic game detail view we can do 1 egdata GET /offers/:id and skip 1 Epic getGameDetails. **Reduction: 1 Epic call per Epic detail view** (getProductContent can stay for requirements/gallery).

### 11.3 What we do not do (to avoid breaking)

- **Replacing prefetch Epic slice with egdata-only:** Replacing browseCatalog(0) in prefetch with egdata top-sellers + latest-games would **reduce 200 Epic calls** per cold start but would **change behavior** (Epic would be ~99 + 25 + free instead of up to ~8000). So we do **not** count that as “without breaking.”
- **Removing getProductContent:** egdata offers longDescription in one shot but Tracker’s product page uses getProductContent for requirements and gallery; we keep that unless we confirm egdata (or our adapter) covers those. So we only count **1** fewer Epic call per detail (getGameDetails), not 2.

### 11.4 Summary table (without breaking anything)

| Situation | Epic calls without egdata | Epic calls with egdata | Reduction |
|-----------|---------------------------|-------------------------|-----------|
| **Normal: cold prefetch** | 201 | 201 | **0** (we don’t replace browseCatalog in prefetch) |
| **Normal: Epic game detail** | 2 per view | 1 per view (if we use egdata for offer) | **1 per view** |
| **Normal: search** | 1 per search | 1 per search | **0** |
| **CF blocked: prefetch/refresh** | 200 (failing) then fallback | 0 Epic; use egdata | **200** (we avoid 200 failing Epic calls) |
| **CF blocked: search** | 1 (failing) | 0 Epic; use egdata | **1** |
| **CF blocked: detail** | 2 (may fail) | 0 Epic; use egdata GET /offers/:id | **2** |

**Bottom line:** Without changing behavior or breaking flows, we can:

- **When Epic is healthy:** Reduce **1 Epic call per Epic game detail view** if we use egdata for offer detail and skip getGameDetails.
- **When Epic is blocked (CF):** Avoid **200** Epic browseCatalog requests per refresh and **1** per search (and **2** per detail if we use egdata for that), i.e. **200+ Epic calls reduced** per blocked session, with egdata used only for fallback + optional detail.
