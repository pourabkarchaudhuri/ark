#!/usr/bin/env node
/**
 * Standalone Node script: run full-catalog adult filter test without Electron.
 * Writes docs/excluded-steam-adult-filter.json, excluded-epic-adult-filter.json,
 * adult-filter-full-catalog-summary.json.
 *
 * Usage: node scripts/run-adult-filter-full.mjs
 * Requires: STEAM_API_KEY in .env (project root)
 * Runtime: ~1 hour for Steam (158k apps, 20 per batch, 400ms delay), then Epic via egdata.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env from project root
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });
} catch {
  // dotenv optional
}

const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const STEAM_WEB_API_BASE = 'https://api.steampowered.com';
const STEAM_STORE_API_BASE = 'https://store.steampowered.com/api';
const EGDATA_BASE = 'https://api.egdata.app';
const STEAM_BATCH_SIZE = 20;
const STEAM_BATCH_DELAY_MS = 400;
const STEAM_APP_LIST_PAGE_SIZE = 50000;
const REQUEST_TIMEOUT_MS = 20000;

const EPIC_SEXUAL_CONTENT_TAG_NAMES = new Set([
  'sexual content', 'strong sexual content', 'adult only', 'nudity', 'nsfw',
  'sexual themes', 'explicit sexual content', 'adults only', 'strong sexual themes',
  'interactive sexual content',
]);

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function fetchWithTimeout(url, ms = REQUEST_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

function isSteamAO(details) {
  const r = details?.ratings?.esrb?.rating;
  return r != null && String(r).toLowerCase() === 'ao';
}

function isEpicExcluded(item) {
  const tags = item?.tags ?? [];
  for (const t of tags) {
    const name = (t?.name ?? '').trim().toLowerCase();
    if (EPIC_SEXUAL_CONTENT_TAG_NAMES.has(name)) return true;
  }
  return false;
}

// ---------- Steam: app list (paginated) ----------
async function fetchSteamAppList() {
  if (!STEAM_API_KEY) {
    throw new Error('STEAM_API_KEY is required. Add it to .env in the project root.');
  }
  const apps = [];
  let lastAppId;
  let page = 0;
  while (true) {
    page++;
    let url = `${STEAM_WEB_API_BASE}/IStoreService/GetAppList/v1/?key=${STEAM_API_KEY}`
      + `&max_results=${STEAM_APP_LIST_PAGE_SIZE}`
      + `&include_games=true&include_dlc=false&include_software=false&include_videos=false&include_hardware=false`;
    if (lastAppId != null) url += `&last_appid=${lastAppId}`;
    log(`Steam app list page ${page}...`);
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Steam GetAppList ${res.status}`);
    const data = await res.json();
    const list = data?.response?.apps ?? [];
    for (const a of list) {
      if (a?.name?.trim()) apps.push({ appid: a.appid, name: a.name });
    }
    log(`  got ${list.length} (total ${apps.length})`);
    if (!data?.response?.have_more_results) break;
    lastAppId = data.response.last_appid;
    if (lastAppId == null) break;
  }
  return apps;
}

// ---------- Steam: batch app details (store API), return AO only ----------
async function fetchSteamDetailsBatch(appIds) {
  if (appIds.length === 0) return [];
  const ids = appIds.slice(0, 20).join(',');
  const url = `${STEAM_STORE_API_BASE}/appdetails?appids=${ids}&cc=us&l=english`;
  try {
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) return [];
    const raw = await res.json();
    const out = [];
    for (const id of appIds.slice(0, 20)) {
      const app = raw[String(id)];
      if (app?.success && app.data) {
        out.push({
          appid: app.data.steam_appid,
          name: app.data.name ?? '',
          ratings: app.data.ratings ?? null,
        });
      }
    }
    return out;
  } catch (e) {
    log(`  batch failed: ${e.message}`);
    return [];
  }
}

// ---------- Epic: egdata top-sellers (paginated) ----------
async function fetchEpicViaEgdata() {
  const elements = [];
  const pageSize = 10;
  const maxPages = 10;
  for (let p = 1; p <= maxPages; p++) {
    const url = `${EGDATA_BASE}/offers/top-sellers?limit=${pageSize}&page=${p}`;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) break;
      const data = await res.json();
      const list = data?.elements ?? [];
      if (list.length === 0) break;
      elements.push(...list);
      log(`Epic egdata page ${p}: ${list.length} (total ${elements.length})`);
      if (list.length < pageSize) break;
    } catch (e) {
      log(`Epic egdata page ${p} failed: ${e.message}`);
      break;
    }
  }
  return elements;
}

// ---------- Main ----------
async function main() {
  const docsDir = path.join(ROOT, 'docs');
  mkdirSync(docsDir, { recursive: true });

  const result = {
    steam: { total: 0, excluded: 0, excludedList: [] },
    epic: { total: 0, excluded: 0, excludedList: [] },
    runAt: new Date().toISOString(),
    epicSource: 'egdata top-sellers',
  };

  const writeOutputs = () => {
    const steamPath = path.join(docsDir, 'excluded-steam-adult-filter.json');
    const epicPath = path.join(docsDir, 'excluded-epic-adult-filter.json');
    const summaryPath = path.join(docsDir, 'adult-filter-full-catalog-summary.json');
    writeFileSync(steamPath, JSON.stringify(result.steam.excludedList, null, 2), 'utf8');
    writeFileSync(epicPath, JSON.stringify(result.epic.excludedList, null, 2), 'utf8');
    writeFileSync(summaryPath, JSON.stringify(result, null, 2), 'utf8');
    log(`Wrote ${steamPath}, ${epicPath}, ${summaryPath}`);
  };

  // Steam
  log('Fetching Steam app list...');
  const appList = await fetchSteamAppList();
  result.steam.total = appList.length;
  log(`Steam app list: ${appList.length} apps`);

  const excludedSteam = [];
  const progressInterval = 1000;
  for (let i = 0; i < appList.length; i += STEAM_BATCH_SIZE) {
    const batch = appList.slice(i, i + STEAM_BATCH_SIZE).map((a) => a.appid);
    const details = await fetchSteamDetailsBatch(batch);
    for (const d of details) {
      if (isSteamAO(d)) excludedSteam.push({ appid: d.appid, name: d.name });
    }
    const done = Math.min(i + STEAM_BATCH_SIZE, appList.length);
    if (done % progressInterval < STEAM_BATCH_SIZE || done === appList.length) {
      log(`Steam progress: ${done}/${appList.length}`);
    }
    await new Promise((r) => setTimeout(r, STEAM_BATCH_DELAY_MS));
  }
  result.steam.excluded = excludedSteam.length;
  result.steam.excludedList = excludedSteam;
  log(`Steam excluded (ESRB AO): ${excludedSteam.length}`);

  // Epic (egdata)
  log('Fetching Epic via egdata top-sellers...');
  const epicItems = await fetchEpicViaEgdata();
  result.epic.total = epicItems.length;
  log(`Epic: ${epicItems.length} items`);

  const excludedEpic = [];
  for (const el of epicItems) {
    if (isEpicExcluded(el)) {
      const matchTags = (el?.tags ?? [])
        .filter((t) => EPIC_SEXUAL_CONTENT_TAG_NAMES.has((t?.name ?? '').toLowerCase()))
        .map((t) => t?.name ?? '');
      excludedEpic.push({
        title: el?.title ?? '',
        id: el?.id ?? '',
        namespace: el?.namespace ?? '',
        matchingTags: matchTags,
      });
    }
  }
  result.epic.excluded = excludedEpic.length;
  result.epic.excludedList = excludedEpic;
  log(`Epic excluded (sexual-content tag): ${excludedEpic.length}`);

  writeOutputs();
  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
