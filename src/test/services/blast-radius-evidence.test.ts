import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNeighbors = vi.fn();
const getScores = vi.fn();
let graphReady = false;

vi.mock('@/services/game-graph-store', () => ({
  gameGraphStore: {
    get isReady() {
      return graphReady;
    },
    getNeighbors: (...args: unknown[]) => getNeighbors(...args),
    getScores: (...args: unknown[]) => getScores(...args),
  },
}));

vi.mock('@/services/prefetch-store', () => ({
  findGameById: vi.fn((id: string) => {
    const titles: Record<string, string> = {
      'steam-hades': 'Hades',
      'steam-lib-1': 'Library Twin',
      'steam-lib-2': 'Library Sibling',
      'steam-other': 'Some Other Game',
    };
    const t = titles[id];
    return t ? { id, title: t } : null;
  }),
}));

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    isInLibrary: (id: string) => id === 'steam-lib-1' || id === 'steam-lib-2',
    getEntry: (id: string) =>
      id === 'steam-lib-1' || id === 'steam-lib-2'
        ? {
            gameId: id,
            cachedMeta: {
              title: id === 'steam-lib-1' ? 'Library Twin' : 'Library Sibling',
            },
          }
        : undefined,
  },
}));

import { buildBlastRadiusEvidence } from '@/services/reco-explainer';

describe('buildBlastRadiusEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphReady = false;
    getNeighbors.mockReturnValue([]);
    getScores.mockReturnValue(null);
  });

  it('returns empty when graph is not ready', () => {
    expect(buildBlastRadiusEvidence('steam-cand', {})).toEqual([]);
    expect(getNeighbors).not.toHaveBeenCalled();
  });

  it('returns Near chips for titled neighbors and library-overlap chip', () => {
    graphReady = true;
    getNeighbors.mockReturnValue([
      { id: 'steam-hades', weight: 0.9 },
      { id: 'steam-lib-1', weight: 0.8 },
      { id: 'steam-lib-2', weight: 0.7 },
      { id: 'steam-other', weight: 0.6 },
      { id: 'steam-unknown', weight: 0.5 },
    ]);
    getScores.mockReturnValue({ community: 3, pageRank: 0.1 });

    const chips = buildBlastRadiusEvidence('steam-cand', {
      graphCommunityAffinity: 0.4,
    });

    expect(chips.some((c) => c.label.startsWith('Near ') && c.label.includes('Hades'))).toBe(true);
    expect(chips.some((c) => /Same cluster as \d+ library/.test(c.label))).toBe(true);
    expect(getNeighbors).toHaveBeenCalledWith('steam-cand', 5);
  });

  it('hides community chip when affinity is not meaningful', () => {
    graphReady = true;
    getNeighbors.mockReturnValue([{ id: 'steam-hades', weight: 0.9 }]);
    getScores.mockReturnValue({ community: 3, pageRank: 0.1 });

    const chips = buildBlastRadiusEvidence('steam-cand', {
      graphCommunityAffinity: 0.01,
    });

    expect(chips.every((c) => !c.label.includes('Same cluster'))).toBe(true);
  });
});
