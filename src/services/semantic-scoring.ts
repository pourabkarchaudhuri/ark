/**
 * Semantic-layer scoring helpers (R4). Pure — no store/worker/embedding imports.
 *
 * Raw cosines against the taste centroid sit in a compressed band (~0.3–0.8) whose
 * position depends on how a vector was composed (Steam catalog text vs Epic/library
 * text). So the layer scores *rank*, not cosine, and ranks within the candidate's own
 * source so composition differences do not penalise one store.
 */
import { percentileRanks } from './ml-normalize';

export type SemanticSource = 'steam' | 'epic' | 'other';

/** Minimum candidates in a source before it gets its own percentile scale. */
export const SOURCE_MIN_GROUP = 8;
/** Percentile given to candidates of a source too small to rank (neutral, never the global bias). */
export const SMALL_SOURCE_PERCENTILE = 0.5;
/** Max reduction of the semantic score for a candidate that looks exactly like rejected games. */
export const NEG_PENALTY_WEIGHT = 0.5;
/** How far the ANN query vector is pushed away from the negative centroid. */
export const NEG_QUERY_LAMBDA = 0.35;
/** Summed negative weight needed for full penalty confidence (1★ game = 2, thumbs-down = 1.5, dismissal = 0.5). */
export const NEG_CONFIDENCE_WEIGHT = 5;

export function semanticSourceOf(gameId: string): SemanticSource {
  if (gameId.startsWith('steam-')) return 'steam';
  if (gameId.startsWith('epic-')) return 'epic';
  return 'other';
}

/**
 * Percentile (0..1) of each value within its own source group. Groups smaller than
 * SOURCE_MIN_GROUP get a neutral percentile: ranking them against the (mostly Steam) pool
 * would re-introduce exactly the composition bias this scale removes.
 */
export function percentileBySource(raw: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<SemanticSource, string[]>();
  for (const id of raw.keys()) {
    const src = semanticSourceOf(id);
    const g = groups.get(src);
    if (g) g.push(id); else groups.set(src, [id]);
  }
  for (const members of groups.values()) {
    if (members.length < SOURCE_MIN_GROUP) {
      for (const id of members) out.set(id, SMALL_SOURCE_PERCENTILE);
      continue;
    }
    const ranks = percentileRanks(members.map(id => raw.get(id)!));
    members.forEach((id, i) => out.set(id, ranks[i]));
  }
  return out;
}

/** 0..1 confidence in the negative signal from the summed weight of negative examples. */
export function negativeConfidence(totalNegativeWeight: number): number {
  return Math.min(1, Math.max(0, totalNegativeWeight) / NEG_CONFIDENCE_WEIGHT);
}

/**
 * Semantic score after the negative penalty. Both percentiles are in 0..1.
 * The penalty is relative: only a candidate that ranks closer to the rejected games than
 * to the user's taste is penalised (the two centroids share the library's common direction,
 * so an absolute negative rank would also punish the best taste matches).
 */
export function finalSemanticScore(tastePct: number, negPct: number, confidence: number): number {
  const v = tastePct - NEG_PENALTY_WEIGHT * confidence * Math.max(0, negPct - tastePct);
  return Math.min(1, Math.max(0, v));
}

/**
 * Query vector pushed away from the negative centroid (L2-normalised).
 * Returns the taste vector unchanged when there is no negative centroid.
 */
export function contrastCentroid(
  taste: Float32Array | null,
  negative: Float32Array | null,
  lambda: number = NEG_QUERY_LAMBDA,
): Float32Array | null {
  if (!taste || !negative || negative.length !== taste.length) return taste;
  const out = new Float32Array(taste.length);
  let mag = 0;
  for (let i = 0; i < taste.length; i++) {
    out[i] = taste[i] - lambda * negative[i];
    mag += out[i] * out[i];
  }
  mag = Math.sqrt(mag);
  if (mag === 0) return taste;
  for (let i = 0; i < out.length; i++) out[i] /= mag;
  return out;
}
