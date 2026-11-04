#!/usr/bin/env node
/** node scripts/perf/gen-profile.mjs <out dir> [--games N] [--status N] [--sessions N] [--applist N] */
import path from 'node:path';
import { generateProfile } from './lib/profile.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
if (!out) {
  console.error('usage: gen-profile.mjs <out dir>');
  process.exit(2);
}
const num = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const opts = {};
if (num('--games')) opts.games = num('--games');
if (num('--status')) opts.statusRows = num('--status');
if (num('--sessions')) opts.sessions = num('--sessions');
if (num('--applist')) opts.appListEntries = num('--applist');
generateProfile(path.resolve(out), opts).then(
  (s) => console.log(JSON.stringify(s)),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
