# Ark v1.0.53

## What's new

### Year Wrapped
- Back/close chrome fixed so navigation out of Wrapped behaves correctly
- Richer year-end stats presentation

### Live Telemetry
- Insights update while a session is in progress
- Friction panel works from the first session (open sessions use live sample span)
- Tighter overhead sampling with millisecond session timestamps

### Overlay detail levels
- `Ctrl+Shift+D` cycles **collapsed → compact → expanded** (default: **compact**)
- Glassy minimal HUD; `Ctrl+Shift+O` still dismisses
- Lazy HWND create/destroy retained — no idle topmost shell
- Click-through still without `{ forward: true }` (no mouse-lag regression)

### Qwen3 listing
- Reranker shown in System Status and Settings alongside embed / Kaggle-style models
- Status probe treats Ollama non-2xx / `{ error: ... }` as not installed (no false “Installed”)

### Perf & Voyage polish
- Journey hours tick no longer storms store subscribers
- Custom-game live hours skip full notify on ticks (session-end still notifies)
- Quieter idle session polling and embedding work; overlay no longer receives telemetry samples
- Scenes & Audit charts get short TLDRs for quicker scan

### Install
Download and run **Ark-Setup-1.0.53.exe**.

### Notes (crash-safe packaging)
Installers must ship a valid `package.json` inside the app archive (version **1.0.53**). Corrupted packaging (as in 1.0.50) causes immediate exit with no in-app recovery — this release verifies the packaged JSON before publish.

### Smoke test
1. App opens to the main window (does not exit in under a second).
2. System Status shows a single Rerank Model block (with tier when ready), not a duplicate.
3. Settings → enable in-game overlay; start a tracked game — corner HUD appears at compact density; mouse feel should match overlay-off.
4. `Ctrl+Shift+D` cycles detail; quit the game — HUD window goes away.
5. Telemetry / Friction updates during an active session.
