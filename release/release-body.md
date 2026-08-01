## Ark 1.0.54 — Performance hotfix

Fixes lag, glitches, and elevated CPU/GPU use while gaming that regressed in 1.0.53.

### Highlights
- Overlay and main UI no longer share one unthrottled Chromium renderer
- Live telemetry / hours ticks coalesced; no localStorage storm every 15s during play
- Embedding polite mode engages for the whole tracked session
- System-status model probes poll far less often when the dropdown is closed
- Overlay hotkeys and live telemetry correctness preserved — just cheaper

**Reinstall / update to Latest** if 1.0.53 felt heavy during play.
