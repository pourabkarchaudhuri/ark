/**
 * Wave 3.1 — idle/forced library+catalog re-chunk helpers.
 * Pure watermark/cursor + need-work checks (no IDB / Ollama).
 */

import {
  CURRENT_POOL_VERSION,
  EMBEDDING_CHUNK_VERSION,
  diffChunksAgainstCache,
  type CachedChunkMeta,
  type ChunkSpec,
} from '@/services/embedding-chunks';

export const RECHUNK_META_KEY = 'rechunk-job';

export type RechunkPhase = 'library' | 'steam' | 'epic' | 'done';

export interface RechunkWatermark {
  key: typeof RECHUNK_META_KEY;
  phase: RechunkPhase;
  /** Exclusive cursor — last successfully processed or skipped gameId. */
  cursorAfter: string | null;
  successCount: number;
  skippedCount: number;
  failureCount: number;
  updatedAt: number;
  poolVersion: number;
  chunkVersion: number;
}

/** True when facet chunks are missing, stale, or hash-mismatched. */
export function gameNeedsChunkWork(
  desired: ChunkSpec[],
  existingMeta: Map<string, CachedChunkMeta>,
): boolean {
  if (desired.length === 0) return false;
  const { toEmbed, staleIds } = diffChunksAgainstCache(desired, existingMeta);
  return toEmbed.length > 0 || staleIds.length > 0;
}

export function createInitialRechunkWatermark(
  now = Date.now(),
): RechunkWatermark {
  return {
    key: RECHUNK_META_KEY,
    phase: 'library',
    cursorAfter: null,
    successCount: 0,
    skippedCount: 0,
    failureCount: 0,
    updatedAt: now,
    poolVersion: CURRENT_POOL_VERSION,
    chunkVersion: EMBEDDING_CHUNK_VERSION,
  };
}

/** Advance cursor after a successful write or an already-complete skip. */
export function advanceRechunkCursor(
  wm: RechunkWatermark,
  gameId: string,
  outcome: 'success' | 'skipped',
  now = Date.now(),
): RechunkWatermark {
  return {
    ...wm,
    cursorAfter: gameId,
    successCount: wm.successCount + (outcome === 'success' ? 1 : 0),
    skippedCount: wm.skippedCount + (outcome === 'skipped' ? 1 : 0),
    updatedAt: now,
  };
}

/** Record a failure without moving the cursor (retry same game next). */
export function recordRechunkFailure(
  wm: RechunkWatermark,
  now = Date.now(),
): RechunkWatermark {
  return {
    ...wm,
    failureCount: wm.failureCount + 1,
    updatedAt: now,
  };
}

export function nextRechunkPhase(phase: RechunkPhase): RechunkPhase {
  if (phase === 'library') return 'steam';
  if (phase === 'steam') return 'epic';
  return 'done';
}

export function beginRechunkPhase(
  wm: RechunkWatermark,
  phase: RechunkPhase,
  now = Date.now(),
): RechunkWatermark {
  return {
    ...wm,
    phase,
    cursorAfter: null,
    updatedAt: now,
  };
}

export function shouldResumeIdleRechunk(
  wm: RechunkWatermark | null,
  chunkingEnabled: boolean,
): boolean {
  if (!chunkingEnabled) return false;
  if (!wm) return true;
  return wm.phase !== 'done';
}

export function gamesAfterCursor<T extends { id: string }>(
  games: T[],
  cursorAfter: string | null,
): T[] {
  const sorted = [...games].sort((a, b) => a.id.localeCompare(b.id));
  if (cursorAfter == null) return sorted;
  return sorted.filter((g) => g.id > cursorAfter);
}

export function rechunkBlockedReason(opts: {
  chunkingEnabled: boolean;
  ollamaAvailable: boolean;
}): string | null {
  if (!opts.chunkingEnabled) {
    return 'Facet chunk embeddings are disabled (kill switch)';
  }
  if (!opts.ollamaAvailable) {
    return 'Ollama unavailable';
  }
  return null;
}

export function rechunkProgressPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}
