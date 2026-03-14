#!/usr/bin/env node
/**
 * Fetches and lists Steam and Epic top sellers.
 * Usage: node scripts/list-top-sellers.mjs
 */

const STEAM_URL = 'https://store.steampowered.com/api/featuredcategories?cc=us&l=english';
const EGDATA_URL = 'https://api.egdata.app/offers/top-sellers?limit=99&skip=0';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function main() {
  console.log('Fetching Steam and Epic top sellers...\n');

  const [steamData, epicData] = await Promise.all([
    fetchJson(STEAM_URL),
    fetchJson(EGDATA_URL),
  ]);

  const steamItems = steamData?.top_sellers?.items ?? [];
  const steamGames = steamItems.filter((it) => it.type === 0);
  const steamList = steamItems.map((it, i) => {
    const type = it.type === 0 ? 'game' : it.type === 1 ? 'sub' : 'bundle';
    return `${i + 1}. [${it.id}] ${it.name || '—'} (${type})`;
  });

  console.log('=== STEAM TOP SELLERS (' + steamItems.length + ' items, ' + steamGames.length + ' games) ===');
  console.log(steamList.join('\n'));

  const elements = epicData?.elements ?? [];
  const total = epicData?.total ?? elements.length;
  const epicList = elements.map((e, i) => `${i + 1}. ${e.title || e.id}`);

  console.log('\n=== EPIC TOP SELLERS (' + total + ') ===');
  console.log(epicList.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
