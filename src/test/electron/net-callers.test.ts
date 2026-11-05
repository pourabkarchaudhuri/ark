/**
 * 1.0.98 F4: the main-process callers that used Node fetch / https, or cleared their timeout before the
 * body was read, now go through the shared network helper. A host that sends headers and stalls must not
 * hang the caller, and a TLS failure must surface instead of being swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: { getAnalyticsEnabled: () => true, setAnalyticsEnabled: () => {}, getAzureOpenAIKey: () => 'k' },
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: null } }));

import { __setNetFetchTransportForTests } from '../../../electron/net-fetch';
import { fetchRssFeeds } from '../../../electron/ipc/rss-handlers';
import { fetchLatestGitHubRelease } from '../../../electron/auto-updater';
import { trackEvent, __setAnalyticsDepsForTests } from '../../../electron/analytics';
import { testAzureConnection } from '../../../electron/ipc/settings-handlers';

/** Headers arrive, the body never finishes (until the request is aborted). */
function stalledBody(init: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('<rss>')); },
    pull() {
      return new Promise<void>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { __setNetFetchTransportForTests(); vi.useRealTimers(); });

describe('RSS feeds', () => {
  it('a feed that stalls mid-body is cut off and the other feeds still come back', async () => {
    const rss = `<rss><channel><item><title>Hello</title><link>https://good.example/a</link><description>d</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`;
    __setNetFetchTransportForTests(async (url, init) => (url.includes('stall') ? stalledBody(init) : new Response(rss, { status: 200 })));
    const p = fetchRssFeeds([
      { url: 'https://stall.example/feed', source: 'Stall' },
      { url: 'https://good.example/feed', source: 'Good' },
    ]);
    await vi.advanceTimersByTimeAsync(15_100);
    const items = await p;
    expect(items.map((i) => i.source)).toEqual(['Good']);
  });
});

describe('GitHub release fallback', () => {
  it('reads the release through the shared helper', async () => {
    let seen = '';
    __setNetFetchTransportForTests(async (url) => { seen = url; return new Response(JSON.stringify({ tag_name: 'v1.2.3', html_url: 'https://github.com/x/y/releases/tag/v1.2.3' }), { status: 200 }); });
    expect(await fetchLatestGitHubRelease()).toEqual({ tag: '1.2.3', url: 'https://github.com/x/y/releases/tag/v1.2.3' });
    expect(seen).toContain('api.github.com');
  });

  it('gives up (null) instead of hanging when the JSON body stalls', async () => {
    __setNetFetchTransportForTests(async (_u, init) => stalledBody(init));
    const p = fetchLatestGitHubRelease();
    await vi.advanceTimersByTimeAsync(15_100);
    expect(await p).toBeNull();
  });
});

describe('analytics POST', () => {
  it('is aborted after its deadline and never throws into the caller', async () => {
    process.env.GA_MEASUREMENT_ID = 'G-T';
    process.env.GA_API_SECRET = 's';
    __setAnalyticsDepsForTests({ isEnabled: () => true, userDataDir: () => process.env.TEMP ?? '.', appVersion: () => '1' });
    let aborted = false;
    __setNetFetchTransportForTests((_u, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true });
    }));
    const p = trackEvent('app_launch');
    await vi.advanceTimersByTimeAsync(10_100);
    await expect(p).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });
});

describe('Azure "Test connection"', () => {
  it('uses the shared helper and reports a stalled endpoint instead of spinning forever', async () => {
    __setNetFetchTransportForTests((_u, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const p = testAzureConnection({ endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '' });
    await vi.advanceTimersByTimeAsync(30_100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/timed out/);
  });

  it('succeeds through the helper', async () => {
    __setNetFetchTransportForTests(async () => new Response('{}', { status: 200 }));
    expect((await testAzureConnection({ endpoint: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '' })).ok).toBe(true);
  });
});
