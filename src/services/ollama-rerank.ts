/**
 * Ollama /api/rerank integration for Embedding Space neighbor ordering.
 * Heuristic ANN + rerankNeighbors runs first; this cross-encoder pass refines top-k.
 */

import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';

/** Default Ollama library name — keep in sync with `electron/settings-store.ts` `DEFAULT_OLLAMA_RERANK_MODEL`. */
export const DEFAULT_OLLAMA_RERANK_MODEL = 'dengcao/bge-reranker-v2-m3';

/** Max candidates passed to heuristic rerank before Ollama rerank (matches ANN over-fetch scale). */
export const NEIGHBOR_HEURISTIC_POOL = 72;

const NEIGHBOR_RERANK_CACHE_TTL_MS = 45_000;
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

export type NeighborRerankStatus =
  | 'skipped_settings'
  | 'skipped_no_client'
  | 'applied'
  | 'empty_results'
  | 'error'
  | 'fallback';

export async function applyOllamaNeighborRerank(
  anchor: GraphNode,
  neighbors: NeighborInfo[],
  finalK: number,
  opts?: { neighborRerankEnabled?: boolean },
): Promise<{ neighbors: NeighborInfo[]; status: NeighborRerankStatus }> {
  const enabled = opts?.neighborRerankEnabled !== false;

  if (!finalK || neighbors.length === 0) {
    return { neighbors: neighbors.slice(0, finalK), status: 'empty_results' };
  }

  const baseSlice = neighbors.slice(0, finalK);
  if (!enabled) {
    return { neighbors: baseSlice, status: 'skipped_settings' };
  }

  const trimmed = neighbors.slice(0, Math.min(neighbors.length, 256));
  if (typeof window === 'undefined' || !window.ollama?.rerank) {
    return { neighbors: baseSlice, status: 'skipped_no_client' };
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
      const status: NeighborRerankStatus =
        res && 'error' in res && res.error.code !== 'empty_results' ? 'error' : 'empty_results';
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
    // embed_fallback is a successful reorder — badge-hidden via 'fallback' status.
    const status: NeighborRerankStatus = res.via === 'embed_fallback' ? 'fallback' : 'applied';
    pruneNeighborRerankCache(now);
    neighborRerankCache.set(cacheKey, { neighbors: out, status, expires: now + NEIGHBOR_RERANK_CACHE_TTL_MS });
    return { neighbors: out, status };
  } catch {
    const out = { neighbors: neighbors.slice(0, finalK), status: 'error' as const };
    pruneNeighborRerankCache(now);
    neighborRerankCache.set(cacheKey, { neighbors: out.neighbors, status: 'error', expires: now + NEIGHBOR_RERANK_CACHE_TTL_MS });
    return out;
  }
}
