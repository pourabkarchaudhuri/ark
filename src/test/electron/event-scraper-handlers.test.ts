/**
 * events:scrapeAll (1.0.97 B06): only main's own GAMING_EVENTS URLs are fetched (no
 * renderer-supplied localhost/LAN URLs, no redirects off the event hosts), and failed fetches
 * are never cached as fresh — offline writes nothing, a failed page keeps the previous good
 * entry, and new / changed / failed ids trigger a refresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  handleScrapeAll,
  sanitizeEventRequest,
  isAllowedEventHost,
  allowedEvents,
  __setEventScraperDepsForTests,
  type EventCache,
} from '../../../electron/ipc/event-scraper-handlers';
import { GAMING_EVENTS } from '@/data/gaming-events';

const DAY = 24 * 60 * 60 * 1000;
const LEGIT = GAMING_EVENTS.filter((e) => e.url).map((e) => ({ id: e.id, url: e.url! }));
const [CES, SGF] = LEGIT;

function page(url: string, body = '<html><body>June 5, 2099</body></html>', status = 200, finalUrl = url): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, 'url', { value: finalUrl });
  return res;
}

function setup(opts: { cache?: EventCache | null; fetch?: (url: string) => Promise<Response> } = {}) {
  let now = 1_800_000_000_000;
  let stored: EventCache | null = opts.cache ?? null;
  const writes: EventCache[] = [];
  const fetch = vi.fn(async (url: string, _init: RequestInit) => (opts.fetch ? opts.fetch(url) : page(url)));
  __setEventScraperDepsForTests({
    fetch,
    readCache: () => (stored ? structuredClone(stored) : null),
    writeCache: (c) => { stored = structuredClone(c); writes.push(c); },
    now: () => now,
  });
  return { fetch, writes, getStored: () => stored, advance: (ms: number) => { now += ms; }, now: () => now };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { __setEventScraperDepsForTests(); });
afterEach(() => { __setEventScraperDepsForTests(); });

describe('request allow-list', () => {
  it('drops localhost, LAN, unknown ids, __proto__ and URL mismatches without fetching', async () => {
    const { fetch } = setup();
    const out = await handleScrapeAll([
      { id: 'ces', url: 'http://127.0.0.1:8080/admin' },
      { id: 'intranet', url: 'http://10.0.0.5/' },
      { id: '__proto__', url: CES.url },
      { id: 'CES', url: CES.url },
      { id: 'summer-game-fest', url: 'https://www.summergamefest.com/?x=1' },
    ]);
    expect(out).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes to main\'s exact URL, dedupes, and caps at the list length', () => {
    const many = Array.from({ length: GAMING_EVENTS.length + 20 }, () => ({ id: CES.id, url: CES.url }));
    expect(sanitizeEventRequest(many)).toEqual([CES]);
    expect(sanitizeEventRequest('nope')).toEqual([]);
    expect(sanitizeEventRequest([null, 5, { id: 5 }])).toEqual([]);
    expect(sanitizeEventRequest(LEGIT)).toEqual(LEGIT);
  });

  it('host check accepts event hosts only', () => {
    expect(isAllowedEventHost(CES.url)).toBe(true);
    expect(isAllowedEventHost('https://ces.tech/schedule')).toBe(true);
    expect(isAllowedEventHost('http://192.168.1.1/')).toBe(false);
    expect(isAllowedEventHost('file:///C:/x')).toBe(false);
  });

  it('a legit request scrapes main\'s whole list with credentials omitted', async () => {
    const { fetch, writes } = setup();
    const out = await handleScrapeAll([CES]);
    expect(out[CES.id]?.url).toBe(CES.url);
    expect(fetch).toHaveBeenCalledTimes(allowedEvents().length);
    expect(fetch.mock.calls.every(([, init]) => init.credentials === 'omit')).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('a redirect to a LAN host is not read', async () => {
    setup({ fetch: async (url) => page(url, '<p>June 5, 2099</p>', 200, url === CES.url ? 'http://192.168.0.10/' : url) });
    const out = await handleScrapeAll([CES]);
    expect(out[CES.id]?.failed).toBe(true);
    expect(out[SGF.id]?.failed).toBeUndefined();
  });
});

describe('failed fetches are not cached as fresh', () => {
  it('offline cold start writes nothing; the next online call scrapes again', async () => {
    let online = false;
    const s = setup({ fetch: async (url) => { if (!online) throw new Error('offline'); return page(url); } });
    await handleScrapeAll([CES]);
    expect(s.writes).toHaveLength(0);
    online = true;
    const out = await handleScrapeAll([CES]);
    expect(s.writes).toHaveLength(1);
    expect(out[CES.id]?.failed).toBeUndefined();
  });

  it('a partial failure keeps the previous good entry for that id', async () => {
    const t = 1_800_000_000_000;
    const good = { id: CES.id, url: CES.url, startDate: 123, youtubeUrls: ['https://youtube.com/x'], twitchUrls: [], scrapedAt: t - 2 * DAY };
    const s = setup({
      cache: { events: { [CES.id]: good }, updatedAt: t - 2 * DAY },
      fetch: async (url) => (url === CES.url ? page(url, '', 503) : page(url)),
    });
    // Stale cache → served at once, background refresh started.
    const served = await handleScrapeAll([CES, SGF]);
    expect(served[CES.id]).toEqual(good);
    await vi.waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.getStored()!.events[CES.id]).toEqual(good);
    expect(s.getStored()!.events[SGF.id]?.url).toBe(SGF.url);
  });

  it('a requested id missing from a fresh cache triggers a background scrape', async () => {
    const t = 1_800_000_000_000;
    const s = setup({
      cache: { events: { [CES.id]: { id: CES.id, url: CES.url, youtubeUrls: [], twitchUrls: [], scrapedAt: t } }, updatedAt: t },
    });
    await handleScrapeAll([CES, SGF]);
    await vi.waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.getStored()!.events[SGF.id]).toBeDefined();
  });

  it('a cached entry scraped from a different URL is stale', async () => {
    const t = 1_800_000_000_000;
    const s = setup({
      cache: { events: { [CES.id]: { id: CES.id, url: 'https://old.example/', youtubeUrls: [], twitchUrls: [], scrapedAt: t } }, updatedAt: t },
    });
    await handleScrapeAll([CES]);
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalled());
  });

  it('a failed entry is retried after ~10 min, not served as fresh for 24 h', async () => {
    const t = 1_800_000_000_000;
    const failed = { id: CES.id, url: CES.url, youtubeUrls: [], twitchUrls: [], scrapedAt: t, failed: true };
    const s = setup({ cache: { events: { [CES.id]: failed }, updatedAt: t } });
    await handleScrapeAll([CES]);
    await flush();
    expect(s.fetch).not.toHaveBeenCalled(); // just failed — not hammered
    s.advance(11 * 60 * 1000);
    await handleScrapeAll([CES]);
    await vi.waitFor(() => expect(s.fetch).toHaveBeenCalled());
  });

  it('a fresh, complete cache is served without fetching', async () => {
    const t = 1_800_000_000_000;
    const events = Object.fromEntries(LEGIT.map((e) => [e.id, { id: e.id, url: e.url, youtubeUrls: [], twitchUrls: [], scrapedAt: t }]));
    const s = setup({ cache: { events, updatedAt: t } });
    expect(await handleScrapeAll(LEGIT)).toEqual(events);
    await flush();
    expect(s.fetch).not.toHaveBeenCalled();
  });
});
