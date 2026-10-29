/**
 * Player counts: implausible values (Steam store pages counted under a launcher, failed lookups)
 * must never reach a card as "1 playing now".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizePlayerCount, formatPlayerCount, formatPlayingNow } from '@/lib/player-count';

vi.mock('@/services/catalog-store', () => ({
  catalogStore: {
    getEntries: vi.fn(async (ids: number[]) =>
      ids.filter((id) => id !== 999).map((id) => ({ appid: id, reviewCount: id === 2519060 ? 250_000 : 40 }))),
  },
}));

describe('sanitizePlayerCount', () => {
  it.each([
    // [count, reviews, expected]
    [1, 0, 1],
    [5, 499, 5],
    [19, 500, null],
    [1, 5000, null],
    [20, 5000, 20],
    [1475, 90_000, 1475],
    [0, 0, null],
    [-1, undefined, null],
    [null, 100, null],
    [undefined, undefined, null],
    [Number.NaN, 10, null],
    [3, undefined, 3],
  ])('count %s with %s reviews → %s', (count, reviews, expected) => {
    expect(sanitizePlayerCount(count as number | null | undefined, reviews as number | undefined)).toBe(expected);
  });
});

describe('formatting', () => {
  it('compacts and pluralises', () => {
    expect(formatPlayerCount(950)).toBe('950');
    expect(formatPlayerCount(1_200)).toBe('1.2K');
    expect(formatPlayerCount(12_400)).toBe('12K');
    expect(formatPlayerCount(1_500_000)).toBe('1.5M');
    expect(formatPlayingNow(1)).toBe('1 player now');
    expect(formatPlayingNow(2)).toBe('2 playing now');
    expect(formatPlayingNow(147_422, ' on Steam')).toBe('147K playing on Steam');
  });
});

describe('steamService.getMultiplePlayerCounts', () => {
  afterEach(() => {
    delete (window as unknown as { steam?: unknown }).steam;
    vi.resetModules();
  });

  it('returns only believable counts: drops unknown, zero and tiny counts on heavily reviewed games', async () => {
    const ipc = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, ({ 730: 1_127_518, 2519060: 1, 115300: 0, 999: null, 7940: 3 } as Record<number, number | null>)[id] ?? null])));
    (window as unknown as { steam: unknown }).steam = { getMultiplePlayerCounts: ipc };
    const { steamService } = await import('@/services/steam-service');
    const out = await steamService.getMultiplePlayerCounts([730, 2519060, 115300, 999, 7940]);
    expect(out).toEqual({ 730: 1_127_518, 7940: 3 });
  });

  it('splits large requests to the IPC batch cap of 200', async () => {
    const ipc = vi.fn(async (ids: number[]) => Object.fromEntries(ids.map((id) => [id, 100])));
    (window as unknown as { steam: unknown }).steam = { getMultiplePlayerCounts: ipc };
    const { steamService } = await import('@/services/steam-service');
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const out = await steamService.getMultiplePlayerCounts(ids);
    expect(ipc).toHaveBeenCalledTimes(3);
    expect(ipc.mock.calls.every(([batch]) => batch.length <= 200)).toBe(true);
    expect(Object.keys(out)).toHaveLength(450);
  });

  it('returns {} outside Electron and when IPC fails', async () => {
    const { steamService } = await import('@/services/steam-service');
    expect(await steamService.getMultiplePlayerCounts([730])).toEqual({});
    (window as unknown as { steam: unknown }).steam = { getMultiplePlayerCounts: vi.fn(async () => { throw new Error('ipc down'); }) };
    expect(await steamService.getMultiplePlayerCounts([730])).toEqual({});
  });
});
