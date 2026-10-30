/**
 * Renderer egdata top-sellers fetch: the abort timer stays armed through the body read,
 * so a server that sends headers and then stalls yields [] after 12 s instead of hanging
 * Top Sellers (and its preload guard) for the session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/services/steam-service', () => ({
  steamService: {
    getTopSellers: vi.fn().mockResolvedValue([]),
    getNewReleases: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/services/epic-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/epic-service')>();
  return {
    ...actual,
    epicService: {
      ...actual.epicService,
      getTopSellersFromCollection: vi.fn().mockResolvedValue([]),
      getFreeGames: vi.fn().mockResolvedValue([]),
      browseCatalog: vi.fn().mockResolvedValue([]),
    },
  };
});

import { fetchEgdataTopSellersPage, gameService } from '@/services/game-service';

/** Headers arrive at once; the body only ends (with an AbortError) when the signal aborts. */
function stalledBodyFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    json: () => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  }));
}

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  originalFetch = globalThis.fetch;
  globalThis.fetch = stalledBodyFetch() as unknown as typeof globalThis.fetch;
  (globalThis.window as Window & { egdata?: unknown }).egdata = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: unknown }).fetch;
});

describe('fetchEgdataTopSellersPage', () => {
  it('returns [] once the 12 s timer aborts a stalled body', async () => {
    let result: unknown[] | undefined;
    void fetchEgdataTopSellersPage(1).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(result).toEqual([]);
  });

  it('getTopSellers settles when every egdata body stalls', async () => {
    let settled = false;
    const p = gameService.getTopSellers().then((g) => { settled = true; return g; });
    for (let i = 0; i < 20 && !settled; i++) await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(await p).toEqual([]);
  });
});
