/**
 * Steam API client (1.0.97 B06): the RateLimiter really limits concurrency and spacing, the
 * shared title collator keeps the old A–Z order, getAppList refreshes once for concurrent
 * callers, appdetails lookups report why they are empty, and recommendations score
 * game-specific candidates, cache the full list (not per limit) and skip degraded runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The module-level singleton must not read or write a real steam-cache.json.
vi.mock('../../../electron/persistent-cache.js', () => ({
  PersistentCache: class {
    get() { return null; }
    set() {}
    has() { return false; }
    clear() {}
    getStats() { return { total: 0, fresh: 0, stale: 0 }; }
    flushSync() {}
  },
}));

import {
  RateLimiter,
  SteamAPIClient,
  PLAYER_COUNT_LIMITER_OPTIONS,
  RECO_MAX_UNCACHED_FETCHES,
  buildRecommendationCandidates,
  type SteamCacheLike,
} from '../../../electron/steam-api';
import { titleCollator, compareTitles } from '@/lib/title-collator';

// ─── Helpers ────────────────────────────────────────────────────────────────

function memCache(): SteamCacheLike & { store: Map<string, { data: unknown; ttl: number; at: number }> } {
  const store = new Map<string, { data: unknown; ttl: number; at: number }>();
  return {
    store,
    get: (<T,>(key: string, allowStale = false) => {
      const e = store.get(key);
      if (!e) return null;
      if (Date.now() - e.at <= e.ttl || allowStale) return e.data as T;
      return null;
    }) as SteamCacheLike['get'],
    set: (key: string, data: unknown, ttl = 5 * 60_000) => { store.set(key, { data, ttl, at: Date.now() }); },
    has: (key: string) => store.has(key),
    clear: () => store.clear(),
    getStats: () => ({ total: store.size, fresh: store.size, stale: 0 }),
    flushSync: () => {},
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** Resolve a promise while draining fake timers (rate-limiter spacing waits). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.finally(() => { done = true; }).catch(() => {});
  for (let i = 0; i < 200 && !done; i++) await vi.runAllTimersAsync();
  return p;
}

const details = (id: number, extra: Record<string, unknown> = {}) => ({
  type: 'game', name: `Game ${id}`, steam_appid: id,
  genres: [{ id: '1', description: 'Action' }],
  categories: [{ id: 2, description: 'Single-player' }],
  developers: ['DevCo'], publishers: ['PubCo'],
  ...extra,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

// ─── Shared collator ────────────────────────────────────────────────────────

describe('titleCollator', () => {
  it('orders mixed case and accents exactly like the old options-form localeCompare', () => {
    const names = ['éclair', 'Zelda', 'apple', 'Äpfel', 'banana', 'Éclair', 'zebra', 'Apple', '1942', 'ölfass', 'Oregon'];
    const oldOrder = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect([...names].sort(compareTitles)).toEqual(oldOrder);
    expect([...names].sort((a, b) => titleCollator.compare(a, b))).toEqual(oldOrder);
  });

  it('sorts 155k synthetic names in under 2 s', () => {
    vi.useRealTimers();
    const names = Array.from({ length: 155_000 }, (_, i) => `Game ${(i * 7919) % 155_000} ${i % 3 ? 'é' : 'E'}dition`);
    const t0 = performance.now();
    names.sort(compareTitles);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// ─── RateLimiter ────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  it('same-tick calls respect maxConcurrent and are spaced by delay', async () => {
    const limiter = new RateLimiter({ delay: 200, maxConcurrent: 3 });
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const task = () => limiter.execute(async () => {
      starts.push(Date.now());
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 50));
      active--;
      return true;
    });
    const all = Promise.all(Array.from({ length: 50 }, task));
    // Slots are taken synchronously: three running, the rest queued, before any await.
    expect(limiter.getActiveCount()).toBe(3);
    expect(limiter.getQueueSize()).toBe(47);
    await settle(all);
    expect(peak).toBeLessThanOrEqual(3);
    expect(starts).toHaveLength(50);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(200);
  });

  it('player-count config runs ~8 at once with short spacing (200 ids in seconds, not 40 s)', async () => {
    const limiter = new RateLimiter(PLAYER_COUNT_LIMITER_OPTIONS);
    let active = 0;
    let peak = 0;
    const t0 = Date.now();
    const all = Promise.all(Array.from({ length: 200 }, () => limiter.execute(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 100));
      active--;
    })));
    await settle(all);
    expect(PLAYER_COUNT_LIMITER_OPTIONS.maxConcurrent).toBe(8);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(3);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('rejects with "queue full" only once requests are actually queued', async () => {
    const limiter = new RateLimiter({ delay: 0, maxConcurrent: 2, maxQueue: 1 });
    const gate: Array<() => void> = [];
    const hold = () => limiter.execute(() => new Promise<void>(r => gate.push(r)));
    const a = hold();
    const b = hold();
    const c = hold(); // queued
    await expect(hold()).rejects.toThrow('Rate limiter queue full');
    expect(limiter.getQueueSize()).toBe(1);
    await vi.runAllTimersAsync();
    gate.splice(0).forEach(r => r());
    await vi.runAllTimersAsync();
    gate.splice(0).forEach(r => r());
    await settle(Promise.all([a, b, c]));
  });

  it('a zero-capacity queue still runs requests while slots are free', async () => {
    const limiter = new RateLimiter({ delay: 0, maxConcurrent: 1, maxQueue: 0 });
    await expect(settle(limiter.execute(async () => 7))).resolves.toBe(7);
  });

  it('coalesces identical in-flight keys and releases them afterwards', async () => {
    const limiter = new RateLimiter({ delay: 0 });
    const fn = vi.fn(async () => 1);
    const [x, y] = await settle(Promise.all([limiter.execute(fn, 'k'), limiter.execute(fn, 'k')]));
    expect(x + y).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1);
    await settle(limiter.execute(fn, 'k'));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─── getAppList ─────────────────────────────────────────────────────────────

describe('SteamAPIClient.getAppList', () => {
  it('two concurrent calls on an empty cache run one fetch sequence, sorted A–Z', async () => {
    const fetch = vi.fn(async () => json({ response: { apps: [
      { appid: 2, name: 'zeta' }, { appid: 1, name: 'Alpha' }, { appid: 3, name: 'éclair' },
    ], have_more_results: false } }));
    const client = new SteamAPIClient({ fetch, cache: memCache() });
    const [a, b] = await settle(Promise.all([client.getAppList(), client.getAppList()]));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.map(x => x.name)).toEqual(['Alpha', 'éclair', 'zeta']);
  });

  it('stale cache is returned at once and concurrent callers share one background refresh', async () => {
    const cache = memCache();
    cache.store.set('full-app-list-v2', { data: [{ appid: 9, name: 'Old' }], ttl: 1, at: Date.now() - 10 });
    const fetch = vi.fn(async () => json({ response: { apps: [{ appid: 1, name: 'New' }] } }));
    const client = new SteamAPIClient({ fetch, cache });
    const [a, b] = await Promise.all([client.getAppList(), client.getAppList()]);
    expect(a).toEqual([{ appid: 9, name: 'Old' }]);
    expect(b).toEqual([{ appid: 9, name: 'Old' }]);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── getAppDetailsWithStatus ────────────────────────────────────────────────

describe('SteamAPIClient.getAppDetailsWithStatus', () => {
  it('ok with data, not_found on success:false, rate_limited during the 429 pause, error on network failure', async () => {
    let mode: 'ok' | 'missing' | '429' | 'down' = 'ok';
    const fetch = vi.fn(async (u: string) => {
      const id = Number(new URL(u).searchParams.get('appids'));
      if (mode === 'down') throw new Error('ENOTFOUND');
      if (mode === '429') return json({}, 429, { 'retry-after': '30' });
      if (mode === 'missing') return json({ [id]: { success: false } });
      return json({ [id]: { success: true, data: details(id) } });
    });
    const client = new SteamAPIClient({ fetch, cache: memCache() });

    const ok = await settle(client.getAppDetailsWithStatus(10));
    expect(ok.status).toBe('ok');
    expect(ok.data?.name).toBe('Game 10');

    mode = 'missing';
    expect(await settle(client.getAppDetailsWithStatus(11))).toEqual({ data: null, status: 'not_found' });

    mode = 'down';
    expect(await settle(client.getAppDetailsWithStatus(12))).toEqual({ data: null, status: 'error' });

    mode = '429';
    expect(await settle(client.getAppDetailsWithStatus(13))).toEqual({ data: null, status: 'rate_limited' });
    expect(client.isAppDetailsPaused()).toBe(true);
    // While paused, nothing is fetched and the status stays rate_limited.
    const calls = fetch.mock.calls.length;
    mode = 'ok';
    expect(await settle(client.getAppDetailsWithStatus(14))).toEqual({ data: null, status: 'rate_limited' });
    expect(fetch.mock.calls.length).toBe(calls);
    // Cached data is still ok during the pause; plain getAppDetails keeps returning null.
    expect((await settle(client.getAppDetailsWithStatus(10))).status).toBe('ok');
    expect(await settle(client.getAppDetails(14))).toBeNull();
  });
});

// ─── Recommendations ────────────────────────────────────────────────────────

describe('buildRecommendationCandidates', () => {
  it('puts creator then genre search hits first, then alternates the chart lists, deduped and excluded', () => {
    const out = buildRecommendationCandidates({
      exclude: [1, 2],
      creator: [100, 101, 1, 102],
      genre: [200, 100, 201],
      topSellers: [300, 301, 302],
      newReleases: [400, 300],
      mostPlayed: [500],
    }, { total: 10 });
    expect(out).toEqual([100, 101, 102, 200, 201, 300, 400, 500, 301, 302]);
  });

  it('caps each search bucket (~15) so the charts still get slots, and fills to the total', () => {
    const creator = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const genre = Array.from({ length: 40 }, (_, i) => 2000 + i);
    const topSellers = Array.from({ length: 40 }, (_, i) => 3000 + i);
    const out = buildRecommendationCandidates({ exclude: [], creator, genre, topSellers, newReleases: [], mostPlayed: [] });
    expect(out).toHaveLength(50);
    expect(out.filter(id => id < 2000)).toHaveLength(15);
    expect(out.filter(id => id >= 2000 && id < 3000)).toHaveLength(15);
    expect(out.filter(id => id >= 3000)).toHaveLength(20);
  });
});

describe('SteamAPIClient.getRecommendations', () => {
  const CURRENT = 1;

  /** Client with the taste-profile inputs cached so only candidate appdetails hit the network. */
  function recoClient(opts: { searchIds?: number[]; chartIds?: number[]; appdetails?: (id: number) => Response } = {}) {
    const cache = memCache();
    cache.set(`app-details-${CURRENT}`, details(CURRENT), 60 * 60_000);
    const searchItems = (opts.searchIds ?? []).map(id => ({ type: 'app', name: `Search ${id}`, id }));
    for (const term of ['DevCo', 'Action']) cache.set(`search-${term}-50`, searchItems, 60 * 60_000);
    cache.set('featured-categories', {
      top_sellers: { id: 'ts', name: 'Top', items: (opts.chartIds ?? []).map(id => ({ id, name: `Chart ${id}` })) },
      new_releases: { id: 'nr', name: 'New', items: [] },
    }, 60 * 60_000);
    cache.set('most-played-games', [], 60 * 60_000);
    const appdetailsCalls: number[] = [];
    const otherUrls: string[] = [];
    const fetch = vi.fn(async (u: string) => {
      const url = new URL(u);
      if (!url.pathname.endsWith('/appdetails')) { otherUrls.push(url.pathname); return json({}); }
      const id = Number(url.searchParams.get('appids'));
      appdetailsCalls.push(id);
      return opts.appdetails ? opts.appdetails(id) : json({ [id]: { success: true, data: details(id) } });
    });
    return { client: new SteamAPIClient({ fetch, cache }), cache, appdetailsCalls, otherUrls, fetch };
  }

  it('scores developer/genre search hits ahead of chart games', async () => {
    const { client, appdetailsCalls } = recoClient({
      searchIds: [100, 101],
      chartIds: Array.from({ length: 60 }, (_, i) => 5000 + i),
    });
    await settle(client.getRecommendations(CURRENT, [], 10));
    expect(appdetailsCalls.slice(0, 2).sort()).toEqual([100, 101]);
  });

  it(`fetches at most ${RECO_MAX_UNCACHED_FETCHES} uncached appdetails per run and scores cached candidates without network`, async () => {
    const chartIds = Array.from({ length: 40 }, (_, i) => 5000 + i);
    const { client, cache, appdetailsCalls } = recoClient({ chartIds });
    // 5 candidates already cached (one of them stale) — scored as-is, never refreshed.
    for (const id of chartIds.slice(30, 35)) cache.set(`app-details-${id}`, details(id), 60 * 60_000);
    cache.store.set(`app-details-${chartIds[35]}`, { data: details(chartIds[35]), ttl: 1, at: Date.now() - 10 });
    const recs = await settle(client.getRecommendations(CURRENT, [], 50));
    expect(appdetailsCalls.length).toBeLessThanOrEqual(RECO_MAX_UNCACHED_FETCHES);
    expect(appdetailsCalls).not.toContain(chartIds[30]);
    expect(appdetailsCalls).not.toContain(chartIds[35]);
    const ids = recs.map(r => r.appId);
    expect(ids).toContain(chartIds[30]);
    expect(ids).toContain(chartIds[35]);
  });

  it('limit 3 then 10 returns 10 (the full list is cached, sliced on read)', async () => {
    const { client, fetch } = recoClient({ searchIds: Array.from({ length: 12 }, (_, i) => 100 + i) });
    expect(await settle(client.getRecommendations(CURRENT, [], 3))).toHaveLength(3);
    const calls = fetch.mock.calls.length;
    expect(await settle(client.getRecommendations(CURRENT, [], 10))).toHaveLength(10);
    expect(fetch.mock.calls.length).toBe(calls); // served from the cache
  });

  it('does not cache an empty or rate-limited run', async () => {
    const empty = recoClient({ searchIds: [100, 101], appdetails: (id) => json({ [id]: { success: false } }) });
    expect(await settle(empty.client.getRecommendations(CURRENT, [], 10))).toEqual([]);
    expect([...empty.cache.store.keys()].some(k => k.startsWith('recommendations'))).toBe(false);

    let n = 0;
    const paused = recoClient({
      searchIds: [100, 101, 102],
      appdetails: (id) => (++n === 1 ? json({}, 429) : json({ [id]: { success: true, data: details(id) } })),
    });
    await settle(paused.client.getRecommendations(CURRENT, [], 10));
    expect([...paused.cache.store.keys()].some(k => k.startsWith('recommendations'))).toBe(false);
  });

  it('caches a healthy run', async () => {
    const { client, cache } = recoClient({ searchIds: [100, 101, 102] });
    const recs = await settle(client.getRecommendations(CURRENT, [], 10));
    expect(recs.length).toBeGreaterThan(0);
    expect([...cache.store.keys()].some(k => k.startsWith('recommendations'))).toBe(true);
  });
});
