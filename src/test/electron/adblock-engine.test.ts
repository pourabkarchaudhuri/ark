/**
 * Ad-block engine cache: versioned file name, corrupt-cache recovery, weekly
 * background refresh, non-ok list fetches (all with an in-memory fs and fetch).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initAdblockEngine,
  adblockCachePath,
  ADBLOCK_REFRESH_AGE_MS,
  FILTER_LIST_URLS,
  type AdblockDeps,
} from '../../../electron/adblock-engine';

/** Fake engine: just remembers where it came from. */
interface Eng { src: string }
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
/** Normalise separators so the in-memory fs works with path.join on Windows too. */
const n = (p: string) => p.replace(/\\/g, '/');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const rawCachePath = adblockCachePath('/u', 7);
const cachePath = n(rawCachePath);

function setup(opts: {
  files?: Record<string, { data: string; mtimeMs?: number }>;
  lists?: Array<{ ok: boolean; status?: number; body?: string }> | 'reject';
} = {}) {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  for (const [k, v] of Object.entries(opts.files ?? {})) files.set(n(k), { data: enc(v.data), mtimeMs: v.mtimeMs ?? NOW });
  const scheduled: Array<() => Promise<void>> = [];
  let fetchCount = 0;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const deps: AdblockDeps<Eng> = {
    dir: '/u',
    engineVersion: 7,
    fs: {
      readFile: vi.fn(async (p: string) => {
        const f = files.get(n(p));
        if (!f) throw enoent();
        return f.data;
      }),
      writeFile: vi.fn(async (p: string, d: Uint8Array) => { files.set(n(p), { data: d, mtimeMs: NOW }); }),
      rename: vi.fn(async (a: string, b: string) => {
        const f = files.get(n(a));
        if (!f) throw enoent();
        files.delete(n(a));
        files.set(n(b), f);
      }),
      unlink: vi.fn(async (p: string) => { files.delete(n(p)); }),
      stat: vi.fn(async (p: string) => {
        const f = files.get(n(p));
        if (!f) throw enoent();
        return { mtimeMs: f.mtimeMs };
      }),
      readdir: vi.fn(async () => [...files.keys()].map((k) => k.slice('/u/'.length))),
    },
    fetch: vi.fn(async (url: string) => {
      if (opts.lists === 'reject') throw new Error('offline');
      const i = FILTER_LIST_URLS.indexOf(url);
      const r = opts.lists?.[i] ?? { ok: true, body: `list${i}` };
      fetchCount++;
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 503), text: async () => r.body ?? '' };
    }),
    parse: vi.fn((text: string) => ({ src: `parsed:${text}` })),
    deserialize: vi.fn((buf: Uint8Array) => {
      const s = dec(buf);
      if (!s.startsWith('ENGINE:')) throw new Error('bad engine');
      return { src: s };
    }),
    serialize: vi.fn((e: Eng) => enc(`ENGINE:${e.src}`)),
    now: () => NOW,
    withTimeout: (p) => p,
    schedule: (fn) => { scheduled.push(fn); },
  };
  const engines: Eng[] = [];
  const run = () => initAdblockEngine(deps, (e) => engines.push(e));
  return { deps, files, engines, scheduled, run, fetches: () => fetchCount };
}

describe('initAdblockEngine', () => {
  it('names the cache after the engine version', () => {
    expect(cachePath).toBe('/u/adblocker-engine-7.bin');
  });

  it('first run downloads, parses and writes the cache atomically', async () => {
    const { files, engines, deps, run } = setup();
    await run();
    expect(engines).toEqual([{ src: 'parsed:list0\nlist1' }]);
    expect(deps.fs.writeFile).toHaveBeenCalledWith(`${rawCachePath}.tmp`, expect.anything());
    expect(deps.fs.rename).toHaveBeenCalledWith(`${rawCachePath}.tmp`, rawCachePath);
    expect(dec(files.get(cachePath)!.data)).toBe('ENGINE:parsed:list0\nlist1');
  });

  it('a fresh cache is used without downloading or scheduling a refresh', async () => {
    const { engines, run, fetches, scheduled } = setup({ files: { [cachePath]: { data: 'ENGINE:cached', mtimeMs: NOW - DAY } } });
    await run();
    expect(engines).toEqual([{ src: 'ENGINE:cached' }]);
    expect(fetches()).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  it('a corrupt cache is unlinked, the lists downloaded and blocking enabled in the same launch', async () => {
    const { files, engines, deps, run } = setup({ files: { [cachePath]: { data: 'garbage' } } });
    await run();
    expect(deps.fs.unlink).toHaveBeenCalledWith(rawCachePath);
    expect(engines).toEqual([{ src: 'parsed:list0\nlist1' }]);
    expect(dec(files.get(cachePath)!.data)).toMatch(/^ENGINE:/);
  });

  it('an old-version cache file is ignored, deleted and a fresh engine built', async () => {
    const old = n(adblockCachePath('/u', 6));
    const legacy = '/u/adblocker-engine.bin';
    const { files, engines, deps, run } = setup({ files: { [old]: { data: 'ENGINE:v6' }, [legacy]: { data: 'ENGINE:v0' } } });
    await run();
    expect(deps.deserialize).not.toHaveBeenCalled();
    expect(engines).toEqual([{ src: 'parsed:list0\nlist1' }]);
    expect(files.has(old)).toBe(false);
    expect(files.has(legacy)).toBe(false);
    expect(files.has(cachePath)).toBe(true);
  });

  it('an 8-day-old cache is used at once, then swapped after the background refresh', async () => {
    const { engines, scheduled, run, files } = setup({ files: { [cachePath]: { data: 'ENGINE:old', mtimeMs: NOW - 8 * DAY } } });
    await run();
    expect(engines).toEqual([{ src: 'ENGINE:old' }]);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(engines).toEqual([{ src: 'ENGINE:old' }, { src: 'parsed:list0\nlist1' }]);
    expect(dec(files.get(cachePath)!.data)).toBe('ENGINE:parsed:list0\nlist1');
  });

  it('a failed background refresh keeps the old engine and the old cache', async () => {
    const { engines, scheduled, run, files } = setup({
      files: { [cachePath]: { data: 'ENGINE:old', mtimeMs: NOW - 8 * DAY } },
      lists: 'reject',
    });
    await run();
    await scheduled[0]();
    expect(engines).toEqual([{ src: 'ENGINE:old' }]);
    expect(dec(files.get(cachePath)!.data)).toBe('ENGINE:old');
  });

  it('a non-ok list response is neither parsed nor cached', async () => {
    const { engines, deps, run, files } = setup({ lists: [{ ok: true, body: 'a' }, { ok: false, status: 503, body: '<html>busy</html>' }] });
    await run();
    expect(deps.parse).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
    expect(files.has(cachePath)).toBe(false);
  });

  it('a download timeout leaves blocking off without throwing', async () => {
    const { deps, engines, run } = setup();
    deps.withTimeout = async () => null;
    await expect(run()).resolves.toBeUndefined();
    expect(engines).toHaveLength(0);
  });

  it('refresh age threshold is 7 days', () => {
    expect(ADBLOCK_REFRESH_AGE_MS).toBe(7 * DAY);
  });
});
