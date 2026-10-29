/**
 * Recommendation Explainer — Layer Score Normalization & Human-Readable Breakdown
 *
 * Takes a ScoredGame's `layerScores` and produces:
 *   1. A weighted percentage breakdown per scoring layer.
 *   2. A human-readable explanation array for display in the UI.
 *   3. Optional blast-radius evidence chips from the ANN neighbor graph.
 */

import { assembleWeights } from './reco-scoring';
import type { ScoredGame, LayerBreakdown, RecoTelemetry } from '@/types/reco';
import { gameGraphStore } from '@/services/game-graph-store';
import { findGameById } from '@/services/prefetch-store';
import { libraryStore } from '@/services/library-store';

/** Evidence chip for Oracle Why panel (blast-radius / graph). */
export interface BlastRadiusChip {
  key: string;
  label: string;
  detail: string;
  tone: 'neutral' | 'genre' | 'theme';
}

const COMMUNITY_AFFINITY_FLOOR = 0.05;
/** Semantic layer is a per-source percentile (0..1): "strong" means clearly above the median. */
const SEMANTIC_STRONG = 0.6;

const LAYER_LABELS: Record<string, string> = {
  contentSimilarity: 'Genre & Theme Match',
  semanticSimilarity: 'Semantic Similarity',
  clusterSemanticSim: 'Cluster Affinity',
  graphSignal: 'Graph Signal',
  qualitySignal: 'Quality Score',
  popularitySignal: 'Popularity',
  recencyBoost: 'Recency Boost',
  diversityBonus: 'Diversity Bonus',
  trajectoryMultiplier: 'Trajectory Fit',
  negativeSignal: 'Negative Signal',
  positiveAffinity: 'Positive Affinity',
  timeOfDayBoost: 'Time-of-Day Fit',
  engagementCurveBonus: 'Engagement Curve',
  franchiseBoost: 'Franchise Boost',
  studioLoyaltyBoost: 'Studio Loyalty',
  sequencingBoost: 'Sequencing Bonus',
  mlSignal: 'ML Model Signal',
  graphPageRankSignal: 'Graph PageRank',
  graphCommunityAffinity: 'Community Affinity',
};

/**
 * Fallback layer weights, used only when the run's real weights are unavailable (old cached results).
 * The worker's actual weights vary per run (embedding/ML/graph coverage) and ride along in
 * telemetry; pass them to normalizeLayerScores via weightsFromTelemetry.
 */
const LAYER_WEIGHTS: Record<string, number> = (() => {
  // The real weight table at full coverage (not a hand-kept copy that drifts from assembleWeights).
  const w = assembleWeights({ embeddingCoverage: 1, hasClusterScores: true, hasGraphScores: true, mlCoverage: 1, graphSignalCoverage: 1 });
  return {
    contentSimilarity: w.W_CONTENT + w.W_CONTENT_ML,
    semanticSimilarity: w.W_SEMANTIC,
    clusterSemanticSim: w.W_CLUSTER_SEM,
    graphSignal: w.W_GRAPH,
    qualitySignal: w.W_QUALITY + w.W_QUALITY_ML,
    popularitySignal: w.W_POPULARITY,
    recencyBoost: w.W_RECENCY,
    diversityBonus: w.W_DIVERSITY,
    timeOfDayBoost: w.W_TIME,
    engagementCurveBonus: w.W_CURVE,
    franchiseBoost: w.W_FRANCHISE,
    studioLoyaltyBoost: w.W_STUDIO,
    sequencingBoost: w.W_SEQUENCING,
    mlSignal: w.W_ML,
    graphPageRankSignal: w.W_GRAPH_PAGERANK,
    graphCommunityAffinity: w.W_GRAPH_COMMUNITY,
    negativeSignal: w.W_NEGATIVE,
    positiveAffinity: w.W_POSITIVE,
    trajectoryMultiplier: 0,
  };
})();

/** Per-layer weights of a run, from its telemetry (undefined when the run predates telemetry). */
export function weightsFromTelemetry(telemetry: RecoTelemetry | null | undefined): Record<string, number> | undefined {
  if (!telemetry?.layers?.length) return undefined;
  const out: Record<string, number> = {};
  for (const l of telemetry.layers) out[l.layer] = l.weight;
  return out;
}

/** Calibrated "N% match" for display (falls back to the raw score for results cached before calibration). */
export function matchPercent(game: Pick<ScoredGame, 'matchPct' | 'score'>): number {
  const pct = game.matchPct ?? Math.round(game.score * 100);
  return Math.min(100, Math.max(0, pct));
}

/** Prefer worker `reasons.explanation` (one prose sentence); fall back to layer-derived lines. */
export function explanationLines(game: ScoredGame): string[] {
  const fromReasons = game.reasons?.explanation?.trim();
  if (fromReasons) return [fromReasons];
  if (game.explanation?.length) return game.explanation;
  return generateExplanation(game);
}

/**
 * One sentence naming the single strongest reason this game surfaced.
 *
 * The drawer leads with this before the evidence chips and the score
 * breakdown, so it has to be a verdict rather than a list: it picks the
 * highest-signal reason available and says only that. Ordered by how
 * convincing the reason is to a reader, not by raw layer weight — "similar to
 * a game you love" lands harder than "scored well on popularity".
 */
export function explanationHeadline(game: ScoredGame): string {
  const r = game.reasons;
  const ls = game.layerScores;
  const pct = matchPercent(game);

  if (r.similarTo.length > 0) {
    return `A ${pct}% match, mostly because it plays like ${r.similarTo.slice(0, 2).join(' and ')}.`;
  }
  if (ls.franchiseBoost > 0) {
    return `A ${pct}% match — it continues a franchise you already follow.`;
  }
  if (ls.studioLoyaltyBoost > 0 && game.developer) {
    return `A ${pct}% match — ${game.developer} is a studio you keep coming back to.`;
  }
  if (r.bestClusterLabel) {
    return `A ${pct}% match with your ${r.bestClusterLabel} cluster.`;
  }
  if (r.sharedGenres.length > 0) {
    return `A ${pct}% match on the ${r.sharedGenres.slice(0, 2).join(' and ')} you play most.`;
  }
  if (r.isHiddenGem) {
    return `A ${pct}% match — critically strong but almost nobody is talking about it.`;
  }
  if (ls.semanticSimilarity > SEMANTIC_STRONG) {
    return `A ${pct}% match on how closely it reads like the games in your library.`;
  }
  if (r.isStretchPick) {
    return `A ${pct}% match, offered as a stretch pick outside your usual range.`;
  }
  return `A ${pct}% match against your overall profile.`;
}

export function normalizeLayerScores(game: ScoredGame, weights?: Record<string, number>): LayerBreakdown[] {
  const entries = Object.entries(game.layerScores)
    .filter(([, v]) => v !== undefined && v !== 0)
    .map(([key, rawScore]) => {
      // Real per-run weight when known (a layer with weight 0 contributed nothing and is not credited).
      const weight = weights ? (weights[key] ?? 0) : (LAYER_WEIGHTS[key] ?? 0.05);
      const weighted = Math.abs(rawScore as number) * weight;
      return {
        name: LAYER_LABELS[key] || key,
        rawScore: rawScore as number,
        key,
        weighted,
      };
    });

  const positiveSum = entries.reduce((s, e) => s + (e.rawScore >= 0 ? e.weighted : 0), 0);
  if (positiveSum === 0) {
    return entries.map(e => ({
      name: e.name,
      rawScore: e.rawScore,
      normalizedScore: 0,
      percentage: 0,
    }));
  }

  return entries
    .filter(e => e.rawScore > 0)
    .map(e => ({
      name: e.name,
      rawScore: e.rawScore,
      normalizedScore: e.weighted / positiveSum,
      percentage: Math.round((e.weighted / positiveSum) * 100),
    }))
    .filter(e => e.percentage > 0)
    .sort((a, b) => b.percentage - a.percentage);
}

/**
 * Client-only blast-radius chips from gameGraphStore neighbors.
 * Returns [] silently when the graph is not ready.
 */
export function buildBlastRadiusEvidence(
  gameId: string,
  layerScores: Pick<ScoredGame['layerScores'], 'graphCommunityAffinity'> = {},
): BlastRadiusChip[] {
  if (!gameGraphStore.isReady) return [];

  const neighbors = gameGraphStore.getNeighbors(gameId, 5);
  if (neighbors.length === 0 && !(layerScores.graphCommunityAffinity && layerScores.graphCommunityAffinity > COMMUNITY_AFFINITY_FLOOR)) {
    return [];
  }

  const resolveTitle = (id: string): string | null => {
    const pref = findGameById(id);
    if (pref?.title) return pref.title;
    const lib = libraryStore.getEntry(id);
    return lib?.cachedMeta?.title?.trim() || null;
  };

  const titled: Array<{ id: string; title: string; inLibrary: boolean }> = [];
  let libraryOverlap = 0;
  for (const n of neighbors) {
    const inLibrary = libraryStore.isInLibrary(n.id);
    if (inLibrary) libraryOverlap++;
    const title = resolveTitle(n.id);
    if (title) titled.push({ id: n.id, title, inLibrary });
  }

  const chips: BlastRadiusChip[] = [];

  // Up to 2 "Near X" chips from titled neighbors
  for (const n of titled.slice(0, 2)) {
    chips.push({
      key: `blast-near-${n.id}`,
      label: `Near ${n.title}`,
      detail: `${n.title} is a close neighbor in the taste graph (ANN similarity edges).`,
      tone: 'neutral',
    });
  }

  if (libraryOverlap > 0) {
    chips.push({
      key: 'blast-lib-overlap',
      label: `Same cluster as ${libraryOverlap} library game${libraryOverlap === 1 ? '' : 's'}`,
      detail:
        libraryOverlap === 1
          ? 'One game in your library sits next to this pick in the neighbor graph.'
          : `${libraryOverlap} games in your library sit next to this pick in the neighbor graph.`,
      tone: 'neutral',
    });
  } else {
    const affinity = layerScores.graphCommunityAffinity ?? 0;
    const scores = gameGraphStore.getScores(gameId);
    if (affinity > COMMUNITY_AFFINITY_FLOOR && scores && scores.community >= 0) {
      chips.push({
        key: `blast-community-${scores.community}`,
        label: 'Shares your Louvain cluster',
        detail: `Community affinity ${Math.round(affinity * 100)}% — part of Louvain community ${scores.community} with games you already play.`,
        tone: 'neutral',
      });
    }
  }

  return chips.slice(0, 3);
}

export function generateExplanation(game: ScoredGame): string[] {
  const lines: string[] = [];
  const ls = game.layerScores;
  const r = game.reasons;

  if (r.sharedGenres.length > 0) {
    lines.push(`Matches your taste in ${r.sharedGenres.slice(0, 3).join(', ')}`);
  }
  if (r.sharedThemes.length > 0) {
    lines.push(`Shares themes you enjoy: ${r.sharedThemes.slice(0, 3).join(', ')}`);
  }
  if (r.similarTo.length > 0) {
    lines.push(`Similar to ${r.similarTo.slice(0, 2).join(' & ')}`);
  }
  if (ls.semanticSimilarity > SEMANTIC_STRONG) {
    lines.push('High semantic similarity to games you love');
  }
  if (r.isHiddenGem) {
    lines.push('A hidden gem — critically acclaimed but under the radar');
  }
  if (ls.franchiseBoost > 0) {
    lines.push('Part of a franchise you follow');
  }
  if (ls.studioLoyaltyBoost > 0) {
    lines.push(`From a studio you trust (${game.developer})`);
  }
  if (r.metacriticScore && r.metacriticScore >= 85) {
    lines.push(`Metacritic score: ${r.metacriticScore}`);
  }
  if (r.isOnSale && game.price?.discountPercent) {
    lines.push(`Currently ${game.price.discountPercent}% off`);
  }
  if (r.isStretchPick) {
    lines.push('A stretch pick — outside your comfort zone');
  }
  if (ls.engagementCurveBonus > 0.05) {
    lines.push('Fits your preferred engagement pattern');
  }

  if (lines.length === 0) {
    lines.push('Recommended based on your overall gaming profile');
  }

  return lines;
}
