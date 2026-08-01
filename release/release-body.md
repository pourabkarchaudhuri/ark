# Ark v1.0.52

## Critical startup fix

**1.0.50 would not open.** The published installer contained a corrupted app package (`package.json` inside the archive was unreadable), so Electron exited immediately — blank/no window, and in-app update could not run. Download and install **Ark-Setup-1.0.52.exe** to replace it.

## Also in this build

### Overlay mouse-lag hotfix (from 1.0.51)
- Click-through without Chromium mouse forwarding (no system-wide cursor lag)
- Overlay window created only while a tracked game is running; destroyed when play ends
- Async session process polling (no sync `tasklist`/PowerShell on the main thread)
- Leaner HUD — no backdrop blur or pulsing badge

### Chunked embeddings Phase A (from 1.0.50)
- Facet chunk embeddings with int8 pooled game vectors; lazy dual-format upgrade
- Kill switch: Settings → Ollama → “Facet chunk embeddings”

### Install
Download and run **Ark-Setup-1.0.52.exe** (uninstalling 1.0.50 first is optional but fine).

### Smoke test
1. App opens to the main window (does not exit in under a second).
2. Settings → enable in-game overlay; start a tracked game — corner HUD appears; mouse feel should match overlay-off.
3. Quit the game — HUD window goes away.
