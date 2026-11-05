/**
 * Web search (DuckDuckGo HTML): body decoding across socket chunks, and per-result parsing so a
 * missing snippet or a malformed redirect URL never misattributes or drops the other results.
 * Pre-pass (main-apis#50): only explicit freshness intents trigger a search, the search has an
 * overall deadline, and results are cached per query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createBodyCollector,
  parseDDGHtml,
  needsWebSearch,
  webSearch,
  __setWebSearchFetchForTests,
  __clearWebSearchCacheForTests,
  webSearchOutcome,
  WEB_SEARCH_DEADLINE_MS,
} from '../../../electron/web-search';

describe('createBodyCollector', () => {
  it('keeps a multi-byte character that straddles two chunks intact', () => {
    const bytes = Buffer.from('Pokémon 原神 review', 'utf8');
    const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // inside the 2-byte é
    const body = createBodyCollector(1024);
    expect(body.push(bytes.subarray(0, cut))).toBe(true);
    // The CJK characters are split too.
    const cjk = bytes.indexOf(Buffer.from('原', 'utf8')) + 2;
    expect(body.push(bytes.subarray(cut, cjk))).toBe(true);
    expect(body.push(bytes.subarray(cjk))).toBe(true);
    expect(body.text()).toBe('Pokémon 原神 review');
  });

  it('reports when the byte limit is exceeded', () => {
    const body = createBodyCollector(4);
    expect(body.push(Buffer.from('abc'))).toBe(true);
    expect(body.push(Buffer.from('de'))).toBe(false);
  });
});

/** Trimmed copy of DuckDuckGo's HTML results markup (one ad, one result without a snippet). */
const DDG_FIXTURE = `
<div class="result results_links results_links_deep result--ad ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;u3=x">Buy <b>Hades</b> cheap</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?u3=x">Sponsored deal</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstore.steampowered.com%2Fapp%2F1145360%2F&amp;rut=abc"><b>Hades</b> on
      Steam</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Defy the god of the dead as you hack and slash out of the <b>Underworld</b>.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fno-snippet&amp;rut=def">Hades wiki</a></h2>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.example%2F%E0%A4%A&amp;rut=ghi">Broken escape</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=y">Snippet for the broken one</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.metacritic.com%2Fgame%2Fhades%2F&amp;rut=jkl">Hades Reviews - Metacritic</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=z">Metascore 93.</a>
  </div>
</div>
`;

describe('parseDDGHtml', () => {
  it('pairs each snippet with its own result, skips ads, and survives a malformed URL', () => {
    const results = parseDDGHtml(DDG_FIXTURE);
    expect(results).toEqual([
      {
        title: 'Hades on Steam',
        url: 'https://store.steampowered.com/app/1145360/',
        description: 'Defy the god of the dead as you hack and slash out of the Underworld.',
      },
      { title: 'Hades wiki', url: 'https://example.com/no-snippet', description: '' },
      {
        title: 'Broken escape',
        url: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.example%2F%E0%A4%A&amp;rut=ghi',
        description: 'Snippet for the broken one',
      },
      { title: 'Hades Reviews - Metacritic', url: 'https://www.metacritic.com/game/hades/', description: 'Metascore 93.' },
    ]);
  });

  it('returns nothing for a page without results', () => {
    expect(parseDDGHtml('<html><body>No results.</body></html>')).toEqual([]);
  });
});

const DDG_HTML =
  '<a rel="nofollow" class="result__a" href="https://example.com/a">Hades <b>patch</b></a>' +
  '<a class="result__snippet" href="x">Patch notes for <b>Hades</b></a>';

beforeEach(() => {
  __clearWebSearchCacheForTests();
  __setWebSearchFetchForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __setWebSearchFetchForTests();
});

describe('needsWebSearch', () => {
  it('ignores generic words that used to trigger a search', () => {
    for (const q of [
      'games like Hades',
      'any new roguelikes?',
      'is Hades free',
      'Hades review',
      'is it worth it',
      'best mod for Skyrim',
      'who won the fight in chapter 3',
      'current objective in Elden Ring',
      'something like Hades but slower',
      'when is the boss fight',
      'where can I find the key',
      'what event happens after the bridge',
      'did the update break saves',
    ]) {
      expect(needsWebSearch(q), q).toBe(false);
    }
  });

  it('keeps explicit freshness intents', () => {
    for (const q of [
      'latest patch notes for Hades II',
      'search for Hollow Knight Silksong news',
      'what is the release date of GTA 6',
      'price of Elden Ring',
      'any news on Silksong',
      'Hades II patch notes',
    ]) {
      expect(needsWebSearch(q), q).toBe(true);
    }
  });
});

describe('webSearch', () => {
  it('returns [] once the overall deadline passes and aborts the request', async () => {
    vi.useFakeTimers();
    let aborted = false;
    __setWebSearchFetchForTests((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }));
    const p = webSearch('slow query', 5);
    await vi.advanceTimersByTimeAsync(WEB_SEARCH_DEADLINE_MS + 10);
    await expect(p).resolves.toEqual([]);
    expect(aborted).toBe(true);
    expect(WEB_SEARCH_DEADLINE_MS).toBeLessThanOrEqual(3000);
  });

  it('caches results per query for a few minutes', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, data: DDG_HTML }));
    __setWebSearchFetchForTests(fetchFn);
    const a = await webSearch('Hades patch', 5);
    const b = await webSearch('  hades PATCH ', 5);
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 200, data: DDG_HTML });
    __setWebSearchFetchForTests(fetchFn);
    expect(await webSearch('q', 5)).toEqual([]);
    expect(await webSearch('q', 5)).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('default transport (1.0.98 F4: shared network helper, not node:https)', () => {
  const setTransport = async (fn?: (url: string, init: RequestInit) => Promise<Response>) => {
    const m = await import('../../../electron/net-fetch');
    m.__setNetFetchTransportForTests(fn);
  };
  beforeEach(() => { __setWebSearchFetchForTests(); __clearWebSearchCacheForTests(); });
  afterEach(async () => { await setTransport(); __clearWebSearchCacheForTests(); });

  it('searches through net-fetch with a POST and parses the page', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await setTransport(async (url, init) => {
      seen = { url, init };
      const r = new Response(DDG_HTML, { status: 200 });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    });
    const out = await webSearchOutcome('hades patch', 5, 1000);
    expect(out.error).toBeUndefined();
    expect(out.results).toHaveLength(1);
    expect(seen!.url).toBe('https://html.duckduckgo.com/html/');
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.redirect).toBe('follow');
    expect(seen!.init.body).toBe('q=hades%20patch');
  });

  it('reports "could not search" (not "no results") when the network or certificate fails', async () => {
    await setTransport(async () => { throw new TypeError('fetch failed: SELF_SIGNED_CERT_IN_CHAIN'); });
    const out = await webSearchOutcome('hades patch', 5, 1000);
    expect(out.results).toEqual([]);
    expect(out.error).toMatch(/SELF_SIGNED_CERT_IN_CHAIN/);
    expect(await webSearch('hades patch', 5, 1000)).toEqual([]);
  });

  it('blocks a redirect that ended on a non-HTTPS URL', async () => {
    await setTransport(async () => {
      const r = new Response(DDG_HTML, { status: 200 });
      Object.defineProperty(r, 'url', { value: 'http://evil.example/' });
      return r;
    });
    const out = await webSearchOutcome('x', 5, 1000);
    expect(out.results).toEqual([]);
    expect(out.error).toMatch(/non-HTTPS/);
  });

  it('cuts off an oversized body', async () => {
    await setTransport(async (url) => {
      const r = new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    });
    const out = await webSearchOutcome('big', 5, 1000);
    expect(out.error).toMatch(/exceeded/);
  });

  it('a non-200 answer is an error, an empty 200 page is just no results', async () => {
    await setTransport(async (url) => { const r = new Response('', { status: 503 }); Object.defineProperty(r, 'url', { value: url }); return r; });
    expect((await webSearchOutcome('a', 5, 1000)).error).toMatch(/503/);
    await setTransport(async (url) => { const r = new Response('<html></html>', { status: 200 }); Object.defineProperty(r, 'url', { value: url }); return r; });
    expect(await webSearchOutcome('b', 5, 1000)).toEqual({ results: [] });
  });
});
