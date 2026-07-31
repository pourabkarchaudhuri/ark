import { describe, it, expect } from 'vitest';
import { keepAnnNeighborsUnderCeiling } from '@/services/ann-retrieve';

describe('ANN hard distance ceiling', () => {
  it('keeps only neighbors under ceiling (no soft top-N fallback)', () => {
    const neighbors = [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.4 },
      { id: 'c', distance: 0.5 },
      { id: 'd', distance: 0.9 },
    ];
    const kept = keepAnnNeighborsUnderCeiling(neighbors, 0.45, 500);
    expect(kept.map(n => n.id)).toEqual(['a', 'b']);
  });

  it('returns empty when nothing is under ceiling', () => {
    const neighbors = [
      { id: 'far1', distance: 0.5 },
      { id: 'far2', distance: 0.8 },
    ];
    expect(keepAnnNeighborsUnderCeiling(neighbors, 0.45, 500)).toEqual([]);
  });

  it('caps at maxKeep among under-ceiling neighbors', () => {
    const neighbors = [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.2 },
      { id: 'c', distance: 0.3 },
    ];
    const kept = keepAnnNeighborsUnderCeiling(neighbors, 0.45, 2);
    expect(kept.map(n => n.id)).toEqual(['a', 'b']);
  });
});
