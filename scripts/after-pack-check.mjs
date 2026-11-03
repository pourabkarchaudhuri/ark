/**
 * electron-builder afterPack hook: fail the build when a secret that must never ship was packaged.
 *
 * Checks the unpacked app directory (release/builds/<v>/win-unpacked) before the installer is made:
 *  - the packaged .env holds only RELEASE_ENV_KEYS;
 *  - no text file outside app.asar assigns a forbidden name (AZURE_*=...);
 *  - resources/llama-runtime holds exactly the built-in llama.cpp files pinned in
 *    electron/local-ai/runtime-manifest.json, and no model weights were packaged (1.0.97 B36);
 *  - resources/litellm-runtime holds the bundled python + LiteLLM the manifest pins (launcher and lock
 *    hashes, litellm version, no unexpected .pth) and no key material (1.0.97 B35). Its third-party
 *    python tree is not text-scanned for env assignments (litellm's own sources name provider variables).
 * Compiled JS that merely reads process.env.AZURE_* is not an assignment and is not flagged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_ENV_KEYS, envKeyNames, findForbiddenEnvNames } from './lib/release-env.mjs';
import { checkPackagedRuntime, readManifest } from './lib/llama-runtime.mjs';
import { checkPackagedLitellm, readLitellmManifest } from './lib/litellm-runtime.mjs';

const RUNTIME_MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'local-ai', 'runtime-manifest.json');
const LITELLM_MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'ai-router', 'litellm-manifest.json');
/** Packaged third-party python tree: checked by checkPackagedLitellm, not by the env-assignment text scan. */
const THIRD_PARTY_DIRS = new Set([path.join('resources', 'litellm-runtime', 'python')]);

const SKIP_EXT = new Set(['.asar', '.node', '.dll', '.exe', '.pak', '.dat', '.bin', '.onnx', '.png', '.ico', '.jpg', '.webp', '.so', '.dylib']);
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** Problems found in an unpacked app directory; empty when it is clean. */
export function checkPackagedDir(appOutDir) {
  const problems = [];
  const envPath = path.join(appOutDir, '.env');
  if (fs.existsSync(envPath)) {
    const allowed = new Set(RELEASE_ENV_KEYS);
    const extra = envKeyNames(fs.readFileSync(envPath, 'utf8')).filter((n) => !allowed.has(n));
    if (extra.length) problems.push(`packaged .env has keys outside the release allow-list: ${extra.join(', ')}`);
  }
  const walk = (dir, depth) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!THIRD_PARTY_DIRS.has(path.relative(appOutDir, p))) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (fs.statSync(p).size > MAX_SCAN_BYTES) continue;
      const names = findForbiddenEnvNames(fs.readFileSync(p, 'utf8'));
      if (names.length) problems.push(`${path.relative(appOutDir, p)} assigns ${[...new Set(names)].join(', ')}`);
    }
  };
  walk(appOutDir, 0);
  return problems;
}

/** Problems with the packaged built-in AI runtime (missing/changed files, packaged model weights). */
export function checkPackagedLocalAi(appOutDir) {
  return checkPackagedRuntime(appOutDir, readManifest(RUNTIME_MANIFEST));
}

/** Problems with the packaged LiteLLM runtime (python, launcher, lock, version, key material). */
export function checkPackagedLitellmRuntime(appOutDir) {
  return checkPackagedLitellm(appOutDir, readLitellmManifest(LITELLM_MANIFEST));
}

export default async function afterPack(context) {
  const problems = checkPackagedDir(context.appOutDir);
  if (problems.length) {
    throw new Error(`[after-pack-check] secrets packaged, build stopped:\n  ${problems.join('\n  ')}`);
  }
  console.log('[after-pack-check] packaged files carry no forbidden env keys');
  const runtimeProblems = checkPackagedLocalAi(context.appOutDir);
  if (runtimeProblems.length) {
    throw new Error(`[after-pack-check] built-in AI runtime is wrong, build stopped:\n  ${runtimeProblems.join('\n  ')}`);
  }
  console.log('[after-pack-check] llama-runtime matches the manifest and no model files are packaged');
  const litellmProblems = checkPackagedLitellmRuntime(context.appOutDir);
  if (litellmProblems.length) {
    throw new Error(`[after-pack-check] bundled LiteLLM runtime is wrong, build stopped:\n  ${litellmProblems.join('\n  ')}`);
  }
  console.log('[after-pack-check] litellm-runtime matches the manifest and carries no key material');
}
