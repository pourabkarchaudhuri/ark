import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    isReady: true,
    queryWithDistances: vi.fn(),
  },
}));

import { annIndex } from '@/services/ann-index';
import {
  queryAnnNeighborGames,
  annNeighborOverFetch,
} from '@/services/ann-neighbor-query';

function mockSettings(chunkAnnMaxSimEnabled: boolean | undefined) {
  (window as unknown as { settings: { getOllamaSettings: () => Promise<unknown> } }).settings = {
    getOllamaSettings: async () => ({ chunkAnnMaxSimEnabled }),
  };
}

describe('annNeighborOverFetch', () => {
  it('uses k*16 under max-sim and a smaller multiplier when off', () => {
    expect(annNeighborOverFetch(10, true)).toBe(160);
    expect(annNeighborOverFetch(10, false)).toBeGreaterThanOrEqual(10);
    expect(annNeighborOverFetch(10, false)).toBeLessThan(160);
  });
});

describe('queryAnnNeighborGames', () => {
  const vec = new Array(8).fill(0.1);

  beforeEach(() => {
    vi.mocked(annIndex.queryWithDistances).mockReset();
  });

  it('max-sim on: does not pass excludeId to usearch; excludes only in aggregate', async () => {
    mockSettings(true);
    // Top-k flooded with source-game chunk hits; other games still present deeper.
    vi.mocked(annIndex.queryWithDistances).mockResolvedValue([
      { id: 'lib:steam-src::facets#0', distance: 0.01 },
      { id: 'lib:steam-src::summary#0', distance: 0.02 },
      { id: 'lib:steam-src::tags#0', distance: 0.03 },
      { id: 'steam-src', distance: 0.04 },
      { id: 'lib:steam-other::facets#0', distance: 0.1 },
      { id: 'steam-far', distance: 0.2 },
    ]);

    const ranked = await queryAnnNeighborGames(vec, 16, 'steam-src');

    expect(annIndex.queryWithDistances).toHaveBeenCalledWith(vec, 16);
    expect(annIndex.queryWithDistances).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'steam-src',
    );
    expect(ranked.map((r) => r.id)).toEqual(['steam-other', 'steam-far']);
    expect(ranked.every((r) => r.id !== 'steam-src')).toBe(true);
  });

  it('max-sim on: overFetch stress — many source chunk hits still yield other games', async () => {
    mockSettings(true);
    const sourceChunks = Array.from({ length: 20 }, (_, i) => ({
      id: `lib:steam-src::facets#${i}`,
      distance: 0.001 * (i + 1),
    }));
    const others = [
      { id: 'lib:steam-a::facets#0', distance: 0.05 },
      { id: 'lib:steam-b::summary#0', distance: 0.06 },
      { id: 'steam-c', distance: 0.07 },
    ];
    vi.mocked(annIndex.queryWithDistances).mockResolvedValue([...sourceChunks, ...others]);

    const ranked = await queryAnnNeighborGames(vec, 64, 'steam-src');
    expect(ranked.map((r) => r.id)).toEqual(['steam-a', 'steam-b', 'steam-c']);
  });

  it('max-sim off: strips :: rows and drops parseAnnIdToGameId === source', async () => {
    mockSettings(false);
    vi.mocked(annIndex.queryWithDistances).mockResolvedValue([
      { id: 'steam-src', distance: 0.01 },
      { id: 'lib:steam-src::facets#0', distance: 0.02 },
      { id: 'lib:steam-other::facets#0', distance: 0.05 },
      { id: 'steam-other', distance: 0.08 },
      { id: 'steam-far', distance: 0.2 },
    ]);

    const ranked = await queryAnnNeighborGames(vec, 16, 'steam-src');

    // May still pass excludeId when max-sim is off (exact id skip is fine).
    expect(ranked.map((r) => r.id)).toEqual(['steam-other', 'steam-far']);
    expect(ranked.some((r) => r.id.includes('::'))).toBe(false);
    expect(ranked.some((r) => r.id === 'steam-src')).toBe(false);
  });

  it('max-sim off: excludes exact source and chunk-self via parseAnnIdToGameId', async () => {
    mockSettings(false);
    // Simulate usearch returning chunk ids for source even when excludeId was the pooled id.
    vi.mocked(annIndex.queryWithDistances).mockResolvedValue([
      { id: 'lib:steam-src::facets#0', distance: 0.01 },
      { id: 'cat:steam-src::summary#0', distance: 0.02 },
      { id: 'steam-keep', distance: 0.1 },
    ]);

    const ranked = await queryAnnNeighborGames(vec, 8, 'steam-src');
    expect(ranked).toEqual([{ id: 'steam-keep', distance: 0.1 }]);
  });
});
