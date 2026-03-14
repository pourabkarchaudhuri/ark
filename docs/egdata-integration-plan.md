# egdata Integration Plan — Additive Enrichment & Correctness

**Date:** 2026-03-07  
**Principle:** Add egdata **only** to enrich and fix Epic data. No removal of existing flows; no breaking changes. Steam, Oracle, Library, and journey stay unchanged.

**References:**  
- Full analysis and field mapping: `docs/egdata-api-comparison.md`  
- Top-sellers test and comparison: `docs/epic-top-sellers-comparison.md`

---

## 1. Gaps We Fill (Additive Only)

| Gap | Today | With egdata |
|-----|--------|-------------|
| **Epic top sellers** | “Top Sellers” = Steam lists + full Epic catalog (5,183 mixed). Epic part is not ranked by sales. | Real **99** ranked Epic top sellers from egdata when user is in Top Sellers (and Epic in store filter). |
| **Epic when Cloudflare blocks** | Circuit open → ~12 games (promo fallback); search broken. | Use egdata for Epic browse (top-sellers/latest) and search (autocomplete + offer detail) so Epic stays usable. |
| **Epic detail: related / price / reviews** | One price (fixed locale), no “Editions & DLC” API, no Epic achievements/review summary. | Optional: egdata related, regional price, achievements, reviews-summary on Epic game detail. |
| **Epic API cost when blocked** | 200 failing Epic requests then minimal fallback. | 0 Epic calls; 1–2 egdata calls for curated lists and search. |

We do **not** replace: prefetch’s full Epic catalog for “All” / other categories, Steam APIs, Oracle, Library, or getProductContent (requirements/gallery).

---

## 2. Architecture: Where egdata Sits

- **New module:** `electron/egdata-api.ts` — HTTP client for `api.egdata.app`. Phase 1: top-sellers, offer by id, health. Phase 2: autocomplete (and optionally latest-games, upcoming, free-games). Phase 3: price, related. No auth for these endpoints.
- **Adapter:** `src/services/egdata-adapter.ts` (or in `electron/` if transform runs in main) — maps egdata offer → `EpicCatalogItem`-like shape so existing `transformEpicGame()` produces a `Game`. Follow §8.11 and §8.13 (field verification, defensive checks).
- **Integration points (additive):**
  - **Top Sellers:** When category is “trending” and we need the Epic slice for Top Sellers, optionally fetch from egdata top-sellers and merge with Steam top sellers (fallback: current prefetch Epic slice).
  - **Fallback:** When Epic GraphQL circuit breaker is open, use egdata for Epic search and for Epic curated lists (top-sellers, latest, upcoming) instead of calling Epic.
  - **Detail (optional):** On Epic game detail, optionally call egdata for related offers and/or regional price (and optionally achievements, reviews-summary).

All existing Epic code paths remain; we add branches that **prefer or fall back to** egdata where it fixes a gap.

---

## 3. Implementation Phases

### Phase 1 — Foundation & Epic Top Sellers (correctness)

**Goal:** Add egdata client and adapter; use egdata for the **Epic slice** of “Top Sellers” so the label matches real top-selling Epic games.

**Tasks:**

1. **egdata HTTP client (main process)**  
   - Add `electron/egdata-api.ts`:  
     - `getTopSellers(limit?, skip?)` → `GET /offers/top-sellers`  
     - `getOffer(id)` → `GET /offers/:id`  
     - `health()` → `GET /health`  
   - Use `net.fetch` (or Node `fetch`), same process as Epic. No auth. **Timeout** (e.g. 10–15 s) and error handling; return `null`/`[]` on failure so callers can fall back. All egdata calls from **main process only** (IPC to renderer) to avoid CORS if renderer ever called egdata directly.

2. **egdata → Game adapter**  
   - Add adapter that maps egdata offer → shape compatible with `transformEpicGame()` (or to `EpicCatalogItem` then call `transformEpicGame`).  
   - Implement §8.13: validate `id`, `namespace`, non-empty `title`; map `developerDisplayName`/`publisherDisplayName` (and `seller.name`); build `price.totalPrice` + optional `fmtPrice` from egdata price (cents + `currencyCode`); coerce `tags[].id` to number; map `urlSlug`/mappings to `epicSlug`. **Set `releaseDate` / `effectiveDate`** from egdata (or default to `''`) so downstream code never calls `.slice()` on undefined.  
   - Unit test: mock egdata offer (minimal + one with price/tags), run adapter → transform, assert valid `Game` (id, title, developer, publisher, genre, platform, releaseDate, no throw).

3. **IPC for egdata**  
   - Add `electron/ipc/egdata-handlers.ts`: e.g. `egdata:getTopSellers`, `egdata:getOffer`, `egdata:health`.  
   - Expose on preload as `window.egdata` (optional; only if we want renderer to trigger egdata).

4. **Top Sellers: Epic slice from egdata**  
   - **Option A (prefetch unchanged):** When building “Top Sellers” data for the UI, if we have egdata and category is “trending,” compute Epic slice from egdata top-sellers (99) instead of from the prefetched “full Epic catalog.” Merge: Steam top sellers + egdata Epic top 99 + (optionally) Epic free games; dedupe by `Game.id`. **Preserve egdata `position`** so the Epic slice is ordered 1–99 when displayed. Prefetch still runs as today for “All” and other categories.  
   - **Option B (at read time):** In `game-service.getTopSellers()` or in the hook that feeds “trending” (`useGameStore`: `getPrefetchedGames()` / fallback `gameService.getTopSellers()`), when supplying Epic for “trending”: if egdata is available, call egdata top-sellers and map to `Game[]`; else use current Epic source (prefetch or browseCatalog).  
   - **Store filter:** When store filter is **Epic only** and category is Top Sellers, show **only** egdata top-sellers (99). When **Both**, show Steam top sellers + egdata Epic top 99 (merged, deduped).  
   - Ensure fallback: if egdata fails or is disabled, use current behavior (Epic = full catalog from prefetch or from browseCatalog).

5. **Feature flag / kill switch**  
   - Add a simple flag (e.g. env or config) to disable egdata so we can turn it off without code change.

**Acceptance:**  
- With egdata enabled, “Top Sellers” shows Steam top sellers + **99** Epic top sellers (from egdata), not 5,183 with Epic as full catalog; Epic slice ordered by egdata `position`.  
- With egdata disabled or failing, “Top Sellers” behaves as today (no regression).  
- No change to Library, Steam, or other categories.  
- **Library state:** Any egdata-sourced `Game[]` must be merged with library state so `isInLibrary` is set correctly (same path as existing catalog games, e.g. from useGameStore / mergedLibraryGames or equivalent).  
- **Catalog store:** egdata top-sellers are used **only** for the Top Sellers category display (and fallback when blocked). They do **not** replace `epicCatalogStore` or the full prefetch cache used for “All,” Oracle, or other consumers.

**References:** §6, §8.7, §8.11, §8.13 in `egdata-api-comparison.md`; §6 in `epic-top-sellers-comparison.md`.

---

### Phase 2 — Resilience: Fallback When Epic Is Blocked

**Goal:** When Epic GraphQL circuit breaker is open, use egdata so Epic search and Epic curated lists still work.

**Tasks:**

1. **Detect “Epic blocked”**  
   - Use existing circuit state in `epic-api.ts` (or expose a simple `isEpicBlocked()` / circuit open) so the app can branch to egdata for Epic-only operations.

2. **Epic search fallback**  
   - When user searches and Epic is blocked: call egdata `GET /autocomplete?query=...&limit=20` (or POST `/search/v2/search`); for each result id, call `GET /offers/:id` to get full offer; map to `Game[]` via adapter; merge with Steam search results (or show Epic-only when store filter is Epic).  
   - When Epic is not blocked, keep current Epic search (GraphQL).

3. **Epic “browse” fallback**  
   - When prefetch or background refresh runs and Epic is blocked: instead of calling browseCatalog (200 requests that will fail), call egdata top-sellers + optionally latest-games/featured/upcoming; map to `Game[]`; use as Epic slice for that run. So combined prefetch = Steam lists + egdata Epic curated (e.g. 99 + 25 + featured) instead of full catalog.  
   - **Also use egdata for “Free” and “Coming Soon” when blocked:** `GET /free-games` and `GET /offers/upcoming` so those categories still show Epic content when GraphQL is unavailable.  
   - Document that in “blocked” mode the Epic set is smaller (curated only); when circuit closes, next refresh gets full catalog again.

4. **Optional: “Epic via egdata” indicator**  
   - When we’re using egdata for Epic data (e.g. fallback or Top Sellers), show a small indicator so support/users know the source (e.g. tooltip “Epic data via egdata” or status in System Status in dev mode).

**Acceptance:**  
- With Epic blocked, search returns Epic results from egdata; Top Sellers / browse can show egdata Epic lists instead of ~12 promo games.  
- When Epic is unblocked, behavior reverts to current (Epic GraphQL + prefetch as today).

**References:** §6, §8.7, §8.9 in `egdata-api-comparison.md`; §11 (API call reduction).

---

### Phase 3 — Enrichment: Detail Page (Related, Price, Optional Achievements/Reviews)

**Goal:** Enrich Epic game detail with related offers (editions/DLC), regional price, and optionally achievements and reviews summary, without removing existing detail flow.

**Tasks:**

1. **Related offers**  
   - On Epic game detail load: if egdata available, call `GET /offers/:id/related`; map to a small list of “Editions & DLC” or “Related” (title, id, slug, price if present). Render as a section or links. Keep existing getAddons from Epic if desired; egdata related can complement or replace when we have it.

2. **Regional price**  
   - Optional: call egdata `GET /offers/:id/price?country=...` (e.g. user locale or fixed US/IN); display formatted price. Tracker today has single locale; this prepares for future multi-country without changing existing price display until we add a country selector.

3. **Achievements / reviews-summary (optional)**  
   - If we add “Epic achievements” or “Epic reviews” section: call egdata `GET /offers/:id/achievements` and/or `GET /offers/:id/reviews-summary`; render counts or list. Only when egdata is enabled and we want to show these sections.

4. **Detail fallback**  
   - When Epic is blocked and user opens an Epic game detail: try egdata `GET /offers/:id` for full offer (longDescription, etc.); merge with getProductContent(slug) from Epic CMS if we still need requirements/gallery. So we can show the page without Epic GraphQL.

**Acceptance:**  
- Epic detail page can show related offers and optional price/achievements/reviews when egdata is used.  
- If egdata is off or fails, detail page behaves as today (no regression).

**References:** §6, §8.7, §8.11 in `egdata-api-comparison.md`.

---

## 4. File & Touch Points (Summary)

| Area | New | Modified |
|------|-----|----------|
| **Electron** | `electron/egdata-api.ts`, `electron/ipc/egdata-handlers.ts` | `electron/ipc/index.ts` (register handlers), `electron/preload.cjs` (expose `window.egdata` if needed) |
| **Adapter** | `src/services/egdata-adapter.ts` (or `electron/egdata-adapter.ts`) | — |
| **Top Sellers** | — | `src/services/game-service.ts` and/or prefetch/useGameStore path that supplies “trending” Epic slice; optionally `src/services/prefetch-store.ts` or `src/hooks/useGameStore.ts` |
| **Fallback** | — | `electron/epic-api.ts` or callers: branch to egdata when circuit open; search path in `epic-service.ts` or game-service; prefetch/refresh path |
| **Detail** | — | `src/pages/game-details.tsx`: add optional egdata related/price/achievements/reviews and detail fallback |
| **Types** | — | `src/vite-env.d.ts` or similar: `window.egdata` types if used from renderer |

**Integration point for Top Sellers Epic slice:** Today “trending” comes from `getPrefetchedGames()` in `useGameStore` (or fallback `gameService.getTopSellers()` which calls Steam + Epic browseCatalog + free games). Prefetch is built in `prefetch-store._doPrefetch()`. Decide explicitly: either (i) **at read time** — when category is “trending,” if egdata enabled, take Steam portion from prefetch (or getTopSellers) and Epic portion from egdata top-sellers (99), merge and sort; or (ii) **in prefetch** — store a separate “trending Epic slice” from egdata and merge at prefetch completion. Document the chosen place so the Epic slice substitution happens in one clear spot.

---

## 5. Order of Work & Dependencies

1. **Phase 1 first:** Foundation (egdata client, adapter, IPC, Top Sellers Epic slice). Delivers the main correctness fix (real Epic top 99) and validates the adapter against §8.13.  
2. **Phase 2 next:** Uses same client and adapter; adds circuit detection and branches for search + browse fallback.  
3. **Phase 3 last:** Optional enrichment; depends on client and adapter; can be split (e.g. related first, then price, then achievements/reviews).

No change to Steam, Oracle, or Library in any phase.

---

## 6. Verification & Safety

- **Before merge (Phase 1):**  
  - Run adapter on at least one live egdata top-sellers item and one full offer (e.g. `GET /offers/03c9e4679725466891f8d72c832dcc01`); assert `transformEpicGame(adapter(offer))` yields valid `Game` (required fields set, no throw).  
  - Add unit test with mocked egdata offer (minimal + one with price/tags) and assert adapter + transform output.  
- **Field safety:** Follow §8.13 in `egdata-api-comparison.md`: validate required fields, map developer/publisher, build price shape, coerce tag ids, guarantee non-empty title.  
- **Fallback:** Every egdata use must have a fallback to current behavior (prefetch Epic slice, Epic GraphQL, or existing detail) so failures do not break the app.

---

## 7. Success Criteria (Additive, No Breaking)

- **Correctness:** “Top Sellers” shows a real Epic top-sellers list (99) when egdata is used for the Epic slice.  
- **Resilience:** When Epic is blocked, Epic search and Epic curated lists still work via egdata.  
- **Enrichment (optional):** Epic detail can show related offers, regional price, and optionally achievements/reviews from egdata.  
- **No regressions:** Steam, Oracle, Library, journey, and all existing Epic flows (browse “All,” prefetch, getGameDetails, getProductContent) continue to work; egdata only adds or replaces the Epic slice where we explicitly choose it (Top Sellers Epic slice, fallback when blocked, optional detail enrichment).

This plan is the single place to track implementing egdata additively to enrich and optimize correctness by filling the gaps identified in the analysis docs.

---

## 8. Review: Gaps and Mitigations

This section captures gaps identified during plan review and how they are addressed.

| Gap | Mitigation |
|-----|------------|
| **Pre-launch / legal** | Before production use of egdata: check egdata-api repo and any **terms of use**, **acceptable use**, **attribution**, and **rate limits**. Confirm whether an API key or rate limit applies later. (Ref: §8.12 egdata-api-comparison.) |
| **Library state (`isInLibrary`)** | egdata-sourced games must be merged with library state so “In Library” is correct. Use the same path as existing catalog games (e.g. set `isInLibrary` from merged library or game store when building the display list). Added to Phase 1 acceptance. |
| **Top Sellers order** | egdata returns `position` (1–99). Preserve this order when building the Epic slice so the list is not shuffled. Added to Phase 1 task 4 and acceptance. |
| **Store filter (Epic only vs Both)** | When store filter is “Epic only” and category Top Sellers, show only egdata 99; when “Both,” show Steam + egdata 99 merged. Added to Phase 1 task 4. (Ref: epic-top-sellers-comparison §6.) |
| **Catalog store vs display** | egdata top-sellers are for **display** only (Top Sellers view and fallback). Do **not** replace `epicCatalogStore` or the full prefetch cache; Oracle and “All” keep using existing Epic catalog. Added to Phase 1 acceptance. |
| **Adapter `releaseDate`** | Downstream code may call `.slice(0, 4)` on releaseDate. Adapter must set `releaseDate`/`effectiveDate` from egdata or default to `''`. Added to Phase 1 adapter task. |
| **Exact integration point** | “Trending” data comes from `getPrefetchedGames()` or `gameService.getTopSellers()`. Decide whether Epic slice substitution happens at **read time** (useGameStore / game-service) or inside **prefetch** (store separate trending Epic slice). Added to §4 File & Touch Points. |
| **Free / Coming Soon when blocked** | When Epic is blocked, “Free” and “Coming Soon” categories can also use egdata: `GET /free-games`, `GET /offers/upcoming`. Added to Phase 2 task 3. (Ref: §8.12 free games/upcoming.) |
| **CORS** | All egdata calls from main process (IPC to renderer). Avoid calling egdata from renderer/worker so CORS is not a concern. Noted in Phase 1 client task. |
| **Detail fallback: getAddons** | When Epic is blocked, game detail can use egdata `GET /offers/:id/related` instead of Epic’s getAddons. Phase 3 already has “related offers”; when in fallback mode, prefer egdata related over getAddons. No change needed. |
| **Optional: egdata rate limit / retry** | egdata does not document rate limits. Client can add a simple request timeout (e.g. 10–15 s). Optional: one retry on 5xx or network error. |
| **Optional: GCP failover** | egdata has `api.egdata.app` and `api-gcp.egdata.app`. Optional: on primary failure, try GCP endpoint once. |
| **Optional: Search fallback N+1** | Phase 2 search fallback does autocomplete + N×GET /offers/:id. For large N, consider caching offer details or limiting to first 10–20 results to avoid latency. |
