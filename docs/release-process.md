# Ark Release Process

Step-by-step guide for building and publishing a new Ark release.

---

## Prerequisites

- Node.js and npm installed
- Git authenticated with push access to `pourabkarchaudhuri/ark`
- GitHub PAT with `repo` scope (for creating releases and uploading assets)
- Local NSIS cache at `.nsis-cache/` in the project root (already set up, gitignored)

---

## 1. Run Tests

```bash
npx vitest run
```

All tests must pass. If any fail, fix them before proceeding.

As of v1.0.31: **347 tests** across **22 test suites** (8 pre-existing failures in game-details and game-card tests are known).

---

## 2. Bump Version

Determine the next version increment (current pattern: `1.0.X` where X increments by 1).

Update `package.json`:

```json
"version": "1.0.NEW_VERSION"
```

---

## 3. Update Changelog

Add a new entry at the **top** of the `CHANGELOG` object in `src/components/changelog-modal.tsx`:

```typescript
'1.0.NEW_VERSION': {
  title: "What's New in Ark 1.0.NEW_VERSION",
  changes: [
    'Feature or fix description here',
    // ...
  ],
},
```

---

## 4. Commit, Tag, and Push

```bash
git add -A
git commit -m "$(cat <<'EOF'
v1.0.NEW_VERSION: Short summary of changes

- Bullet point details
- ...
EOF
)"
git tag v1.0.NEW_VERSION
git push origin main --tags
```

---

## 5. Build the Electron NSIS Installer

### The NSIS Cache Problem

`electron-builder` downloads NSIS binaries from GitHub on every build. On restricted networks, this download is blocked. The solution is to use the **local NSIS cache** stored at `.nsis-cache/` in the project root.

### Build Commands

**Step 1 — Compile TypeScript + Vite build:**

Note: `tsc` is not globally installed on this machine; use `npx` prefixes.

```bash
npm run clean && npx tsc -p tsconfig.node.json && cp electron/preload.cjs dist-electron/electron/preload.cjs && npx vite build
```

**Step 2 — Run electron-builder with local NSIS (project-root cache):**

```bash
ELECTRON_BUILDER_NSIS_DIR="$(pwd)/.nsis-cache/nsis-3.0.4.1" \
ELECTRON_BUILDER_NSIS_RESOURCES_DIR="$(pwd)/.nsis-cache/nsis-resources-3.4.1" \
npx electron-builder --win nsis --publish never
```

This is the exact command that worked for v1.0.31. The `.nsis-cache/` directory in the project root contains the NSIS binaries. Do **not** use `export` — inline env vars on the same command line work correctly in Git Bash on Windows.

### Output

Build artifacts appear in **`release/builds/<version>/`** (set by `build.directories.output` in package.json — one folder per version, inside the gitignored `release/`). Never pass `--config.directories.output` to point a build at a new root-level folder: that is what used to litter the repo root with `release-NNNN/` directories.

| File | Purpose |
|------|---------|
| `Ark-Setup-X.Y.Z.exe` | NSIS installer (~134 MB as of v1.0.31) |
| `Ark-Setup-X.Y.Z.exe.blockmap` | Delta update blockmap |
| `latest.yml` | Auto-updater manifest (version, sha512, size) |

### Managing local build folders

Each build keeps its own folder, so old ones accumulate (~0.3–1.5 GB each). Published versions live on GitHub, so only the latest couple are worth keeping locally:

```bash
npm run release:prune                    # dry run: lists what would go (keeps 2 newest)
npm run release:prune -- --apply         # delete them
npm run release:prune -- --legacy --apply  # also clear pre-1.0.72 leftovers (root release-NNNN/, _asar-cmp/, release/builds/_legacy/)
```

If a folder refuses to delete or move, a file inside `win-unpacked/resources` (`app.asar` or a native `.node` module) is still held open by Windows — close any Ark launched from that folder, or reboot, then re-run. Do not work around a locked folder by building into a new output directory.

### If NSIS Cache Is Missing

If `.nsis-cache/` is empty or corrupted, restore from `%LOCALAPPDATA%\electron-builder\Cache\nsis\`:

```bash
cp -r "$LOCALAPPDATA/electron-builder/Cache/nsis/nsis-3.0.4.1/"* .nsis-cache/nsis-3.0.4.1/
cp -r "$LOCALAPPDATA/electron-builder/Cache/nsis/nsis-resources-3.4.1/"* .nsis-cache/nsis-resources-3.4.1/
```

Or run a successful build on an unrestricted network first, then copy the cache.

### NSIS Versions (as of electron-builder v26.7.0)

- **NSIS:** `3.0.4.1` (do NOT use 3.0.4.2 — [known issue](https://github.com/electron-userland/electron-builder/issues/6334))
- **NSIS Resources:** `3.4.1`
- **Environment variables:** `ELECTRON_BUILDER_NSIS_DIR`, `ELECTRON_BUILDER_NSIS_RESOURCES_DIR`

---

## 6. Create GitHub Release

Use the script. It is the only supported publish path (the old `release:draft` electron-builder
publish and the hand-rolled curl steps are gone).

1. Write the release notes to `release/release-body.md`. Start with a direct installer link
   (`https://github.com/pourabkarchaudhuri/ark/releases/download/vX.Y.Z/Ark-Setup-X.Y.Z.exe`)
   for users whose in-app updater keeps failing.
2. Publish:

   ```bash
   GITHUB_TOKEN=<pat> npm run release:publish
   ```

   The script:
   - checks the three artifacts exist in `release/builds/<version>/` and that `latest.yml` names this version's installer;
   - creates the release as a **draft** (or reuses an existing draft for the same tag);
   - uploads `Ark-Setup-X.Y.Z.exe`, `.blockmap` and `latest.yml` (via curl; the token goes in a temp header file, never on the command line);
   - re-reads the release and checks each asset is `uploaded` with the same size as on disk;
   - only then publishes it (`draft: false`, `make_latest`).

   If anything fails the release stays a draft, so no client can see a release without
   `latest.yml` or with a half-uploaded installer. Fix the problem and run the script again;
   it resumes with the existing draft and skips assets already uploaded.

### Verify the release

```bash
npm run release:verify            # current package.json version
node scripts/verify-release.mjs 1.0.84 --download   # also stream + hash the published installer
```

Checks, by tag (not `/releases/latest`): the release is published; the installer, blockmap and
`latest.yml` are uploaded; `latest.yml` names this version's installer with the right size; the
local installer's sha512 matches `latest.yml`; the packaged `.env` contains only allow-listed key
names; no token file was packaged; only the win32/x64 onnxruntime binaries were packaged.
`--download` is off by default because some networks reset executable downloads.

### Required release assets checklist

- [ ] `Ark-Setup-X.Y.Z.exe` — the NSIS installer
- [ ] `Ark-Setup-X.Y.Z.exe.blockmap` — kept for compatibility (differential download is disabled)
- [ ] `latest.yml` — the auto-updater reads this to detect new versions

### Troubleshooting "error downloading update"

- The update toast shows the error code and a hint (connection reset, timeout, blocked, checksum,
  disk full, file locked). **Try alternate download** resumes an interrupted download, verifies
  the sha512 from `latest.yml`, opens the installer and closes Ark.
- If the toast says the download was **blocked**, a firewall/proxy/security tool is stopping the
  installer. Use **Download from GitHub** (browser) or ask IT to allow GitHub release downloads.
- Users on 1.0.83 or older have the old updater: point them at the direct installer link in the
  release notes.

---

## Quick Reference

| Step | Command |
|------|---------|
| Run tests | `npx vitest run` |
| Build Step 1 | `npm run clean && npx tsc -p tsconfig.node.json && cp electron/preload.cjs dist-electron/electron/preload.cjs && npx vite build` |
| Build Step 2 | `ELECTRON_BUILDER_NSIS_DIR="$(pwd)/.nsis-cache/nsis-3.0.4.1" ELECTRON_BUILDER_NSIS_RESOURCES_DIR="$(pwd)/.nsis-cache/nsis-resources-3.4.1" npx electron-builder --win nsis --publish never` |
| Verify artifacts | `ls -lh release/builds/1.0.NEW_VERSION/` |
| Publish | `GITHUB_TOKEN=<pat> npm run release:publish` |
| Verify release | `npm run release:verify` |
| Prune old builds | `npm run release:prune` (dry run) → `npm run release:prune -- --apply` |
| Check latest release | `curl -s -H "Authorization: token $PAT" "https://api.github.com/repos/pourabkarchaudhuri/ark/releases/latest"` |

---

## Cached Files

The following cached files live in the project root and are gitignored:

| Directory | Purpose |
|-----------|---------|
| `.nsis-cache/nsis-3.0.4.1/` | NSIS compiler binaries for electron-builder |
| `.nsis-cache/nsis-resources-3.4.1/` | NSIS resource files (plugins, stubs) |

These are needed because the corporate network blocks downloads from `github.com/electron-userland/electron-builder-binaries`. If the cache is lost, restore from `%LOCALAPPDATA%\electron-builder\Cache\nsis\` or download from an unrestricted network.

---

## Gotchas

1. **`tsc` not found:** Use `npx tsc` instead of bare `tsc` — TypeScript is not globally installed.
2. **`python3` not found:** Python is not available on this machine. Use `node -e` for scripting.
3. **Inline JSON with curl:** Single quotes and newlines in the release body break `curl`'s `-d '...'` syntax. Always use the `release-payload.json` file approach (Step 6, above).
4. **NSIS env vars:** Inline env vars (`VAR=val command`) work in Git Bash. Do not use `export` as a separate statement — it works but is unnecessary and can confuse the shell if the command is run in a subshell.
5. **Build time:** electron-builder step takes ~4 minutes. The exe upload takes ~25 seconds on this network.

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| 1.0.37 | 2026-04-13 | Similar Games (ANN) on game details; browse search grid/dropdown sync; search debounce 400ms |
| 1.0.36 | 2026-04-12 | Guided tour spotlight fix, rerank badges, Ollama reranking pipeline, AI chat improvements, tour flow audit |
| 1.0.35 | 2026-03-14 | Playtime baseline fix (no more reset when tracking exe), Transmissions improvements |
| 1.0.31 | 2026-02-18 | Medals system, Oracle recommendations, Ollama embeddings, Year Wrapped, Gantt virtualization, perf fixes |
| 1.0.30 | 2026-02-17 | UI rebrand, release calendar redesign, IPC refactor, Metacritic rewrite, loading screen removal |
| 1.0.29 | 2026-02-12 | Fix splash screen crash in packaged builds, asset path hardening |
| 1.0.28 | 2026-02-12 | Epic Games Store, game details overhaul, 3D splash, perf fixes |
| 1.0.27 | 2026-02-11 | Browse game count fix, custom game status, spinner z-order |
| 1.0.26 | 2026-02-11 | Calendar overhaul, consistent modals, custom game navigation |
| 1.0.25 | 2026-02-10 | Performance optimization, memory management, thumbnail fallbacks |
