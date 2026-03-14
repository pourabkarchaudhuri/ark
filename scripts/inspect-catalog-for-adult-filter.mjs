#!/usr/bin/env node
/**
 * Inspect Steam and Epic/egdata catalog data to find patterns that distinguish
 * porn / sexual-content games from proper M-rated games (e.g. GTA).
 *
 * Usage:
 *   node scripts/inspect-catalog-for-adult-filter.mjs
 *   node scripts/inspect-catalog-for-adult-filter.mjs [steam_appid_1] [steam_appid_2]  # extra Steam app IDs to sample
 *
 * Writes:
 *   docs/catalog-adult-filter-inspection.json  (raw summary for analysis)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STEAM_FEATURED = 'https://store.steampowered.com/api/featuredcategories?cc=us&l=english';
const STEAM_APPDETAILS = 'https://store.steampowered.com/api/appdetails';
const EGDATA_TOP = 'https://api.egdata.app/offers/top-sellers';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function getSteamTopSellerAppIds() {
  const data = await fetchJson(STEAM_FEATURED);
  const items = data?.top_sellers?.items ?? [];
  return items.filter((it) => it.type === 0).slice(0, 15).map((it) => it.id);
}

async function getSteamAppDetails(appId) {
  const url = `${STEAM_APPDETAILS}?appids=${appId}&cc=us&l=english`;
  const data = await fetchJson(url);
  const app = data[String(appId)];
  if (!app?.success || !app.data) return null;
  const d = app.data;
  return {
    steam_appid: d.steam_appid,
    name: d.name,
    type: d.type,
    required_age: d.required_age,
    categories: d.categories ?? [],
    genres: d.genres ?? [],
    content_descriptors: d.content_descriptors ?? null,
    ratings: d.ratings ?? null,
  };
}

async function getEgdataTopSellers(limit = 99, skip = 0) {
  const url = `${EGDATA_TOP}?limit=${limit}&skip=${skip}`;
  const data = await fetchJson(url);
  return data?.elements ?? [];
}

function collectEgdataTagAndCategorySummary(elements) {
  const tagIds = new Set();
  const tagNames = new Set();
  const tagIdToName = new Map();
  const categoryPaths = new Set();
  const sampleByTag = new Map(); // tag name -> one title that has it

  for (const el of elements) {
    const title = el?.title ?? el?.id ?? '';
    for (const p of el?.categories ?? []) {
      const path = typeof p === 'string' ? p : p?.path;
      if (path) categoryPaths.add(path);
    }
    for (const t of el?.tags ?? []) {
      const id = t?.id != null ? String(t.id) : '';
      const name = t?.name ?? '';
      if (id) tagIds.add(id);
      if (name) {
        tagNames.add(name);
        if (!tagIdToName.has(id)) tagIdToName.set(id, name);
        if (!sampleByTag.has(name)) sampleByTag.set(name, title);
      }
    }
  }

  return {
    tagIds: [...tagIds].sort(),
    tagNames: [...tagNames].sort(),
    tagIdToName: Object.fromEntries([...tagIdToName].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
    categoryPaths: [...categoryPaths].sort(),
    sampleByTag: Object.fromEntries([...sampleByTag].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

async function main() {
  const extraSteamIds = process.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));

  console.log('Fetching Steam featured categories...');
  const steamAppIds = await getSteamTopSellerAppIds();
  const allSteamIds = [...new Set([...steamAppIds, ...extraSteamIds])];

  console.log('Fetching Steam appdetails for', allSteamIds.length, 'apps...');
  const steamSamples = [];
  for (const appId of allSteamIds) {
    try {
      const details = await getSteamAppDetails(appId);
          if (details) steamSamples.push(details);
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.warn(`  ${appId}: ${e.message}`);
    }
  }

  console.log('Fetching egdata top-sellers (paginated)...');
  const egdataElements = [];
  for (let skip = 0; skip < 99; skip += 10) {
    const page = await getEgdataTopSellers(10, skip);
    if (page.length === 0) break;
    egdataElements.push(...page);
    if (page.length < 10) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const egdataSummary = collectEgdataTagAndCategorySummary(egdataElements);

  // Build summary for analysis
  const steamRatingsSeen = new Set();
  const steamContentDescriptorIds = new Set();
  const steamCategoryIds = new Set();
  for (const s of steamSamples) {
    if (s.ratings?.esrb?.rating) steamRatingsSeen.add(s.ratings.esrb.rating);
    for (const id of s.content_descriptors?.ids ?? []) steamContentDescriptorIds.add(id);
    for (const c of s.categories ?? []) steamCategoryIds.add(c.id);
  }

  const out = {
    inspectedAt: new Date().toISOString(),
    steam: {
      sampleCount: steamSamples.length,
      appIds: steamSamples.map((s) => s.steam_appid),
      samples: steamSamples,
      summary: {
        required_ages: [...new Set(steamSamples.map((s) => s.required_age))].sort(),
        esrb_ratings_seen: [...steamRatingsSeen].sort(),
        content_descriptor_ids_seen: [...steamContentDescriptorIds].sort(),
        category_ids_seen: [...steamCategoryIds].sort(),
      },
    },
    egdata: {
      elementCount: egdataElements.length,
      tagCount: egdataSummary.tagNames.length,
      categoryPathCount: egdataSummary.categoryPaths.length,
      allTagNames: egdataSummary.tagNames,
      allTagIds: egdataSummary.tagIds,
      tagIdToName: egdataSummary.tagIdToName,
      allCategoryPaths: egdataSummary.categoryPaths,
      sampleByTag: egdataSummary.sampleByTag,
      // Full elements (trimmed to first 20 for size) for manual spot-check
      firstTitles: egdataElements.slice(0, 20).map((e) => ({
        title: e?.title,
        namespace: e?.namespace,
        id: e?.id,
        tags: e?.tags?.map((t) => ({ id: t?.id, name: t?.name })),
        categories: e?.categories,
      })),
    },
  };

  const outPath = `${__dirname}/../docs/catalog-adult-filter-inspection.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outPath);

  // Print concise summary
  console.log('\n--- Steam summary ---');
  console.log('ESRB ratings seen:', out.steam.summary.esrb_ratings_seen.join(', '));
  console.log('content_descriptor ids seen:', out.steam.summary.content_descriptor_ids_seen.join(', '));
  console.log('required_age values:', out.steam.summary.required_ages.join(', '));
  console.log('\n--- Epic/egdata summary ---');
  console.log('Unique tag names:', out.egdata.allTagNames.length);
  console.log('Unique category paths:', out.egdata.allCategoryPaths.length);
  const sexualLike = out.egdata.allTagNames.filter(
    (n) => /sexual|nudity|nsfw|explicit|erotic|porn|adult only|strong sexual/i.test(n)
  );
  if (sexualLike.length) console.log('Tag names suggesting sexual/adult content:', sexualLike);
  else console.log('No tag names in this sample suggest sexual/adult (top sellers are mainstream).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
