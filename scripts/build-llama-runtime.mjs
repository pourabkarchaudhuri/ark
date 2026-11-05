/**
 * Unpack the pinned llama.cpp release into build/llama-runtime (1.0.97 B36). Run by build:app;
 * electron-builder's extraResources ships that folder as resources/llama-runtime.
 *
 *   node scripts/build-llama-runtime.mjs [--update-manifest] [--zip=<path>]
 *
 * The release zip (electron/local-ai/runtime-manifest.json: build tag, url, sha256) is cached in
 * .llama-cache/ (gitignored) and only downloaded when missing or when its hash does not match.
 * Only llama-server.exe and its DLLs are kept, plus the MIT licence. Every kept file must match
 * the sha256 recorded in the manifest; --update-manifest records them instead (after a pin bump).
 * Model weights are never part of this: Ark downloads them at runtime.
 *
 * The pinned url is the upstream SOURCE archive: the pinned sha256/size/files describe the zip that
 * scripts/build-llama-from-source.mjs builds from it with MSVC (not an upstream binary). When no cached
 * zip matches, this script runs that build itself (needs Visual Studio Build Tools, cmake, ninja and the
 * Vulkan SDK pieces, see docs/release-process.md) and, because an MSVC build is not bit-reproducible,
 * re-pins sha256, size and file hashes in the manifest for review and commit. --no-source-build fails
 * instead of building.
 *
 * A network that resets GitHub release downloads: fetch the zip in a browser and pass it with
 * --zip=<path> (or ARK_LLAMA_RUNTIME_ZIP); it is copied into the cache only if its sha256 matches.
 * (Some networks reset GitHub release-asset downloads of zip files; curl, PowerShell and Node all fail
 * the same way there. Fetch the zip from another network once; it stays in .llama-cache.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRuntimeDir, hashRuntimeDir, isRuntimeFile, readManifest, sha256File } from './lib/llama-runtime.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The ARK_LLAMA_* overrides exist for the script's own test (a synthetic zip in a temp folder).
const manifestPath = process.env.ARK_LLAMA_MANIFEST || path.join(root, 'electron', 'local-ai', 'runtime-manifest.json');
const cacheDir = process.env.ARK_LLAMA_CACHE_DIR || path.join(root, '.llama-cache');
const outDir = process.env.ARK_LLAMA_OUT_DIR || path.join(root, 'build', 'llama-runtime');
let updateManifest = process.argv.includes('--update-manifest');
const noSourceBuild = process.argv.includes('--no-source-build');
const fromSourceScript = process.env.ARK_LLAMA_FROM_SOURCE_SCRIPT || path.join(root, 'scripts', 'build-llama-from-source.mjs');
/** The manifest url is a source tarball (codeload / archive), never a binary release asset. */
const isSourceArchive = (url) => /codeload\.github\.com|\/archive\/|\/zip\/refs\//i.test(url);

const manifest = readManifest(manifestPath);
const rt = manifest.runtime;
fs.mkdirSync(cacheDir, { recursive: true });

async function download(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      if (attempt === 3) throw new Error(`download failed for ${url}: ${err instanceof Error ? err.message : err}`);
      console.log(`[llama-runtime] retry ${attempt}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const zipPath = path.join(cacheDir, rt.asset);
const givenZip = process.argv.find((a) => a.startsWith('--zip='))?.slice('--zip='.length) || process.env.ARK_LLAMA_RUNTIME_ZIP;
if (givenZip && (!fs.existsSync(zipPath) || sha256File(zipPath) !== rt.sha256)) {
  if (sha256File(givenZip) !== rt.sha256) throw new Error(`[llama-runtime] ${givenZip} is not ${rt.asset} (sha256 mismatch)`);
  fs.copyFileSync(givenZip, zipPath);
}
let builtFromSource = false;
if (!fs.existsSync(zipPath) || sha256File(zipPath) !== rt.sha256) {
  if (isSourceArchive(rt.url)) {
    // Nothing downloadable matches the pin: the pinned zip is a local MSVC build of this source tag.
    if (noSourceBuild) {
      throw new Error(`[llama-runtime] no cached ${rt.asset} matches the manifest and ${rt.url} is a source archive; run node scripts/build-llama-from-source.mjs (see docs/release-process.md)`);
    }
    console.log(`[llama-runtime] no cached ${rt.asset} matches the pin; building ${rt.build} from source`);
    fs.rmSync(zipPath, { force: true });
    try {
      execFileSync(process.execPath, [fromSourceScript], { stdio: 'inherit', env: { ...process.env, ARK_LLAMA_CACHE_DIR: cacheDir } });
    } catch (err) {
      throw new Error(`[llama-runtime] the source build failed (${err instanceof Error ? err.message : err}); see docs/release-process.md for the tools it needs`);
    }
    if (!fs.existsSync(zipPath)) throw new Error(`[llama-runtime] the source build did not produce ${zipPath}`);
    builtFromSource = true;
  } else {
    console.log(`[llama-runtime] downloading ${rt.asset}`);
    try {
      await download(rt.url, zipPath);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : err}
[llama-runtime] download ${rt.url} in a browser and rerun with --zip=<path>`);
    }
  }
}
const zipHash = sha256File(zipPath);
if (builtFromSource) {
  // A fresh MSVC build cannot match the old pin: record what was built so the pins describe this zip.
  rt.sha256 = zipHash;
  rt.size = fs.statSync(zipPath).size;
  updateManifest = true;
  console.log('[llama-runtime] locally built zip: sha256, size and file hashes will be re-pinned in the manifest; review and commit them');
} else if (zipHash !== rt.sha256) {
  fs.rmSync(zipPath, { force: true });
  throw new Error(`[llama-runtime] ${rt.asset} sha256 ${zipHash} != manifest ${rt.sha256}; the cached copy was removed`);
}

// Extract into its own empty folder (bsdtar ships with Windows 10+ and reads zip files).
const extractDir = path.join(cacheDir, `extract-${rt.build}`);
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
// Windows' own bsdtar by full path: a GNU tar earlier on PATH (Git Bash) cannot read zip files.
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tarExe, ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });

// The zip may hold the files flat or under one folder; take the folder that has llama-server.exe.
const findServerDir = (dir, depth = 0) => {
  if (fs.existsSync(path.join(dir, 'llama-server.exe'))) return dir;
  if (depth > 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = findServerDir(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
};
const srcDir = findServerDir(extractDir);
if (!srcDir) throw new Error(`[llama-runtime] llama-server.exe not found in ${rt.asset}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  if (isRuntimeFile(name)) fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
}

// Licence: from the zip when it carries one, else the tagged LICENSE from the repo (cached).
const licenceInZip = fs.readdirSync(srcDir).find((n) => /^licen[cs]e/i.test(n));
const licenceCache = path.join(cacheDir, `LICENSE-${rt.build}`);
if (licenceInZip) {
  fs.copyFileSync(path.join(srcDir, licenceInZip), path.join(outDir, rt.license.file));
} else {
  if (!fs.existsSync(licenceCache)) await download(rt.license.url, licenceCache);
  fs.copyFileSync(licenceCache, path.join(outDir, rt.license.file));
}
fs.rmSync(extractDir, { recursive: true, force: true });

const hashes = hashRuntimeDir(outDir);
delete hashes[rt.license.file];
if (updateManifest) {
  manifest.runtime.files = hashes;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[llama-runtime] manifest updated: ${Object.keys(hashes).length} file hash(es) recorded`);
}

const problems = checkRuntimeDir(outDir, readManifest(manifestPath));
if (problems.length) {
  throw new Error(`[llama-runtime] build/llama-runtime does not match the manifest:\n  ${problems.join('\n  ')}`);
}
const bytes = Object.keys(hashes).reduce((n, f) => n + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`[llama-runtime] ${rt.build}: ${Object.keys(hashes).length} file(s), ${(bytes / 1e6).toFixed(1)} MB -> build/llama-runtime`);
