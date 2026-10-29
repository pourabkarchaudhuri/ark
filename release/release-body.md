# Ark v1.0.89 — How long to beat

## New

- **Game pages show how long a game takes to beat**, from HowLongToBeat: main story, main + extras, and completionist hours. Click the badge to see the game on howlongtobeat.com.
- **Smart matching:** store edition names and trademark symbols are ignored, and the release year tells remakes and sequels apart. If Ark isn't sure it has the right game, it shows nothing rather than a wrong time.
- **Ask the AI assistant** "how long is Hades?" and it answers with the same data.
- **Your choice:** turn it off in Settings → Application. When on, the game's title is sent to howlongtobeat.com; answers are kept for 30 days so the same game isn't looked up again.

If the in-app update fails, download the installer directly:
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.89/Ark-Setup-1.0.89.exe

---

**Tests:** 1667 tests (145 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects. Checked live against howlongtobeat.com.
**No ranking change.**
