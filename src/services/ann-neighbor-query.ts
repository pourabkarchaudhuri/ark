/**
 * Phase B.1 — flagged ANN neighbor expand for Embedding Space + Similar Games.
 * Oracle / graph stay on pooled ids (chunk hits ignored via steam-/epic- filter
 * or idIndex miss).
 */

import { annIndex } from '@/services/ann-index';
import { aggregateMaxSimByGameId, parseAnnIdToGameId } from '@/services/ann-max-sim';

/** Over-fetch multiplier when max-sim aggregates many chunk rows per game. */
const MAX_SIM_OVERFETCH_MULT = 16;

/** Baseline over-fetch when max-sim is off (pooled ids only). */
const POOLED_OVERFETCH_MULT = 8;

/**
 * How many ANN rows to request for a desired neighbor `k`.
 * Max-sim needs a large over-fetch so source-game chunk self-hits cannot burn `k`.
 */
export function annNeighborOverFetch(k: number, maxSimEnabled: boolean): number {
  if (k <= 0) return 0;
  return maxSimEnabled ? k * MAX_SIM_OVERFETCH_MULT : k * POOLED_OVERFETCH_MULT + 1;
}

export async function isChunkAnnMaxSimEnabled(): Promise<boolean> {
  try {
    const s = await window.settings?.getOllamaSettings?.();
    return (s as { chunkAnnMaxSimEnabled?: boolean } | undefined)?.chunkAnnMaxSimEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Query ANN and return game-level neighbors.
 * When `ollama.chunkAnnMaxSimEnabled` (default on): max-sim over chunk + pooled hits.
 *   — does **not** pass excludeId into usearch (chunk ids never match); exclude in aggregate.
 * When off: pooled ids only (strip `::` chunk rows) and drop source via parseAnnIdToGameId.
 */
export async function queryAnnNeighborGames(
  vec: number[] | Float32Array,
  overFetch: number,
  sourceGameId: string,
): Promise<Array<{ id: string; distance: number }>> {
  const maxSim = await isChunkAnnMaxSimEnabled();
  // Max-sim: never pass excludeId — usearch only skips exact id match, so chunk
  // rows for the source (`lib:{id}::…`) would still fill k and then be dropped.
  const raw = maxSim
    ? await annIndex.queryWithDistances(vec, overFetch)
    : await annIndex.queryWithDistances(vec, overFetch, sourceGameId);

  if (maxSim) {
    return aggregateMaxSimByGameId(raw, { excludeGameId: sourceGameId }).map((r) => ({
      id: r.gameId,
      distance: r.distance,
    }));
  }

  return raw
    .filter((r) => !r.id.includes('::') && parseAnnIdToGameId(r.id) !== sourceGameId)
    .sort((a, b) => a.distance - b.distance);
}
