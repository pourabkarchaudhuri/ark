/**
 * Bundled LiteLLM runtime (1.0.97 B35): what goes into the installer and how to check it.
 *
 * Shared by scripts/build-litellm-runtime.mjs (builds build/litellm-runtime: a pinned CPython plus
 * the hash-locked LiteLLM wheels), scripts/after-pack-check.mjs and scripts/verify-release.mjs (the
 * packaged copy must match electron/ai-router/litellm-manifest.json and carry no key material).
 * File-system only, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File } from './llama-runtime.mjs';

export { sha256File };

/** Where the runtime lands inside the packaged app (extraResources "to"). */
export const PACKAGED_LITELLM_DIR = path.join('resources', 'litellm-runtime');

export const LAUNCHER_FILE = 'ark_litellm.py';
export const LOCK_COPY_FILE = 'requirements.lock.txt';
/** Pinned hashes of the python tree, next to litellm-manifest.json. */
export const TREE_MANIFEST_NAME = 'litellm-python-tree.json';

export function readTreeManifest(treePath) {
  return fs.existsSync(treePath) ? JSON.parse(fs.readFileSync(treePath, 'utf8')) : { schema: 1, units: {} };
}

export function readLitellmManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** Compiled bytecode is rebuilt by python on first import, so it is not part of the pinned tree. */
const isVolatile = (name) => name === '__pycache__' || name.toLowerCase().endsWith('.pyc');

/** sha256 over every file under `dir` (relative path + content hash, sorted); returns the digest and file count. */
function digestTree(dir) {
  const rows = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (isVolatile(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) rows.push(`${r}\0${sha256File(p)}`);
      else rows.push(`${r}\0<${e.isSymbolicLink() ? 'symlink' : 'special'}>`);
    }
  };
  walk(dir, '');
  rows.sort();
  return { sha256: crypto.createHash('sha256').update(rows.join('\n')).digest('hex'), files: rows.length };
}

/**
 * The python tree is pinned in units: every entry of python/ (files and folders), with python/Lib and
 * python/Lib/site-packages split one level further so a mismatch names a package, not the whole tree.
 * Returns { "python/Lib/site-packages/litellm": { sha256, files }, ... }.
 */
export function hashPythonTree(runtimeDir) {
  const units = {};
  const pyRoot = path.join(runtimeDir, 'python');
  const visit = (rel) => {
    const abs = path.join(runtimeDir, ...rel.split('/'));
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (isVolatile(e.name)) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && (r === 'python/Lib' || r === 'python/Lib/site-packages')) visit(r);
      else if (e.isDirectory()) units[r] = digestTree(path.join(runtimeDir, ...r.split('/')));
      else units[r] = { sha256: sha256File(path.join(runtimeDir, ...r.split('/'))), files: 1 };
    }
  };
  if (fs.existsSync(pyRoot)) visit('python');
  return Object.fromEntries(Object.entries(units).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Problems with the packaged python tree compared to the pinned unit list (litellm-python-tree.json). */
export function checkPythonTree(runtimeDir, tree) {
  const expected = tree?.units ?? {};
  const names = Object.keys(expected);
  if (names.length === 0) return ['python tree manifest lists no units (run build-litellm-runtime.mjs --update-manifest)'];
  const actual = hashPythonTree(runtimeDir);
  const problems = [];
  for (const n of names) {
    if (!(n in actual)) problems.push(`python tree: missing ${n}`);
    else if (actual[n].sha256 !== expected[n].sha256 || actual[n].files !== expected[n].files) problems.push(`python tree: ${n} does not match the manifest`);
  }
  for (const n of Object.keys(actual)) {
    if (!(n in expected)) problems.push(`python tree: unexpected ${n}`);
  }
  return problems;
}

/** Files that hold (or are named like) credentials; none may ever be in the runtime folder. */
const KEY_FILE_RE = /(^\.env(\..*)?$|\.pem$|\.p12$|\.pfx$|\.key$|^config\.ya?ml$|^ai-router.*\.json$|^secrets?\..*)/i;
/** Credential shapes that must not appear in the files we ship ourselves (launcher, lock, manifest). */
const KEY_TEXT_RE = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|ARK_KEY_[A-Z0-9_]+\s*=\s*\S+)/;

/** Our own top-level files are scanned for key text; third-party packages are not (their tests carry fake keys). */
function ownFiles(dir) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile())
    : [];
}

/** Names of every `.pth` file under site-packages (a .pth can run code at interpreter start). */
export function listPthFiles(runtimeDir) {
  const site = path.join(runtimeDir, 'python', 'Lib', 'site-packages');
  if (!fs.existsSync(site)) return [];
  return fs.readdirSync(site).filter((n) => n.toLowerCase().endsWith('.pth')).sort();
}

function walkNames(root, maxDepth, visit, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkNames(p, maxDepth, visit, depth + 1);
    else visit(p, e.name);
  }
}

/**
 * Problems with a runtime folder compared to the manifest; empty when it matches:
 * interpreter present, launcher and lock copy hash-equal to the manifest, LiteLLM at the pinned
 * version, no unexpected .pth file, no key material. When `tree` (litellm-python-tree.json) is given, the
 * whole python tree must also hash-match it.
 */
export function checkLitellmRuntimeDir(dir, manifest, tree) {
  const problems = [];
  if (!fs.existsSync(dir)) return [`runtime folder missing: ${dir}`];
  if (!fs.existsSync(path.join(dir, 'python', 'python.exe'))) problems.push('python/python.exe missing');

  const launcher = path.join(dir, LAUNCHER_FILE);
  if (!fs.existsSync(launcher)) problems.push(`${LAUNCHER_FILE} missing`);
  else if (sha256File(launcher) !== manifest?.launcher?.sha256) problems.push(`${LAUNCHER_FILE} sha256 does not match the manifest`);

  const lock = path.join(dir, LOCK_COPY_FILE);
  if (!fs.existsSync(lock)) problems.push(`${LOCK_COPY_FILE} missing`);
  else if (sha256File(lock) !== manifest?.litellm?.lockSha256) problems.push('lock file sha256 does not match the manifest');

  const site = path.join(dir, 'python', 'Lib', 'site-packages');
  const want = manifest?.litellm?.version;
  const dist = fs.existsSync(site)
    ? fs.readdirSync(site).find((n) => /^litellm-[^-]+\.dist-info$/i.test(n))
    : undefined;
  if (!dist) problems.push('litellm is not installed');
  else if (dist.toLowerCase() !== `litellm-${want}.dist-info`.toLowerCase()) problems.push(`litellm version ${dist} != pinned ${want}`);

  if (tree !== undefined && fs.existsSync(path.join(dir, 'python'))) problems.push(...checkPythonTree(dir, tree));

  const allowed = new Set((manifest?.python?.allowedPth ?? []).map((n) => n.toLowerCase()));
  for (const pth of listPthFiles(dir)) {
    if (!allowed.has(pth.toLowerCase())) problems.push(`unexpected .pth file in site-packages: ${pth}`);
  }

  walkNames(dir, 3, (p, name) => {
    // Only our own top-level files and the python/ root are checked by name; deep package files are not.
    if (path.dirname(p) === dir || path.dirname(p) === path.join(dir, 'python')) {
      if (KEY_FILE_RE.test(name)) problems.push(`key-like file in the runtime folder: ${path.relative(dir, p)}`);
    }
  });
  for (const name of ownFiles(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).size > 1_000_000) continue;
    const m = KEY_TEXT_RE.exec(fs.readFileSync(p, 'utf8'));
    if (m) problems.push(`${name} contains key-like text`);
  }
  return problems;
}

/** Problems with a packaged (unpacked) app directory. */
export function checkPackagedLitellm(appOutDir, manifest, tree) {
  // The tree list is required for a packaged copy: passing none would silently skip the hash check.
  const treeToUse = tree ?? { units: {} };
  return checkLitellmRuntimeDir(path.join(appOutDir, PACKAGED_LITELLM_DIR), manifest, treeToUse).map((p) => `litellm-runtime: ${p}`);
}
