#!/usr/bin/env node
/**
 * Back-port the ARK_PERF probes onto an older checkout (a baseline worktree such as v1.0.96 or v1.0.97) so the
 * same harness can measure it. Copies the CURRENT electron/perf-probe.ts (so both sides run the same probes, including the
 * built-in AI ones), adds the install call to electron/main.ts and the ipcRenderer-listener probe to
 * electron/preload.cjs where the old build lacks them. Idempotent.
 *
 *   node scripts/perf/apply-probes.mjs <checkout dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const target = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(target, 'electron', 'main.ts'))) {
  console.error('usage: apply-probes.mjs <checkout dir containing electron/main.ts>');
  process.exit(2);
}

fs.copyFileSync(path.join(repo, 'electron', 'perf-probe.ts'), path.join(target, 'electron', 'perf-probe.ts'));

const mainPath = path.join(target, 'electron', 'main.ts');
let main = fs.readFileSync(mainPath, 'utf8');
if (!main.includes('installPerfProbes')) {
  const anchor = "process.title = 'Ark';";
  if (!main.includes(anchor)) throw new Error('anchor not found in main.ts');
  main = main.replace(
    anchor,
    `${anchor}\n\nimport { installPerfProbes } from './perf-probe.js';\ninstallPerfProbes();`,
  );
  fs.writeFileSync(mainPath, main);
}

if (!main.includes("'--ark-perf'")) {
  const a = 'preload: preloadPath,';
  if (!main.includes(a)) throw new Error('preload anchor not found in main.ts');
  main = main.replace(a, `${a}
      additionalArguments: process.env.ARK_PERF === '1' ? ['--ark-perf'] : [],`);
  fs.writeFileSync(mainPath, main);
}

const prePath = path.join(target, 'electron', 'preload.cjs');
let pre = fs.readFileSync(prePath, 'utf8');
if (!pre.includes('__arkPerf')) {
  const repoPre = fs.readFileSync(path.join(repo, 'electron', 'preload.cjs'), 'utf8');
  const idx = repoPre.indexOf('// Perf-gate probe');
  if (idx < 0) throw new Error('probe block missing from repo preload.cjs');
  pre += '\n' + repoPre.slice(idx);
  fs.writeFileSync(prePath, pre);
}
console.log('probes applied to', target);
