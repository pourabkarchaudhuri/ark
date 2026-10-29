/**
 * v1.0.96 performance fixes keep behaviour identical while doing less work: cached review counts,
 * one hasKey call per burst, merged price lookups with an error back-off, yielding pool-neighbour
 * search with bit-identical results, and one shared Upcoming selection rule.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computePoolNeighbors, computePoolNeighborsAsync } from '@/services/reco-scoring';
import { UpcomingSelector } from '@/lib/upcoming-select';

const getEntries = vi.fn(async (ids: number[]) => ids.map((appid) => ({ appid, reviewCount: 1000 })));
vi.mock('@/services/catalog-store', () => ({ catalogStore: { getEntries: (ids: number[]) => getEntries(ids) } }));

afterEach(() => {
  delete (window as unknown as { steam?: unknown }).steam;
  delete (window as unknown as { ggdeals?: unknown }).ggdeals;
  vi.resetModules();
  getEntries.mockClear();
});

describe('player counts: review counts are looked up once per session', () => {
  it('a refresh of the same cards sends no new catalog lookup', async () => {
    (window as unknown as { steam: unknown }).steam = {
      getMultiplePlayerCounts: vi.fn(async (ids: number[]) => Object.fromEntries(ids.map((id) => [id, 5]))),
    };
    const { steamService, __resetReviewCountCacheForTests } = await import('@/services/steam-service');
    __resetReviewCountCacheForTests();
    const first = await steamService.getMultiplePlayerCounts([1, 2, 3]);
    const second = await steamService.getMultiplePlayerCounts([1, 2, 3]);
    expect(first).toEqual({}); // 5 players on games with 1,000 reviews: implausible → unknown (unchanged rule)
    expect(second).toEqual(first);
    expect(getEntries).toHaveBeenCalledTimes(1);
  });
});

describe('gg.deals renderer service', () => {
  const PRICE = { title: 'X', url: 'https://gg.deals/game/x/', currency: 'USD', currentRetail: 9.99, currentKeyshops: null, historicalRetail: 4.99, historicalKeyshops: null };

  it('one hasKey IPC for a burst of cards, and one getPrices batch for all of them', async () => {
    const hasKey = vi.fn(async () => true);
    const getPrices = vi.fn(async (ids: number[]) => ({ prices: Object.fromEntries(ids.map((id) => [String(id), PRICE])) }));
    (window as unknown as { ggdeals: unknown }).ggdeals = { hasKey, getPrices, setKey: vi.fn(), clearKey: vi.fn(), testKey: vi.fn() };
    const { ggDealsService } = await import('@/services/ggdeals-service');
    ggDealsService.settingsChanged();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ggDealsService.getPrice(i + 1)));
    expect(results.every((p) => p?.currentRetail === 9.99)).toBe(true);
    expect(hasKey).toHaveBeenCalledTimes(1);
    expect(getPrices).toHaveBeenCalledTimes(1);
  });

  it('a card remounting while its price is loading reuses the request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const getPrices = vi.fn(async (ids: number[]) => { await gate; return { prices: Object.fromEntries(ids.map((id) => [String(id), PRICE])) }; });
    (window as unknown as { ggdeals: unknown }).ggdeals = { hasKey: async () => true, getPrices, setKey: vi.fn(), clearKey: vi.fn(), testKey: vi.fn() };
    const { ggDealsService } = await import('@/services/ggdeals-service');
    ggDealsService.settingsChanged();
    const a = ggDealsService.getPrice(7);
    const b = ggDealsService.getPrice(7);
    release();
    const [pa, pb] = await Promise.all([a, b]);
    expect(pa).toEqual(pb);
    expect(getPrices).toHaveBeenCalledTimes(1);
    expect(getPrices.mock.calls[0][0]).toEqual([7]);
  });

  it('after gg.deals fails, cards stop asking for a minute', async () => {
    const getPrices = vi.fn(async () => ({ prices: {}, error: 'unavailable' as const }));
    (window as unknown as { ggdeals: unknown }).ggdeals = { hasKey: async () => true, getPrices, setKey: vi.fn(), clearKey: vi.fn(), testKey: vi.fn() };
    const { ggDealsService } = await import('@/services/ggdeals-service');
    ggDealsService.settingsChanged();
    expect(await ggDealsService.getPrice(1)).toBeNull();
    expect(await ggDealsService.getPrice(2)).toBeNull();
    expect(getPrices).toHaveBeenCalledTimes(1);
    ggDealsService.settingsChanged(); // e.g. a new key: asks again straight away
    await ggDealsService.getPrice(3);
    expect(getPrices).toHaveBeenCalledTimes(2);
  });
});

describe('computePoolNeighborsAsync', () => {
  it('returns exactly what the one-shot version returns', async () => {
    const rand = (() => { let x = 7; return () => (x = (x * 48271) % 2147483647) / 2147483647; })();
    const vec = () => Array.from({ length: 16 }, () => rand() - 0.3);
    const sources = Array.from({ length: 6 }, (_, i) => ({ gameId: `lib-${i}`, vector: vec() }));
    const candidates = Array.from({ length: 300 }, (_, i) => ({ gameId: `c-${i}`, embedding: i % 7 === 0 ? undefined : vec() }));
    const opts = { k: 25, ceiling: 0.9 };
    const sync = computePoolNeighbors(sources, candidates, opts);
    const asyncRes = await computePoolNeighborsAsync(sources, candidates, opts);
    expect(asyncRes.hits).toBe(sync.hits);
    expect(asyncRes.neighbors).toEqual(sync.neighbors);
  });

  it('stops early when the compute was superseded', async () => {
    const res = await computePoolNeighborsAsync(
      [{ gameId: 'a', vector: [1, 0] }, { gameId: 'b', vector: [0, 1] }],
      [{ gameId: 'c', embedding: [1, 0] }],
      { k: 5, ceiling: 1, shouldStop: () => true },
    );
    expect(res.hits).toBe(0);
  });
});

describe('UpcomingSelector (shared by main and renderer)', () => {
  it('keeps reviewed recent releases and the nearest future ones, capped', () => {
    const now = Date.UTC(2026, 9, 15);
    const sec = (ms: number) => Math.floor(ms / 1000);
    const day = 86_400_000;
    const sel = new UpcomingSelector({ fromMs: now - 45 * day, toMs: now + 1000 * day, nowMs: now, minRecentReviews: 20, maxRecent: 1, maxFuture: 2 });
    const rows = [
      { id: 'recent-big', releaseDate: sec(now - 3 * day), reviewCount: 900 },
      { id: 'recent-small', releaseDate: sec(now - 4 * day), reviewCount: 300 },
      { id: 'recent-unreviewed', releaseDate: sec(now - 2 * day), reviewCount: 3 },
      { id: 'future-far', releaseDate: sec(now + 200 * day), reviewCount: 0 },
      { id: 'future-near', releaseDate: sec(now + 5 * day), reviewCount: 0 },
      { id: 'future-mid', releaseDate: sec(now + 50 * day), reviewCount: 0 },
      { id: 'too-old', releaseDate: sec(now - 90 * day), reviewCount: 9000 },
      { id: 'undated', releaseDate: 0, reviewCount: 9000 },
    ];
    rows.forEach((r) => sel.admit(r));
    expect(sel.result().map((r) => r.id)).toEqual(['recent-big', 'future-near', 'future-mid']);
  });
});
