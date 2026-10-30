/**
 * steam:getUpcomingReleases (1.0.97 B06): an empty result (offline, or Steam's featured call
 * failed) is not cached for an hour — the next call after the connection is back refetches.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/persistent-cache.js', () => ({
  PersistentCache: class { get() { return null; } set() {} has() { return false; } clear() {} getStats() { return { total: 0, fresh: 0, stale: 0 }; } flushSync() {} },
}));

import { createUpcomingReleasesLoader, type UpcomingReleasesApi } from '../../../electron/ipc/steam-handlers';

function fakeApi(online: () => boolean) {
  const api = {
    getComingSoon: vi.fn(async () => (online() ? [{ id: 1, name: 'Soon', image: 'a.jpg' }] : [])),
    getNewReleases: vi.fn(async () => { if (!online()) throw new Error('offline'); return [{ id: 2, name: 'New', image: 'b.jpg' }]; }),
    getAppDetails: vi.fn(async (id: number) => ({ name: `Game ${id}`, release_date: { coming_soon: true, date: 'Coming soon' } })),
  };
  return api as typeof api & UpcomingReleasesApi;
}

describe('createUpcomingReleasesLoader', () => {
  it('offline → nothing cached, next online call refetches', async () => {
    let online = false;
    const api = fakeApi(() => online);
    const load = createUpcomingReleasesLoader(api, { sleep: async () => {} });
    expect(await load()).toEqual([]);
    online = true;
    const res = await load();
    expect(res.map((g: { id: number }) => g.id).sort()).toEqual([1, 2]);
    expect(api.getComingSoon).toHaveBeenCalledTimes(2);
  });

  it('a non-empty result is cached for an hour', async () => {
    let now = 1_000_000;
    const api = fakeApi(() => true);
    const load = createUpcomingReleasesLoader(api, { now: () => now, sleep: async () => {} });
    await load();
    await load();
    expect(api.getComingSoon).toHaveBeenCalledTimes(1);
    now += 61 * 60 * 1000;
    await load();
    expect(api.getComingSoon).toHaveBeenCalledTimes(2);
  });
});
