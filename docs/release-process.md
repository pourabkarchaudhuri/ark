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

Build artifacts appear in `release/`:

| File | Purpose |
|------|---------|
| `Ark-Setup-X.Y.Z.exe` | NSIS installer (~134 MB as of v1.0.31) |
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

**Important:** Do NOT pass the release body as an inline JSON string — special characters (single quotes, newlines) break `curl`'s JSON parsing. Instead, write the body to a file and use `node` to build a properly escaped JSON payload.

**Step 1 — Write the release body as Markdown:**

Create/update `release/release-body.md` with the release notes.

**Step 2 — Generate the JSON payload:**

```bash
node -e "
const fs = require('fs');
const body = fs.readFileSync('release/release-body.md', 'utf8');
const payload = JSON.stringify({
  tag_name: 'v1.0.NEW_VERSION',
  name: 'v1.0.NEW_VERSION',
  body: body,
  draft: false,
  prerelease: false
});
fs.writeFileSync('release/release-payload.json', payload);
"
```

**Step 3 — Create the release via the API:**

```bash
curl -s -X POST \
  -H "Authorization: token YOUR_PAT" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/pourabkarchaudhuri/ark/releases" \
  -d @release/release-payload.json
```

Note the `id` field from the JSON response — this is the **Release ID** needed for asset uploads.

**Step 4 — Clean up the payload file:**

```bash
rm release/release-payload.json
```

### Upload assets

Three files must be uploaded for the auto-updater to work:

```bash
RELEASE_ID=<from previous step>
PAT=<your token>
REPO="pourabkarchaudhuri/ark"

# 1. NSIS installer (~134 MB, takes ~25 seconds)
curl -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=Ark-Setup-1.0.NEW_VERSION.exe" \
  --data-binary "@release/Ark-Setup-1.0.NEW_VERSION.exe"

# 2. Blockmap (for delta updates)
curl -s -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=Ark-Setup-1.0.NEW_VERSION.exe.blockmap" \
  --data-binary "@release/Ark-Setup-1.0.NEW_VERSION.exe.blockmap"

# 3. latest.yml (auto-updater manifest)
curl -s -X POST \
  -H "Authorization: token $PAT" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=latest.yml" \
  --data-binary "@release/latest.yml"
```

### Verify the release

```bash
curl -s -H "Authorization: token $PAT" \
  "https://api.github.com/repos/pourabkarchaudhuri/ark/releases/latest" \
  | node -e "
const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{
  const j=JSON.parse(Buffer.concat(d));
  console.log('Release:', j.name);
  console.log('Tag:', j.tag_name);
  console.log('Published:', j.published_at);
  console.log('Assets:');
  j.assets.forEach(a=>console.log('  -',a.name,'('+a.size+' bytes, state:'+a.state+')'));
})"
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
| Build Step 1 | `npm run clean && npx tsc -p tsconfig.node.json && cp electron/preload.cjs dist-electron/electron/preload.cjs && npx vite build` |
| Build Step 2 | `ELECTRON_BUILDER_NSIS_DIR="$(pwd)/.nsis-cache/nsis-3.0.4.1" ELECTRON_BUILDER_NSIS_RESOURCES_DIR="$(pwd)/.nsis-cache/nsis-resources-3.4.1" npx electron-builder --win nsis --publish never` |
| Verify artifacts | `ls -lh release/Ark-Setup-*.exe release/*.yml release/*.blockmap` |
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
| 1.0.31 | 2026-02-18 | Medals system, Oracle recommendations, Ollama embeddings, Year Wrapped, Gantt virtualization, perf fixes |
| 1.0.30 | 2026-02-17 | UI rebrand, release calendar redesign, IPC refactor, Metacritic rewrite, loading screen removal |
| 1.0.29 | 2026-02-12 | Fix splash screen crash in packaged builds, asset path hardening |
| 1.0.28 | 2026-02-12 | Epic Games Store, game details overhaul, 3D splash, perf fixes |
| 1.0.27 | 2026-02-11 | Browse game count fix, custom game status, spinner z-order |
| 1.0.26 | 2026-02-11 | Calendar overhaul, consistent modals, custom game navigation |
| 1.0.25 | 2026-02-10 | Performance optimization, memory management, thumbnail fallbacks |
