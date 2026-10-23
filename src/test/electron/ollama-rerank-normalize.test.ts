import { describe, it, expect } from 'vitest';
import { normalizeOllamaRerankRows, summarizeRerankScores } from '../../../electron/ollama-rerank-normalize';

describe('normalizeOllamaRerankRows', () => {
  it('maps relevance_score and score, filters invalid index', () => {
    const out = normalizeOllamaRerankRows(
      [
        { index: 0, relevance_score: 0.9 },
        { index: 99, score: 0.5 },
        { index: 1, relevance_score: 0.2 },
      ],
      2,
    );
    expect(out).toEqual([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.2 },
    ]);
  });

  it('returns null for empty or invalid', () => {
    expect(normalizeOllamaRerankRows(undefined, 3)).toBeNull();
    expect(normalizeOllamaRerankRows([], 3)).toBeNull();
    expect(normalizeOllamaRerankRows([{ index: 5 }], 2)).toBeNull();
  });

  it('sorts rows by score — forks that echo input order must not leak it into the ranking', () => {
    // Oracle ranks by ROW POSITION, so an unsorted reply would apply input order.
    const out = normalizeOllamaRerankRows(
      [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.8 },
        { index: 2, score: 0.5 },
        { index: 3, relevance_score: 0.8 },
      ],
      4,
    );
    expect(out!.map((r) => r.index)).toEqual([1, 3, 2, 0]); // stable on the 0.8 tie
  });

  it('keeps the best score for a duplicated index', () => {
    const out = normalizeOllamaRerankRows(
      [
        { index: 0, relevance_score: 0.2 },
        { index: 1, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.9 },
      ],
      2,
    );
    expect(out).toEqual([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.5 },
    ]);
  });
});

describe('summarizeRerankScores', () => {
  it('reports min, max and population stdev', () => {
    const s = summarizeRerankScores([{ relevance_score: 0 }, { relevance_score: 1 }]);
    expect(s.scoreMin).toBe(0);
    expect(s.scoreMax).toBe(1);
    expect(s.scoreStdev).toBeCloseTo(0.5);
  });

  it('constant scores have zero spread', () => {
    const s = summarizeRerankScores([{ relevance_score: 0 }, { relevance_score: 0 }, { relevance_score: 0 }]);
    expect(s.scoreMax! - s.scoreMin!).toBe(0);
    expect(s.scoreStdev).toBe(0);
  });

  it('is all-null for no rows', () => {
    expect(summarizeRerankScores([])).toEqual({ scoreMin: null, scoreMax: null, scoreStdev: null });
  });
});
