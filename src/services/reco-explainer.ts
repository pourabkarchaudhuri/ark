/**
 * Recommendation Explainer — Layer Score Normalization & Human-Readable Breakdown
 *
 * Takes a ScoredGame's `layerScores` and produces:
 *   1. A weighted percentage breakdown per scoring layer.
 *   2. A human-readable explanation array for display in the UI.
 *   3. Optional blast-radius evidence chips from the ANN neighbor graph.
 */

import type { ScoredGame, LayerBreakdown } from '@/types/reco';
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
 * Approximate worker layer weights for honest contribution breakdown.
 * Dynamic ML/graph budgets are folded into typical mid values.
 */
const LAYER_WEIGHTS: Record<string, number> = {
  contentSimilarity: 0.22,
  semanticSimilarity: 0.18,
  clusterSemanticSim: 0.06,
  graphSignal: 0.08,
  qualitySignal: 0.10,
  popularitySignal: 0.04,
  recencyBoost: 0.04,
  diversityBonus: 0.04,
  timeOfDayBoost: 0.03,
  engagementCurveBonus: 0.03,
  franchiseBoost: 0.08,
  studioLoyaltyBoost: 0.05,
  sequencingBoost: 0.04,
  mlSignal: 0.06,
  graphPageRankSignal: 0.024,
  graphCommunityAffinity: 0.036,
  negativeSignal: 0.06,
  positiveAffinity: 0.05,
  trajectoryMultiplier: 0,
};

/** Prefer worker `reasons.explanation`; fall back to layer-derived lines. */
export function explanationLines(game: ScoredGame): string[] {
  const fromReasons = game.reasons?.explanation?.trim();
  if (fromReasons) {
    // Worker emits a single prose sentence; also accept "; "-joined parts
    if (fromReasons.includes('; ')) return fromReasons.split('; ').map(s => s.trim()).filter(Boolean);
    return [fromReasons];
  }
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
  const pct = Math.min(100, Math.max(0, Math.round(game.score * 100)));

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
  if (ls.semanticSimilarity > 0.1) {
    return `A ${pct}% match on how closely it reads like the games in your library.`;
  }
  if (r.isStretchPick) {
    return `A ${pct}% match, offered as a stretch pick outside your usual range.`;
  }
  return `A ${pct}% match against your overall profile.`;
}

export function normalizeLayerScores(game: ScoredGame): LayerBreakdown[] {
  const entries = Object.entries(game.layerScores)
    .filter(([, v]) => v !== undefined && v !== 0)
    .map(([key, rawScore]) => {
      const weight = LAYER_WEIGHTS[key] ?? 0.05;
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
  if (ls.semanticSimilarity > 0.1) {
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
