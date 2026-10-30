/**
 * Metacritic scraper (main process): negative caching only for real misses, 'game/' first with the
 * legacy platform pages probed in parallel, in-flight dedupe, and a bounded in-memory cache.
 * The network and clock go through __setMetacriticDepsForTests (no real requests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchMetacriticReviews, __setMetacriticDepsForTests } from '../../../electron/metacritic-api';

/** A game page big enough to count as real, with a Metascore in JSON-LD. */
function page(name: string, score: number): string {
  const ld = JSON.stringify({ name, aggregateRating: { ratingValue: String(score) } });
  return `<html><head><script type="application/ld+json">${ld}</script></head><body>${'x'.repeat(1200)}</body></html>`;
}

type Handler = (url: string) => Response | Promise<Response>;

let now = 1_000_000;
let calls: string[] = [];

function install(handler: Handler) {
  calls = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return handler(u);
  });
  __setMetacriticDepsForTests({ fetch: () => fetch as unknown as typeof globalThis.fetch, now: () => now });
  return fetch;
}

const notFound = () => new Response('nope', { status: 404 });

beforeEach(() => { now = 1_000_000; });
afterEach(() => { __setMetacriticDepsForTests(); });

describe('fetchMetacriticReviews caching', () => {
  it('a miss where every page answered 404 is cached for an hour', async () => {
    install(notFound);
    expect(await fetchMetacriticReviews('Hades')).toBeNull();
    const first = calls.length;
    expect(first).toBe(6); // game/ + 4 legacy prefixes + search
    now += 59 * 60 * 1000;
    expect(await fetchMetacriticReviews('Hades')).toBeNull();
    expect(calls.length).toBe(first);
    now += 2 * 60 * 1000;
    await fetchMetacriticReviews('Hades');
    expect(calls.length).toBe(first * 2);
  });

  it('a 429 is not remembered as "no data" for an hour (short negative TTL only)', async () => {
    install(() => new Response('slow down', { status: 429 }));
    expect(await fetchMetacriticReviews('Hades')).toBeNull();
    const first = calls.length;
    now += 30 * 1000;
    await fetchMetacriticReviews('Hades');
    expect(calls.length).toBe(first); // brief negative cache
    now += 4 * 60 * 1000;
    await fetchMetacriticReviews('Hades');
    expect(calls.length).toBe(first * 2);
  });

  it('a timeout / network failure is also only cached briefly, and a later success is returned', async () => {
    let fail = true;
    install((url) => {
      if (fail) throw new DOMException('aborted', 'AbortError');
      return url.endsWith('/game/hades/') ? new Response(page('Hades', 93)) : notFound();
    });
    expect(await fetchMetacriticReviews('Hades')).toBeNull();
    fail = false;
    now += 4 * 60 * 1000;
    expect((await fetchMetacriticReviews('Hades'))?.score).toBe(93);
  });
});

describe('fetchMetacriticReviews probing', () => {
  it("a 'game/' hit costs one request", async () => {
    install((url) => (url === 'https://www.metacritic.com/game/hades/' ? new Response(page('Hades', 93)) : notFound()));
    const r = await fetchMetacriticReviews('Hades');
    expect(r?.score).toBe(93);
    expect(calls).toEqual(['https://www.metacritic.com/game/hades/']);
  });

  it('legacy prefixes run in parallel after a miss, and the first hit in priority order wins', async () => {
    const resolvers: Array<() => void> = [];
    install((url) => {
      if (url === 'https://www.metacritic.com/game/pc/hades/') {
        // Slowest answer, but highest priority among the legacy pages.
        return new Promise<Response>((resolve) => resolvers.push(() => resolve(new Response(page('Hades PC', 90)))));
      }
      if (url === 'https://www.metacritic.com/game/playstation-5/hades/') return new Response(page('Hades PS5', 80));
      return notFound();
    });
    const p = fetchMetacriticReviews('Hades');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    // All four legacy prefixes were requested before the slow one answered.
    expect(calls.filter((u) => /\/game\/[a-z0-9-]+\/hades\/$/.test(u))).toHaveLength(4);
    resolvers[0]();
    expect((await p)?.title).toBe('Hades PC');
  });

  it('two concurrent calls for one title run one cascade', async () => {
    install(notFound);
    const [a, b] = await Promise.all([fetchMetacriticReviews('Hades'), fetchMetacriticReviews('  hades ')]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(calls).toHaveLength(6);
  });

  it('the in-memory cache stays bounded (oldest entries are evicted)', async () => {
    install((url) => new Response(page(url, 70)));
    for (let i = 0; i < 250; i++) await fetchMetacriticReviews(`Game ${i}`);
    const before = calls.length;
    await fetchMetacriticReviews('Game 249'); // recent: still cached
    expect(calls.length).toBe(before);
    await fetchMetacriticReviews('Game 0'); // oldest: evicted past 200 entries
    expect(calls.length).toBe(before + 1);
  });
});
