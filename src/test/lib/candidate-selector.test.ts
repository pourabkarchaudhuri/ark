/**
 * Oracle catalog candidate selection (1.0.97) — the main-process `catalog:queryCandidates` handler
 * and the renderer fallback scan share src/lib/candidate-selector.ts. Golden test: for one fixture
 * catalog both return the same ordered ids, equal to the pre-1.0.97 renderer implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { CatalogEntry } from '@/types/catalog';
import { CatalogStore } from '@/services/catalog-store';
import {
  CANDIDATE_QUERY_MAX_POPULAR_QUOTA,
  CANDIDATE_QUERY_MAX_RESULTS,
  CANDIDATE_QUERY_MAX_TERMS,
  sanitizeCandidateQueryOpts,
} from '@/lib/candidate-selector';
import { queryCatalogCandidates } from '../../../electron/ipc/store-handlers';

const MIGRATION_MARKER = 'ark-steam-catalog-migrated-v1';
const ENTRIES_NS = 'catalog-entries';

/** The pre-1.0.97 CatalogStore.queryForCandidates body, kept verbatim as the reference. */
function legacySelect(entries: CatalogEntry[], opts: {
  topGenres: string[]; loyalDevelopers: string[]; loyalPublishers: string[]; excludeIds: Set<string>;
  minReviews: number; minPositivity: number; maxResults: number; maxPopularQuota: number;
}): CatalogEntry[] {
  const genreSet = new Set(opts.topGenres.map(g => g.toLowerCase()));
  const devSet = new Set(opts.loyalDevelopers.map(d => d.toLowerCase()));
  const pubSet = new Set(opts.loyalPublishers.map(p => p.toLowerCase()));
  const matched: CatalogEntry[] = [];
  const popularOnly: CatalogEntry[] = [];
  for (const entry of entries) {
    const id = `steam-${entry.appid}`;
    if (opts.excludeIds.has(id)) continue;
    if (entry.reviewCount < opts.minReviews || entry.reviewPositivity < opts.minPositivity) continue;
    const hasGenreMatch = entry.genres.some(g => genreSet.has(g.toLowerCase()));
    const hasDevMatch = entry.developer && devSet.has(entry.developer.toLowerCase());
    const hasPubMatch = entry.publisher && pubSet.size > 0 && pubSet.has(entry.publisher.toLowerCase());
    if (hasGenreMatch || hasDevMatch || hasPubMatch) matched.push(entry);
    else if (entry.reviewCount >= 1000) popularOnly.push(entry);
  }
  popularOnly.sort((a, b) => b.reviewCount - a.reviewCount);
  const combined = [...matched, ...popularOnly.slice(0, opts.maxPopularQuota)];
  combined.sort((a, b) => b.reviewCount - a.reviewCount);
  return combined.slice(0, opts.maxResults);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const GENRES = ['RPG', 'Action', 'Puzzle', 'Strategy', 'Simulation', 'Indie', 'adventure', 'Racing'];
const DEVS = ['Valve', 'FromSoftware', 'fromsoftware', 'Indie Co', '', 'Larian'];
const PUBS = ['Devolver', 'Bandai', '', 'Annapurna'];

function fixtureCatalog(n: number): CatalogEntry[] {
  const r = rng(97);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const out: CatalogEntry[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      appid: i * 7,
      name: `Game ${i}`,
      genres: [pick(GENRES), ...(r() < 0.4 ? [pick(GENRES)] : [])],
      themes: [], modes: [],
      developer: pick(DEVS),
      publisher: pick(PUBS),
      shortDescription: '',
      releaseDate: 0,
      reviewScore: 0,
      // Coarse buckets so many rows tie and the stable sort's scan order matters.
      reviewCount: [0, 5, 50, 500, 1000, 1500, 5000, 20_000][Math.floor(r() * 8)],
      reviewPositivity: Math.round(r() * 10) / 10,
      windows: true, mac: false, linux: false, steamDeckCompat: 0,
      isFree: false, tagIds: [],
    });
  }
  return out;
}

function installStore(entries: CatalogEntry[], withMainQuery: boolean) {
  const db = new Map<string, CatalogEntry>();
  for (const e of entries) db.set(String(e.appid), e);
  const keys = [...db.keys()].sort();
  const calls = { getChunk: 0, queryCandidates: 0 };
  const getChunk = async (ns: string, { startAfter, limit }: { startAfter?: string; limit: number }) => {
    calls.getChunk++;
    if (ns !== ENTRIES_NS) return { rows: [], done: true };
    const start = startAfter ? keys.findIndex(k => k > startAfter) : 0;
    const from = start < 0 ? keys.length : start;
    const slice = keys.slice(from, from + limit);
    const rows = slice.map(k => ({ key: k, value: db.get(k) }));
    return { rows, nextKey: rows.length ? rows[rows.length - 1].key : undefined, done: rows.length < limit };
  };
  const fake: Record<string, unknown> = { getChunk, get: async () => ({ value: null }) };
  if (withMainQuery) {
    fake.queryCandidates = async (ns: string, opts: unknown) => {
      calls.queryCandidates++;
      // Structured clone, like IPC.
      return queryCatalogCandidates({ getChunk } as never, ns, structuredClone(opts));
    };
  }
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { calls, keyOrdered: keys.map(k => db.get(k)!) };
}

const OPTS = {
  topGenres: ['rpg', 'Strategy'],
  loyalDevelopers: ['FROMSOFTWARE'],
  loyalPublishers: ['Annapurna'],
  minReviews: 10,
  minPositivity: 0.5,
  maxResults: 400,
  maxPopularQuota: 60,
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(MIGRATION_MARKER, 'yes');
});

afterEach(() => {
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('Oracle catalog candidates — main handler vs renderer fallback (golden)', () => {
  it('returns identical ordered ids on both paths, equal to the legacy implementation', async () => {
    const catalog = fixtureCatalog(5000);
    const excludeIds = new Set(['steam-7', 'steam-70', 'steam-700', 'steam-3500']);

    const main = installStore(catalog, true);
    const viaMain = await new CatalogStore().queryForCandidates({ ...OPTS, excludeIds });
    expect(main.calls.queryCandidates).toBe(1);

    const fb = installStore(catalog, false);
    const viaFallback = await new CatalogStore().queryForCandidates({ ...OPTS, excludeIds });
    expect(fb.calls.queryCandidates).toBe(0);
    expect(fb.calls.getChunk).toBeGreaterThan(1);

    const legacy = legacySelect(main.keyOrdered, { ...OPTS, excludeIds });
    const ids = (rows: CatalogEntry[]) => rows.map(e => e.appid);
    expect(legacy.length).toBeGreaterThan(100);
    expect(ids(viaMain)).toEqual(ids(legacy));
    expect(ids(viaFallback)).toEqual(ids(legacy));
    expect(viaMain).toEqual(legacy);
  });

  it('the main handler reads 2000-row chunks and yields between them', async () => {
    const catalog = fixtureCatalog(4500);
    const keys = catalog.map(e => String(e.appid)).sort();
    const limits: number[] = [];
    const store = {
      getChunk: async (_ns: string, o: { startAfter?: string; limit: number }) => {
        limits.push(o.limit);
        const from = o.startAfter ? keys.indexOf(o.startAfter) + 1 : 0;
        const slice = keys.slice(from, from + o.limit);
        return { rows: slice.map(k => ({ key: k, value: catalog.find(e => String(e.appid) === k) })), nextKey: slice[slice.length - 1], done: slice.length < o.limit };
      },
    };
    const res = await queryCatalogCandidates(store as never, ENTRIES_NS, { ...OPTS, excludeIds: [] });
    expect('rows' in res && res.rows.length).toBeGreaterThan(0);
    expect(limits).toEqual([2000, 2000, 2000]);
  });

  it('falls back to the renderer scan when the main query errors', async () => {
    const catalog = fixtureCatalog(300);
    const env = installStore(catalog, false);
    (window as unknown as { store: Record<string, unknown> }).store.queryCandidates = async () => ({ error: 'rate_limited' });
    const out = await new CatalogStore().queryForCandidates({ ...OPTS, excludeIds: new Set() });
    expect(out.map(e => e.appid)).toEqual(legacySelect(env.keyOrdered, { ...OPTS, excludeIds: new Set() }).map(e => e.appid));
    expect(env.calls.getChunk).toBeGreaterThan(0);
  });
});

describe('catalog:queryCandidates argument validation', () => {
  const store = { getChunk: vi.fn(async () => ({ rows: [], done: true })) };

  it('rejects a bad namespace or non-object options without reading the store', async () => {
    store.getChunk.mockClear();
    expect(await queryCatalogCandidates(store as never, 42, {})).toEqual({ error: 'bad arguments' });
    expect(await queryCatalogCandidates(store as never, '', {})).toEqual({ error: 'bad arguments' });
    expect(await queryCatalogCandidates(store as never, ENTRIES_NS, null)).toEqual({ error: 'bad arguments' });
    expect(await queryCatalogCandidates(store as never, ENTRIES_NS, [1, 2])).toEqual({ error: 'bad arguments' });
    expect(store.getChunk).not.toHaveBeenCalled();
  });

  it('rejects non-string lists, a Set for excludeIds, and oversized lists', () => {
    expect(sanitizeCandidateQueryOpts({ topGenres: ['RPG', 3] })).toBeNull();
    expect(sanitizeCandidateQueryOpts({ loyalDevelopers: 'Valve' })).toBeNull();
    expect(sanitizeCandidateQueryOpts({ excludeIds: new Set(['steam-1']) })).toBeNull();
    expect(sanitizeCandidateQueryOpts({ excludeIds: [{}] })).toBeNull();
    expect(sanitizeCandidateQueryOpts({ topGenres: Array(CANDIDATE_QUERY_MAX_TERMS + 1).fill('x') })).toBeNull();
  });

  it('clamps maxResults and maxPopularQuota and applies the defaults', () => {
    const o = sanitizeCandidateQueryOpts({ maxResults: 1e9, maxPopularQuota: 1e9, excludeIds: ['steam-1'] })!;
    expect(o.maxResults).toBe(CANDIDATE_QUERY_MAX_RESULTS);
    expect(o.maxPopularQuota).toBe(CANDIDATE_QUERY_MAX_POPULAR_QUOTA);
    expect(o.excludeIds.has('steam-1')).toBe(true);
    const d = sanitizeCandidateQueryOpts({})!;
    expect(d).toMatchObject({ topGenres: [], minReviews: 10, minPositivity: 0.5, maxResults: 25_000, maxPopularQuota: 200 });
    const neg = sanitizeCandidateQueryOpts({ maxResults: -5, maxPopularQuota: Number.NaN })!;
    expect(neg.maxResults).toBe(0);
    expect(neg.maxPopularQuota).toBe(200);
  });
});
