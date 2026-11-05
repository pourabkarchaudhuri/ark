/**
 * Build the bundled LiteLLM runtime into build/litellm-runtime (1.0.97 B35). Run by build:app;
 * electron-builder's extraResources ships that folder as resources/litellm-runtime.
 *
 *   node scripts/build-litellm-runtime.mjs [--update-manifest] [--relock] [--python-archive=<path>]
 *
 * What it builds: a pinned CPython 3.12 for Windows x64 (python-build-standalone first, the official
 * python.org NuGet package when GitHub release assets are blocked; both pinned by sha256 in
 * electron/ai-router/litellm-manifest.json) plus LiteLLM and its dependencies installed from
 * scripts/litellm/requirements.lock.txt with `pip --require-hashes --no-deps --only-binary=:all:`,
 * and the launcher ark_litellm.py. Archives are cached in .litellm-cache/ (gitignored).
 *
 * A network that resets the python archive download: fetch the file named in the manifest from
 * another network and pass it with --python-archive=<path> (or ARK_LITELLM_PYTHON_ARCHIVE); it is
 * used only if its sha256 matches a pinned source.
 *
 * --update-manifest records the lock/launcher hashes after a deliberate change.
 * --relock re-resolves litellm[proxy] with the host pip into a new lock file (review the diff and
 * check the PyPI/OSV advisories for the new version before committing).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHER_FILE, LOCK_COPY_FILE, TREE_MANIFEST_NAME, checkLitellmRuntimeDir, hashPythonTree, listPthFiles,
  readLitellmManifest, readTreeManifest, sha256File,
} from './lib/litellm-runtime.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The ARK_LITELLM_* overrides exist for the script's own test (a synthetic manifest, lock and cache in a temp folder).
const manifestPath = process.env.ARK_LITELLM_MANIFEST || path.join(root, 'electron', 'ai-router', 'litellm-manifest.json');
const cacheDir = process.env.ARK_LITELLM_CACHE_DIR || path.join(root, '.litellm-cache');
const outDir = process.env.ARK_LITELLM_OUT_DIR || path.join(root, 'build', 'litellm-runtime');
const treePath = path.join(path.dirname(manifestPath), TREE_MANIFEST_NAME);
const lockPath = process.env.ARK_LITELLM_LOCK || path.join(root, 'scripts', 'litellm', 'requirements.lock.txt');
const launcherPath = path.join(root, 'scripts', 'litellm', LAUNCHER_FILE);
const updateManifest = process.argv.includes('--update-manifest');
const relock = process.argv.includes('--relock');
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

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
      const why = err instanceof Error ? (err.cause?.code || err.message) : String(err);
      if (attempt === 3) throw new Error(`download failed for ${url}: ${why}`);
      console.log(`[litellm-runtime] retry ${attempt}: ${why}`);
    }
  }
}

function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...opts });
}

// ── --relock ────────────────────────────────────────────────────────────────────────────────
if (relock) {
  const m = readLitellmManifest(manifestPath);
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-litellm-relock-'));
  const host = process.env.ARK_HOST_PYTHON || 'python';
  run(host, ['-m', 'pip', 'download', `litellm[proxy]==${m.litellm.version}`, '--only-binary=:all:', '--python-version', '3.12',
    '--platform', 'win_amd64', '--implementation', 'cp', '-d', dl]);
  const rows = fs.readdirSync(dl).filter((f) => f.endsWith('.whl')).map((f) => {
    const [name, version] = f.slice(0, -4).split('-');
    return { name: name.replace(/_/g, '-').toLowerCase(), version, hash: sha256File(path.join(dl, f)) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const head = fs.readFileSync(lockPath, 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n');
  fs.writeFileSync(lockPath, `${head}\n${rows.map((r) => `${r.name}==${r.version} \\\n    --hash=sha256:${r.hash}`).join('\n')}\n`);
  fs.rmSync(dl, { recursive: true, force: true });
  console.log(`[litellm-runtime] lock rewritten: ${rows.length} packages. Review the diff, check the advisories, then run with --update-manifest.`);
  process.exit(0);
}

// ── 1. The lock and launcher must be what the manifest pins ─────────────────────────────────
const manifest = readLitellmManifest(manifestPath);
const lockHash = sha256File(lockPath);
const launcherHash = sha256File(launcherPath);
if (updateManifest) {
  manifest.litellm.lockSha256 = lockHash;
  manifest.launcher.sha256 = launcherHash;
} else {
  if (lockHash !== manifest.litellm.lockSha256) {
    throw new Error(`[litellm-runtime] requirements.lock.txt sha256 ${lockHash} != manifest ${manifest.litellm.lockSha256}; review the change and rerun with --update-manifest`);
  }
  if (launcherHash !== manifest.launcher.sha256) {
    throw new Error(`[litellm-runtime] ${LAUNCHER_FILE} sha256 ${launcherHash} != manifest ${manifest.launcher.sha256}; rerun with --update-manifest`);
  }
}
const lockText = fs.readFileSync(lockPath, 'utf8');
const esc = (v) => v.replace(/\./g, '\\.');
for (const bad of manifest.litellm.neverUse ?? []) {
  if (new RegExp(`^litellm==${esc(bad)}\\b`, 'm').test(lockText)) {
    throw new Error(`[litellm-runtime] the lock pins litellm ${bad}, a release that shipped malware`);
  }
}
if (!new RegExp(`^litellm==${esc(manifest.litellm.version)} `, 'm').test(lockText)) {
  throw new Error(`[litellm-runtime] the lock does not pin litellm ${manifest.litellm.version}`);
}
const pinned = (lockText.match(/^[A-Za-z0-9_.-]+==\S+ \\$/gm) ?? []).length;
const hashed = (lockText.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length;
if (pinned === 0 || pinned !== hashed) {
  throw new Error('[litellm-runtime] every locked package needs exactly one sha256 hash');
}

// ── 2. The python archive ───────────────────────────────────────────────────────────────────
const sources = manifest.python.sources;
const given = process.argv.find((a) => a.startsWith('--python-archive='))?.slice('--python-archive='.length) || process.env.ARK_LITELLM_PYTHON_ARCHIVE;
if (given) {
  const h = sha256File(given);
  const src = sources.find((s) => s.sha256 === h);
  if (!src) throw new Error(`[litellm-runtime] ${given} is not a pinned python archive (sha256 ${h})`);
  fs.copyFileSync(given, path.join(cacheDir, src.asset));
}
let chosen = null;
const failures = [];
for (const src of sources) {
  const dest = path.join(cacheDir, src.asset);
  try {
    if (!fs.existsSync(dest) || sha256File(dest) !== src.sha256) {
      console.log(`[litellm-runtime] downloading ${src.asset} (${src.kind})`);
      await download(src.url, dest);
    }
    const h = sha256File(dest);
    if (h !== src.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error(`sha256 ${h} != manifest ${src.sha256}; the cached copy was removed`);
    }
    chosen = { ...src, file: dest };
    break;
  } catch (err) {
    failures.push(`${src.kind}: ${err instanceof Error ? err.message : err}`);
    console.log(`[litellm-runtime] ${src.kind} source failed: ${failures.at(-1)}`);
  }
}
if (!chosen) {
  throw new Error(`[litellm-runtime] no python source worked:\n  ${failures.join('\n  ')}\n[litellm-runtime] fetch ${sources[0].asset} from another network and pass --python-archive=<path>`);
}

// ── 3. Extract and arrange ──────────────────────────────────────────────────────────────────
const extractDir = path.join(cacheDir, 'extract-python');
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
run(tarExe, [chosen.kind === 'pbs' ? '-xzf' : '-xf', chosen.file, '-C', extractDir]);
const findPythonDir = (dir, depth = 0) => {
  if (fs.existsSync(path.join(dir, 'python.exe'))) return dir;
  if (depth > 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = findPythonDir(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
};
const pySrc = findPythonDir(extractDir);
if (!pySrc) throw new Error(`[litellm-runtime] python.exe not found in ${chosen.asset}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const pyOut = path.join(outDir, 'python');
fs.cpSync(pySrc, pyOut, { recursive: true });
fs.rmSync(extractDir, { recursive: true, force: true });

// Never needed by the sidecar: headers, import libs, the test suite, IDLE, Tk.
for (const rel of ['include', 'libs', 'Lib/test', 'Lib/idlelib', 'Lib/tkinter', 'Lib/turtledemo', 'tcl', 'Doc', 'Tools']) {
  fs.rmSync(path.join(pyOut, ...rel.split('/')), { recursive: true, force: true });
}
const dllDir = path.join(pyOut, 'DLLs');
for (const f of fs.existsSync(dllDir) ? fs.readdirSync(dllDir) : []) {
  if (/^(_tkinter|_testcapi|_test)/i.test(f) || /^(tcl|tk)\d/i.test(f)) fs.rmSync(path.join(dllDir, f), { force: true });
}

// ── 4. Install LiteLLM from the lock, hashes required ───────────────────────────────────────
const py = path.join(pyOut, 'python.exe');
const pipEnv = { ...process.env, PIP_CACHE_DIR: path.join(cacheDir, 'pip'), PIP_DISABLE_PIP_VERSION_CHECK: '1' };
fs.mkdirSync(path.join(cacheDir, 'pip'), { recursive: true });
console.log('[litellm-runtime] installing from the lock (about 160 MB of wheels the first time)');
run(py, ['-I', '-m', 'pip', 'install', '--require-hashes', '--no-deps', '--only-binary=:all:', '-r', lockPath], { env: pipEnv });
// pip itself is build tooling; the sidecar never installs anything.
const sitePackages = path.join(pyOut, 'Lib', 'site-packages');
for (const n of fs.readdirSync(sitePackages)) {
  if (/^pip(-|$)/i.test(n) || /^setuptools/i.test(n) || n === '_distutils_hack' || n === 'distutils-precedence.pth') {
    fs.rmSync(path.join(sitePackages, n), { recursive: true, force: true });
  }
}
fs.rmSync(path.join(pyOut, 'Lib', 'ensurepip'), { recursive: true, force: true });

// Weight the sidecar never uses: the admin UI (disabled), the database/redis/queue/audio/dataframe
// extras of litellm[proxy], and the gunicorn/granian servers (the launcher runs uvicorn). Chosen by
// importing litellm.proxy.proxy_server and running chat/embeddings/rerank without them (see
// src/test/electron/litellm-runtime-smoke.test.ts); a pruned package that turns out to be needed
// fails the smoke import below, never silently at runtime.
const PRUNE_PACKAGES = [
  'polars', 'polars_runtime_32', '_polars_runtime_32', 'psycopg', 'psycopg_binary', 'hiredis', 'rq',
  'granian', 'gunicorn', 'msal', 'msal_extensions',
];
const pruneSet = new Set(PRUNE_PACKAGES);
for (const n of fs.readdirSync(sitePackages)) {
  // "polars-1.44.2.dist-info" -> polars; "numpy.libs" would be numpy
  const base = n.toLowerCase().replace(/\.dist-info$/, '').replace(/-\d.*$/, '').replace(/\.libs$/, '').replace(/-/g, '_');
  if (pruneSet.has(base)) fs.rmSync(path.join(sitePackages, n), { recursive: true, force: true });
}
// The admin UI bundle (16 MB) goes, but the proxy logs an error when the folder is missing: leave a stub page.
const uiDir = path.join(sitePackages, 'litellm', 'proxy', '_experimental', 'out');
fs.rmSync(uiDir, { recursive: true, force: true });
fs.mkdirSync(uiDir, { recursive: true });
fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>Ark LiteLLM</title>\n');
for (const rel of ['pythonwin', 'PyWin32.chm']) fs.rmSync(path.join(sitePackages, rel), { recursive: true, force: true });

// ── 5. Our files and the checks ─────────────────────────────────────────────────────────────
fs.copyFileSync(launcherPath, path.join(outDir, LAUNCHER_FILE));
fs.copyFileSync(lockPath, path.join(outDir, LOCK_COPY_FILE));
const pythonLicence = path.join(pyOut, 'LICENSE.txt');
if (fs.existsSync(pythonLicence)) fs.copyFileSync(pythonLicence, path.join(outDir, 'PYTHON-LICENSE.txt'));
fs.writeFileSync(path.join(outDir, 'SOURCE.txt'),
  `Bundled LiteLLM ${manifest.litellm.version} (MIT) and CPython ${chosen.version} (${chosen.kind}).\nBuilt from requirements.lock.txt with pip --require-hashes.\n`);

const pth = listPthFiles(outDir);
if (updateManifest) manifest.python.allowedPth = pth;
const unexpected = pth.filter((n) => !(manifest.python.allowedPth ?? []).includes(n));
if (unexpected.length) throw new Error(`[litellm-runtime] unexpected .pth file(s) in site-packages (they run code at start): ${unexpected.join(', ')}`);

console.log('[litellm-runtime] smoke import');
run(py, ['-I', '-c', 'import litellm, fastapi, uvicorn, yaml; import litellm.proxy.proxy_server; from litellm.proxy.proxy_cli import run_server; print("litellm import ok")']);

if (updateManifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(treePath, `${JSON.stringify({ schema: 1, units: hashPythonTree(outDir) }, null, 2)}
`, 'utf8');
  console.log('[litellm-runtime] manifest and python tree list updated');
}
const problems = checkLitellmRuntimeDir(outDir, readLitellmManifest(manifestPath), readTreeManifest(treePath));
if (problems.length) {
  throw new Error(`[litellm-runtime] build/litellm-runtime does not match the manifest:\n  ${problems.join('\n  ')}`);
}
const sizeOf = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
  const p = path.join(dir, e.name);
  return n + (e.isDirectory() ? sizeOf(p) : fs.statSync(p).size);
}, 0);
console.log(`[litellm-runtime] litellm ${manifest.litellm.version} on python ${chosen.version} (${chosen.kind}), ${(sizeOf(outDir) / 1e6).toFixed(0)} MB -> build/litellm-runtime`);
