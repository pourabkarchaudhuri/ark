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
    expect(ranked[1]!.distance).toBeCloseTo(0.2);
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
});
