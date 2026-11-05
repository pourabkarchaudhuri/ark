/**
 * Shared network helper (1.0.98 F4): the deadline covers the body read, a quit or caller abort cuts the
 * request, keep-alive touches while a response is open, and the global-fetch bridge is a no-op outside Electron.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  netFetch,
  makeNetFetch,
  withKeepAlive,
  bridgeGlobalFetchForHosts,
  __setNetFetchTransportForTests,
} from '../../../electron/net-fetch';

/** A response whose body sends one chunk, then never ends (until the request is aborted). */
function stallingTransport(): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"a":')); },
      pull() {
        return new Promise<void>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      },
    });
    return new Response(body, { status: 200 });
  };
}

afterEach(() => {
  __setNetFetchTransportForTests();
  vi.useRealTimers();
});

describe('netFetch', () => {
  it('returns the body when the host answers in time', async () => {
    __setNetFetchTransportForTests(async () => new Response('{"ok":true}', { status: 200 }));
    const res = await netFetch('https://example.com/x', {}, { timeoutMs: 1000 });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps the deadline armed through the body read (headers arrive, body stalls)', async () => {
    __setNetFetchTransportForTests(stallingTransport());
    const res = await netFetch('https://example.com/x', {}, { timeoutMs: 40 });
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow(/timed out after 40 ms/);
  });

  it('rejects with the timeout when the host never answers', async () => {
    __setNetFetchTransportForTests((_u, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(netFetch('https://example.com/x', {}, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it('aborts when the caller signal aborts, in opts or in init', async () => {
    __setNetFetchTransportForTests(stallingTransport());
    const a = new AbortController();
    const res = await netFetch('https://example.com/x', {}, { timeoutMs: 0, signal: a.signal });
    const pending = res.text();
    a.abort(new Error('caller left'));
    await expect(pending).rejects.toThrow('caller left');

    const b = new AbortController();
    b.abort(new Error('already gone'));
    await expect(netFetch('https://example.com/x', { signal: b.signal })).rejects.toThrow('already gone');
  });

  it('does not leave a timer behind once the body is read', async () => {
    vi.useFakeTimers();
    __setNetFetchTransportForTests(async () => new Response('hi', { status: 200 }));
    const res = await netFetch('https://example.com/x', {}, { timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(1);
    await res.text();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling the body also releases the timer', async () => {
    vi.useFakeTimers();
    __setNetFetchTransportForTests(async () => new Response('hi', { status: 200 }));
    const res = await netFetch('https://example.com/x', {}, { timeoutMs: 5000 });
    await res.body!.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps url and status of the original response', async () => {
    __setNetFetchTransportForTests(async () => {
      const r = new Response('x', { status: 201 });
      Object.defineProperty(r, 'url', { value: 'https://example.com/final' });
      return r;
    });
    const res = await netFetch('https://example.com/x');
    expect(res.url).toBe('https://example.com/final');
    expect(res.status).toBe(201);
  });
});

describe('makeNetFetch', () => {
  it('works as a drop-in fetch for SDKs', async () => {
    const seen: string[] = [];
    __setNetFetchTransportForTests(async (url) => { seen.push(url); return new Response('ok'); });
    const f = makeNetFetch({ timeoutMs: 1000 });
    expect(await (await f('https://example.com/v1', { method: 'POST' })).text()).toBe('ok');
    expect(await (await f(new URL('https://example.com/v2'))).text()).toBe('ok');
    expect(seen).toEqual(['https://example.com/v1', 'https://example.com/v2']);
  });
});

describe('withKeepAlive', () => {
  it('touches at start, while the body is open and at the end', async () => {
    vi.useFakeTimers();
    const touch = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = (async () => new Response(new ReadableStream({
      async pull(c) { await gate; c.enqueue(new TextEncoder().encode('done')); c.close(); },
    }))) as unknown as typeof fetch;
    const res = await withKeepAlive(base, touch, 1000)('http://127.0.0.1:1/v1/chat');
    expect(touch).toHaveBeenCalledTimes(1);
    const reading = res.text();
    await vi.advanceTimersByTimeAsync(3500);
    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(4); // start + 3 ticks
    release();
    expect(await reading).toBe('done');
    const after = touch.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(touch.mock.calls.length).toBe(after);
  });

  it('stops touching when the request fails', async () => {
    vi.useFakeTimers();
    const touch = vi.fn();
    const base = (async () => { throw new Error('refused'); }) as unknown as typeof fetch;
    await expect(withKeepAlive(base, touch, 1000)('http://127.0.0.1:1')).rejects.toThrow('refused');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('bridgeGlobalFetchForHosts', () => {
  it('does nothing outside a ready Electron app', () => {
    const before = globalThis.fetch;
    expect(bridgeGlobalFetchForHosts(['generativelanguage.googleapis.com'])).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });
});
