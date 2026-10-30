/**
 * Web search pre-pass (main-apis#50): only explicit freshness intents trigger a
 * search, the search has an overall deadline, and results are cached per query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  needsWebSearch,
  webSearch,
  __setWebSearchFetchForTests,
  __clearWebSearchCacheForTests,
  WEB_SEARCH_DEADLINE_MS,
} from '../../../electron/web-search';

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
