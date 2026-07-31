import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    isReady: true,
    queryWithDistances: vi.fn(),
  },
}));

vi.mock('@/services/embedding-service', () => ({
  getEmbeddingById: vi.fn(),
}));

vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn((id: string) => {
    const titles: Record<string, string> = {
      'steam-10': 'Neighbor Alpha',
      'steam-11': 'Neighbor Beta',
      'steam-12': 'Neighbor Far',
    };
    const t = titles[id];
    return t
      ? { id, title: t, genre: [], coverUrl: undefined, headerImage: undefined, screenshots: [] }
      : null;
  }),
}));

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getEntry: () => undefined,
  },
}));

vi.mock('@/services/custom-game-store', () => ({
  customGameStore: {
    getGame: () => undefined,
  },
}));

import { annIndex } from '@/services/ann-index';
import { getEmbeddingById } from '@/services/embedding-service';
import { getSimilarTitlesForReco } from '@/services/similar-games';

describe('getSimilarTitlesForReco', () => {
  beforeEach(() => {
    vi.mocked(getEmbeddingById).mockResolvedValue(new Array(8).fill(0.1));
    vi.mocked(annIndex.queryWithDistances).mockResolvedValue([
      { id: 'steam-source', distance: 0 },
      { id: 'steam-10', distance: 0.12 },
      { id: 'steam-11', distance: 0.3 },
      { id: 'steam-12', distance: 0.6 },
    ]);
  });

  it('returns ANN neighbor display titles under distance gate', async () => {
    const titles = await getSimilarTitlesForReco('steam-source', 6);
    expect(titles).toContain('Neighbor Alpha');
    expect(titles).toContain('Neighbor Beta');
    expect(titles).not.toContain('Neighbor Far');
  });

  it('returns empty when embedding missing (no fake titles)', async () => {
    vi.mocked(getEmbeddingById).mockResolvedValue(null);
    expect(await getSimilarTitlesForReco('steam-source', 6)).toEqual([]);
  });
});
