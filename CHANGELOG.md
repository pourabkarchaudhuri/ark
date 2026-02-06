# Changelog

All notable changes to Ark (Game Tracker) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.15] - 2025-02-05

### Fixed
- **Electron main process** – Define `__dirname` from `import.meta.url` in ESM so the app starts when run as a module (fixes crash and “window never opens” in tests and packaged app).
- **Electron e2e tests** – Longer timeouts for launch/firstWindow; dismiss changelog before clicking Library/Settings; use role-based locators for Browse/Library tabs so all 21 tests pass.

---

## [1.0.14] - 2025-02-05

### Added
- **INR pricing** – Game details and Steam data now show Indian Rupee (₹) from the Steam API (`cc=in`).
- **External links in default browser** – Steam store, Metacritic, FitGirl, and in-page links (description, requirements, languages) open in your default OS browser so your logins stay intact (`shell.openExternal`).

### Changed
- **Cleaner game lists** – Games without developer or publisher (e.g. FiveM) are no longer shown in Browse or Library; `hasValidDeveloperInfo` filters them out in Steam service and library games.
- **Library view** – Heart and Library badge are hidden in Library view; use the ellipsis menu or right-click to remove games.
- **Performance** – Game cards use a value-based memo comparison so they re-render only when game data or display flags change, reducing unnecessary re-renders during scrolling.

### Fixed
- Removed duplicate `declare global` Window type declarations from dashboard, window-controls, and title-bar so `openExternal` is correctly typed and used.

---

## [1.0.13]

- Export/import library, Clear library, better game images, search bar clears when switching to Library view.

## [1.0.12]

- Fixed game card navigation in production; hash-based routing for Electron.

## [1.0.11]

- Auto-update snackbar, game card clicks, library view shows all games.

## [1.0.10]

- Test release for auto-update.

## [1.0.9]

- Auto-update notifications and preload updater API.

## [1.0.8]

- Renamed to Ark, version in navbar, changelog modal.

## [1.0.7] – 1.0.6

- Version display, auto-update, custom icon, build fixes.
