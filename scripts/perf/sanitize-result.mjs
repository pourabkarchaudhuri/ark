#!/usr/bin/env node
/**
 * Write a copy of a harness result JSON with paths and user names removed (safe to commit as a baseline).
 *
 *   node scripts/perf/sanitize-result.mjs <in.json> <out.json> [extra-name-to-strip ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeResult } from './lib/sanitize.mjs';

const [inp, out, ...extra] = process.argv.slice(2);
if (!inp || !out) {
  console.error('usage: sanitize-result.mjs <in.json> <out.json> [name ...]');
  process.exit(2);
}
const clean = sanitizeResult(JSON.parse(fs.readFileSync(inp, 'utf8')), extra);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(clean, null, 2) + '\n');
console.log(`wrote ${out}`);
