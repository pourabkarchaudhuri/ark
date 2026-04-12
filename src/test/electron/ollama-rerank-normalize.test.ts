import { describe, it, expect } from 'vitest';
import { normalizeOllamaRerankRows } from '../../../electron/ollama-rerank-normalize';

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
});
