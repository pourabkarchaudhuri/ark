/**
 * Pure normalization of Ollama POST /api/rerank JSON rows — shared with IPC handler tests.
 */

export type RerankResultRow = { index: number; relevance_score: number };

export function normalizeOllamaRerankRows(
  raw: Array<{ index?: number; relevance_score?: number; score?: number }> | undefined,
  sliceLength: number,
): RerankResultRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const results: RerankResultRow[] = [];
  for (const row of raw) {
    const idx =
      typeof row.index === 'number' && row.index >= 0 && row.index < sliceLength ? row.index : -1;
    if (idx < 0) continue;
    const relevance_score =
      typeof row.relevance_score === 'number'
        ? row.relevance_score
        : typeof row.score === 'number'
          ? row.score
          : 0;
    results.push({ index: idx, relevance_score });
  }
  return results.length === 0 ? null : results;
}
