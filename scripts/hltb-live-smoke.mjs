/**
 * Live smoke test of the HowLongToBeat client against the real site (not part of vitest).
 *
 *   npx tsc -p tsconfig.node.json && node scripts/hltb-live-smoke.mjs
 *
 * Runs the compiled production client (dist-electron/electron/hltb-api.js) with an in-memory cache,
 * Node's fetch and the same honest User-Agent style the app sends. Exits non-zero if a well-known
 * game does not resolve to its HowLongToBeat entry.
 */
import { HltbClient } from '../dist-electron/electron/hltb-api.js';

const store = new Map();
const client = new HltbClient({
  fetch: (u, i) => fetch(u, i),
  cache: { get: (k) => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  userAgent: 'Ark/smoke-test (+https://github.com/pourabkarchaudhuri/ark)',
});

const cases = [
  { title: 'Hades', year: 2020, expectId: 62941 },
  { title: 'Call of Duty®: Modern Warfare®', year: 2019, expectId: 63110 },
  { title: 'The Witcher 3: Wild Hunt – Game of the Year Edition', year: 2015 },
  { title: 'A Game That Does Not Exist Zzqx', expectId: null },
];

let failed = 0;
for (const c of cases) {
  const t = await client.getTimes({ title: c.title, year: c.year });
  const ok = c.expectId === undefined ? true : (t?.hltbId ?? null) === c.expectId;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.title} -> ${t ? `${t.name} (${t.year}) main ${t.mainHours}h, +extras ${t.mainExtraHours}h, 100% ${t.completionistHours}h` : 'no match'}`);
}
process.exit(failed ? 1 : 0);
