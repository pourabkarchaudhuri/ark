/**
 * egdata:getTopSellers: 15 min cache of non-empty results, one shared in-flight fetch,
 * partial results when a page fails, and the non-200 body is drained.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** page → status (200 default) or 'empty' for an empty element list */
  pageStatus: new Map<number, number | 'empty'>(),
  requests: [] as number[],
  resumed: 0,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(ch, fn)) },
}));

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../electron/egdata-api.js', () => ({
  egdataAPI: { getTopSellersPaginated: vi.fn(async () => ({ elements: [], total: 0 })) },
}));

import { __setNetFetchTransportForTests } from '../../../electron/net-fetch';

/** Fake network: one response per requested page; a non-200 page has a body whose release is counted. */
function installTransport(): void {
  __setNetFetchTransportForTests(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    h.requests.push(page);
    await new Promise((r) => setTimeout(r, 0));
    const status = h.pageStatus.get(page) ?? 200;
    if (status !== 200 && status !== 'empty') {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('boom')); }, cancel() { h.resumed++; } });
      return new Response(body, { status });
    }
    const elements = status === 'empty' ? [] : Array.from({ length: 10 }, (_, i) => {
      const pos = (page - 1) * 10 + i + 1;
      return { id: `o${pos}`, namespace: 'ns', position: pos };
    });
    return new Response(JSON.stringify({ elements, total: 99 }), { status: 200 });
  });
}

import { register, resetTopSellersCache } from '../../../electron/ipc/egdata-handlers';

register();
const getTopSellers = (limit?: number, skip?: number) =>
  h.handlers.get('egdata:getTopSellers')!({}, limit, skip) as Promise<{ elements: Array<{ id: string }>; total: number }>;

beforeEach(() => {
  resetTopSellersCache();
  h.pageStatus.clear();
  h.requests.length = 0;
  h.resumed = 0;
  installTransport();
  // Nothing may reach the real network
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});

describe('egdata:getTopSellers', () => {
  it('serves a second call within the TTL from cache', async () => {
    const first = await getTopSellers(99, 0);
    expect(first.elements).toHaveLength(99);
    expect(h.requests).toHaveLength(10);
    const second = await getTopSellers(99, 0);
    expect(second.elements).toHaveLength(99);
    expect(h.requests).toHaveLength(10);
  });

  it('concurrent calls share one fetch', async () => {
    const [a, b] = await Promise.all([getTopSellers(), getTopSellers()]);
    expect(a.elements).toHaveLength(99);
    expect(b.elements).toHaveLength(99);
    expect(h.requests).toHaveLength(10);
  });

  it('a failing page keeps the other nine and drains the error body', async () => {
    h.pageStatus.set(4, 500);
    const res = await getTopSellers();
    expect(res.elements).toHaveLength(90);
    expect(res.elements.map((e) => e.id)).not.toContain('o31');
    expect(res.elements[0].id).toBe('o1');
    expect(h.resumed).toBe(1);
  });

  it('does not cache an empty result', async () => {
    for (let p = 1; p <= 10; p++) h.pageStatus.set(p, 'empty');
    expect((await getTopSellers()).elements).toHaveLength(0);
    h.pageStatus.clear();
    expect((await getTopSellers()).elements).toHaveLength(99);
  });

  it('applies limit and skip to the cached list', async () => {
    const res = await getTopSellers(5, 10);
    expect(res.elements.map((e) => e.id)).toEqual(['o11', 'o12', 'o13', 'o14', 'o15']);
  });
});
