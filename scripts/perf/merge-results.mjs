#!/usr/bin/env node
/**
 * Merge two partial harness results of the same build into one (used for the v1.0.96 baseline, whose scenario
 * cycles get slower every cycle because that build leaks DOM, so the cycle run was stopped after cycle N and the
 * hidden-idle and app-list phases were run separately with `--cycles 0`).
 *
 *   node scripts/perf/merge-results.mjs <cycles.json> <tail.json> <out.json> [--note "text"]
 */
import fs from 'node:fs';

const [a, b, out] = process.argv.slice(2);
if (!a || !b || !out) {
  console.error('usage: merge-results.mjs <cycles.json> <tail.json> <out.json> [--note text]');
  process.exit(2);
}
const ni = process.argv.indexOf('--note');
const note = ni >= 0 ? process.argv[ni + 1] : null;
const A = JSON.parse(fs.readFileSync(a, 'utf8'));
const B = JSON.parse(fs.readFileSync(b, 'utf8'));
const merged = { ...A };
merged.hiddenIdle = B.hiddenIdle;
merged.applist = B.applist;
merged.meta = { ...A.meta, cycles: A.cycles.length, hiddenIdleS: B.meta.hiddenIdleS, mergedFrom: [a, b], note };
merged.skippedSteps = [...new Set([...(A.skippedSteps ?? []), ...(B.skippedSteps ?? [])])];
fs.writeFileSync(out, JSON.stringify(merged, null, 2));
console.log(`merged ${A.cycles.length} cycles + tail -> ${out}`);
