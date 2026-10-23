/**
 * Pure normalization of Ollama POST /api/rerank JSON rows — shared with IPC handler tests.
 */

export type RerankResultRow = { index: number; relevance_score: number };

/**
 * Normalize native /api/rerank rows into `{ index, relevance_score }`, sorted
 * by score (highest first).
 *
 * Callers rank by ROW POSITION (Oracle uses the ordinal as the rank), and the
 * Qwen and cosine tiers already return sorted rows — but Ollama forks that
 * serve /api/rerank are not consistent about it (some echo input order). The
 * sort is stable, so equal scores keep the input order. Duplicate indices keep
 * their best score.
 */
export function normalizeOllamaRerankRows(
  raw: Array<{ index?: number; relevance_score?: number; score?: number }> | undefined,
  sliceLength: number,
): RerankResultRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const byIndex = new Map<number, RerankResultRow>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const idx =
      typeof row.index === 'number' && Number.isInteger(row.index) && row.index >= 0 && row.index < sliceLength
        ? row.index
        : -1;
    if (idx < 0) continue;
    const rawScore =
      typeof row.relevance_score === 'number'
        ? row.relevance_score
        : typeof row.score === 'number'
          ? row.score
          : 0;
    const relevance_score = Number.isFinite(rawScore) ? rawScore : 0;
    const prev = byIndex.get(idx);
    if (!prev || relevance_score > prev.relevance_score) {
      byIndex.set(idx, { index: idx, relevance_score });
    }
  }
  if (byIndex.size === 0) return null;
  // Map iteration is insertion order, so the stable sort keeps input order on ties.
  return [...byIndex.values()].sort((a, b) => b.relevance_score - a.relevance_score);
}

export interface RerankScoreSummary {
  scoreMin: number | null;
  scoreMax: number | null;
  scoreStdev: number | null;
}

/** Min / max / population stdev of the scores — null fields for an empty list. */
export function summarizeRerankScores(rows: ReadonlyArray<{ relevance_score: number }>): RerankScoreSummary {
  const scores = rows.map((r) => r.relevance_score).filter((s) => Number.isFinite(s));
  if (scores.length === 0) return { scoreMin: null, scoreMax: null, scoreStdev: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  const mean = sum / scores.length;
  let sq = 0;
  for (const s of scores) sq += (s - mean) * (s - mean);
  return { scoreMin: min, scoreMax: max, scoreStdev: Math.sqrt(sq / scores.length) };
}
