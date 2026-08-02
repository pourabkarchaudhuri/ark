/**
 * Ollama /api/rerank integration for Embedding Space neighbor ordering.
 * Heuristic ANN + rerankNeighbors runs first; this cross-encoder pass refines top-k.
 */

import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';
import { rerankStatus, toRerankTier, type RerankStatus } from '@/services/oracle-rerank';

/** Default Ollama library name — keep in sync with `electron/settings-store.ts` `DEFAULT_OLLAMA_RERANK_MODEL`. */
export const DEFAULT_OLLAMA_RERANK_MODEL = 'dengcao/bge-reranker-v2-m3';

/** Max candidates passed to heuristic rerank before Ollama rerank (matches ANN over-fetch scale). */
export const NEIGHBOR_HEURISTIC_POOL = 72;

// v1.0.60: bumped 45 s → 10 min so path-walk / repeat-selection through
// Embedding Space (Wave 3 restored ES neighbor rerank on every click) doesn't
// re-fire /api/rerank IPC for the same anchor within a browsing session.
// Interactive cost drops to zero on cache hit, and the LRU-style prune below
// still keeps memory bounded.
const NEIGHBOR_RERANK_CACHE_TTL_MS = 600_000;
const neighborRerankCache = new Map<string, { neighbors: NeighborInfo[]; status: NeighborRerankStatus; expires: number }>();

function pruneNeighborRerankCache(now: number = Date.now()) {
  for (const [key, entry] of neighborRerankCache) {
    if (entry.expires <= now) neighborRerankCache.delete(key);
  }
}

function neighborCacheKey(anchorId: string, neighborIds: string[], finalK: number): string {
  const sig = neighborIds.join('\0');
  return `${anchorId}|${finalK}|${sig}`;
}

export function graphNodeToNeighborQueryText(n: GraphNode): string {
  const g = n.genres?.length ? `Genres: ${n.genres.join(', ')}` : '';
  const t = (n.themes?.length ?? 0) ? `Themes: ${(n.themes ?? []).join(', ')}` : '';
  const dev = n.developer ? `Developer: ${n.developer}` : '';
  const pub = n.publisher ? `Publisher: ${n.publisher}` : '';
  return [n.title, g, t, dev, pub].filter(Boolean).join(' | ');
}

/**
 * Alias of the shared `RerankStatus`. The neighbor pass and the Oracle shelf
 * pass used to disagree about the same event — `embed_fallback` mapped to
 * 'fallback' here and to 'applied' there — so both now carry one outcome plus
 * the tier that produced it.
 *
 * `skipped_settings` became `skipped_disabled` in the shared vocabulary.
 */
export type NeighborRerankStatus = RerankStatus;

export async function applyOllamaNeighborRerank(
  anchor: GraphNode,
  neighbors: NeighborInfo[],
  finalK: number,
  opts?: { neighborRerankEnabled?: boolean },
): Promise<{ neighbors: NeighborInfo[]; status: RerankStatus }> {
  const enabled = opts?.neighborRerankEnabled !== false;

  if (!finalK || neighbors.length === 0) {
    return { neighbors: neighbors.slice(0, finalK), status: rerankStatus('empty_results') };
  }

  const baseSlice = neighbors.slice(0, finalK);
  if (!enabled) {
    return { neighbors: baseSlice, status: rerankStatus('skipped_disabled') };
  }

  const trimmed = neighbors.slice(0, Math.min(neighbors.length, 256));
  if (typeof window === 'undefined' || !window.ollama?.rerank) {
    return { neighbors: baseSlice, status: rerankStatus('skipped_no_client') };
  }

  const nbIds = trimmed.map((n) => n.id);
  const cacheKey = neighborCacheKey(anchor.id, nbIds, finalK);
  const now = Date.now();
  pruneNeighborRerankCache(now);
  const hit = neighborRerankCache.get(cacheKey);
  if (hit && hit.expires > now) {
    return { neighbors: hit.neighbors, status: hit.status };
  }

  const query = graphNodeToNeighborQueryText(anchor);
  const documents = trimmed.map((nb) => {
    if (!nb.node) return `Game ${nb.id}`;
    return graphNodeToNeighborQueryText(nb.node);
  });
  try {
    const res = await window.ollama.rerank({ query, documents, topN: finalK });
    if (!res || 'error' in res || !('results' in res) || !res.results?.length) {
      const status: RerankStatus = rerankStatus(
        res && 'error' in res && res.error.code !== 'empty_results' ? 'error' : 'empty_results',
      );
      const out = { neighbors: neighbors.slice(0, finalK), status };
      pruneNeighborRerankCache(now);
      neighborRerankCache.set(cacheKey, { neighbors: out.neighbors, status, expires: now + NEIGHBOR_RERANK_CACHE_TTL_MS });
      return out;
    }

    const byIdx = new Map<number, NeighborInfo>();
    trimmed.forEach((nb, i) => byIdx.set(i, nb));

    const out: NeighborInfo[] = [];
    const seen = new Set<string>();
    for (const r of res.results) {
      if (out.length >= finalK) break;
      const nb = byIdx.get(r.index);
      if (!nb || seen.has(nb.id)) continue;
      seen.add(nb.id);
      const rel = r.relevance_score;
      const pseudoDist =
        typeof rel === 'number' && Number.isFinite(rel)
          ? Math.max(0.0001, 1 - Math.min(1, Math.max(0, rel)))
          : nb.distance;
      out.push({ ...nb, distance: +pseudoDist.toFixed(4) });
    }
    if (out.length < finalK) {
      for (const nb of trimmed) {
        if (out.length >= finalK) break;
        if (!seen.has(nb.id)) {
          seen.add(nb.id);
          out.push(nb);
        }
      }
    }
    // Applied either way; the tier says whether it was a cross-encoder or cosine.
    const status: RerankStatus = rerankStatus('applied', toRerankTier(res.via));
    pruneNeighborRerankCache(now);
    neighborRerankCache.set(cacheKey, { neighbors: out, status, expires: now + NEIGHBOR_RERANK_CACHE_TTL_MS });
    return { neighbors: out, status };
  } catch {
    const status = rerankStatus('error');
    const out = { neighbors: neighbors.slice(0, finalK), status };
    pruneNeighborRerankCache(now);
    neighborRerankCache.set(cacheKey, { neighbors: out.neighbors, status, expires: now + NEIGHBOR_RERANK_CACHE_TTL_MS });
    return out;
  }
}
