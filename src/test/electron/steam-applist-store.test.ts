/**
 * Steam app list storage: its own file (out of steam-cache.json), lazy memoised load,
 * one-time migration from the old PersistentCache key.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SteamAppListStore, LEGACY_APP_LIST_KEY, type AppListStoreDeps } from '../../../electron/steam-applist-store';

const APPS = [{ appid: 10, name: 'Counter-Strike' }, { appid: 570, name: 'Dota 2' }];

function setup(opts: { file?: string | null; legacy?: unknown } = {}) {
  const files = new Map<string, string>();
  if (opts.file) files.set('/u/steam-applist.json', opts.file);
  const legacyStore = new Map<string, unknown>();
  if (opts.legacy !== undefined) legacyStore.set(LEGACY_APP_LIST_KEY, opts.legacy);
  const deps: AppListStoreDeps = {
    filePath: '/u/steam-applist.json',
    readFile: vi.fn(async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    }),
    writeFile: vi.fn(async (p: string, d: string) => { files.set(p, d); }),
    legacy: {
      get: vi.fn(<T,>(k: string) => (legacyStore.get(k) as T) ?? null),
      delete: vi.fn((k: string) => { legacyStore.delete(k); }),
    },
    now: () => 1_000_000,
  };
  return { deps, files, legacyStore, store: new SteamAppListStore(deps) };
}

describe('SteamAppListStore', () => {
  it('reads the file once and memoises the result', async () => {
    const { deps, store } = setup({ file: JSON.stringify({ savedAt: 5, apps: APPS }) });
    const [a, b] = await Promise.all([store.load(), store.load()]);
    expect(a).toEqual({ savedAt: 5, apps: APPS });
    expect(b).toBe(a);
    await store.load();
    expect(deps.readFile).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no file and no legacy entry', async () => {
    const { store } = setup();
    expect(await store.load()).toBeNull();
  });

  it('treats a corrupt file as missing', async () => {
    const { store } = setup({ file: '{not json' });
    expect(await store.load()).toBeNull();
  });

  it('save writes the list to its own file and updates memory', async () => {
    const { files, store } = setup();
    await store.save(APPS);
    expect(JSON.parse(files.get('/u/steam-applist.json')!)).toEqual({ savedAt: 1_000_000, apps: APPS });
    expect(await store.load()).toEqual({ savedAt: 1_000_000, apps: APPS });
  });

  it('save never throws when the write fails (the fetched list is still returned)', async () => {
    const { deps, store } = setup();
    vi.mocked(deps.writeFile).mockRejectedValueOnce(new Error('EACCES'));
    await expect(store.save(APPS)).resolves.toBeUndefined();
    expect((await store.load())?.apps).toEqual(APPS);
  });

  it('migrates the old cache entry as stale, writes the new file and removes the key', async () => {
    const { deps, files, legacyStore, store } = setup({ legacy: APPS });
    const loaded = await store.load();
    expect(loaded).toEqual({ savedAt: 0, apps: APPS }); // stale → refreshed in the background
    expect(legacyStore.has(LEGACY_APP_LIST_KEY)).toBe(false);
    expect(deps.legacy!.delete).toHaveBeenCalledWith(LEGACY_APP_LIST_KEY);
    expect(JSON.parse(files.get('/u/steam-applist.json')!).apps).toEqual(APPS);
  });

  it('drops a leftover legacy key even when the new file already exists', async () => {
    const { legacyStore, store } = setup({ file: JSON.stringify({ savedAt: 5, apps: APPS }), legacy: [] });
    await store.load();
    expect(legacyStore.has(LEGACY_APP_LIST_KEY)).toBe(false);
  });
});
