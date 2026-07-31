# Ark v1.0.41 — Health & Voyage Overhaul

Big release. Voyage / OCD Mode has been rebuilt around a new hero band + focus row. Time-tracking accuracy is fixed at the root. Session-tick freezes are gone. Update flow is no longer silent when it fails. And the Captain's Log "Invalid Date" bug is dead.

## Voyage / OCD Mode overhaul

- **Hero band** — Sticky top section showing every game where you're actively playing right now (either `Playing Now` OR last-played within 24 h). Each card has the cover, elapsed session minutes, and a 14-day activity ribbon of hours-per-day bars.
- **Focus row** — The top 3 games by rolling 30-day playtime, rendered as horizontal 12-week ridgelines. At-a-glance answer to "what am I actually playing?"
- **Rebuilt archive Gantt** — Want-to-Play and On-Hold segments no longer clutter the timeline. Completions become gold ▲ chevron milestones at the completion date, not wide grey wall-clock bars. Bar opacity scales to per-segment session intensity so short-but-intense play stands out.
- **Unified scroll** — Sidebar and Gantt timeline now share one vertical scroll container. No more panels drifting apart when you scroll. Sidebar auto-collapses to a thumbnail strip after 200 px of scroll.
- **Playing Now pips** — Sessions inside a Playing segment are now rendered as fuchsia-accented Playing-Now pips with subtle ring shadow.

## Time tracking — fixed at the root

- **Full exe-path matching** — Session tracker no longer relies on basename alone. Games sharing an executable name (common in indie Unity titles) can no longer double-count. First-time basename-only match logs a diagnostic warning.
- **Session-fragment tolerance raised** — `MISSES_BEFORE_END` bumped from 2 to 4 polls (~60 s). Heavy GPU load, AV scans, and PowerShell contention no longer split one play block into many phantom sessions.
- **"Playing since" now correct** — Five code paths that derived `firstPlayedAt` from your library-add date have been rewritten to use your earliest recorded session start (falling back to the first `Want-to-Play → Playing` status transition, then last-played, then added-at). Games that spent months in your backlog before you played them now show the correct first-play date.
- **Exe metadata IPC** — New `window.exeInfo.analyze(exePath)` reads file mtime, size, and digital-signature signer + validity via PowerShell. Detects known launchers (EA, Riot, Steam, Valve, Rockstar, Ubisoft, Epic, Bethesda, Blizzard, Battle.net, GOG, Uplay, Origin) plus basename hints (`launcher`, `bootstrap`, `loader`) for a future "That looks like a launcher, not a game" warning during exe selection.

## Auto-state (opt-in)

- **Want-to-Play → Playing** — After a session ≥ 10 minutes, games automatically promote out of your backlog to Playing. Behind a preferences toggle (default off). Stamps `autoTransitionedAt` so a future undo UI can revert. Never overwrites Completed, On-Hold, or explicit Playing-Now.
- **On-Hold suggestions** — New helper hook detects games sitting in Playing with no session for 14+ days for a future "Suggest pausing?" chip.

## Update flow — no more silence

- **"Check for Updates" button** in Settings → About. Manual check with spinner, latest-version display, and one-click Download when an update is available.
- **Update snackbar error state** — If GitHub is unreachable at startup, you now see a dismissible "Couldn't reach GitHub — will try again in 2 min." toast with a Retry-now action. Previously silent.
- **Pre-release version comparison** — Releases tagged `1.0.42-rc1` now compare correctly against `1.0.41`. No more silent "no update" when a pre-release ships.

## Random-offline banner — fixed

- **Adblocker whitelist** — The connectivity probe to `connectivitycheck.gstatic.com` is now allowed through before EasyList / EasyPrivacy filtering. The banner no longer flaps because the built-in adblocker cancelled its own probe.
- **Probe hardened** — Timeout raised 5 s → 12 s. Two consecutive failures required before flipping offline.

## Session-tick performance

- **Hours-only subscription channel** — Library store now has a separate `subscribeHours` channel. The 15-second `updateHoursFromSessions` writes fire only that channel, not every listener. The master 6000+-entry games memo, Oracle signature check, and Medals view all stay quiet during play.
- **`useLibraryHours(gameId)` hook** — Per-card live hours subscription without invalidating the master games memo.
- **Session-store + status-history writes debounced** — 300 ms scheduler replaces synchronous `JSON.stringify` + `localStorage.setItem` on every session end and status change.
- **Oracle shelf virtualization** — Horizontal `useVirtualizer` (264 px card width, 3 overscan). Only ~10 cards render per shelf instead of all 40+.
- **ann-graph RAF leak fixed** — Supernova + shockwave animation ID sets no longer grow unbounded during long play sessions. IDs are removed each frame.
- **Idempotent `beforeunload` listeners** — Library, journey, and custom-game store singletons no longer stack handlers under HMR / tests.

## Transmissions

- **Scheduled Broadcast cards get cover art** — Extracted from event pages via `og:image` → `twitter:image` → JSON-LD → `link rel=image_src` → hero `<img>` precedence chain. Falls back to the existing celestial etching when no image is available.

## Captain's Log

- **"Invalid Date" fixed** — Journey-view card date now uses `parseJourneyIso` guard. Journey store also sanitizes date fields on load, record, and import so the bug can't regress from legacy data.

## Fixes

- Journey / library / custom-game store `firstPlayedAt` fallback chains rewritten (5 sites, all using new `sessionStore.getFirstSessionStart` and `statusHistoryStore.getFirstPlayingTransition` helpers).
- Journey store sanitizes `addedAt` / `firstPlayedAt` / `lastPlayedAt` / `removedAt` on all write paths.

## Under the hood

- New IPC: `exe-info:analyze` (main → renderer via `window.exeInfo.analyze`).
- New settings: `preferences.autoStatusTransition` (opt-in Want-to-Play → Playing promotion).
- New library-store type field: `LibraryGameEntry.autoTransitionedAt?`.
- New event-scraper field: `ScrapedEvent.imageUrl`, threaded through `ResolvedEvent`.
- Renderer connectivity probe now correctly labels itself in DevTools; adblocker no longer cancels it.

---

**Tests:** 666/666 passing. Electron and renderer typecheck clean.

**Data compatibility:** No IDB migration required. Cached embeddings, sessions, and library state all remain valid.
