# Ark v1.0.84 — Reliable updates

**If the in-app update keeps failing, download the installer directly:**
https://github.com/pourabkarchaudhuri/ark/releases/download/v1.0.84/Ark-Setup-1.0.84.exe
Run it over your current install. Your library and settings are kept.

## Fixed

- **Clear update errors.** Instead of "error downloading update", Ark now tells you what happened (connection cut, timeout, blocked by security software or your network, disk full, and so on) and what to try next.
- **Try alternate download.** If an update download is interrupted, this resumes it where it stopped, checks the installer is genuine, opens it, and closes Ark so it can install.
- **No more false "up to date".** If GitHub can't be reached, the update check now says so.
- **No more stuck downloads.** A stalled download is retried automatically, and old error messages don't linger.

## Changed

- Smaller installer (unused machine-learning files for other platforms removed).
- API keys in web addresses are hidden from logs.

---

**Tests:** 1609 tests (138 files) passing under `vitest --isolate`. Typecheck clean on both TypeScript projects.
**No ranking change. No data changes.**
