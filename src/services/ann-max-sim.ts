/**
 * Phase B.1 — multi-vector ANN max-sim aggregation.
 *
 * ANN may hold both pooled game ids and facet chunk ids
 * (`lib:`/`cat:` + gameId + `::` + kind#seq). Query over-fetches, then this
 * module maps hits → gameId and keeps the best (min cosine distance) per game.
 *
 * Pure helpers — no usearch / IDB dependency (unit-testable).
 */

export type AnnDistanceHit = { id: string; distance: number };

export type MaxSimGameHit = { gameId: string; distance: number };

/** Chunk ANN ids contain `::` between game key and kind#seq. Pooled ids do not. */
export function isChunkAnnId(id: string): boolean {
  return id.includes('::');
}

/**
 * Map an ANN row id to its game id.
 * - Pooled: identity
 * - Chunk: `lib:{gameId}::{kind}#{seq}` / `cat:{gameId}::{kind}#{seq}`
 *   (gameId may itself contain colons, e.g. epic-ns:offer)
 */
export function parseAnnIdToGameId(id: string): string {
  if (!isChunkAnnId(id)) return id;
  const head = id.slice(0, id.indexOf('::'));
  if (head.startsWith('lib:')) return head.slice(4);
  if (head.startsWith('cat:')) return head.slice(4);
  return head;
}

/**
 * Aggregate ANN hits by game: keep minimum distance (max similarity) per game.
 * Excludes the query game when provided.
 */
export function aggregateMaxSimByGameId(
  hits: readonly AnnDistanceHit[],
  opts?: { excludeGameId?: string },
): MaxSimGameHit[] {
  const exclude = opts?.excludeGameId;
  const best = new Map<string, number>();
  for (const h of hits) {
    const gameId = parseAnnIdToGameId(h.id);
    if (exclude && gameId === exclude) continue;
    const prev = best.get(gameId);
    if (prev === undefined || h.distance < prev) {
      best.set(gameId, h.distance);
    }
  }
  return [...best.entries()]
    .map(([gameId, distance]) => ({ gameId, distance }))
    .sort((a, b) => a.distance - b.distance);
}
