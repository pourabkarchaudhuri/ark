/**
 * Live smoke test of the gg.deals client (not part of vitest). The key is read from the environment
 * only — never pass it on a shared command line or commit it.
 *
 *   npx tsc -p tsconfig.node.json
 *   set GG_DEALS_KEY=...   (PowerShell: $env:GG_DEALS_KEY = '...')
 *   node scripts/ggdeals-live-smoke.mjs
 */
import { GgDealsClient } from '../dist-electron/electron/ggdeals-api.js';

const key = process.env.GG_DEALS_KEY;
if (!key) {
  console.error('Set GG_DEALS_KEY');
  process.exit(2);
}
const store = new Map();
const client = new GgDealsClient({
  fetch: (u, i) => fetch(u, i),
  cache: { get: (k) => store.get(k) ?? null, set: (k, v) => { store.set(k, v); } },
  getKey: () => key,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const test = await client.testKey(key);
console.log('key:', test.ok ? 'ok' : `FAIL (${test.error})`);
const { prices, error } = await client.getPrices([1145360, 730, 999999999], process.env.GG_DEALS_REGION ?? 'us');
for (const [id, p] of Object.entries(prices)) {
  console.log(id, p ? `${p.title}: official ${p.currentRetail} ${p.currency} (low ${p.historicalRetail}), resellers ${p.currentKeyshops}` : 'no data');
}
process.exit(test.ok && !error && prices[1145360] ? 0 : 1);
