/**
 * electron-builder afterPack hook: fail the build when a secret that must never ship was packaged.
 *
 * Checks the unpacked app directory (release/builds/<v>/win-unpacked) before the installer is made:
 *  - the packaged .env holds only RELEASE_ENV_KEYS;
 *  - no text file outside app.asar assigns a forbidden name (AZURE_*=...).
 * Compiled JS that merely reads process.env.AZURE_* is not an assignment and is not flagged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_ENV_KEYS, envKeyNames, findForbiddenEnvNames } from './lib/release-env.mjs';

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
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.isFile() || SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (fs.statSync(p).size > MAX_SCAN_BYTES) continue;
      const names = findForbiddenEnvNames(fs.readFileSync(p, 'utf8'));
      if (names.length) problems.push(`${path.relative(appOutDir, p)} assigns ${[...new Set(names)].join(', ')}`);
    }
  };
  walk(appOutDir, 0);
  return problems;
}

export default async function afterPack(context) {
  const problems = checkPackagedDir(context.appOutDir);
  if (problems.length) {
    throw new Error(`[after-pack-check] secrets packaged, build stopped:\n  ${problems.join('\n  ')}`);
  }
  console.log('[after-pack-check] packaged files carry no forbidden env keys');
}
