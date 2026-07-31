# Ark v1.0.46 — Drag, Popovers, Cross-store Sync, Epic Cleanup

Five queued features shipped in one release.

## Added

- **Draggable carousels (mouse click-and-drag).** New shared hook `src/hooks/useDraggableScroll.ts` — pointer-based click-and-drag horizontal panning wired into Oracle shelf carousels and the Scheduled Broadcasts strip. 5 px activation threshold so plain clicks still open the card. Skips buttons / links / `[data-no-drag]` descendants. Uses `setPointerCapture` for pans that survive brief mouse exits, and swallows the release click so a drag never accidentally navigates.
- **Right-click Oracle recommendation → "Why recommended?" popover.** New `RecoWhyPopover` (portal-rendered, cursor-anchored, viewport-clamped) attached to Oracle cards. Reveals the game title, best-cluster label, similar-to titles (up to 3), shared genres (up to 4), and the top 5 non-zero layer signals with proportional bars. Closes on outside mousedown, Escape, scroll, or another context menu.
- **Cross-store status sync on 100% title match.** `libraryStore.propagateStatusByTitle` fires from `updateEntry` whenever a status change is Playing / Playing Now / Completed. Siblings across other stores (Steam/Epic) with the same normalized title mirror the status. Rules: Completed can overwrite anything not-Completed; Playing can only overwrite Want-to-Play / On-Hold. Never overwrites Completed or Playing Now. Also runs a one-shot startup sweep to reconcile any pre-existing inconsistencies.
- **Backlog excludes unannounced games.** `libraryStore.getBacklogEntries()` + `useLibraryBacklog()` filter Want-to-Play entries where the release date is missing, "TBA" / "TBD" / "Coming Soon" / "To Be Announced" / "Unknown", or a sentinel-future year (≥ 2090). Games with a real confirmed date stay.

## Fixed

- **Epic API dummy pages excluded.** Empty offers (no description AND no image) are now filtered out at every list-returning API path in `electron/epic-api.ts`, at every `transformEpicGame` call in `src/services/epic-service.ts`, and at persist time in `src/services/epic-catalog-store.ts`. Release-date presence is intentionally ignored — a page is dummy iff both description AND image are absent.

## Under the hood

- New `LibraryGameEntry.crossStoreSyncedFrom?: string` field — diagnostic trace of the sibling that drove a status propagation.
- New `libraryStore` public API: `propagateStatusByTitle`, `syncCrossStoreStatusesOnce`, `isReleaseDateConfirmed`, `getBacklogEntries`.
- New `useLibraryBacklog()` hook.
- 9 new unit tests covering cross-store propagation (Completed spread, Playing spread with Completed-sibling protection, Want-to-Play no-op, edition-suffix normalization) and backlog filtering.

---

**Tests:** 699/699 passing. Electron and renderer typecheck clean. Vite build clean.
**Data compatibility:** No IDB migration. Additive field only (`crossStoreSyncedFrom`). Existing users auto-reconcile any cross-store inconsistencies on first `getAllEntries()` after upgrade.
