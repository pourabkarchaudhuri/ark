/**
 * Recommendation Explainer — Layer Score Normalization & Human-Readable Breakdown
 *
 * Takes a ScoredGame's `layerScores` and produces:
 *   1. A normalized percentage breakdown per scoring layer.
 *   2. A human-readable explanation array for display in the UI.
 */

import type { ScoredGame, LayerBreakdown } from '@/types/reco';

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
  timeOfDayBoost: 'Time-of-Day Fit',
  engagementCurveBonus: 'Engagement Curve',
  franchiseBoost: 'Franchise Boost',
  studioLoyaltyBoost: 'Studio Loyalty',
  sequencingBoost: 'Sequencing Bonus',
  mlSignal: 'ML Model Signal',
};

export function normalizeLayerScores(game: ScoredGame): LayerBreakdown[] {
  const entries = Object.entries(game.layerScores)
    .filter(([, v]) => v !== undefined && v !== 0)
    .map(([key, rawScore]) => ({
      name: LAYER_LABELS[key] || key,
      rawScore: rawScore as number,
      key,
    }));

  const positiveSum = entries.reduce((s, e) => s + Math.max(0, e.rawScore), 0);
  if (positiveSum === 0) {
    return entries.map(e => ({
      name: e.name,
      rawScore: e.rawScore,
      normalizedScore: 0,
      percentage: 0,
    }));
  }

  return entries
    .map(e => ({
      name: e.name,
      rawScore: e.rawScore,
      normalizedScore: Math.max(0, e.rawScore) / positiveSum,
      percentage: Math.round((Math.max(0, e.rawScore) / positiveSum) * 100),
    }))
    .filter(e => e.percentage > 0)
    .sort((a, b) => b.percentage - a.percentage);
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
