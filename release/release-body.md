# Ark v1.0.101 — smoother 3D

## Fixed

- **Voyage, Your Ark** loads covers only for the boxes around the selected one (nearest first, a few at a time) and decodes them at a small size, instead of loading the whole ring at once. Entering the gallery no longer freezes, and stepping through boxes stays smooth.
- **Splash screen** backdrop renders at a lower resolution and with a smaller shadow map.
- The glowing "Enter Embedding Space" border does less work per frame.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.101/Ark-Setup-1.0.101.exe

---

**Tests:** 3502 tests (335 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**Ranking:** unchanged (Oracle engine version 16, embedding version 2).
