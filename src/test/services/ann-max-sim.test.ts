import { describe, it, expect } from 'vitest';
import {
  parseAnnIdToGameId,
  isChunkAnnId,
  aggregateMaxSimByGameId,
} from '@/services/ann-max-sim';

describe('parseAnnIdToGameId / isChunkAnnId', () => {
  it('treats pooled ids (no ::) as game ids', () => {
    expect(isChunkAnnId('steam-730')).toBe(false);
    expect(parseAnnIdToGameId('steam-730')).toBe('steam-730');
    expect(parseAnnIdToGameId('epic-ns:offer')).toBe('epic-ns:offer');
  });

  it('parses lib/cat chunk ids with :: separator', () => {
    expect(isChunkAnnId('lib:steam-730::facets#0')).toBe(true);
    expect(parseAnnIdToGameId('lib:steam-730::facets#0')).toBe('steam-730');
    expect(parseAnnIdToGameId('cat:epic-ns:offer::summary#1')).toBe('epic-ns:offer');
  });
});

describe('aggregateMaxSimByGameId', () => {
  it('keeps the best (min) distance per game across chunk and pooled hits', () => {
    const hits = [
      { id: 'lib:steam-1::facets#0', distance: 0.4 },
      { id: 'lib:steam-1::summary#0', distance: 0.2 },
      { id: 'steam-1', distance: 0.35 },
      { id: 'lib:steam-2::facets#0', distance: 0.1 },
      { id: 'steam-3', distance: 0.5 },
    ];
    const ranked = aggregateMaxSimByGameId(hits, { excludeGameId: 'steam-0' });
    expect(ranked.map((r) => r.gameId)).toEqual(['steam-2', 'steam-1', 'steam-3']);
    expect(ranked[0]!.distance).toBeCloseTo(0.1);
    // summary chunk 0.2 + kind penalty (1 − 0.55) × 0.25 = 0.3125 — still beats pooled 0.35
    expect(ranked[1]!.distance).toBeCloseTo(0.3125);
  });

  it('excludes the query game (pooled or chunk form)', () => {
    const hits = [
      { id: 'steam-9', distance: 0.01 },
      { id: 'lib:steam-9::facets#0', distance: 0.02 },
      { id: 'steam-8', distance: 0.3 },
    ];
    const ranked = aggregateMaxSimByGameId(hits, { excludeGameId: 'steam-9' });
    expect(ranked).toEqual([{ gameId: 'steam-8', distance: 0.3 }]);
  });

  it('returns empty for empty hits', () => {
    expect(aggregateMaxSimByGameId([], { excludeGameId: 'x' })).toEqual([]);
  });

  it('overFetch stress: many source chunk-self hits still leave other games', () => {
    const sourceChunks = Array.from({ length: 40 }, (_, i) => ({
      id: `lib:steam-src::facets#${i}`,
      distance: 0.001 * (i + 1),
    }));
    const others = [
      { id: 'lib:steam-a::facets#0', distance: 0.05 },
      { id: 'steam-b', distance: 0.08 },
    ];
    const ranked = aggregateMaxSimByGameId([...sourceChunks, ...others], {
      excludeGameId: 'steam-src',
    });
    expect(ranked.map((r) => r.gameId)).toEqual(['steam-a', 'steam-b']);
  });
});

describe('chunk-kind weighting (v1.0.74)', () => {
  it('a description-slice hit counts for less than a facets hit at the same raw distance', async () => {
    const { aggregateMaxSimByGameId, chunkKindPenalty } = await import('@/services/ann-max-sim');
    expect(chunkKindPenalty('cat:steam-1::facets#0')).toBe(0);
    expect(chunkKindPenalty('steam-1')).toBe(0);
    expect(chunkKindPenalty('cat:steam-2::description#1')).toBeGreaterThan(0.1);
    const out = aggregateMaxSimByGameId([
      { id: 'cat:steam-2::description#1', distance: 0.2 },
      { id: 'cat:steam-1::facets#0', distance: 0.25 },
    ]);
    expect(out.map((r) => r.gameId)).toEqual(['steam-1', 'steam-2']);
  });
});
