/**
 * gg.deals client: response parsing, batching ≤100, caching, invalid-key handling, the breaker,
 * and that the API key never ends up in cache keys or log output.
 */
import { describe, it, expect, vi } from 'vitest';

const logged: string[] = [];
vi.mock('../../../electron/safe-logger.js', () => ({
  logger: {
    log: vi.fn((...a: unknown[]) => logged.push(a.join(' '))),
    warn: vi.fn((...a: unknown[]) => logged.push(a.join(' '))),
    error: vi.fn((...a: unknown[]) => logged.push(a.join(' '))),
  },
}));

import { GgDealsClient, isPlausibleGgDealsKey, normalizeRegion, parseAppIds, parsePriceEntry, type GgCacheLike } from '../../../electron/ggdeals-api';

const KEY = 'secretKEY_1234567';
const HADES = { title: 'Hades', url: 'https://gg.deals/game/hades/', prices: { currentRetail: '24.99', currentKeyshops: '17.32', historicalRetail: '6.24', historicalKeyshops: '5.52', currency: 'USD' } };

function memCache(): GgCacheLike & { store: Map<string, { data: unknown; ttl: number }> } {
  const store = new Map<string, { data: unknown; ttl: number }>();
  return { store, get: <T,>(k: string) => (store.get(k)?.data as T) ?? null, set: (k, data, ttl) => { store.set(k, { data, ttl }); } };
}

function setup(handler: (url: URL) => Response, key: string | null = KEY) {
  let now = 5_000_000;
  const urls: URL[] = [];
  const fetch = vi.fn(async (u: string) => { const url = new URL(u); urls.push(url); return handler(url); });
  const cache = memCache();
  const c = new GgDealsClient({ fetch, cache, getKey: () => key, now: () => now, sleep: async (ms) => { now += ms; } });
  return { c, urls, cache, advance: (ms: number) => { now += ms; } };
}

const ok = (data: Record<string, unknown>) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('parsePriceEntry', () => {
  it('parses string prices and rejects entries without any current price', () => {
    expect(parsePriceEntry(HADES)).toEqual({
      title: 'Hades', url: 'https://gg.deals/game/hades/', currency: 'USD',
      currentRetail: 24.99, currentKeyshops: 17.32, historicalRetail: 6.24, historicalKeyshops: 5.52,
    });
    expect(parsePriceEntry(null)).toBeNull();
    expect(parsePriceEntry({ title: 'x', prices: { currentRetail: null, currentKeyshops: null, currency: 'USD' } })).toBeNull();
    expect(parsePriceEntry({ ...HADES, url: 'https://evil.example/' })?.url).toBe('https://gg.deals/');
  });
});

describe('GgDealsClient', () => {
  it('fetches in batches of at most 100 and caches each game for 6 hours', async () => {
    const { c, urls, cache } = setup((url) => {
      const ids = url.searchParams.get('ids')!.split(',');
      return ok(Object.fromEntries(ids.map((id) => [id, id === '1145360' ? HADES : null])));
    });
    const ids = [1145360, ...Array.from({ length: 150 }, (_, i) => i + 1)];
    const res = await c.getPrices(ids, 'us');
    expect(res.error).toBeUndefined();
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.searchParams.get('ids')!.split(',').length <= 100)).toBe(true);
    expect(res.prices[1145360]?.currentRetail).toBe(24.99);
    expect(res.prices[5]).toBeNull();
    // second call: all from cache
    await c.getPrices(ids, 'us');
    expect(urls).toHaveLength(2);
    expect([...cache.store.values()][0].ttl).toBe(6 * 3600e3);
  });

  it('never puts the key in cache keys or logs', async () => {
    logged.length = 0;
    const { c, cache } = setup(() => new Response('boom', { status: 500 }));
    await c.getPrices([1], 'us');
    const { c: c2, cache: cache2 } = setup(() => ok({ 1: HADES }));
    await c2.getPrices([1], 'us');
    for (const k of [...cache.store.keys(), ...cache2.store.keys()]) expect(k).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('reports a rejected key and stops retrying it until the key changes', async () => {
    const { c, urls } = setup(() => new Response(JSON.stringify({ success: false, data: { message: 'Invalid key.', code: 400 } }), { status: 400 }));
    expect((await c.getPrices([1], 'us')).error).toBe('invalid-key');
    expect((await c.getPrices([2], 'us')).error).toBe('invalid-key');
    expect(urls).toHaveLength(1);
  });

  it('pauses for 15 minutes after 429 and does not cache the failure', async () => {
    let fail = true;
    const { c, urls, cache, advance } = setup(() => (fail ? new Response('', { status: 429 }) : ok({ 1: HADES })));
    expect((await c.getPrices([1], 'us')).error).toBe('unavailable');
    expect(cache.store.size).toBe(0);
    expect((await c.getPrices([1], 'us')).error).toBe('unavailable');
    expect(urls).toHaveLength(1);
    fail = false;
    advance(16 * 60 * 1000);
    expect((await c.getPrices([1], 'us')).prices[1]?.title).toBe('Hades');
  });

  it('asks for nothing without a key', async () => {
    const { c, urls } = setup(() => ok({}), null);
    expect(await c.getPrices([1], 'us')).toEqual({ prices: {}, error: 'no-key' });
    expect(urls).toHaveLength(0);
  });

  it('testKey: ok for a working key, invalid-key otherwise', async () => {
    expect(await setup(() => ok({ 730: HADES })).c.testKey(KEY)).toEqual({ ok: true });
    expect(await setup(() => new Response(JSON.stringify({ success: false, data: { message: 'Invalid key.' } }), { status: 400 })).c.testKey(KEY))
      .toEqual({ ok: false, error: 'invalid-key' });
  });

  it('only known regions are sent', () => {
    expect(normalizeRegion('gb')).toBe('gb');
    expect(normalizeRegion('../x')).toBe('us');
    expect(normalizeRegion(undefined)).toBe('us');
  });
});

describe('IPC input validation', () => {
  it('accepts plausible keys only', () => {
    expect(isPlausibleGgDealsKey('abcDEF123_-xyz')).toBe(true);
    expect(isPlausibleGgDealsKey('short')).toBe(false);
    expect(isPlausibleGgDealsKey('has space inside')).toBe(false);
    expect(isPlausibleGgDealsKey(42)).toBe(false);
  });

  it('appids: positive integers, deduplicated, capped at 300', () => {
    expect(parseAppIds([1, 1, 2, -3, 1.5, 'x', 0])).toEqual([1, 2]);
    expect(parseAppIds(Array.from({ length: 500 }, (_, i) => i + 1))).toHaveLength(300);
    expect(parseAppIds('1,2')).toBeNull();
  });
});
