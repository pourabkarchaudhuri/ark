/**
 * Pure ANN neighbor keep helpers for Oracle taste retrieval.
 * Hard distance ceiling — empty set is fine (BM25/catalog fill the pool).
 */

export interface AnnNeighbor {
  id: string;
  distance: number;
}

/**
 * Keep neighbors with distance ≤ ceiling, sorted ascending, capped at maxKeep.
 * No soft fallback to unfiltered top-N when nothing passes the ceiling.
 */
export function keepAnnNeighborsUnderCeiling(
  neighbors: ReadonlyArray<AnnNeighbor>,
  ceiling: number,
  maxKeep: number,
): AnnNeighbor[] {
  return [...neighbors]
    .filter(n => Number.isFinite(n.distance) && n.distance <= ceiling)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, maxKeep));
}
