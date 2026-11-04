/**
 * Deterministic test-profile generator for the perf harness.
 *
 * Writes a userData directory the app can boot from, with no real keys and no real user data:
 *   <dir>/leveldb                 library (2,000 games), status history (5,000 rows),
 *                                 sessions (10,000), Voyage journey rows
 *   <dir>/steam-applist.json      155k-entry Steam app list (1.0.97 layout, stale on purpose)
 *   <dir>/steam-cache.json        same list in the pre-1.0.97 layout (PersistentCache key), so a v1.0.96
 *                                 build reads it exactly where it expects it
 *
 * Browser-side state (tour/changelog flags) is set by the harness's priming launch, not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));

export const PROFILE_DEFAULTS = {
  games: 2000,
  statusRows: 5000,
  sessions: 10000,
  appListEntries: 155000,
  seed: 1097,
};

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['Want to Play', 'Playing', 'Playing Now', 'Completed', 'On Hold'];
const STATUS_WEIGHTS = [0.4, 0.15, 0.02, 0.33, 0.1];
const GENRES = ['Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Indie', 'Shooter', 'Puzzle', 'Racing', 'Sports', 'Horror', 'Platformer'];
const WORDS = ['Star', 'Iron', 'Shadow', 'Echo', 'Neon', 'Ember', 'Void', 'Hollow', 'Crown', 'Drift', 'Pixel', 'Rogue', 'Saga', 'Frost', 'Orbit', 'Relic', 'Thorn', 'Zenith', 'Mirage', 'Anvil'];
const NOUNS = ['Legacy', 'Frontier', 'Dynasty', 'Protocol', 'Chronicle', 'Odyssey', 'Uprising', 'Harbor', 'Citadel', 'Reverie', 'Wanderer', 'Fable', 'Syndicate', 'Descent', 'Outpost'];

function pickWeighted(r, weights) {
  const x = r();
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (x < acc) return i;
  }
  return weights.length - 1;
}

export function makeTitle(r, i) {
  return `${WORDS[Math.floor(r() * WORDS.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]} ${i}`;
}

async function putBatches(db, ops, size = 2000) {
  for (let i = 0; i < ops.length; i += size) {
    await db.batch(ops.slice(i, i + size));
  }
}

export async function generateProfile(dir, opts = {}) {
  const o = { ...PROFILE_DEFAULTS, ...opts };
  const r = rng(o.seed);
  fs.mkdirSync(dir, { recursive: true });
  const { ClassicLevel } = require('classic-level');
  const db = new ClassicLevel(path.join(dir, 'leveldb'), { valueEncoding: 'utf8', keyEncoding: 'utf8' });
  await db.open();

  const now = Date.now();
  const DAY = 86_400_000;
  const iso = (t) => new Date(t).toISOString();
  const put = (ns, key, value) => ({ type: 'put', key: `${ns}::${key}`, value: JSON.stringify(value) });

  // --- library + journey -------------------------------------------------
  const library = [];
  const journey = [];
  const games = [];
  for (let i = 0; i < o.games; i++) {
    const appId = 10000 + i * 7;
    const gameId = `steam-${appId}`;
    const title = makeTitle(r, i);
    const status = STATUSES[pickWeighted(r, STATUS_WEIGHTS)];
    const hours = status === 'Want to Play' ? 0 : Math.round(r() * 220 * 10) / 10;
    const addedAt = iso(now - Math.floor(r() * 900) * DAY - Math.floor(r() * DAY));
    const lastPlayedAt = hours > 0 ? iso(now - Math.floor(r() * 400) * DAY) : undefined;
    const genre = [GENRES[Math.floor(r() * GENRES.length)], GENRES[Math.floor(r() * GENRES.length)]].filter((g, k, a) => a.indexOf(g) === k);
    const year = 2005 + Math.floor(r() * 21);
    const releaseDate = `${year}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
    const cachedMeta = {
      title,
      store: 'steam',
      coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
      headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
      developer: `${WORDS[i % WORDS.length]} Studio`,
      publisher: `${NOUNS[i % NOUNS.length]} Games`,
      genre,
      platform: ['PC'],
      releaseDate,
      metacriticScore: Math.floor(55 + r() * 40),
      summary: `${title} is a synthetic perf-harness game used to exercise the library at scale.`,
      steamAppId: appId,
    };
    const entry = {
      gameId,
      steamAppId: appId,
      status,
      priority: ['High', 'Medium', 'Low'][Math.floor(r() * 3)],
      publicReviews: '',
      recommendationSource: '',
      hoursPlayed: hours,
      hoursBaseline: hours,
      rating: hours > 0 ? Math.floor(r() * 6) : 0,
      cachedMeta,
      ...(lastPlayedAt ? { lastPlayedAt } : {}),
      addedAt,
      updatedAt: addedAt,
    };
    library.push(put('library', gameId, entry));
    journey.push(
      put('journey', gameId, {
        gameId,
        title,
        coverUrl: cachedMeta.coverUrl,
        genre,
        platform: ['PC'],
        releaseDate,
        status,
        hoursPlayed: hours,
        rating: entry.rating,
        ...(hours > 0 ? { firstPlayedAt: iso(Date.parse(addedAt) + 2 * DAY) } : {}),
        ...(lastPlayedAt ? { lastPlayedAt } : {}),
        addedAt,
      }),
    );
    games.push({ gameId, title, status, addedAt });
  }
  await putBatches(db, library);
  await putBatches(db, journey);

  // --- status history (one blob under status-history::data) -------------
  const entries = [];
  for (let i = 0; i < o.statusRows; i++) {
    const g = games[Math.floor(r() * games.length)];
    const prev = i % 5 === 0 ? null : STATUSES[Math.floor(r() * STATUSES.length)];
    entries.push({
      gameId: g.gameId,
      title: g.title,
      previousStatus: prev,
      newStatus: STATUSES[Math.floor(r() * STATUSES.length)],
      timestamp: iso(now - Math.floor(r() * 900 * DAY)),
      source: ['user', 'auto-hold', 'auto-promote', 'sync'][Math.floor(r() * 4)],
    });
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await db.batch([put('status-history', 'data', { version: 2, entries, lastUpdated: iso(now) })]);

  // --- sessions ----------------------------------------------------------
  const sessions = [];
  for (let i = 0; i < o.sessions; i++) {
    const g = games[Math.floor(r() * games.length)];
    const start = now - Math.floor(r() * 800 * DAY);
    const dur = 10 + Math.floor(r() * 170);
    const idle = Math.floor(r() * Math.min(20, dur / 3));
    const id = `perf-${String(i).padStart(6, '0')}-${Math.floor(r() * 1e9).toString(16)}`;
    sessions.push(
      put('session', id, {
        id,
        gameId: g.gameId,
        executablePath: `C:\\Games\\${g.title.replace(/\s+/g, '')}\\game.exe`,
        startTime: iso(start),
        endTime: iso(start + dur * 60_000),
        durationMinutes: dur,
        idleMinutes: idle,
        activeInputMinutes: Math.max(0, dur - idle - Math.floor(r() * 10)),
      }),
    );
  }
  await putBatches(db, sessions);
  await db.close();

  // --- Steam app list (both layouts) -------------------------------------
  const apps = new Array(o.appListEntries);
  for (let i = 0; i < o.appListEntries; i++) apps[i] = { appid: 20 + i * 10, name: makeTitle(r, i) };
  // 1.0.97 layout, savedAt two days old: stale, so getAppList() serves it and refreshes in the background.
  fs.writeFileSync(path.join(dir, 'steam-applist.json'), JSON.stringify({ savedAt: now - 2 * DAY, apps }));
  // pre-1.0.97 layout: PersistentCache file, entry fresh (timestamp now, 24 h ttl) so it loads at boot.
  fs.writeFileSync(
    path.join(dir, 'steam-cache.json'),
    JSON.stringify({ 'full-app-list-v2': { data: apps, timestamp: now - 23 * 3600_000, ttl: 24 * 3600 * 1000 } }),
  );

  const summary = { dir, games: o.games, statusRows: o.statusRows, sessions: o.sessions, appListEntries: o.appListEntries };
  fs.writeFileSync(path.join(dir, 'perf-profile.json'), JSON.stringify(summary));
  return summary;
}
