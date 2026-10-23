/**
 * Ollama /api/rerank integration for Embedding Space neighbor ordering.
 * Heuristic ANN + rerankNeighbors runs first; this cross-encoder pass refines top-k.
 */

import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';
import {
  buildRerankRunRecord,
  cancelRerankRequest,
  computeRerankMovement,
  getRerankBridge,
  lookupRerankTier,
  newRerankRequestId,
  outcomeForRerankError,
  recordRerankRun,
  rerankHasNoSignal,
  rerankPlan,
  rerankStatus,
  toRerankTier,
  type RerankPlan,
  type RerankRunReport,
  type RerankStatus,
} from '@/services/oracle-rerank';

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
/**
 * Failures (error / empty / no signal / timeout) are cached only briefly: long
 * enough that re-clicking the same star does not re-fire a failing call, short
 * enough that a reranker that just came up (Ollama started, Qwen3 pulled) is
 * used on the next visit instead of 10 minutes later.
 */
export const NEIGHBOR_RERANK_FAILURE_TTL_MS = 30_000;
/** The tier lookup is normally a cached answer; never let a slow probe eat the neighbour budget. */
const NEIGHBOR_TIER_LOOKUP_TIMEOUT_MS = 1_500;
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

/** Test hook. */
export function __clearNeighborRerankCacheForTests(): void {
  neighborRerankCache.clear();
}

export function graphNodeToNeighborQueryText(n: GraphNode): string {
  const g = n.genres?.length ? `Genres: ${n.genres.join(', ')}` : '';
  const t = (n.themes?.length ?? 0) ? `Themes: ${(n.themes ?? []).join(', ')}` : '';
  const dev = n.developer ? `Developer: ${n.developer}` : '';
  // Publisher is left out on purpose (as in the embedding text): shared publishers made
  // unrelated games look like matches to the reranker.
  return [n.title, g, t, dev].filter(Boolean).join(' | ');
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

/**
 * Rerank the heuristic neighbour list, bounded by `NEIGHBOR_RERANK_BUDGET_MS`
 * (the user is waiting on the links). When the reranker does not answer in
 * time the heuristic order is returned with a 'skipped_timeout' status and the
 * main-process pass is cancelled. On the Qwen3 tiers only the top of the
 * heuristic order is scored (one generate call per document).
 */
export async function applyOllamaNeighborRerank(
  anchor: GraphNode,
  neighbors: NeighborInfo[],
  finalK: number,
  opts?: { neighborRerankEnabled?: boolean; plan?: RerankPlan },
): Promise<{ neighbors: NeighborInfo[]; status: RerankStatus }> {
  const enabled = opts?.neighborRerankEnabled !== false;

  if (!finalK || neighbors.length === 0) {
    return { neighbors: neighbors.slice(0, finalK), status: rerankStatus('empty_results') };
  }

  const baseSlice = neighbors.slice(0, finalK);
  if (!enabled) {
    return { neighbors: baseSlice, status: rerankStatus('skipped_disabled') };
  }

  const bridge = getRerankBridge();
  if (!bridge) {
    return { neighbors: baseSlice, status: rerankStatus('skipped_no_client') };
  }

  const plan = opts?.plan ?? rerankPlan('neighbors', await lookupRerankTier(bridge, NEIGHBOR_TIER_LOOKUP_TIMEOUT_MS));
  // Never fewer documents than links shown; never more than the plan allows.
  const trimmed = neighbors.slice(0, Math.min(neighbors.length, Math.max(finalK, plan.maxDocs)));

  const nbIds = trimmed.map((n) => n.id);
  const cacheKey = neighborCacheKey(anchor.id, nbIds, finalK);
  const now = Date.now();
  pruneNeighborRerankCache(now);
  const hit = neighborRerankCache.get(cacheKey);
  if (hit && hit.expires > now) {
    return { neighbors: hit.neighbors, status: hit.status };
  }

  const remember = (out: NeighborInfo[], status: RerankStatus) => {
    const ttl = status.outcome === 'applied' ? NEIGHBOR_RERANK_CACHE_TTL_MS : NEIGHBOR_RERANK_FAILURE_TTL_MS;
    pruneNeighborRerankCache(now);
    neighborRerankCache.set(cacheKey, { neighbors: out, status, expires: Date.now() + ttl });
  };

  const query = graphNodeToNeighborQueryText(anchor);
  const documents = trimmed.map((nb) => {
    if (!nb.node) return `Game ${nb.id}`;
    return graphNodeToNeighborQueryText(nb.node);
  });
  const requestId = newRerankRequestId('neighbors');
  const startedAt = Date.now();
  const record = (
    status: RerankStatus,
    extra?: { report?: RerankRunReport; results?: ReadonlyArray<{ relevance_score: number }>; movement?: ReturnType<typeof computeRerankMovement> },
  ) => {
    recordRerankRun(buildRerankRunRecord({
      source: 'neighbors', outcome: status.outcome, tier: status.tier, startedAt, requested: trimmed.length,
      report: extra?.report, results: extra?.results, movement: extra?.movement,
    }), bridge);
  };

  type Reply = Awaited<ReturnType<typeof bridge.rerank>>;
  const TIMED_OUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race<Reply | typeof TIMED_OUT>([
      bridge.rerank({ query, documents, topN: finalK, requestId, budgetMs: plan.mainBudgetMs }),
      new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), plan.budgetMs); }),
    ]);
    if (res === TIMED_OUT) {
      cancelRerankRequest(bridge, requestId);
      const status = rerankStatus('skipped_timeout');
      record(status);
      remember(baseSlice, status);
      return { neighbors: baseSlice, status };
    }
    if (!res || 'error' in res || !('results' in res) || !res.results?.length) {
      const status: RerankStatus = res && 'error' in res
        ? rerankStatus(outcomeForRerankError(res.error.code), res.report?.tier ?? null)
        : rerankStatus('empty_results');
      record(status, { report: res && 'error' in res ? res.report : undefined });
      remember(baseSlice, status);
      return { neighbors: baseSlice, status };
    }

    const tier = toRerankTier(res.via) ?? res.report?.tier ?? null;
    if (rerankHasNoSignal(res.report, res.results)) {
      const status = rerankStatus('no_signal', tier);
      record(status, { report: res.report, results: res.results });
      remember(baseSlice, status);
      return { neighbors: baseSlice, status };
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
    const movement = computeRerankMovement([baseSlice.map((n) => n.id)], [out.map((n) => n.id)]);
    // Applied either way; the tier says whether it was a cross-encoder or cosine.
    const status: RerankStatus = {
      ...rerankStatus('applied', tier),
      moved: movement.moved,
      meanAbsDelta: movement.meanAbsDelta,
    };
    record(status, { report: res.report, results: res.results, movement });
    remember(out, status);
    return { neighbors: out, status };
  } catch {
    const status = rerankStatus('error');
    record(status);
    remember(baseSlice, status);
    return { neighbors: baseSlice, status };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
