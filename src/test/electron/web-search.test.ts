/**
 * Web search (DuckDuckGo HTML): body decoding across socket chunks, and per-result parsing so a
 * missing snippet or a malformed redirect URL never misattributes or drops the other results.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createBodyCollector, parseDDGHtml } from '../../../electron/web-search';

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
