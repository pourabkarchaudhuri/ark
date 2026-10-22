/**
 * Prune old electron-builder outputs under release/builds/.
 *
 * Each build lands in release/builds/<version>/ (installer, blockmap, latest.yml,
 * win-unpacked). Published versions live on GitHub, so local copies are only
 * useful for the most recent few. Dry-run by default — pass --apply to delete.
 *
 *   npm run release:prune                 # list what would be removed (keeps 2)
 *   npm run release:prune -- --keep 3     # keep the 3 newest versions
 *   npm run release:prune -- --apply      # actually delete
 *
 * --legacy also removes pre-v1.0.72 leftovers: release/builds/_legacy/, root-level
 * release-NNNN dirs and _asar-cmp. Some of those may hold files locked by Windows
 * (loaded .node modules); if removal fails, reboot and run again.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildsDir = path.join(root, 'release', 'builds');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const legacy = args.includes('--legacy');
const keepArg = args.find(a => a.startsWith('--keep='))?.slice(7) ?? (args.includes('--keep') ? args[args.indexOf('--keep') + 1] : undefined);
const keep = keepArg === undefined ? 2 : Number(keepArg);
if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep must be an integer >= 1');
  process.exit(1);
}
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

function dirSize(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) total += dirSize(path.join(p, ent.name));
    return total;
  } catch { return 0; } // locked / vanished mid-walk
}

if (!fs.existsSync(buildsDir)) {
  console.log('No release/builds/ directory — nothing to prune.');
  process.exit(0);
}

const versions = fs.readdirSync(buildsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
  .map(d => d.name)
  .sort(cmpVersion)
  .reverse();

// Never remove the version currently in package.json, even if older ones are newer-named.
const doomed = versions.slice(keep).filter(v => v !== current).map(v => path.join(buildsDir, v));
if (legacy) {
  if (fs.existsSync(path.join(buildsDir, '_legacy'))) doomed.push(path.join(buildsDir, '_legacy'));
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.isDirectory() && (/^release-\d+[a-z]?$/.test(ent.name) || ent.name === '_asar-cmp')) doomed.push(path.join(root, ent.name));
  }
  // Loose outputs that sat directly in release/ before builds/ existed (release-body.md is kept)
  const rel = path.join(root, 'release');
  for (const ent of fs.readdirSync(rel, { withFileTypes: true })) {
    if (ent.name === 'win-unpacked' || ent.name === 'latest.yml' || ent.name === 'builder-debug.yml'
      || ent.name === 'builder-effective-config.yaml' || /^Ark-Setup-.*\.(exe|blockmap)$/.test(ent.name)) doomed.push(path.join(rel, ent.name));
  }
}

if (doomed.length === 0) {
  console.log(`Nothing to prune (keeping ${keep}: ${versions.slice(0, keep).join(', ') || 'none'}).`);
  process.exit(0);
}

let freed = 0;
for (const dir of doomed) {
  const size = dirSize(dir);
  freed += size;
  console.log(`${apply ? 'Removing' : 'Would remove'} ${path.relative(root, dir)} (${(size / 1e9).toFixed(2)} GB)`);
  if (apply) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (err) { console.warn(`  could not fully remove (${err.code ?? err.message}) — files are locked; reboot and re-run`); }
  }
}
console.log(`${apply ? 'Freed' : 'Would free'} ${(freed / 1e9).toFixed(2)} GB.${apply ? '' : ' Re-run with --apply to delete.'}`);
