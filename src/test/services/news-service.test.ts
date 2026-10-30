/**
 * news-service — TTL cache and "from your fleet" tagging (1.0.97 B23:
 * titles are lowercased once per fetch instead of once per news item).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let libraryIds: string[] = [];
const titles: Record<string, string> = {};

vi.mock('@/services/steam-service', () => ({
  steamService: { getNewsForApp: vi.fn(async () => []) },
}));
vi.mock('@/services/library-store', () => ({
  libraryStore: { getAllGameIds: () => libraryIds },
}));
vi.mock('@/services/journey-store', () => ({
  journeyStore: { getEntry: (id: string) => (titles[id] ? { title: titles[id] } : undefined) },
}));

import { fetchAllNews, clearNewsCache } from '@/services/news-service';

const RSS = [
  { id: 'r1', title: 'Elden Ring DLC dated', summary: 'FromSoftware news', source: 'PC Gamer', url: 'https://a/1', publishedAt: 300 },
  { id: 'r2', title: 'Hades II leaves early access', summary: 'Supergiant', source: 'RPS', url: 'https://a/2', publishedAt: 200 },
  { id: 'r3', title: 'Industry roundup', summary: 'Nothing about your games, just Go and Ox', source: 'Eurogamer', url: 'https://a/3', publishedAt: 100 },
];

const getRSSFeeds = vi.fn(async () => RSS.map((r) => ({ ...r })));

describe('fetchAllNews', () => {
  beforeEach(() => {
    clearNewsCache();
    getRSSFeeds.mockClear();
    libraryIds = [];
    for (const k of Object.keys(titles)) delete titles[k];
    (window as unknown as { newsApi?: unknown }).newsApi = { getRSSFeeds };
  });

  afterEach(() => {
    delete (window as unknown as { newsApi?: unknown }).newsApi;
  });

  it('tags library matches case-insensitively and ignores titles of 2 chars or less', async () => {
    // Non-Steam ids keep the Steam news path out of the picture.
    libraryIds = ['epic-1', 'epic-2', 'epic-3', 'epic-4'];
    titles['epic-1'] = 'ELDEN RING';
    titles['epic-2'] = 'hades ii';
    titles['epic-3'] = 'Go';
    titles['epic-4'] = 'Ox';
    const items = await fetchAllNews();
    const byId = Object.fromEntries(items.map((i) => [i.id, i.isFromYourFleet]));
    expect(byId).toEqual({ r1: true, r2: true, r3: false });
  });

  it('marks nothing when the library is empty', async () => {
    const items = await fetchAllNews();
    expect(items.map((i) => i.isFromYourFleet)).toEqual([false, false, false]);
  });

  it('serves a non-forced call from the cache and refetches when forced', async () => {
    await fetchAllNews();
    expect(getRSSFeeds).toHaveBeenCalledTimes(1);
    await fetchAllNews(false);
    expect(getRSSFeeds).toHaveBeenCalledTimes(1);
    await fetchAllNews(true);
    expect(getRSSFeeds).toHaveBeenCalledTimes(2);
  });
});
