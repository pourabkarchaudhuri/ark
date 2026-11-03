/**
 * Built-in llama.cpp runtime (1.0.97 B36): what goes into the installer and how to check it.
 *
 * Shared by scripts/build-llama-runtime.mjs (unpacks the pinned release into build/llama-runtime),
 * scripts/after-pack-check.mjs and scripts/verify-release.mjs (the packaged copy must match
 * electron/local-ai/runtime-manifest.json, and no model file may ever be packaged).
 * File-system only, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Where the runtime lands inside the packaged app (extraResources "to"). */
export const PACKAGED_RUNTIME_DIR = path.join('resources', 'llama-runtime');

/**
 * Files kept from the release zip: the server and the DLLs it loads (ggml backends, Vulkan,
 * CPU variants). Every other tool in the zip (llama-cli, llama-bench, ...) is left out.
 */
export function isRuntimeFile(name) {
  const base = path.basename(name).toLowerCase();
  return base === 'llama-server.exe' || base.endsWith('.dll');
}

/** Model weights never ship: they are downloaded at runtime. */
export function isModelFile(name) {
  return /\.(gguf|gguf\.part|safetensors)$/i.test(name);
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** sha256 of every file directly inside `dir`, keyed by file name, sorted. */
export function hashRuntimeDir(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = sha256File(p);
  }
  return out;
}

/**
 * Problems with a runtime folder compared to the manifest; empty when it matches.
 * The folder must hold exactly the manifest's files (plus the licence), each with its hash.
 */
export function checkRuntimeDir(dir, manifest) {
  const problems = [];
  if (!fs.existsSync(dir)) return [`runtime folder missing: ${dir}`];
  const expected = manifest?.runtime?.files ?? {};
  const names = Object.keys(expected);
  if (names.length === 0) problems.push('runtime manifest lists no files');
  if (!names.includes('llama-server.exe')) problems.push('runtime manifest does not list llama-server.exe');
  const licence = manifest?.runtime?.license?.file;
  for (const name of names) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { problems.push(`missing ${name}`); continue; }
    const actual = sha256File(p);
    if (actual !== expected[name]) problems.push(`${name} sha256 ${actual} != manifest ${expected[name]}`);
  }
  for (const name of fs.readdirSync(dir)) {
    if (isModelFile(name)) problems.push(`model file in the runtime folder: ${name}`);
    else if (!(name in expected) && name !== licence) problems.push(`unexpected file in the runtime folder: ${name}`);
  }
  if (licence && !fs.existsSync(path.join(dir, licence))) problems.push(`licence file ${licence} missing`);
  return problems;
}

/** Every model-weight file under `root` (relative paths). Bounded depth. */
export function findModelFiles(root, maxDepth = 10) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (isModelFile(e.name)) found.push(path.relative(root, p));
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return found;
}

/** Problems with a packaged (unpacked) app directory: runtime present and matching, no models. */
export function checkPackagedRuntime(appOutDir, manifest) {
  const problems = checkRuntimeDir(path.join(appOutDir, PACKAGED_RUNTIME_DIR), manifest)
    .map((p) => `llama-runtime: ${p}`);
  const models = findModelFiles(appOutDir);
  if (models.length) problems.push(`model files packaged: ${models.join(', ')}`);
  return problems;
}

export function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}
