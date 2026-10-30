/**
 * Steam Web API key handling (1.0.97 B01): a build that ships without STEAM_API_KEY sends no
 * `key=` param and the key-only IStoreService calls return [] without a request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/persistent-cache.js', () => ({
  PersistentCache: class {
    get() { return null; }
    set() {}
    flushSync() {}
  },
}));

import { steamWebApiUrl, hasSteamApiKey, steamAPI } from '../../../electron/steam-api';

const savedKey = process.env.STEAM_API_KEY;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => { throw new Error('network must not be used'); });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.STEAM_API_KEY;
  else process.env.STEAM_API_KEY = savedKey;
});

describe('steamWebApiUrl', () => {
  it('omits the key param entirely when no key is set', () => {
    const url = steamWebApiUrl('ISteamChartsService/GetMostPlayedGames/v1/', {}, '');
    expect(url).toBe('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/');
    expect(url).not.toMatch(/key=/);
  });

  it('adds the key and params, skipping undefined values', () => {
    const url = steamWebApiUrl('IStoreService/GetAppList/v1/', { max_results: 5, last_appid: undefined, include_dlc: false }, 'abc');
    const u = new URL(url);
    expect(u.searchParams.get('key')).toBe('abc');
    expect(u.searchParams.get('max_results')).toBe('5');
    expect(u.searchParams.get('include_dlc')).toBe('false');
    expect(u.searchParams.has('last_appid')).toBe(false);
  });

  it('reads the key from the environment lazily', () => {
    process.env.STEAM_API_KEY = '  ';
    expect(hasSteamApiKey()).toBe(false);
    expect(steamWebApiUrl('X/v1/')).not.toMatch(/key=/);
    process.env.STEAM_API_KEY = 'k1';
    expect(hasSteamApiKey()).toBe(true);
    expect(steamWebApiUrl('X/v1/')).toMatch(/key=k1/);
  });
});

describe('key-only endpoints without a key', () => {
  it('getAppList and getTagList return [] and make no request', async () => {
    process.env.STEAM_API_KEY = '';
    expect(await steamAPI.getAppList()).toEqual([]);
    expect(await steamAPI.getTagList()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
