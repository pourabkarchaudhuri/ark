import { describe, it, expect } from 'vitest';
import { alignMatchPctToOrder } from '@/services/oracle-rerank';
import type { ScoredGame } from '@/types/reco';

const g = (id: string, matchPct?: number) => ({ gameId: id, matchPct } as unknown as ScoredGame);

describe('alignMatchPctToOrder', () => {
  it('hands the same percentages back best-first along the reranked order', () => {
    const out = alignMatchPctToOrder([g('c', 80), g('a', 95), g('b', 90)]);
    expect(out.map(x => x.gameId)).toEqual(['c', 'a', 'b']);
    expect(out.map(x => x.matchPct)).toEqual([95, 90, 80]);
  });
  it('leaves shelves without full percentages alone', () => {
    const games = [g('a', 90), g('b')];
    expect(alignMatchPctToOrder(games)).toBe(games);
  });
  it('does not mutate the input games', () => {
    const a = g('a', 70); const b = g('b', 90);
    alignMatchPctToOrder([a, b]);
    expect(a.matchPct).toBe(70);
  });
});
