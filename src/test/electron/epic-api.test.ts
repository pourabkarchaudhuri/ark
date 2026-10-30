/**
 * Epic API client: the shared rate limiter really holds MAX_CONCURRENT / spacing, limited
 * catalog crawls never masquerade as the full catalog, stale search results are replaced by
 * a fresh fetch, definitive detail-page misses are remembered, and the Cloudflare solver
 * skips its hidden window when a clearance cookie is already saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cf = vi.hoisted(() => ({
  /** cf_clearance value the session currently holds ('' = none). */
  clearance: '',
  windows: [] as Array<{ options: any; destroy: ReturnType<typeof vi.fn>; destroyed: boolean }>,
  title: 'Epic Games Store',
}));

vi.mock('electron', () => {
  class MockBrowserWindow {
    options: any;
    destroyed = false;
    destroy = vi.fn(() => { this.destroyed = true; });
    private loadHandler: (() => void) | null = null;
    webContents = {
      once: (event: string, cb: () => void) => { if (event === 'did-finish-load') this.loadHandler = cb; },
      getTitle: () => cf.title,
      getURL: () => 'https://store.epicgames.com/en-US/',
    };
    constructor(options: any) {
      this.options = options;
      cf.windows.push(this);
    }
    loadURL() {
      setTimeout(() => this.loadHandler?.(), 500);
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
  }
  const session = {
    defaultSession: {
      cookies: {
        get: vi.fn(async () => (cf.clearance ? [{ name: 'cf_clearance', value: cf.clearance }] : [])),
      },
    },
  };
  const api = { BrowserWindow: MockBrowserWindow, session, net: undefined };
  return { ...api, default: api };
});

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../electron/persistent-cache.js', () => {
  class PersistentCache {
    store = new Map<string, { data: unknown; at: number; ttl: number }>();
    set(key: string, data: unknown, ttl: number) { this.store.set(key, { data, at: Date.now(), ttl }); }
    get<T>(key: string, allowStale = false): T | null {
      const e = this.store.get(key);
      if (!e) return null;
      if (Date.now() - e.at <= e.ttl || allowStale) return e.data as T;
      return null;
    }
    isStale(key: string) {
      const e = this.store.get(key);
      return !e || Date.now() - e.at > e.ttl;
    }
    clear() { this.store.clear(); }
    getStats() { return { total: this.store.size, fresh: 0, stale: 0 }; }
    flushSync() {}
  }
  return { PersistentCache };
});

import { EpicAPIClient, RateLimiter } from '../../../electron/epic-api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const item = (i: number) => ({ namespace: 'ns', id: `o${i}`, title: `Game ${i}`, description: 'desc' });

type Handler = (url: string, body: any) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    handler(String(url), init?.body ? JSON.parse(String(init.body)) : undefined));
  vi.stubGlobal('fetch', fetchMock);
}

/** Resolve a promise while driving fake timers (rate-limiter spacing, solver polling). */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.finally(() => { done = true; }).catch(() => {});
  for (let i = 0; i < 500 && !done; i++) await vi.advanceTimersByTimeAsync(300);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  cf.clearance = '';
  cf.windows.length = 0;
  cf.title = 'Epic Games Store';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RateLimiter', () => {
  it('releases at most 2 at a time, at least 300ms apart, from one pending timer', async () => {
    const rl = new RateLimiter();
    const grants: number[] = [];
    let active = 0;
    let peak = 0;
    const work = Array.from({ length: 8 }, () =>
      rl.acquire().then(async () => {
        grants.push(Date.now());
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1000));
        active--;
        rl.release();
      }));
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(work);
    expect(grants).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(2);
    for (let i = 1; i < grants.length; i++) expect(grants[i] - grants[i - 1]).toBeGreaterThanOrEqual(300);
  });

  it('keeps a single timer armed however many acquire/release calls pile up', async () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 8; i++) void rl.acquire();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0); // first grant, next one armed 300ms out
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300); // second grant — cap reached, nothing armed
    expect(vi.getTimerCount()).toBe(0);
    rl.release();
    rl.release();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('browseCatalog cache keys', () => {
  const TOTAL = 200;
  beforeEach(() => {
    mockFetch((url, body) => {
      if (url.includes('graphql')) {
        const start = body.variables.start as number;
        const count = body.variables.count as number;
        const elements = Array.from({ length: Math.max(0, Math.min(count, TOTAL - start)) }, (_, k) => item(start + k));
        return json({ data: { Catalog: { searchStore: { elements, paging: { count, total: TOTAL } } } } });
      }
      return json({ data: { Catalog: { searchStore: { elements: [] } } } });
    });
  });

  it('a limited crawl is not served as the full catalog afterwards', async () => {
    const c = new EpicAPIClient();
    const limited = await drive(c.browseCatalog(99));
    expect(limited).toHaveLength(99);
    const full = await drive(c.browseCatalog(0));
    expect(full).toHaveLength(TOTAL);
  });

  it('a limited call slices a cached full catalog without crawling', async () => {
    const c = new EpicAPIClient();
    expect(await drive(c.browseCatalog(0))).toHaveLength(TOTAL);
    const calls = fetchMock.mock.calls.length;
    const limited = await drive(c.browseCatalog(99));
    expect(limited).toHaveLength(99);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

describe('searchGames', () => {
  it('returns the fresh results after refetching a stale entry', async () => {
    let title = 'Old';
    mockFetch((url) => {
      if (url.includes('graphql')) {
        return json({ data: { Catalog: { searchStore: { elements: [{ ...item(1), title }] } } } });
      }
      return json({});
    });
    const c = new EpicAPIClient();
    expect((await drive(c.searchGames('hades')))[0].title).toBe('Old');
    vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10 min search TTL
    title = 'New';
    expect((await drive(c.searchGames('hades')))[0].title).toBe('New');
  });
});

describe('detail-page miss caching', () => {
  it('remembers a definitive reviews miss (all SKUs 404, OpenCritic empty)', async () => {
    mockFetch((url) => {
      if (url.includes('productReviews')) return new Response('', { status: 404 });
      if (url.includes('graphql')) return json({ data: { OpenCritic: { productReviews: null } } });
      return json({});
    });
    const c = new EpicAPIClient();
    expect(await drive(c.getProductReviews('some-game'))).toBeNull();
    const calls = fetchMock.mock.calls.length;
    expect(await drive(c.getProductReviews('some-game'))).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('does not remember a miss caused by a 429', async () => {
    mockFetch((url) => {
      if (url.includes('productReviews')) return new Response('', { status: 429 });
      if (url.includes('graphql')) return json({ data: { OpenCritic: { productReviews: null } } });
      return json({});
    });
    const c = new EpicAPIClient();
    await drive(c.getProductReviews('some-game'));
    const calls = fetchMock.mock.calls.length;
    await drive(c.getProductReviews('some-game'));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('remembers a 404 product page and an empty addon list', async () => {
    mockFetch((url) => {
      if (url.includes('content/products')) return new Response('', { status: 404 });
      if (url.includes('graphql')) return json({ data: { Catalog: { searchStore: { elements: [], paging: { count: 0, total: 0 } } } } });
      return json({});
    });
    const c = new EpicAPIClient();
    expect(await drive(c.getProductContent('nope'))).toBeNull();
    expect(await drive(c.getAddons('ns'))).toEqual([]);
    const calls = fetchMock.mock.calls.length;
    await drive(c.getProductContent('nope'));
    await drive(c.getAddons('ns'));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

describe('Cloudflare solver', () => {
  it('uses a saved cf_clearance cookie without opening a window', async () => {
    cf.clearance = 'saved';
    const c = new EpicAPIClient();
    expect(await c.initCloudflare()).toBe(true);
    expect(cf.windows).toHaveLength(0);
  });

  it('closes the hidden window within ~5s when the page shows no challenge', async () => {
    const c = new EpicAPIClient();
    const p = c.initCloudflare();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cf.windows).toHaveLength(1);
    expect(cf.windows[0].destroy).toHaveBeenCalled();
    expect(cf.windows[0].options.webPreferences).toMatchObject({ images: false, backgroundThrottling: true });
    expect(await p).toBe(false);
  });

  it('a 403 starts the solver once and only a new clearance value counts as solved', async () => {
    cf.clearance = 'rejected';
    cf.title = 'Just a moment...';
    mockFetch((url) => (url.includes('graphql') ? new Response('', { status: 403 }) : json({})));
    const c = new EpicAPIClient();
    await drive(c.searchGames('a')); // 403 → circuit open
    expect(c.isEpicBlocked()).toBe(true);
    void c.searchGames('b'); // circuit open → solver kicked off
    void c.searchGames('c'); // solver already running
    await vi.advanceTimersByTimeAsync(4500);
    expect(cf.windows).toHaveLength(1);
    expect(cf.windows[0].destroyed).toBe(false); // challenge page: keeps waiting, old cookie ignored
    cf.clearance = 'fresh';
    await vi.advanceTimersByTimeAsync(1500);
    expect(cf.windows[0].destroyed).toBe(true);
    expect(c.isEpicBlocked()).toBe(false);
  });
});
