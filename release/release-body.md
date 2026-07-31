# Ark v1.0.42 — Update Flow, Oracle, Search, Auto-State Hotfix Bundle

Emergency hotfix bundling multiple v1.0.41 regressions and follow-through work.

## Fixed

- **Update flow — "Failed to update" bug.** Differential (blockmap) downloads disabled; every update pulls the full installer. Real electron-updater error is preserved and shown to the user (was being clobbered by a generic catch-all). "Download from GitHub" fallback button added to the snackbar and Settings About tab for manual recovery when auto-update fails.
- **Oracle shelf cards no longer collapsed.** Reverted the v1.0.41 horizontal virtualization on shelf carousels — the absolute-positioned wrapper had no explicit height and its fixed 264 px `estimateSize` fought `OracleCard`'s min/max width clamp. Restored the original `flex gap-4` layout.
- **Steam / Epic game-details hero parity.** Epic games now use their CMS gallery hero image as the wide backdrop (prefers a URL matching `/hero|background/i`, else first gallery image, else `headerImage`/`coverUrl`). A stylized fuchsia-tinted gradient renders behind the hero so Epic games without any art still match Steam's stylized look.
- **Live Transmissions cover images.** RSS extractor gained `<content:encoded>` HTML scanning (WordPress full-post content), `<itunes:image>` for podcast RSS, channel-level `<image><url>` fallback, and protocol-relative URL normalization. Warns per source when a feed item still ends up imageless.
- **Browse search doesn't refresh the grid on every keystroke.** Split into `typingQuery` (dropdown-only) and `committedQuery` (grid filter). Grid rebuilds on Enter (instant), clicking a suggestion, or 400 ms of typing idle. No more grid flicker while typing.
- **Search suggestions dropdown scrolls with "+N more" footer.** Sticky bottom bar shows `+N more results` on the left and a `↵ to see all` kbd hint on the right when the dropdown has more than ~8 rows.

## Added

- **Auto Playing → On Hold sweep.** Any library entry in `Playing` whose `lastPlayedAt` is 30+ days old now automatically moves to `On Hold`. Runs on app startup + every 60 min. Opt out via `preferences.autoOnHoldTransition` (default on). Never overwrites `Completed`, `Playing Now`, `Want to Play`, or `On Hold`. Stamps `autoTransitionedAt` so future UI can offer one-click undo.
- **Launcher-aware auto-state gate.** The v1.0.41 Want-to-Play → Playing auto-transition now invokes `window.exeInfo.analyze(exePath)` first. If the signer matches a known launcher publisher (EA, Riot, Steam, Valve, Rockstar, Ubisoft, Epic, Bethesda, Blizzard, Battle.net, GOG, Uplay, Origin) or the basename contains `launcher`/`bootstrap`/`loader`, promotion is skipped and `launcherDetected: true` is stamped. Playtime tracked via a launcher is unreliable — we no longer promote games based on it.
- **`LibraryGameEntry.launcherDetected?: boolean`** field. UIs can now surface a "this looks like a launcher — tracking may be inaccurate" warning.

## Under the hood

- New hook `src/hooks/useAutoOnHold.ts` — periodic sweep, wired via `useSessionTracker`.
- New setting `preferences.autoOnHoldTransition` in `electron/settings-store.ts` (default TRUE).
- `epicToSteamDetails` gallery-hero extraction with `/hero|background/i` preference.
- `electron/ipc/rss-handlers.ts` extended parser (content:encoded, itunes:image, channel image, protocol-relative URL normalization).
- Dashboard search state split; `SearchSuggestions` container `max-h-[28rem]` with sticky "+N more" footer.
- `autoUpdater.disableDifferentialDownload = true`.
- Structured download IPC return: `{ success, error?, errorName? }`.
- Structured error log: `name`, `message`, `stack` (previously only `message`).

## For users stranded on v1.0.40 or v1.0.41

If your auto-update failed, download the v1.0.42 installer directly from this release page and run it — your library, sessions, settings, and cached data are all preserved (the installer performs an in-place upgrade).

---

**Tests:** 666/666 passing. Electron and renderer typecheck clean.
**Data compatibility:** No IDB migration required.
