/**
 * HowLongToBeat client: title matching, the token handshake, caching and the circuit breaker.
 * Uses recorded-shape fixtures (no network).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HltbClient, hltbSearchTerms, normalizeHltbTitle, pickBestMatch, type HltbCacheLike } from '../../../electron/hltb-api';
import { parseHltbQuery } from '../../../electron/ipc/hltb-handlers';

const MW = [
  { game_id: 186586, game_name: 'Call of Duty: Modern Warfare 4', game_type: 'game', release_world: 2026, comp_main: 27814 },
  { game_id: 63110, game_name: 'Call of Duty: Modern Warfare', game_type: 'game', release_world: 2019, comp_main: 22194, comp_plus: 32589, comp_100: 54466, comp_all: 25977 },
  { game_id: 109060, game_name: 'Call of Duty: Modern Warfare II', game_type: 'game', release_world: 2022, comp_main: 29398 },
  { game_id: 1468, game_name: 'Call of Duty 4: Modern Warfare', game_type: 'game', release_world: 2007, comp_main: 24805 },
];

describe('normalizeHltbTitle', () => {
  it('drops marks, punctuation, store edition suffixes and maps roman numerals', () => {
    expect(normalizeHltbTitle('The Witcher® 3: Wild Hunt – Game of the Year Edition')).toBe('the witcher 3 wild hunt');
    expect(normalizeHltbTitle('Call of Duty®: Modern Warfare® II')).toBe('call of duty modern warfare 2');
    expect(normalizeHltbTitle("Assassin's Creed Valhalla Deluxe Edition")).toBe('assassins creed valhalla');
    expect(normalizeHltbTitle('Pokémon')).toBe('pokemon');
    expect(normalizeHltbTitle('Gold Rush! 2')).toBe('gold rush 2');
    expect(normalizeHltbTitle('Final Fantasy VII Remake')).toBe('final fantasy 7 remake');
  });
});

describe('hltbSearchTerms', () => {
  it('searches without marks and edition suffixes, keeping roman numerals as written', () => {
    expect(hltbSearchTerms('Call of Duty®: Modern Warfare® II')).toEqual(['call', 'of', 'duty', 'modern', 'warfare', 'ii']);
    expect(hltbSearchTerms('The Witcher 3: Wild Hunt – Game of the Year Edition')).toEqual(['the', 'witcher', '3', 'wild', 'hunt']);
  });
});

describe('pickBestMatch', () => {
  it('picks the exact title, and uses the year to tell same-named games apart', () => {
    expect(pickBestMatch({ title: 'Call of Duty®: Modern Warfare®', year: 2019 }, MW)?.game_id).toBe(63110);
    expect(pickBestMatch({ title: 'Call of Duty: Modern Warfare II', year: 2022 }, MW)?.game_id).toBe(109060);
  });

  it('does not guess when the year contradicts the only close match', () => {
    expect(pickBestMatch({ title: 'Call of Duty: Modern Warfare', year: 2030 }, [MW[1]])).toBeNull();
  });

  it('rejects DLC and weak matches', () => {
    expect(pickBestMatch({ title: 'Hades' }, [{ game_id: 1, game_name: 'Hades', game_type: 'dlc' }])).toBeNull();
    expect(pickBestMatch({ title: 'Hades' }, [{ game_id: 2, game_name: 'Saint Seiya: The Hades', game_type: 'game', release_world: 2007 }])).toBeNull();
    expect(pickBestMatch({ title: 'Hades' }, [])).toBeNull();
  });

  it('accepts an alias', () => {
    expect(pickBestMatch({ title: 'MGSV' }, [{ game_id: 5, game_name: 'Metal Gear Solid V: The Phantom Pain', game_alias: 'MGSV, MGS5', game_type: 'game' }])?.game_id).toBe(5);
  });
});

function memoryCache(): HltbCacheLike & { store: Map<string, { data: unknown; ttl: number }> } {
  const store = new Map<string, { data: unknown; ttl: number }>();
  return {
    store,
    get: <T,>(k: string) => (store.get(k)?.data as T) ?? null,
    set: (k, data, ttl) => { store.set(k, { data, ttl }); },
  };
}

function client(responses: Array<(url: string, init?: RequestInit) => Response>, cache = memoryCache()) {
  let now = 1_000_000;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next(url, init);
  });
  const c = new HltbClient({ fetch, cache, now: () => now, sleep: async (ms) => { now += ms; }, userAgent: 'Ark/test' });
  return { c, calls, cache, advance: (ms: number) => { now += ms; } };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HltbClient', () => {
  it('does the token handshake, sends an honest user agent, and converts seconds to hours', async () => {
    const { c, calls } = client([json({ token: 'tok' }), json({ data: MW })]);
    const t = await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 });
    expect(t).toMatchObject({ hltbId: 63110, mainHours: 6.2, mainExtraHours: 9.1, completionistHours: 15.1, url: 'https://howlongtobeat.com/game/63110' });
    expect(calls[0].url).toMatch(/\/api\/search\/site\/init\?t=\d+/);
    expect((calls[1].init?.headers as Record<string, string>)['x-auth-token']).toBe('tok');
    expect((calls[1].init?.headers as Record<string, string>)['User-Agent']).toBe('Ark/test');
  });

  it('caches hits for 30 days and misses for a day; a second lookup makes no request', async () => {
    const { c, calls, cache } = client([json({ token: 'tok' }), json({ data: MW }), json({ data: [] })]);
    await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 });
    await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 });
    expect(calls).toHaveLength(2);
    expect(await c.getTimes({ title: 'Nothing Like This' })).toBeNull();
    const ttls = [...cache.store.values()].map((v) => v.ttl).sort((a, b) => a - b);
    expect(ttls).toEqual([24 * 3600e3, 30 * 24 * 3600e3]);
  });

  it('refreshes an expired token once on 403', async () => {
    const { c, calls } = client([json({ token: 'old' }), json({}, 403), json({ token: 'new' }), json({ data: MW })]);
    const t = await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 });
    expect(t?.hltbId).toBe(63110);
    expect((calls[3].init?.headers as Record<string, string>)['x-auth-token']).toBe('new');
  });

  it('opens a 30-minute breaker on 429 / unexpected shapes and does not cache the failure', async () => {
    const { c, calls, cache, advance } = client([json({ token: 'tok' }), json({}, 429), json({ token: 'tok2' }), json({ data: MW })]);
    expect(await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 })).toBeNull();
    expect(cache.store.size).toBe(0);
    expect(await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 })).toBeNull();
    expect(calls).toHaveLength(2); // breaker open: no request
    advance(31 * 60 * 1000);
    expect((await c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 }))?.hltbId).toBe(63110);
  });

  it('one request at a time for concurrent lookups of the same game', async () => {
    const { c, calls } = client([json({ token: 'tok' }), json({ data: MW })]);
    const [a, b] = await Promise.all([
      c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 }),
      c.getTimes({ title: 'Call of Duty: Modern Warfare', year: 2019 }),
    ]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(2);
  });
});

describe('parseHltbQuery (IPC input)', () => {
  it('accepts a sane title/year and rejects everything else', () => {
    expect(parseHltbQuery({ title: '  Hades ', year: 2020 })).toEqual({ title: 'Hades', year: 2020 });
    expect(parseHltbQuery({ title: 'Hades', year: 3000 })).toEqual({ title: 'Hades', year: undefined });
    expect(parseHltbQuery({ title: '' })).toBeNull();
    expect(parseHltbQuery({ title: 'x'.repeat(201) })).toBeNull();
    expect(parseHltbQuery('Hades')).toBeNull();
    expect(parseHltbQuery(null)).toBeNull();
  });
});
