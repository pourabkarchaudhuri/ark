/**
 * Oracle v3 — Recommendation Engine Worker
 *
 * Runs the full multi-layer scoring pipeline off the main thread.
 *
 * Layers:
 *   1.  Taste Profile (Feature Vectorisation)
 *   2.  Engagement Curve Analysis
 *   3.  Negative Signal Mining
 *   4.  Status Trajectory Scoring
 *   5.  Content Similarity (Cosine — tag-based)
 *   6.  Semantic Similarity (Embedding cosine — optional, gracefully skipped)
 *   7.  Co-Occurrence Graph + Similar-Games Graph Traversal
 *   8.  Quality Signal (multi-factor, now with review sentiment)
 *   9.  Popularity Debiasing
 *  10.  Time-of-Day Contextual Boost
 *  11.  Franchise Detection & Scoring
 *  12.  Studio Loyalty Boost
 *  13.  Cross-Game Session Sequencing
 *  14.  Diversity Re-Ranking (MMR)
 *  15.  Taste Cluster Detection
 *  16.  Explanation Generation
 *  17.  Shelf Assembly (v3 — with franchise & price shelves)
 *
 * Graceful degradation: when embeddings are unavailable, Layer 6
 * returns 0 and its weight is redistributed to content similarity
 * and graph traversal.
 */

import { median } from '../services/ml-normalize';
import type {
  RecoWorkerInput,
  RecoWorkerMessage,
  UserGameSnapshot,
  TasteProfile,
  ScoredGame,
  RecoShelf,
  TasteCluster,
  FranchiseCluster,
  RecoTelemetry,
} from '@/types/reco';
import { toCanonicalGenre, toCanonicalGenres } from '@/data/canonical-genres';
import {
  canonicalFranchiseBase,
  computeFranchiseBoost,
  detectFranchises,
  isFutureReleaseDate,
} from '@/services/franchise';
import { matchesDeepInGenre, matchesMoodShelf, isComingSoonForShelf } from '@/services/reco-shelf-rules';
import {
  computeEngagementWeight,
  computeNegativeWeight,
  heroEvidenceSortKey,
  isEvidenceGame,
} from '@/services/engagement-weight';
import { buildPositiveProfile } from '@/services/reco-feedback-profiles';

import {
  ANN_TASTE_MATCH_CEILING,
  noteTokens,
  splitCreditedNames,
  computeNotesThemeBonus,
  norm,
  clamp01,
  isReleasedPlayableForBacklog,
  CURVE_MULTIPLIERS,
  classifyEngagementCurve,
  _engagementCache,
  computeEngagementScore,
  buildTasteProfile,
  buildNegativeProfile,
  DenseFeatureSpace,
  fastCosineProfileVsCandidate,
  computeSemanticSimilarity,
  buildGraphUserContext,
  computeGraphSignal,
  computeQualitySignal,
  computePopularitySignal,
  computeRecencyBoost,
  computeDiversityBonus,
  quantileSorted,
  calibrateMatchPercent,
  buildTimeOfDayContext,
  computeTimeOfDayBoost,
  computeStudioLoyaltyBoost,
  buildSequencingContext,
  computeSequencingBoost,
  mmrRerank,
  computeRecoTelemetry,
  detectTasteClusters,
  assembleWeights,
  GRAPH_COVERAGE_MIN_SCORE,
} from '@/services/reco-scoring';

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Semantic and cluster layers are per-source percentiles (0..1), so these are rank thresholds.
const SEMANTIC_EXPLAIN_MIN = 0.5;
const CLUSTER_EXPLAIN_MIN = 0.8;
const CLUSTER_EXPLAIN_MARGIN = 0.1;

function progress(stage: string, percent: number) {
  self.postMessage({ type: 'progress', stage, percent } satisfies RecoWorkerMessage);
}

// ─── Layer 16: Explanation Generation ───────────────────────────────────────────

function generateExplanation(
  scored: ScoredGame,
  _userGames: UserGameSnapshot[],
  profile: TasteProfile,
): string {
  const parts: string[] = [];
  const matchPct = scored.matchPct ?? Math.round(scored.score * 100);

  // Franchise entry callout (top priority)
  if (scored.reasons.isFranchiseEntry && scored.reasons.franchiseOf) {
    parts.push(`part of the ${scored.reasons.franchiseOf} series you love`);
  }

  // Semantic discovery — Taste Match from ANN distance, not mere membership
  const annDist = scored.reasons.annDistance;
  if (
    typeof annDist === 'number'
    && annDist <= ANN_TASTE_MATCH_CEILING
    && scored.layerScores.semanticSimilarity > SEMANTIC_EXPLAIN_MIN
  ) {
    parts.push('discovered through your taste profile');
  } else if (scored.reasons.semanticRetrieved && scored.layerScores.semanticSimilarity > SEMANTIC_EXPLAIN_MIN) {
    parts.push('close to games you love in embedding space');
  }

  // Cluster centroid match — game resonates with a specific taste niche. Only claim a
  // niche when the cluster fits clearly better than the overall taste (embedding cosines
  // sit in a compressed band, so an absolute threshold alone would flag nearly everything).
  if (
    scored.layerScores.clusterSemanticSim >= CLUSTER_EXPLAIN_MIN
    && scored.layerScores.clusterSemanticSim - scored.layerScores.semanticSimilarity >= CLUSTER_EXPLAIN_MARGIN
    && scored.reasons.bestClusterLabel
  ) {
    parts.push(`fits your ${scored.reasons.bestClusterLabel} taste`);
  }

  // Top reason: similar to a loved game
  if (scored.reasons.similarTo.length > 0) {
    parts.push(`similar to ${scored.reasons.similarTo[0]}`);
  }

  // Studio loyalty
  if (scored.layerScores.studioLoyaltyBoost > 0.1) {
    parts.push(`from ${scored.developer}, a studio you trust`);
  }

  // Shared genres (canonical display names)
  if (scored.reasons.sharedGenres.length > 0) {
    const topGenreHours = profile.genres.find(g => norm(g.name) === norm(scored.reasons.sharedGenres[0]));
    if (topGenreHours && topGenreHours.totalHours > 10) {
      parts.push(`you've spent ${Math.round(topGenreHours.totalHours)}h in ${scored.reasons.sharedGenres[0]} games`);
    } else {
      parts.push(`matches your love of ${scored.reasons.sharedGenres.slice(0, 2).join(' & ')}`);
    }
  }

  // Deal callout
  if (scored.reasons.isOnSale && scored.price?.discountPercent) {
    parts.push(`${scored.price.discountPercent}% off right now`);
  }

  // Hidden gem callout
  if (scored.reasons.isHiddenGem) {
    parts.push(`hidden gem with ${scored.metacriticScore} Metacritic`);
  }

  // Stretch pick callout
  if (scored.reasons.isStretchPick) {
    parts.push('outside your comfort zone');
  }

  // Quality signal
  if (!scored.reasons.isHiddenGem && scored.metacriticScore && scored.metacriticScore >= 85) {
    parts.push(`critically acclaimed (${scored.metacriticScore}/100)`);
  }

  if (parts.length === 0) {
    return `${matchPct}% match based on your gaming taste`;
  }

  return `${matchPct}% match — ${parts.slice(0, 3).join(', ')}`;
}

// ─── Full Pipeline ─────────────────────────────────────────────────────────────

async function runPipeline(input: RecoWorkerInput): Promise<{ tasteProfile: TasteProfile; shelves: RecoShelf[]; telemetry?: RecoTelemetry }> {
  const { userGames, candidates, now, currentHour, embeddingCoverage, dismissedGameIds } = input;
  const thumbsDownIds = input.thumbsDownIds ?? [];
  const thumbsUpIds = input.thumbsUpIds ?? [];
  const dismissedSet = new Set(dismissedGameIds);
  for (const id of thumbsDownIds) dismissedSet.add(id);

  // Normalize array fields — old DB entries may have undefined for optional arrays
  for (const c of candidates) {
    if (!c.genres) c.genres = [];
    if (!c.themes) c.themes = [];
    if (!c.gameModes) c.gameModes = [];
    if (!c.perspectives) c.perspectives = [];
  }
  for (const g of userGames) {
    if (!g.genres) g.genres = [];
    if (!g.themes) g.themes = [];
    if (!g.gameModes) g.gameModes = [];
    if (!g.perspectives) g.perspectives = [];
  }

  // Reset per-run caches
  _engagementCache.clear();

  // Mine thumbs-down / thumbs-up features before filtering thumbs-down from the pool
  const thumbsDownSet = new Set(thumbsDownIds);
  const thumbsUpSet = new Set(thumbsUpIds);
  const thumbsDownCandidates = candidates.filter(c => thumbsDownSet.has(c.gameId));
  const thumbsUpCandidates = candidates.filter(c => thumbsUpSet.has(c.gameId));

  // Filter out dismissed / thumbs-down candidates (thumbs-up stay in the pool)
  const filteredCandidates = candidates.filter(c => !dismissedSet.has(c.gameId));

  // ── 1. Build taste profile ──
  progress('Analyzing your library...', 5);
  const tasteProfile = buildTasteProfile(userGames, now);

  if (filteredCandidates.length === 0) {
    return { tasteProfile, shelves: buildShelvesFromScored([], [], userGames, tasteProfile, [], [], null, now) };
  }

  // ── 2. Classify engagement curves ──
  progress('Analyzing play patterns...', 8);
  // Always classify here with the shared function: the store's snapshot builder keeps its own older
  // classifier (which ignored completion) and its label must not stick.
  for (const ug of userGames) {
    ug.engagementPattern = classifyEngagementCurve(ug);
  }

  // ── 3. Build negative / positive taste profiles ──
  progress('Mining negative signals...', 12);
  const negativeProfile = buildNegativeProfile(userGames, now, thumbsDownCandidates);
  const positiveProfile = buildPositiveProfile(userGames, thumbsUpCandidates);

  // F8: notes tokens from loved / evidence games
  const lovedNotesTokens = new Set<string>();
  for (const ug of userGames) {
    if (!ug.userNotes) continue;
    if (computeEngagementWeight(ug) <= 0) continue; // notes from rejected games are not 'loved'
    if (!isEvidenceGame(ug) && ug.rating < 4) continue;
    for (const t of noteTokens(ug.userNotes)) lovedNotesTokens.add(t);
  }

  // ── 4. Pre-compute taste vectors (dense Float32Array) ──
  progress('Building taste vectors...', 16);
  const featureSpace = new DenseFeatureSpace();

  // Register all features from profile + candidates + negative games into the dictionary
  const registerProfile = (p: TasteProfile) => {
    for (const g of p.genres) featureSpace.register(`g:${g.name}`);
    for (const t of p.themes) featureSpace.register(`t:${t.name}`);
    for (const m of p.gameModes) featureSpace.register(`m:${m.name}`);
    for (const pe of p.perspectives) featureSpace.register(`p:${pe.name}`);
    for (const d of p.developers.slice(0, 20)) featureSpace.register(`d:${d.name}`);
    for (const pub of p.publishers.slice(0, 15)) featureSpace.register(`pub:${pub.name}`);
  };
  registerProfile(tasteProfile);

  for (const c of filteredCandidates) {
    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (can) featureSpace.register(`g:${norm(can)}`);
    }
    for (const t of c.themes) featureSpace.register(`t:${norm(t)}`);
    for (const m of c.gameModes) featureSpace.register(`m:${norm(m)}`);
    for (const p of c.perspectives) featureSpace.register(`p:${norm(p)}`);
    for (const d of splitCreditedNames(c.developer)) featureSpace.register(`d:${d}`);
    if (c.publisher) featureSpace.register(`pub:${norm(c.publisher)}`);
  }

  for (const g of userGames) {
    for (const genre of g.genres) {
      const can = toCanonicalGenre(genre);
      if (can) featureSpace.register(`g:${norm(can)}`);
    }
    for (const t of g.themes) featureSpace.register(`t:${norm(t)}`);
    for (const d of splitCreditedNames(g.developer)) featureSpace.register(`d:${d}`);
  }

  const { vec: profileVecDense, mag: profileMag } = featureSpace.profileToDense(tasteProfile);
  const { vec: negVecDense, mag: negMag } = featureSpace.mapToDense(negativeProfile.vec);
  const { vec: posVecDense, mag: posMag } = featureSpace.mapToDense(positiveProfile.vec);

  progress('Linking your library...', 20);

  // ── 6. Use precomputed taste centroid for semantic similarity ──
  const useSemantics = embeddingCoverage > 0;
  const hasPrecomputedScores = !!input.precomputedSemanticScores;
  const precomputedScores = input.precomputedSemanticScores ?? {};
  // Candidates without an embedding (not yet embedded, custom) get the pool median instead of 0.
  const semanticMedian = hasPrecomputedScores ? median(Object.values(precomputedScores)) : 0;

  // Graph metrics from persisted neighbor graph (optional — present when gameGraphStore has built it)
  const graphScores = input.graphScores ?? {};
  const userCommunityCounts = input.userCommunityCounts ?? {};
  const userCommunityTotal = Math.max(1, input.userCommunityTotal ?? 0);
  const hasGraphScores = Object.keys(graphScores).length > 0;
  let maxGraphPageRank = 1e-9;
  if (typeof input.graphMaxPageRank === 'number' && input.graphMaxPageRank > 0) {
    // Global normalizer from the full graph — graphScores is a candidate/user subset.
    maxGraphPageRank = input.graphMaxPageRank;
  } else if (hasGraphScores) {
    for (const g of Object.values(graphScores)) {
      if (g.pageRank > maxGraphPageRank) maxGraphPageRank = g.pageRank;
    }
  }
  // Always build the centroid when available — backlog advisor + cluster detection need it
  // even when per-candidate scoring uses precomputed scores.
  const tasteCentroid: Float64Array | null = useSemantics && input.tasteCentroid
    ? new Float64Array(input.tasteCentroid)
    : null;

  // ── 7. Detect franchises ──
  progress('Detecting game franchises...', 23);
  const franchises = detectFranchises(userGames, filteredCandidates, (f) => {
    progress('Detecting game franchises...', 23 + Math.floor(f * 2));
  });
  const userGameIds = new Set(userGames.map(g => g.gameId));

  // ── 8. Early taste cluster detection (needed for cluster centroid scoring) ──
  progress('Detecting taste clusters...', 24);
  const clusters = input.precomputedClusters ?? detectTasteClusters(userGames, now);
  tasteProfile.clusters = clusters;
  const precomputedClusterScores = input.precomputedClusterScores ?? {};
  const hasPrecomputedClusterScores = clusters.length >= 2 && Object.keys(precomputedClusterScores).length > 0;
  const clusterMedian = hasPrecomputedClusterScores ? median(Object.values(precomputedClusterScores).map(v => v.sim)) : 0;

  // Cluster semantic scoring. Candidate embeddings are stripped before the worker,
  // so the main thread precomputes per-candidate cluster scores (precomputedClusterScores).
  // The in-worker centroid path below is only the fallback for callers that still
  // send raw candidate embeddings.
  const clusterCentroids: Array<{ centroid: Float64Array; label: string }> = [];
  if (useSemantics && !hasPrecomputedScores) {
    for (const cl of clusters) {
      if (cl.semanticCentroid) {
        clusterCentroids.push({ centroid: new Float64Array(cl.semanticCentroid), label: cl.label });
      }
    }
  }

  // ── 9. Build hoisted contexts (PERF: built once, not per candidate) ──
  progress('Building scoring contexts...', 26);
  const graphCtx = buildGraphUserContext(userGames, now);
  const todCtx = buildTimeOfDayContext(userGames, currentHour);
  const seqCtx = buildSequencingContext(userGames);

  // Sort user games by engagement weight descending so computeGraphSignal's
  // early termination (break after 3 matches) picks the strongest signals.
  userGames.sort((a, b) =>
    (graphCtx.ugWeights.get(b.gameId) ?? 0) - (graphCtx.ugWeights.get(a.gameId) ?? 0),
  );

  // Pre-compute per-user-game normalized canonical genre sets for engagement curve bonus
  const ugGenreNorms = new Map<string, Set<string>>();
  for (const ug of userGames) {
    const canon = ug.genres.map(g => toCanonicalGenre(g)).filter(Boolean) as string[];
    ugGenreNorms.set(ug.gameId, new Set(canon.map(norm)));
  }

  // Pre-compute profile feature sets (normalized for comparison; profile.genres use canonical display names)
  const profileGenresNorm = new Set(tasteProfile.genres.map(g => norm(g.name)));
  const rejectedGenresNorm = new Set<string>();
  for (const ug of userGames) {
    if (computeNegativeWeight(ug) > 0 || computeEngagementWeight(ug) <= 0) {
      for (const g of toCanonicalGenres(ug.genres || [])) rejectedGenresNorm.add(norm(g));
    }
  }
  const profileThemes = new Set(tasteProfile.themes.map(t => t.name));
  const profileModes = new Set(tasteProfile.gameModes.map(m => m.name));

  // ── Score candidates ──
  progress('Scoring candidates...', 28);
  const maxPlayerCount = Math.max(1, ...filteredCandidates.map(c => c.playerCount ?? 0));
  // "Hidden gem" = well-reviewed AND in the least-played quarter of the pool (a percentile, not 10% of one outlier's max).
  const knownPlayerCounts = filteredCandidates
    .map(c => c.playerCount)
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);
  const hiddenGemPlayerCeiling = knownPlayerCounts.length >= 20
    ? quantileSorted(knownPlayerCounts, 0.25)
    : maxPlayerCount * 0.1;
  let nonFiniteScores = 0;
  const totalCandidates = filteredCandidates.length;

  // Graph signal pre-pass: coverage decides how much weight the layer keeps
  // (assembleWeights moves the shortfall to content similarity).
  const libraryNeighbors = input.libraryNeighbors ?? {};
  const graphByCandidate = new Map<string, { score: number; similarTo: string[] }>();
  let graphNonZero = 0;
  for (const c of filteredCandidates) {
    const g = computeGraphSignal(c, userGames, libraryNeighbors[c.gameId], graphCtx);
    graphByCandidate.set(c.gameId, g);
    if (g.score >= GRAPH_COVERAGE_MIN_SCORE) graphNonZero++;
  }
  const graphSignalCoverage = filteredCandidates.length > 0 ? graphNonZero / filteredCandidates.length : 0;

  // ML coverage = share of candidates with a real model score.
  const mlCoverage = filteredCandidates.filter(c => c.mlScore != null).length / Math.max(1, filteredCandidates.length);

  // ML-less candidates (Epic, post-2023, custom) get the pool median, not 0, so they are neither punished nor boosted.
  const mlMedian = median(filteredCandidates.filter(c => c.mlScore != null).map(c => c.mlScore as number));

  const hasClusterCentroids = hasPrecomputedClusterScores || clusterCentroids.length >= 2;
  const clusterLabels = clusterCentroids.map(c => c.label);
  const {
    W_SEMANTIC, W_CLUSTER_SEM, W_CONTENT, W_GRAPH, W_QUALITY, W_POPULARITY, W_RECENCY,
    W_DIVERSITY, W_TIME, W_CURVE, W_NEGATIVE, W_POSITIVE, W_FRANCHISE, W_STUDIO,
    W_SEQUENCING, W_GRAPH_COMMUNITY, W_GRAPH_PAGERANK, W_ML, W_CONTENT_ML, W_QUALITY_ML,
  } = assembleWeights({
    embeddingCoverage,
    hasClusterScores: hasClusterCentroids,
    hasGraphScores,
    mlCoverage,
    graphSignalCoverage,
  });

  const maxGenreWeight = tasteProfile.genres[0]?.weight ?? 1;
  const scored: ScoredGame[] = [];
  const scoringProgressStep = Math.max(1, Math.floor(totalCandidates / 20));

  for (let i = 0; i < filteredCandidates.length; i++) {
    const c = filteredCandidates[i];

    // Layer 5: Content similarity — dense Float32Array cosine
    const { indices: candidateIndices, mag: candidateMag } = featureSpace.candidateToIndices(c);
    const contentSimilarity = fastCosineProfileVsCandidate(profileVecDense, profileMag, candidateIndices, candidateMag);

    // Layer 6: Semantic similarity (proportional to embedding coverage)
    const semanticSimilarity = useSemantics
      ? (hasPrecomputedScores
          ? (precomputedScores[c.gameId] ?? semanticMedian)
          : computeSemanticSimilarity(tasteCentroid, c.embedding))
      : 0;

    // Layer 6b: Cluster centroid semantic similarity — max across all cluster centroids.
    // Skipped when precomputed scores are provided (candidate embeddings are stripped);
    // the budget is redistributed to the main semantic layer via hasClusterCentroids.
    let clusterSemanticSim = 0;
    let bestClusterIdx = -1;
    let bestClusterLabel: string | undefined;
    if (W_CLUSTER_SEM > 0) {
      const pre = precomputedClusterScores[c.gameId];
      if (pre) {
        clusterSemanticSim = pre.sim;
        bestClusterLabel = pre.label;
      } else if (hasPrecomputedClusterScores) {
        // No embedding for this candidate: neutral (median), not a penalty. No label, so no explanation.
        clusterSemanticSim = clusterMedian;
      } else if (c.embedding && c.embedding.length > 0) {
        for (let ci = 0; ci < clusterCentroids.length; ci++) {
          const sim = computeSemanticSimilarity(clusterCentroids[ci].centroid, c.embedding);
          if (sim > clusterSemanticSim) {
            clusterSemanticSim = sim;
            bestClusterIdx = ci;
          }
        }
        bestClusterLabel = bestClusterIdx >= 0 ? clusterLabels[bestClusterIdx] : undefined;
      }
    }

    // Layer 7: Graph traversal (uses pre-built context — no per-candidate Set allocations)
    const graph = graphByCandidate.get(c.gameId)!;
    const graphSignal = graph.score;

    // Layer 8: Quality signal (with review sentiment)
    const qualitySignal = computeQualitySignal(c);

    // Layer 9: Popularity debiasing
    const popularitySignal = computePopularitySignal(c.playerCount, maxPlayerCount);

    // Recency boost
    const recencyBoost = computeRecencyBoost(c.releaseDate, now);

    // Diversity bonus (uses pre-computed profile genre weights; canonical genres)
    const cCanonGenres = c.genres.map(g => toCanonicalGenre(g)).filter(Boolean) as string[];
    const diversityBonus = computeDiversityBonus(cCanonGenres, tasteProfile.genres, maxGenreWeight);

    // Layer 10: Time-of-day contextual boost (uses hoisted context)
    const timeOfDayBoost = computeTimeOfDayBoost(c, todCtx);

    // Layer 11: Franchise boost
    const franchise = computeFranchiseBoost(c, franchises, userGameIds);
    const franchiseBoost = franchise.boost;

    // Layer 12: Studio loyalty boost
    const studioLoyaltyBoost = computeStudioLoyaltyBoost(c, tasteProfile.loyalDevelopers, tasteProfile);

    // Layer 13: Session sequencing (uses hoisted context)
    const sequencingBoost = computeSequencingBoost(c, seqCtx);

    // Layer 3: Negative signal — dense cosine between negative profile and candidate indices
    const negativeSignal = negativeProfile.strength > 0
      ? fastCosineProfileVsCandidate(negVecDense, negMag, candidateIndices, candidateMag) * negativeProfile.strength
      : 0;

    // Positive affinity — dense cosine between thumbs-up profile and candidate
    const positiveAffinity = positiveProfile.strength > 0
      ? fastCosineProfileVsCandidate(posVecDense, posMag, candidateIndices, candidateMag) * positiveProfile.strength
      : 0;

    // Engagement curve bonus (uses pre-computed canonical genre norm sets)
    let engagementCurveBonus = 0;
    const cGenresNorm = new Set(c.genres.map(g => toCanonicalGenre(g)).filter((x): x is NonNullable<typeof x> => x !== null).map(x => norm(x)));
    for (const ug of userGames) {
      const curveMult = CURVE_MULTIPLIERS[ug.engagementPattern || 'unknown'];
      if (curveMult > 1.1) {
        const ugGN = ugGenreNorms.get(ug.gameId)!;
        let overlap = 0;
        for (const g of cGenresNorm) {
          if (ugGN.has(g)) overlap++;
        }
        if (overlap > 0) {
          engagementCurveBonus = Math.max(engagementCurveBonus, (curveMult - 1) * (overlap / Math.max(cGenresNorm.size || 1, 1)));
        }
      }
    }
    engagementCurveBonus = clamp01(engagementCurveBonus);

    // Shared features for reasons (canonical genres that match profile)
    const sharedGenres: string[] = [...new Set(c.genres.map(g => toCanonicalGenre(g)).filter((x): x is NonNullable<typeof x> => x !== null).filter(x => profileGenresNorm.has(norm(x))))];
    const sharedThemes = c.themes.filter(t => profileThemes.has(norm(t)));
    const sharedModes = c.gameModes.filter(m => profileModes.has(norm(m)));

    const isHiddenGem = (c.metacriticScore ?? 0) >= 80
      && (c.playerCount ?? Infinity) < hiddenGemPlayerCeiling;
    // A genre only the user rejected is not "intentional variety" — exclude it from Stretch Picks.
    const isStretchPick = cCanonGenres.length > 0 && sharedGenres.length === 0
      && !cCanonGenres.some(x => rejectedGenresNorm.has(norm(x)));
    const isOnSale = !!c.price?.discountPercent && c.price.discountPercent > 0;

    // ML model signal: only when a real score was attached (no ?? 0.5 under W_ML)
    const mlSignal = c.mlScore != null && Number.isFinite(c.mlScore) ? c.mlScore : mlMedian;

    // Layer 14: Graph metrics (PageRank quality propagation + Louvain community affinity)
    let graphPageRankSignal = 0;
    let graphCommunityAffinity = 0;
    if (hasGraphScores) {
      const gs = graphScores[c.gameId];
      if (gs) {
        graphPageRankSignal = clamp01(gs.pageRank / maxGraphPageRank);
        const inCommunity = userCommunityCounts[gs.community] ?? 0;
        graphCommunityAffinity = clamp01(inCommunity / userCommunityTotal);
      }
    }

    // F8: light lexical notes overlap with loved games (cap ≤ 0.05)
    const notesBonus = computeNotesThemeBonus(c, lovedNotesTokens);

    // Final composite score
    const score = clamp01(
      contentSimilarity * (W_CONTENT + W_CONTENT_ML) +
      semanticSimilarity * W_SEMANTIC +
      clusterSemanticSim * W_CLUSTER_SEM +
      graphSignal * W_GRAPH +
      qualitySignal * (W_QUALITY + W_QUALITY_ML) +
      popularitySignal * W_POPULARITY +
      recencyBoost * W_RECENCY +
      diversityBonus * W_DIVERSITY +
      timeOfDayBoost * W_TIME +
      engagementCurveBonus * W_CURVE +
      franchiseBoost * W_FRANCHISE +
      studioLoyaltyBoost * W_STUDIO +
      sequencingBoost * W_SEQUENCING +
      mlSignal * W_ML +
      graphPageRankSignal * W_GRAPH_PAGERANK +
      graphCommunityAffinity * W_GRAPH_COMMUNITY +
      notesBonus +
      positiveAffinity * W_POSITIVE -
      negativeSignal * W_NEGATIVE
    );
    if (!Number.isFinite(score)) { nonFiniteScores++; continue; }

    scored.push({
      gameId: c.gameId,
      title: c.title,
      coverUrl: c.coverUrl,
      headerImage: c.headerImage,
      developer: c.developer,
      publisher: c.publisher,
      genres: c.genres,
      themes: c.themes,
      gameModes: c.gameModes,
      platforms: c.platforms,
      metacriticScore: c.metacriticScore,
      playerCount: c.playerCount,
      releaseDate: c.releaseDate,
      score,
      layerScores: {
        contentSimilarity,
        semanticSimilarity,
        clusterSemanticSim,
        graphSignal,
        qualitySignal,
        popularitySignal,
        recencyBoost,
        diversityBonus,
        trajectoryMultiplier: 1,
        negativeSignal,
        positiveAffinity,
        timeOfDayBoost,
        engagementCurveBonus,
        franchiseBoost,
        studioLoyaltyBoost,
        sequencingBoost,
        mlSignal,
        graphPageRankSignal,
        graphCommunityAffinity,
      },
      reasons: {
        sharedGenres,
        sharedThemes,
        sharedModes,
        similarTo: graph.similarTo,
        metacriticScore: c.metacriticScore,
        popularityRank: c.playerCount,
        isHiddenGem,
        isStretchPick,
        franchiseOf: franchise.franchiseName,
        isFranchiseEntry: franchise.isFranchiseEntry,
        isOnSale,
        semanticRetrieved: c.semanticRetrieved === true,
        lexicalRetrieved: c.lexicalRetrieved === true,
        annDistance: c.annDistance,
        bestClusterLabel,
        explanation: '',
        comingSoon: c.comingSoon === true,
      },
      ...(c.price ? { price: c.price } : {}),
    });

    if (i % scoringProgressStep === 0) {
      const pct = 28 + Math.floor((i / totalCandidates) * 30);
      progress(`Scoring candidates... (${i.toLocaleString()}/${totalCandidates.toLocaleString()})`, pct);
    }

    if (i % 2000 === 0 && i > 0) await new Promise(r => setTimeout(r, 4));
  }

  // Display calibration: raw scores sit in a narrow low band, so "N% match" is the pool-relative position
  // between its 5th percentile and its best score (kept within 1–99).
  if (scored.length > 0) {
    const sortedScores = scored.map(s => s.score).sort((a, b) => a - b);
    const lo = quantileSorted(sortedScores, 0.05);
    // 98th percentile, not the maximum: one outlier must not compress everyone else (and pin the top pick at 99%).
    const hi = quantileSorted(sortedScores, 0.98);
    for (const s of scored) s.matchPct = Math.min(99, Math.max(1, calibrateMatchPercent(s.score, lo, hi)));
  }

  // ── 14. Diversity re-ranking (MMR) ──
  progress('Applying diversity filter...', 60);
  // F2: hero/next-obsession prefers evidence-aligned scores
  scored.sort((a, b) => {
    const alignA = 0.5 * a.layerScores.contentSimilarity + 0.5 * a.layerScores.semanticSimilarity;
    const alignB = 0.5 * b.layerScores.contentSimilarity + 0.5 * b.layerScores.semanticSimilarity;
    return heroEvidenceSortKey(b.score, alignB) - heroEvidenceSortKey(a.score, alignA);
  });
  const MMR_POOL_SIZE = 500;
  // Unreleased titles are for the dedicated Coming Soon / Upcoming Sequels shelves (built from allScored),
  // not the main shelves — a game you cannot play yet is not a top pick.
  const mmrPool = scored.filter(sg => !isComingSoonForShelf(sg.releaseDate, sg.reasons.comingSoon, now)).slice(0, MMR_POOL_SIZE);
  // Relevance = the evidence-aligned hero key (so the hero pick is not overridden by a plain score sort);
  // similarity = embedding-sketch cosine (genre-Jaccard where a game has no sketch), franchise and developer.
  const reranked = mmrRerank(mmrPool, 0.7, 80, (f) => {
    progress('Applying diversity filter...', 60 + Math.floor(f * 8));
  }, {
    relevance: g => heroEvidenceSortKey(g.score, 0.5 * g.layerScores.contentSimilarity + 0.5 * g.layerScores.semanticSimilarity),
    vectors: input.mmrVectors,
  });

  // (Clusters already detected at step 8 for centroid scoring)

  // ── 16. Generate explanations ──
  progress('Generating insights...', 76);
  for (const s of reranked) {
    const prose = generateExplanation(s, userGames, tasteProfile);
    s.reasons.explanation = prose;
    s.explanation = [prose];
  }

  // ── 17. Shelf assembly ──
  progress('Building shelves...', 84);
  const shelves = buildShelvesFromScored(reranked, scored, userGames, tasteProfile, clusters, franchises, tasteCentroid, now);

  const telemetry = computeRecoTelemetry({
    scored,
    weights: {
      contentSimilarity: W_CONTENT + W_CONTENT_ML,
      semanticSimilarity: W_SEMANTIC,
      clusterSemanticSim: W_CLUSTER_SEM,
      graphSignal: W_GRAPH,
      qualitySignal: W_QUALITY + W_QUALITY_ML,
      popularitySignal: W_POPULARITY,
      recencyBoost: W_RECENCY,
      diversityBonus: W_DIVERSITY,
      timeOfDayBoost: W_TIME,
      engagementCurveBonus: W_CURVE,
      franchiseBoost: W_FRANCHISE,
      studioLoyaltyBoost: W_STUDIO,
      sequencingBoost: W_SEQUENCING,
      mlSignal: W_ML,
      graphPageRankSignal: W_GRAPH_PAGERANK,
      graphCommunityAffinity: W_GRAPH_COMMUNITY,
      positiveAffinity: W_POSITIVE,
      negativeSignal: W_NEGATIVE,
    },
    funnel: {
      candidatesIn: candidates.length,
      afterExclusions: filteredCandidates.length,
      scored: scored.length,
      mmrPool: mmrPool.length,
      mmrSelected: reranked.length,
      shelfGames: shelves.reduce((n, sh) => n + sh.games.length, 0),
      nonFinite: nonFiniteScores,
    },
    embeddingCoverage,
    mlCoverage,
    graphScoresAvailable: hasGraphScores,
  });

  return { tasteProfile, shelves, telemetry };
}

// ─── Shelf Assembly ────────────────────────────────────────────────────────────

function buildShelvesFromScored(
  reranked: ScoredGame[],
  allScored: ScoredGame[],
  userGames: UserGameSnapshot[],
  profile: TasteProfile,
  clusters: TasteCluster[],
  franchises: FranchiseCluster[],
  tasteCentroid: Float64Array | null,
  nowMs: number,
): RecoShelf[] {
  const shelves: RecoShelf[] = [];
  const usedGameIds = new Set<string>();
  // Pool-relative relevance floor (above-median): absolute score thresholds drift whenever weights/signals change.
  const poolRelevanceFloor = allScored.length > 0
    ? quantileSorted(allScored.map(sg => sg.score).sort((a, b) => a - b), 0.5)
    : 0;

  const addToUsed = (games: ScoredGame[]) => {
    for (const g of games) usedGameIds.add(g.gameId);
  };

  // Hero — top pick
  if (reranked.length > 0) {
    shelves.push({
      type: 'hero',
      title: 'Your Next Obsession',
      games: [reranked[0]],
    });
    addToUsed([reranked[0]]);
  }

  // "Complete the Series" — franchise entries the user hasn't played
  for (const franchise of franchises.slice(0, 3)) {
    // Skip franchises the user rated poorly (they are a negative signal) or never actually played.
    if (franchise.userAvgRating > 0 && franchise.userAvgRating < 3) continue;
    if (franchise.userPlayedIds.length === 0) continue;

    const missingEntries = franchise.entries
      .filter(e => !e.isUserOwned)
      .map(e => reranked.find(r => r.gameId === e.gameId) || allScored.find(s => s.gameId === e.gameId))
      .filter((s): s is ScoredGame => !!s && !usedGameIds.has(s.gameId));

    if (missingEntries.length >= 1) {
      shelves.push({
        type: 'complete-the-series',
        title: `Complete the ${franchise.displayName} Series`,
        subtitle: 'Same series as games you own — not just a shared brand',
        games: missingEntries.slice(0, 10),
      });
      addToUsed(missingEntries.slice(0, 10));
    }
  }

  // "Because you loved X": the seed must be a game the user actually liked (a hated 80h game is not
  // "loved"), and — since each pick's similarTo keeps only its 3 strongest links — we try the user's
  // top few seeds and use the first one that has enough picks, instead of betting on a single title.
  const seedCandidates = [...userGames]
    .filter(g => g.title && computeEngagementWeight(g) > 0 && (g.rating >= 4 || g.hoursPlayed >= 20))
    .sort((a, b) => computeEngagementScore(b, nowMs) - computeEngagementScore(a, nowMs))
    .slice(0, 5);

  for (const seed of seedCandidates) {
    const becauseGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.reasons.similarTo.some(t => norm(t) === norm(seed.title)))
      .slice(0, 12);
    if (becauseGames.length >= 2) {
      shelves.push({
        type: 'because-you-loved',
        title: `Because you loved ${seed.title}`,
        seedGameTitle: seed.title,
        games: becauseGames,
      });
      addToUsed(becauseGames);
      break;
    }
  }

  // "From Studios You Love"
  if (profile.loyalDevelopers.length > 0 || profile.loyalPublishers.length > 0) {
    const studioGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.layerScores.studioLoyaltyBoost > 0)
      .slice(0, 12);

    if (studioGames.length >= 2) {
      const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const studioNames = [
        ...profile.loyalDevelopers.slice(0, 2).map(titleCase),
        ...profile.loyalPublishers.filter(p => !profile.loyalDevelopers.includes(p)).slice(0, 2).map(titleCase),
      ].slice(0, 3);
      shelves.push({
        type: 'from-studios-you-love',
        title: 'From Studios You Love',
        subtitle: `Games by ${studioNames.join(', ')}`,
        games: studioGames,
      });
      addToUsed(studioGames);
    }
  }

  // "Deep in [Genre]" — primary canonical genre must equal topGenre
  if (profile.topGenre) {
    const genreGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && matchesDeepInGenre(s.genres, profile.topGenre))
      .slice(0, 12);

    if (genreGames.length >= 2) {
      const displayGenre = profile.topGenre.charAt(0).toUpperCase() + profile.topGenre.slice(1);
      shelves.push({
        type: 'deep-in-genre',
        title: `Deep in ${displayGenre}`,
        subtitle: `Primary genre is ${displayGenre}`,
        games: genreGames,
      });
      addToUsed(genreGames);
    }
  }

  // "For your [mood]" — require the cluster label genre on the candidate
  for (const cluster of clusters) {
    if (!cluster.label || cluster.gameCount < 2) continue;
    const labelGenre = cluster.profile.topGenre || cluster.label;
    const clusterGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && matchesMoodShelf(s.genres, labelGenre))
      .slice(0, 10);

    if (clusterGames.length >= 3) {
      shelves.push({
        type: 'for-your-mood',
        title: `For your ${cluster.label} side`,
        subtitle: cluster.topGames.filter(Boolean).length > 0 ? `Based on ${cluster.topGames.filter(Boolean).slice(0, 2).join(' & ')}` : undefined,
        games: clusterGames,
      });
      addToUsed(clusterGames);
    }
  }

  // Catalogue-style shelves (Hidden Gems, Deals, Free, Critics' Choice, New Releases, Trending) are built from
  // the WHOLE scored pool, not the ~80 MMR survivors (which are chosen for taste, so a hidden gem or a deal had
  // to be a top-80 taste pick to appear at all). They keep a relevance floor (above-median score) so they stay
  // "for you", and are de-duplicated per shelf (≤2 per developer, 1 per franchise).
  const poolByScore = allScored
    .filter(s => !isComingSoonForShelf(s.releaseDate, s.reasons.comingSoon, nowMs) && s.score >= poolRelevanceFloor)
    .sort((a, b) => b.score - a.score);
  const pickDiverse = (list: ScoredGame[], limit: number): ScoredGame[] => {
    const perDev = new Map<string, number>();
    const franchises = new Set<string>();
    const out: ScoredGame[] = [];
    for (const g of list) {
      if (out.length >= limit) break;
      if (usedGameIds.has(g.gameId)) continue;
      const dev = splitCreditedNames(g.developer)[0] ?? '';
      const base = canonicalFranchiseBase(g.title);
      if (dev && (perDev.get(dev) ?? 0) >= 2) continue;
      if (base && franchises.has(base)) continue;
      if (dev) perDev.set(dev, (perDev.get(dev) ?? 0) + 1);
      if (base) franchises.add(base);
      out.push(g);
    }
    return out;
  };

  // Hidden Gems
  const hiddenGems = pickDiverse(poolByScore.filter(s => s.reasons.isHiddenGem), 12);
  if (hiddenGems.length >= 2) {
    shelves.push({
      type: 'hidden-gems',
      title: 'Hidden Gems',
      subtitle: 'Critically acclaimed, under the radar',
      games: hiddenGems,
    });
    addToUsed(hiddenGems);
  }

  // Deals For You — games on sale matching user taste
  const deals = pickDiverse(
    poolByScore
      .filter(s => s.reasons.isOnSale && s.price?.discountPercent && s.price.discountPercent >= 20)
      .sort((a, b) => (b.price?.discountPercent ?? 0) - (a.price?.discountPercent ?? 0)),
    12,
  );

  if (deals.length >= 2) {
    shelves.push({
      type: 'deals-for-you',
      title: 'Deals For You',
      subtitle: 'Games on sale that match your taste',
      games: deals,
    });
    addToUsed(deals);
  }

  // Free For You — free games matching user taste
  const freeGames = pickDiverse(poolByScore.filter(s => s.price?.isFree), 12);

  if (freeGames.length >= 2) {
    shelves.push({
      type: 'free-for-you',
      title: 'Free For You',
      subtitle: 'Great free games matching your taste',
      games: freeGames,
    });
    addToUsed(freeGames);
  }

  // Critics' Choice
  const criticsChoice = pickDiverse(
    poolByScore
      .filter(s => (s.metacriticScore ?? 0) >= 85)
      .sort((a, b) => (b.metacriticScore ?? 0) - (a.metacriticScore ?? 0) || b.score - a.score),
    12,
  );

  if (criticsChoice.length >= 2) {
    shelves.push({
      type: 'critics-choice',
      title: "Critics' Choice",
      subtitle: 'Top-rated by reviewers, matched to your taste',
      games: criticsChoice,
    });
    addToUsed(criticsChoice);
  }

  // Stretch Picks — prefer low content AND low semantic to evidence taste (F2)
  const stretchPicks = reranked
    .filter(s => !usedGameIds.has(s.gameId) && s.reasons.isStretchPick && s.score > 0.12)
    .sort((a, b) => {
      const farA = a.layerScores.contentSimilarity + a.layerScores.semanticSimilarity;
      const farB = b.layerScores.contentSimilarity + b.layerScores.semanticSimilarity;
      return farA - farB || b.score - a.score;
    })
    .slice(0, 12);

  if (stretchPicks.length >= 2) {
    shelves.push({
      type: 'stretch-picks',
      title: 'Stretch Picks',
      subtitle: 'Far from your evidence taste — intentional variety',
      games: stretchPicks,
    });
    addToUsed(stretchPicks);
  }

  // New Releases For You
  const sixtyDaysAgo = nowMs - 60 * 24 * 60 * 60 * 1000;
  const newReleases = pickDiverse(
    poolByScore.filter(s => {
      const rd = new Date(s.releaseDate).getTime();
      return !isNaN(rd) && rd > sixtyDaysAgo && rd <= nowMs;
    }),
    12,
  );

  if (newReleases.length >= 2) {
    shelves.push({
      type: 'new-releases-for-you',
      title: 'New Releases For You',
      subtitle: 'Recently launched games matching your taste',
      games: newReleases,
    });
    addToUsed(newReleases);
  }

  // Upcoming Sequels — franchise entries with a real future releaseDate only
  const upcomingSequels = allScored
    .filter(s => {
      if (usedGameIds.has(s.gameId)) return false;
      if (!s.reasons.isFranchiseEntry) return false;
      return isFutureReleaseDate(s.releaseDate, nowMs);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (upcomingSequels.length >= 1) {
    shelves.push({
      type: 'upcoming-sequels',
      title: 'Upcoming Sequels',
      subtitle: 'Dated sequels in series you own',
      games: upcomingSequels,
    });
    addToUsed(upcomingSequels);
  }

  // Coming Soon For You — empty date ≠ upcoming; honor comingSoon flag. Same pool-relative floor.
  const comingSoonFloor = poolRelevanceFloor;
  const comingSoon = allScored
    .filter(s => {
      if (usedGameIds.has(s.gameId)) return false;
      return isComingSoonForShelf(s.releaseDate, s.reasons.comingSoon, nowMs);
    })
    .filter(s => s.score >= comingSoonFloor)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (comingSoon.length >= 2) {
    shelves.push({
      type: 'coming-soon-for-you',
      title: 'Coming Soon For You',
      subtitle: 'Upcoming games you might love',
      games: comingSoon,
    });
    addToUsed(comingSoon);
  }

  // Trending Now
  const trending = pickDiverse(
    poolByScore
      .filter(s => (s.playerCount ?? 0) > 0)
      .sort((a, b) => (b.playerCount ?? 0) - (a.playerCount ?? 0)),
    12,
  );

  if (trending.length >= 2) {
    shelves.push({
      type: 'trending-now',
      title: 'Trending Now',
      subtitle: 'Popular games that match your taste',
      games: trending,
    });
    addToUsed(trending);
  }

  // "Finish and Try"
  const onHoldGames = userGames.filter(g => g.status === 'On Hold' && g.title);
  if (onHoldGames.length > 0) {
    const topOnHold = onHoldGames.sort((a, b) => b.hoursPlayed - a.hoursPlayed)[0];
    const topOnHoldCanonNorm = new Set(topOnHold.genres.map(g => toCanonicalGenre(g)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c)));
    const finishAndTry = reranked
      .filter(s => !usedGameIds.has(s.gameId) &&
        (s.reasons.similarTo.some(t => norm(t) === norm(topOnHold.title)) ||
        s.genres.some(g => topOnHoldCanonNorm.has(norm(toCanonicalGenre(g) ?? g)))))
      .slice(0, 8);

    if (finishAndTry.length >= 2) {
      shelves.push({
        type: 'finish-and-try',
        title: `Finish ${topOnHold.title}, then try...`,
        subtitle: 'Motivation to complete what you started',
        seedGameTitle: topOnHold.title,
        games: finishAndTry,
      });
      addToUsed(finishAndTry);
    }
  }

  // Unfinished Business
  const unfinished = userGames
    .filter(g => g.title && (g.status === 'Playing' || g.status === 'On Hold' || g.status === 'Playing Now'))
    .sort((a, b) => {
      const aTime = a.lastSessionDate ? new Date(a.lastSessionDate).getTime() : new Date(a.addedAt).getTime();
      const bTime = b.lastSessionDate ? new Date(b.lastSessionDate).getTime() : new Date(b.addedAt).getTime();
      return aTime - bTime;
    })
    .slice(0, 8)
    .map((g): ScoredGame => ({
      gameId: g.gameId,
      title: g.title,
      coverUrl: undefined,
      headerImage: undefined,
      developer: g.developer,
      publisher: g.publisher,
      genres: g.genres,
      themes: g.themes,
      gameModes: g.gameModes,
      platforms: [],
      metacriticScore: null,
      playerCount: null,
      releaseDate: g.releaseDate,
      score: 0,
      layerScores: {
        contentSimilarity: 0, semanticSimilarity: 0, clusterSemanticSim: 0,
        graphSignal: 0, qualitySignal: 0, popularitySignal: 0, recencyBoost: 0,
        diversityBonus: 0, trajectoryMultiplier: 0, negativeSignal: 0,
        timeOfDayBoost: 0, engagementCurveBonus: 0,
        franchiseBoost: 0, studioLoyaltyBoost: 0, sequencingBoost: 0,
        mlSignal: 0,
      },
      reasons: {
        sharedGenres: [], sharedThemes: [], sharedModes: [],
        similarTo: [], metacriticScore: null, popularityRank: null,
        isHiddenGem: false, isStretchPick: false,
        isFranchiseEntry: false, isOnSale: false,
        semanticRetrieved: false,
        explanation: `You've been playing this — pick it back up!`,
      },
    }));

  if (unfinished.length >= 1) {
    shelves.push({
      type: 'unfinished-business',
      title: 'Unfinished Business',
      subtitle: "Games you started but haven't completed",
      games: unfinished,
    });
  }

  // ── Backlog Advisor ──
  // Surface "Want to Play" games, ranked by how well they fit the user's
  // current taste profile — effectively a prioritized play-next queue.
  // Uses the same semantic centroid + content similarity as the main pipeline.
  const backlogCandidates = userGames
    .filter(g =>
      g.status === 'Want to Play'
      && g.hoursPlayed === 0
      && isReleasedPlayableForBacklog(g.releaseDate, nowMs),
    )
    .map((g): ScoredGame => {
      const genreOverlapCount = g.genres.filter(gn => {
        const cn = toCanonicalGenre(gn) ?? gn;
        return profile.genres.some(pg => pg.name.toLowerCase() === cn.toLowerCase());
      }).length;
      const themeOverlapCount = g.themes.filter(t =>
        profile.themes.some(pt => pt.name.toLowerCase() === t.toLowerCase())
      ).length;
      const genreOverlap = g.genres.length > 0 ? clamp01(genreOverlapCount / g.genres.length) : 0;
      const themeOverlap = g.themes.length > 0 ? clamp01(themeOverlapCount / g.themes.length) : 0;
      const gDevs = splitCreditedNames(g.developer);
      const gPubs = splitCreditedNames(g.publisher);
      const devMatch = profile.loyalDevelopers.some(d => gDevs.includes(d)) ? 1 : 0;
      const pubMatch = profile.loyalPublishers.some(p => gPubs.includes(p)) ? 0.5 : 0;
      const ratingBoost = g.rating > 0 ? g.rating / 5 : 0;

      const semanticSim = computeSemanticSimilarity(tasteCentroid, g.embedding);
      // F8: High-priority WtP gets intent boost on wishlist ordering only
      const priorityBoost = g.priority === 'High' ? 0.12 : 0;

      const score = clamp01(tasteCentroid && semanticSim > 0
        ? genreOverlap * 0.20 + themeOverlap * 0.10 + devMatch * 0.15 + pubMatch * 0.05
          + ratingBoost * 0.10 + semanticSim * 0.30 + 0.10 + priorityBoost
        : genreOverlap * 0.30 + themeOverlap * 0.15 + devMatch * 0.20 + pubMatch * 0.10
          + ratingBoost * 0.15 + 0.10 + priorityBoost);

      const reasons: string[] = [];
      if (semanticSim > 0.3) reasons.push('Strong semantic match to your taste');
      if (genreOverlapCount > 0) reasons.push(`Matches ${genreOverlapCount} of your top genres`);
      if (devMatch) reasons.push(`From ${g.developer}, a studio you love`);
      if (themeOverlapCount > 0) reasons.push(`${themeOverlapCount} shared themes with your favourites`);

      return {
        gameId: g.gameId,
        title: g.title,
        coverUrl: undefined,
        headerImage: undefined,
        developer: g.developer,
        publisher: g.publisher,
        genres: g.genres,
        themes: g.themes,
        gameModes: g.gameModes,
        platforms: [],
        metacriticScore: null,
        playerCount: null,
        releaseDate: g.releaseDate,
        score,
        layerScores: {
          contentSimilarity: genreOverlap, semanticSimilarity: clamp01(semanticSim), clusterSemanticSim: 0,
          graphSignal: 0, qualitySignal: 0, popularitySignal: 0, recencyBoost: 0,
          diversityBonus: 0, trajectoryMultiplier: 0, negativeSignal: 0,
          timeOfDayBoost: 0, engagementCurveBonus: 0,
          franchiseBoost: devMatch * 0.2, studioLoyaltyBoost: pubMatch * 0.1, sequencingBoost: 0,
          mlSignal: 0,
        },
        reasons: {
          sharedGenres: g.genres.filter(gn => profile.genres.some(pg => pg.name.toLowerCase() === gn.toLowerCase())),
          sharedThemes: g.themes.filter(t => profile.themes.some(pt => pt.name.toLowerCase() === t.toLowerCase())),
          sharedModes: [],
          similarTo: [],
          metacriticScore: null,
          popularityRank: null,
          isHiddenGem: false,
          isStretchPick: false,
          isFranchiseEntry: false,
          isOnSale: false,
          semanticRetrieved: false,
          explanation: reasons.length > 0 ? reasons.join('. ') : 'In your backlog — matches your current taste',
        },
        explanation: reasons,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (backlogCandidates.length >= 1) {
    shelves.push({
      type: 'backlog-advisor',
      title: 'Backlog Advisor',
      subtitle: 'Your wishlist, ranked by your current taste',
      games: backlogCandidates,
    });
  }

  return shelves;
}

// ─── Worker Entry ──────────────────────────────────────────────────────────────

let _running = false;
self.onmessage = async (e: MessageEvent<RecoWorkerInput>) => {
  if (_running) return;
  _running = true;
  const t0 = performance.now();

  try {
    const { tasteProfile, shelves, telemetry } = await runPipeline(e.data);
    const computeTimeMs = Math.round(performance.now() - t0);

    self.postMessage({
      type: 'result',
      tasteProfile,
      shelves,
      computeTimeMs,
      telemetry,
    } satisfies RecoWorkerMessage);
  } catch (err) {
    console.error('[reco.worker] Pipeline failed:', err);
    self.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      computeTimeMs: Math.round(performance.now() - t0),
    } satisfies RecoWorkerMessage);
  } finally {
    _running = false;
  }
};
