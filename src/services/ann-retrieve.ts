/**
 * Pure ANN neighbor keep helpers for Oracle taste retrieval.
 * Hard distance ceiling — empty set is fine (BM25/catalog fill the pool).
 */

import { aggregateMaxSimByGameId } from '@/services/ann-max-sim';

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

/**
 * Raw ANN rows → retrievable game candidates, in the order that does not waste the cap:
 * aggregate chunk rows to their game (best distance, chunk-kind penalty) → drop library/linked and
 * non-store ids → apply the distance ceiling → cap. (Capping first, as before, let the user's own
 * games and chunk duplicates burn the 500 slots, and chunk ids — `lib:`/`cat:` prefixed — were silently
 * discarded by the steam-/epic- filter.)
 */
export function selectAnnCandidates(
  raw: ReadonlyArray<AnnNeighbor>,
  opts: { ceiling: number; maxKeep: number; isExcluded: (gameId: string) => boolean },
): AnnNeighbor[] {
  return aggregateMaxSimByGameId(raw)
    .filter(r => (r.gameId.startsWith('steam-') || r.gameId.startsWith('epic-')) && !opts.isExcluded(r.gameId))
    .map(r => ({ id: r.gameId, distance: r.distance }))
    .filter(n => Number.isFinite(n.distance) && n.distance <= opts.ceiling)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, opts.maxKeep));
}
