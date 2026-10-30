/**
 * DetailEnricher (1.0.97 B21): generation guard on reset (renderer-stores#12), forget() for
 * store-evicted ids (ui-browse-details#19) and the capped, live-only queue (renderer-stores#33).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DetailEnricher, MAX_PENDING_QUEUE, evictOldestEnrichments } from '@/services/detail-enricher';

type IOCallback = (entries: IntersectionObserverEntry[]) => void;
let ioCallbacks: IOCallback[] = [];

class FakeIO {
  constructor(cb: IOCallback) { ioCallbacks.push(cb); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function details(appId: number) {
  return { appId, details: { steam_appid: appId, name: `Game ${appId}`, developers: ['Dev'] } };
}

/** Observe a card for each id and fire one intersection for all of them. */
function show(enricher: DetailEnricher, ids: string[]): Map<string, HTMLElement> {
  const els = new Map<string, HTMLElement>();
  for (const id of ids) {
    const el = document.createElement('div');
    els.set(id, el);
    enricher.observe(el, id);
  }
  const cb = ioCallbacks[ioCallbacks.length - 1]!;
  cb([...els.values()].map((el) => ({ isIntersecting: true, target: el }) as unknown as IntersectionObserverEntry));
  return els;
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('DetailEnricher', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onEnriched: ReturnType<typeof vi.fn>;
  let needs: (id: string) => boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    ioCallbacks = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    fetchMock = vi.fn();
    (window as unknown as { steam: unknown }).steam = { getMultipleAppDetails: fetchMock };
    onEnriched = vi.fn();
    needs = () => true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (window as unknown as { steam: unknown }).steam = undefined;
  });

  function make() {
    const e = new DetailEnricher();
    e.configure({ onEnriched, needsEnrichment: (id) => needs(id) });
    return e;
  }

  for (const outcome of ['resolves', 'rejects'] as const) {
    it(`a batch superseded by reset() is dropped when it ${outcome}`, async () => {
      const e = make();
      const a = deferred<unknown[]>();
      const b = deferred<unknown[]>();
      fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

      show(e, ['steam-1', 'steam-2']);
      vi.advanceTimersByTime(300);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      e.reset();
      show(e, ['steam-10', 'steam-11', 'steam-12', 'steam-13', 'steam-14', 'steam-15', 'steam-16']);
      vi.advanceTimersByTime(300);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      if (outcome === 'resolves') a.resolve([details(1), details(2)]);
      else a.reject(new Error('429'));
      await flush();
      expect(onEnriched).not.toHaveBeenCalled();
      // A's chain started no cooldown of its own: only B's chain is alive.
      expect(vi.getTimerCount()).toBe(0);

      b.resolve([details(16), details(15)]);
      await flush();
      expect(onEnriched).toHaveBeenCalledTimes(1);
      const ids = [...(onEnriched.mock.calls[0]![0] as Map<string, unknown>).keys()];
      expect(ids.sort()).toEqual(['steam-15', 'steam-16']);
      // B's cooldown for the queued 7th id is the single active timer.
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(3000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  }

  it('evictOldestEnrichments returns the evicted ids; forget() lets observe() queue them again', async () => {
    const e = make();
    fetchMock.mockImplementation(async (ids: number[]) => ids.map(details));
    show(e, ['steam-1']);
    vi.advanceTimersByTime(300);
    await flush();
    expect(onEnriched).toHaveBeenCalledTimes(1);

    const map = new Map<string, number>();
    for (let i = 1; i <= 2001; i++) map.set(`steam-${i}`, i);
    const evicted = evictOldestEnrichments(map, 2000);
    expect(evicted).toEqual(['steam-1']);
    expect(map.size).toBe(2000);
    expect(map.has('steam-1')).toBe(false);

    // Before forget: steam-1 is done, so a new card for it is not even observed.
    show(e, ['steam-1']);
    vi.advanceTimersByTime(3300);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    e.forget(evicted);
    show(e, ['steam-1']);
    vi.advanceTimersByTime(3300);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toEqual([1]);
  });

  it('a permanently failed id stays blocked', async () => {
    const e = make();
    fetchMock.mockRejectedValue(new Error('boom'));
    show(e, ['steam-7']);
    vi.advanceTimersByTime(300);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    show(e, ['steam-7']);
    vi.advanceTimersByTime(3300);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps the pending queue at the latest ids', async () => {
    const e = make();
    fetchMock.mockImplementation(async (ids: number[]) => ids.map(details));
    const ids = Array.from({ length: 200 }, (_, i) => `steam-${i + 1}`);
    show(e, ids);
    vi.advanceTimersByTime(300);
    await flush();
    // Drain every batch; only the latest MAX_PENDING_QUEUE ids are ever fetched.
    for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(3000); await flush(); }
    const fetched = fetchMock.mock.calls.flatMap((c) => c[0] as number[]);
    expect(fetched).toHaveLength(MAX_PENDING_QUEUE);
    expect(Math.min(...fetched)).toBe(200 - MAX_PENDING_QUEUE + 1);
  });

  it('skips unmounted cards and cards that no longer need details', async () => {
    const e = make();
    fetchMock.mockImplementation(async (ids: number[]) => ids.map(details));
    const els = show(e, ['steam-1', 'steam-2', 'steam-3']);
    e.unobserve(els.get('steam-3')!);
    needs = (id) => id !== 'steam-2';
    vi.advanceTimersByTime(300);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toEqual([1]);
  });
});
