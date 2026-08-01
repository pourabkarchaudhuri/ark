/**
 * Phase B.1 — flagged ANN neighbor expand for Embedding Space + Similar Games.
 * Oracle / graph stay on pooled ids (chunk hits ignored via steam-/epic- filter
 * or idIndex miss).
 */

import { annIndex } from '@/services/ann-index';
import { aggregateMaxSimByGameId } from '@/services/ann-max-sim';

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
 * When off: pooled ids only (strip `::` chunk rows).
 */
export async function queryAnnNeighborGames(
  vec: number[] | Float32Array,
  overFetch: number,
  sourceGameId: string,
): Promise<Array<{ id: string; distance: number }>> {
  const raw = await annIndex.queryWithDistances(vec, overFetch, sourceGameId);
  if (await isChunkAnnMaxSimEnabled()) {
    return aggregateMaxSimByGameId(raw, { excludeGameId: sourceGameId }).map((r) => ({
      id: r.gameId,
      distance: r.distance,
    }));
  }
  return raw
    .filter((r) => r.id !== sourceGameId && !r.id.includes('::'))
    .sort((a, b) => a.distance - b.distance);
}
