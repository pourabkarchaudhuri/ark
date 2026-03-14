#!/usr/bin/env node
/**
 * Probe egdata top-sellers API: raw calls with different limit/skip, report counts.
 * Usage: node scripts/probe-egdata-top-sellers.mjs
 */

const BASE = 'https://api.egdata.app/offers/top-sellers';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log('Probing egdata top-sellers (raw)...\n');

  // Single request: limit=99, skip=0
  const u99 = `${BASE}?limit=99&skip=0`;
  console.log('1) GET', u99);
  const d99 = await fetchJson(u99);
  const el99 = d99?.elements ?? [];
  const total99 = d99?.total ?? '?';
  console.log('   elements.length:', el99.length);
  console.log('   response.total:', total99);
  if (el99.length > 0) {
    console.log('   first 3:', el99.slice(0, 3).map((e) => e?.title || e?.id || e?.namespace).join(', '));
  }
  console.log('');

  // Single request: limit=10, skip=0
  const u10 = `${BASE}?limit=10&skip=0`;
  console.log('2) GET', u10);
  const d10 = await fetchJson(u10);
  const el10 = d10?.elements ?? [];
  console.log('   elements.length:', el10.length);
  console.log('   response.total:', d10?.total ?? '?');
  console.log('');

  // Pagination: limit=10, skip=10
  const u10_10 = `${BASE}?limit=10&skip=10`;
  console.log('3) GET', u10_10);
  const d10_10 = await fetchJson(u10_10);
  const el10_10 = d10_10?.elements ?? [];
  console.log('   elements.length:', el10_10.length);
  console.log('   response.total:', d10_10?.total ?? '?');
  if (el10_10.length > 0) {
    console.log('   first 2:', el10_10.slice(0, 2).map((e) => e?.title || e?.id).join(', '));
    const ids0 = el10.map((e) => (e?.namespace && e?.id ? `${e.namespace}:${e.id}` : '')).filter(Boolean);
    const ids10 = el10_10.map((e) => (e?.namespace && e?.id ? `${e.namespace}:${e.id}` : '')).filter(Boolean);
    const overlap = ids0.filter((id) => ids10.includes(id)).length;
    console.log('   ids overlap with skip=0:', overlap, '(0 = different page)');
  }
  console.log('');

  // Pagination: limit=33, skip=33
  const u33_33 = `${BASE}?limit=33&skip=33`;
  console.log('4) GET', u33_33);
  const d33_33 = await fetchJson(u33_33);
  const el33_33 = d33_33?.elements ?? [];
  console.log('   elements.length:', el33_33.length);
  console.log('   response.total:', d33_33?.total ?? '?');
  console.log('');

  // Try page=2 (in case API uses page not skip)
  const uPage2 = `${BASE}?limit=10&page=2`;
  console.log('5) GET', uPage2);
  try {
    const dPage2 = await fetchJson(uPage2);
    const elPage2 = dPage2?.elements ?? [];
    console.log('   elements.length:', elPage2.length);
    if (elPage2.length > 0) {
      const ids0 = el10.map((e) => (e?.namespace && e?.id ? `${e.namespace}:${e.id}` : '')).filter(Boolean);
      const idsP2 = elPage2.map((e) => (e?.namespace && e?.id ? `${e.namespace}:${e.id}` : '')).filter(Boolean);
      console.log('   overlap with page 0:', ids0.filter((id) => idsP2.includes(id)).length);
    }
  } catch (e) {
    console.log('   error:', e.message);
  }
  console.log('');

  // Summary
  console.log('--- Summary ---');
  console.log('limit=99 skip=0  →', el99.length, 'elements');
  console.log('limit=10 skip=0  →', el10.length, 'elements');
  console.log('limit=10 skip=10 →', el10_10.length, 'elements');
  console.log('limit=33 skip=33 →', el33_33.length, 'elements');

  // Paginated fetch (same logic as Electron IPC) — API uses page=1,2,..., should get 99
  console.log('\n--- Paginated fetch (page=1,2,...) ---');
  const PAGE_SIZE = 10;
  const MAX_PAGES = 10;
  const byId = new Map();
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}?limit=${PAGE_SIZE}&page=${p}`;
    const data = await fetchJson(url);
    const elements = data?.elements ?? [];
    if (elements.length === 0) break;
    for (const el of elements) {
      const id = el?.id && el?.namespace ? `${el.namespace}:${el.id}` : '';
      if (id && !byId.has(id)) byId.set(id, { el, position: el.position ?? 999 });
    }
    if (elements.length < PAGE_SIZE) break;
  }
  const sorted = Array.from(byId.values())
    .sort((a, b) => a.position - b.position)
    .map((x) => x.el)
    .slice(0, 99);
  console.log('Paginated total:', sorted.length, 'elements');
  if (sorted.length < 90) {
    throw new Error(`Expected at least 90 elements from pagination, got ${sorted.length}`);
  }
  console.log('OK: pagination returns', sorted.length, 'elements');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
