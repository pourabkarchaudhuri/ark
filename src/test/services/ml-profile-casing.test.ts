import { describe, it, expect } from 'vitest';

/**
 * Mirror of electron/ml-model buildUserProfile Recommended filter.
 * Kept pure so vitest can assert Completed casing without loading ONNX.
 */
function countRecommended(
  games: Array<{ rating: number; status: string }>,
): number {
  return games.filter(g => {
    const status = (g.status || '').toLowerCase();
    return (
      g.rating >= 3 ||
      status === 'completed' ||
      status === 'playing' ||
      status === 'playing now'
    );
  }).length;
}

describe('ML buildUserProfile status casing', () => {
  it('counts Completed / Playing / Playing Now (title case)', () => {
    const n = countRecommended([
      { rating: 0, status: 'Completed' },
      { rating: 0, status: 'Playing' },
      { rating: 0, status: 'Playing Now' },
      { rating: 0, status: 'Want to Play' },
    ]);
    expect(n).toBe(3);
  });

  it('still accepts legacy lowercase statuses', () => {
    const n = countRecommended([
      { rating: 0, status: 'completed' },
      { rating: 0, status: 'playing' },
    ]);
    expect(n).toBe(2);
  });
});
