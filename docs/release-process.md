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

As of v1.0.28: **297 tests** across **20 test suites**.

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

**Important:** Do NOT include `Co-authored-by: Cursor` or similar AI tool trailers in the commit message.

If the commit was auto-tagged with a Cursor trailer, amend it:

```bash
# Only if the commit has NOT been pushed yet:
git commit --amend  # (edit message to remove trailer)

# If already pushed, amend then force push:
git commit --amend
git tag -d v1.0.NEW_VERSION
git tag v1.0.NEW_VERSION
git push origin main --tags --force
```

---

## 5. Build the Electron NSIS Installer

### The NSIS Cache Problem

`electron-builder` downloads NSIS binaries from GitHub on every build. On restricted networks, this download is blocked. The solution is to use the **local NSIS cache** stored at `.nsis-cache/` in the project root.

### Build Commands

**Step 1 — Compile TypeScript + Vite build:**

```bash
npm run clean && tsc -p tsconfig.node.json && cp electron/preload.cjs dist-electron/electron/preload.cjs && vite build
```

**Step 2 — Run electron-builder with local NSIS:**

```bash
export ELECTRON_BUILDER_NSIS_DIR="$(pwd)/.nsis-cache/nsis-3.0.4.1"
export ELECTRON_BUILDER_NSIS_RESOURCES_DIR="$(pwd)/.nsis-cache/nsis-resources-3.4.1"
npx electron-builder --win nsis --publish never
```

Or as a single command (**use absolute paths** — relative paths cause ENOENT on Windows):

```bash
ELECTRON_BUILDER_NSIS_DIR="$(pwd)/.nsis-cache/nsis-3.0.4.1" \
ELECTRON_BUILDER_NSIS_RESOURCES_DIR="$(pwd)/.nsis-cache/nsis-resources-3.4.1" \
npx electron-builder --win nsis --publish never
```

### Output

Build artifacts appear in `release/`:

| File | Purpose |
|------|---------|
| `Ark-Setup-X.Y.Z.exe` | NSIS installer (~120 MB) |
| `Ark-Setup-X.Y.Z.exe.blockmap` | Delta update blockmap |
| `latest.yml` | Auto-updater manifest (version, sha512, size) |

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

### Create the release

Use the GitHub API with a PAT:

```bash
curl -s -X POST \
  -H "Authorization: token YOUR_PAT" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/pourabkarchaudhuri/ark/releases" \
  -d '{
    "tag_name": "v1.0.NEW_VERSION",
    "name": "v1.0.NEW_VERSION",
    "body": "## What'\''s New in Ark v1.0.NEW_VERSION\n\n- Change 1\n- Change 2\n...",
    "draft": false,
    "prerelease": false
  }'
```

Note the `Release ID` from the response — needed for asset uploads.

### Upload assets

Three files must be uploaded for the auto-updater to work:

```bash
RELEASE_ID=<from previous step>
PAT=<your token>
REPO="pourabkarchaudhuri/ark"

# 1. NSIS installer
curl -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=Ark-Setup-1.0.NEW_VERSION.exe" \
  --data-binary "@release/Ark-Setup-1.0.NEW_VERSION.exe"

# 2. Blockmap (for delta updates)
curl -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=Ark-Setup-1.0.NEW_VERSION.exe.blockmap" \
  --data-binary "@release/Ark-Setup-1.0.NEW_VERSION.exe.blockmap"

# 3. latest.yml (auto-updater manifest)
curl -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=latest.yml" \
  --data-binary "@release/latest.yml"
```

### Required release assets checklist

- [ ] `Ark-Setup-X.Y.Z.exe` — the NSIS installer
- [ ] `Ark-Setup-X.Y.Z.exe.blockmap` — delta update support
- [ ] `latest.yml` — auto-updater needs this to detect new versions

**Note on `latest.yml`:** Only upload if the sha512 hash differs from the previous release (it always will for a new version since the exe changes). No need to recreate it manually — `electron-builder` generates it automatically.

---

## Quick Reference

| Step | Command |
|------|---------|
| Run tests | `npx vitest run` |
| Build (full) | Steps 1 + 2 above |
| Build (if Vite already done) | Step 2 only (electron-builder) |
| Verify artifacts | `ls -lh release/Ark-Setup-*.exe release/*.yml release/*.blockmap` |
| Check previous release | `curl -s -H "Authorization: token $PAT" "https://api.github.com/repos/pourabkarchaudhuri/ark/releases/latest"` |

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| 1.0.30 | 2026-02-17 | UI rebrand, release calendar redesign, IPC refactor, Metacritic rewrite, loading screen removal |
| 1.0.29 | 2026-02-12 | Fix splash screen crash in packaged builds, asset path hardening |
| 1.0.28 | 2026-02-12 | Epic Games Store, game details overhaul, 3D splash, perf fixes |
| 1.0.27 | 2026-02-11 | Browse game count fix, custom game status, spinner z-order |
| 1.0.26 | 2026-02-11 | Calendar overhaul, consistent modals, custom game navigation |
| 1.0.25 | 2026-02-10 | Performance optimization, memory management, thumbnail fallbacks |
