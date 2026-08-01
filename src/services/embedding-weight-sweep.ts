/**
 * Wave 3.2 — weight-sweep harness for CHUNK_WEIGHTS.
 * Pure scoring over fixture chunk vectors — no Ollama / IDB.
 */

import {
  CHUNK_WEIGHTS,
  CURRENT_POOL_VERSION,
  poolChunkVectors,
  type ChunkKind,
} from '@/services/embedding-chunks';

export type WeightCandidate = Record<ChunkKind, number>;

export interface SweepFixtureGame {
  gameId: string;
  chunks: Array<{ kind: ChunkKind; vector: number[] }>;
}

export interface SweepQuery {
  /** Query game id (excluded from ranking). */
  queryGameId: string;
  /** Chunk vectors for the query game (pooled with candidate weights). */
  queryChunks: Array<{ kind: ChunkKind; vector: number[] }>;
  /** Game ids that count as relevant hits for MRR. */
  relevantIds: string[];
}

export interface WeightSweepScore {
  weights: WeightCandidate;
  mrr: number;
  /** Mean (relevant_best_dist − nearest_other_dist); higher is better when relevant is closer. */
  distanceGap: number;
  labeledQueries: number;
}

export interface WeightSweepResult {
  baseline: WeightSweepScore;
  winner: WeightSweepScore;
  candidates: WeightSweepScore[];
  /** True when winner beats baseline on MRR (tie-break: distanceGap). */
  improved: boolean;
  /** Suggested pool version if shipping the winner (baseline version + 1 when improved). */
  suggestedPoolVersion: number | null;
}

const KINDS: ChunkKind[] = ['facets', 'notes', 'summary', 'description', 'similar'];

export function cloneChunkWeights(src: WeightCandidate = CHUNK_WEIGHTS): WeightCandidate {
  return {
    facets: src.facets,
    notes: src.notes,
    summary: src.summary,
    description: src.description,
    similar: src.similar,
  };
}

/** Generate small perturbations around baseline (±scale on one kind at a time + a few combos). */
export function generateWeightCandidates(
  baseline: WeightCandidate = CHUNK_WEIGHTS,
  scale = 0.15,
): WeightCandidate[] {
  const out: WeightCandidate[] = [cloneChunkWeights(baseline)];
  for (const kind of KINDS) {
    const up = cloneChunkWeights(baseline);
    up[kind] = Math.max(0.05, baseline[kind] * (1 + scale));
    out.push(up);
    const down = cloneChunkWeights(baseline);
    down[kind] = Math.max(0.05, baseline[kind] * (1 - scale));
    out.push(down);
  }
  // Combo: boost facets+notes, soften description+similar
  const combo = cloneChunkWeights(baseline);
  combo.facets = Math.max(0.05, baseline.facets * (1 + scale));
  combo.notes = Math.max(0.05, baseline.notes * (1 + scale));
  combo.description = Math.max(0.05, baseline.description * (1 - scale));
  combo.similar = Math.max(0.05, baseline.similar * (1 - scale));
  out.push(combo);
  return out;
}

function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  const sim = denom > 1e-12 ? dot / denom : 0;
  return 1 - sim;
}

function poolWithWeights(
  chunks: Array<{ kind: ChunkKind; vector: number[] }>,
  weights: WeightCandidate,
): Float32Array {
  return poolChunkVectors(
    chunks.map((c) => ({ vector: c.vector, weight: weights[c.kind] ?? 0 })),
  );
}

export function scoreWeightCandidate(
  weights: WeightCandidate,
  corpus: SweepFixtureGame[],
  queries: SweepQuery[],
): WeightSweepScore {
  const pooled = new Map<string, Float32Array>();
  for (const g of corpus) {
    pooled.set(g.gameId, poolWithWeights(g.chunks, weights));
  }

  let mrrSum = 0;
  let gapSum = 0;
  let labeled = 0;

  for (const q of queries) {
    if (q.relevantIds.length === 0) continue;
    labeled++;
    const qVec = poolWithWeights(q.queryChunks, weights);
    const ranked: Array<{ id: string; distance: number }> = [];
    for (const [id, vec] of pooled) {
      if (id === q.queryGameId) continue;
      ranked.push({ id, distance: cosineDistance(qVec, vec) });
    }
    ranked.sort((a, b) => a.distance - b.distance);

    const relevant = new Set(q.relevantIds);
    let rr = 0;
    for (let i = 0; i < ranked.length; i++) {
      if (relevant.has(ranked[i].id)) {
        rr = 1 / (i + 1);
        break;
      }
    }
    mrrSum += rr;

    const relevantDists = ranked.filter((r) => relevant.has(r.id)).map((r) => r.distance);
    const otherDists = ranked.filter((r) => !relevant.has(r.id)).map((r) => r.distance);
    const bestRel = relevantDists.length ? Math.min(...relevantDists) : 1;
    const bestOther = otherDists.length ? Math.min(...otherDists) : 1;
    // Positive when relevant is closer than nearest distractor.
    gapSum += bestOther - bestRel;
  }

  return {
    weights: cloneChunkWeights(weights),
    mrr: labeled > 0 ? mrrSum / labeled : 0,
    distanceGap: labeled > 0 ? gapSum / labeled : 0,
    labeledQueries: labeled,
  };
}

function betterScore(a: WeightSweepScore, b: WeightSweepScore): boolean {
  if (a.mrr !== b.mrr) return a.mrr > b.mrr;
  return a.distanceGap > b.distanceGap;
}

/**
 * Run candidates (or auto-generated perturbations) and pick a winner.
 * Does **not** mutate production CHUNK_WEIGHTS / CURRENT_POOL_VERSION.
 */
export function runWeightSweep(opts: {
  corpus: SweepFixtureGame[];
  queries: SweepQuery[];
  candidates?: WeightCandidate[];
  baseline?: WeightCandidate;
  currentPoolVersion?: number;
}): WeightSweepResult {
  const baselineWeights = cloneChunkWeights(opts.baseline ?? CHUNK_WEIGHTS);
  const candidates = opts.candidates ?? generateWeightCandidates(baselineWeights);
  const scores = candidates.map((w) =>
    scoreWeightCandidate(w, opts.corpus, opts.queries),
  );
  const baseline = scoreWeightCandidate(baselineWeights, opts.corpus, opts.queries);
  let winner = baseline;
  for (const s of scores) {
    if (betterScore(s, winner)) winner = s;
  }
  const improved = betterScore(winner, baseline);
  const poolVer = opts.currentPoolVersion ?? CURRENT_POOL_VERSION;
  return {
    baseline,
    winner,
    candidates: scores,
    improved,
    suggestedPoolVersion: improved ? poolVer + 1 : null,
  };
}
