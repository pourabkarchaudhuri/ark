## Ark 1.0.56 — UX hotfix trio + Embedding Space declutter

### Fixed
- **Ark Wrapped soft-lock** — slide navigation uses full-overlay hit-testing (not tiny calendar cells); always-visible Back / Continue / Done chrome.
- **Guided tour stuck dimmer** — generation-scoped Joyride leftover sweep, Escape clears orphan portals after Finish, spotlight no longer uses a full-screen blocker shadow.
- **Overlay detail levels restored on main** — Ctrl+Shift+D cycles collapsed → compact → expanded with HWND resize (ported from the 1.0.53 line). Lazy create/destroy and click-through without mouse forward preserved.

### Added
- Always-visible overlay shortcut hints on compact/expanded (`O dismiss · D cycle`), plus Settings copy for Ctrl+Shift+O / Ctrl+Shift+D.
- 1.0.55 ANN Settings (Rebuild ANN, What’s New) unchanged.

### Changed
- **Embedding Space declutter** — Timeshear, Cartographer HUD, and Monuments removed. Codex remains via C hotkey (Curator).
