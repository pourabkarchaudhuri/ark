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

import type {
  RecoWorkerInput,
  RecoWorkerMessage,
  UserGameSnapshot,
  CandidateGame,
  TasteProfile,
  FeatureWeight,
  ScoredGame,
  RecoShelf,
  TasteCluster,
  EngagementPattern,
  FranchiseCluster,
  FranchiseEntry,
} from '@/types/reco';
import { toCanonicalGenre, toCanonicalGenres, CANONICAL_GENRES } from '@/data/canonical-genres';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function progress(stage: string, percent: number) {
  self.postMessage({ type: 'progress', stage, percent } satisfies RecoWorkerMessage);
}

const norm = (s: string) => s.toLowerCase().trim();
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ─── Layer 1: Taste Profile ────────────────────────────────────────────────────

const STATUS_WEIGHTS: Record<string, number> = {
  'Completed': 1.0,
  'Playing Now': 0.9,
  'Playing': 0.7,
  'On Hold': 0.3,
  'Want to Play': 0.1,
};

// ─── Layer 2: Engagement Curve Analysis ────────────────────────────────────────

const CURVE_MULTIPLIERS: Record<EngagementPattern, number> = {
  'long-tail': 1.4,
  'slow-burn': 1.3,
  'honeymoon': 0.9,
  'binge-drop': 0.6,
  'unknown': 1.0,
};

function classifyEngagementCurve(snap: UserGameSnapshot): EngagementPattern {
  const { sessionTimestamps, sessionDurations, sessionCount } = snap;

  if (sessionCount < 3) return 'unknown';

  const firstTime = Math.min(...sessionTimestamps);
  const lastTime = Math.max(...sessionTimestamps);
  const spanDays = (lastTime - firstTime) / (1000 * 60 * 60 * 24);

  if (spanDays <= 3 && sessionCount >= 3) return 'binge-drop';

  const isSpread = spanDays >= 14;

  if (sessionDurations.length >= 4) {
    const firstHalf = sessionDurations.slice(0, Math.floor(sessionDurations.length / 2));
    const secondHalf = sessionDurations.slice(Math.floor(sessionDurations.length / 2));
    const avgFirst = firstHalf.reduce((s, d) => s + d, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d, 0) / secondHalf.length;

    if (avgSecond > avgFirst * 1.2 && isSpread) return 'slow-burn';
  }

  if (sessionDurations.length >= 5) {
    const firstThree = sessionDurations.slice(0, 3);
    const rest = sessionDurations.slice(3);
    const avgFirstThree = firstThree.reduce((s, d) => s + d, 0) / firstThree.length;
    const avgRest = rest.reduce((s, d) => s + d, 0) / rest.length;

    if (avgFirstThree > avgRest * 1.5) return 'honeymoon';
  }

  if (isSpread) return 'long-tail';

  return 'unknown';
}

// Engagement score cache — reset per pipeline run to avoid stale values
const _engagementCache = new Map<string, number>();

function computeEngagementScore(game: UserGameSnapshot, now: number): number {
  const cached = _engagementCache.get(game.gameId);
  if (cached !== undefined) return cached;

  const maxHours = 500;
  const normalizedHours = clamp01(Math.min(game.hoursPlayed, maxHours) / maxHours);
  const normalizedRating = game.rating / 5;
  const statusScore = STATUS_WEIGHTS[game.status] ?? 0.3;

  const sessionDepth = game.sessionCount > 0
    ? clamp01(game.avgSessionMinutes / 240)
    : normalizedHours * 0.3;

  const HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
  const addedTime = new Date(game.addedAt).getTime();
  const lastActivity = game.lastSessionDate
    ? new Date(game.lastSessionDate).getTime()
    : addedTime;
  const age = now - lastActivity;
  const temporalDecay = Math.pow(0.5, age / HALF_LIFE_MS);

  const curvePattern = game.engagementPattern || classifyEngagementCurve(game);
  const curveMult = CURVE_MULTIPLIERS[curvePattern];

  const baseScore =
    normalizedHours * 0.28 +
    normalizedRating * 0.25 +
    statusScore * 0.18 +
    sessionDepth * 0.14 +
    temporalDecay * 0.10 +
    (curveMult - 1) * 0.05;

  const result = clamp01(baseScore * curveMult);
  _engagementCache.set(game.gameId, result);
  return result;
}

function buildFeatureMap(
  games: UserGameSnapshot[],
  now: number,
  extractor: (g: UserGameSnapshot) => string[],
): FeatureWeight[] {
  const map = new Map<string, { weight: number; count: number; hours: number; ratingSum: number; ratedCount: number }>();

  for (const game of games) {
    const engagement = computeEngagementScore(game, now);
    const features = extractor(game);
    for (const f of features) {
      const key = norm(f);
      if (!key) continue;
      const existing = map.get(key) || { weight: 0, count: 0, hours: 0, ratingSum: 0, ratedCount: 0 };
      existing.weight += engagement;
      existing.count += 1;
      existing.hours += game.hoursPlayed;
      if (game.rating > 0) {
        existing.ratingSum += game.rating;
        existing.ratedCount += 1;
      }
      map.set(key, existing);
    }
  }

  return Array.from(map.entries())
    .map(([name, data]) => ({
      name,
      weight: data.weight,
      gameCount: data.count,
      totalHours: data.hours,
      avgRating: data.ratedCount > 0 ? data.ratingSum / data.ratedCount : 0,
    }))
    .sort((a, b) => b.weight - a.weight);
}

function getReleaseBucket(dateStr: string): string {
  const year = new Date(dateStr).getFullYear();
  if (isNaN(year)) return 'unknown';
  if (year >= 2023) return '2023+';
  if (year >= 2020) return '2020-2022';
  if (year >= 2015) return '2015-2019';
  if (year >= 2010) return '2010-2014';
  if (year >= 2000) return '2000-2009';
  return 'pre-2000';
}

function buildTasteProfile(games: UserGameSnapshot[], now: number): TasteProfile {
  const genresRaw = buildFeatureMap(games, now, g => toCanonicalGenres(g.genres || []));
  const genres = genresRaw.map(g => ({
    ...g,
    name: CANONICAL_GENRES.find(c => norm(c) === g.name) ?? g.name,
  }));
  const themes = buildFeatureMap(games, now, g => g.themes);
  const gameModes = buildFeatureMap(games, now, g => g.gameModes);
  const perspectives = buildFeatureMap(games, now, g => g.perspectives);
  const developers = buildFeatureMap(games, now, g => [g.developer].filter(Boolean));
  const publishers = buildFeatureMap(games, now, g => [g.publisher].filter(Boolean));
  const eras = buildFeatureMap(games, now, g => g.releaseDate ? [getReleaseBucket(g.releaseDate)] : []);

  const totalHours = games.reduce((s, g) => s + g.hoursPlayed, 0);
  const ratedGames = games.filter(g => g.rating > 0);
  const avgRating = ratedGames.length > 0
    ? ratedGames.reduce((s, g) => s + g.rating, 0) / ratedGames.length
    : 0;

  // Detect loyal developers: ≥2 games, avg rating ≥3.5 or ≥20 hours
  const loyalDevelopers = developers
    .filter(d => d.gameCount >= 2 && (d.avgRating >= 3.5 || d.totalHours >= 20))
    .map(d => d.name);

  return {
    genres,
    themes,
    gameModes,
    perspectives,
    developers,
    publishers,
    eras,
    totalGames: games.length,
    totalHours,
    avgRating,
    topGenre: genres[0]?.name ?? '',
    topTheme: themes[0]?.name ?? '',
    clusters: [],
    loyalDevelopers,
  };
}

// ─── Layer 3: Negative Signal Mining ────────────────────────────────────────────

function buildNegativeProfile(
  games: UserGameSnapshot[],
  now: number,
): { vec: FeatureVector; strength: number } {
  const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

  const negativeGames = games.filter(g => {
    if (g.removedAt) return true;
    if (g.status === 'On Hold' && g.hoursPlayed < 2) return true;
    if (g.status === 'Want to Play') {
      const age = now - new Date(g.addedAt).getTime();
      if (age > SIX_MONTHS_MS && g.sessionCount === 0) return true;
    }
    return false;
  });

  if (negativeGames.length === 0) return { vec: new Map(), strength: 0 };

  const vec: FeatureVector = new Map();
  for (const g of negativeGames) {
    for (const genre of g.genres) {
      const can = toCanonicalGenre(genre);
      if (can) vec.set(`g:${norm(can)}`, (vec.get(`g:${norm(can)}`) || 0) + 1);
    }
    for (const theme of g.themes) vec.set(`t:${norm(theme)}`, (vec.get(`t:${norm(theme)}`) || 0) + 1);
    if (g.developer) vec.set(`d:${norm(g.developer)}`, (vec.get(`d:${norm(g.developer)}`) || 0) + 1);
  }

  const maxVal = Math.max(1, ...vec.values());
  for (const [k, v] of vec) vec.set(k, v / maxVal);

  return { vec, strength: Math.min(negativeGames.length / games.length, 0.5) };
}

// ─── Layer 4: Status Trajectory Scoring ─────────────────────────────────────────

const TRAJECTORY_MULTIPLIERS: Record<string, number> = {
  'want to play|playing|completed': 1.5,
  'want to play|playing now|completed': 1.6,
  'playing|completed': 1.3,
  'playing now|completed': 1.4,
  'want to play|playing': 1.1,
  'playing|on hold': 0.6,
  'want to play': 0.3,
};

function getTrajectoryMultiplier(game: UserGameSnapshot): number {
  if (game.statusTrajectory.length === 0) return 1.0;
  const key = game.statusTrajectory.map(s => s.toLowerCase()).join('|');

  if (TRAJECTORY_MULTIPLIERS[key] !== undefined) return TRAJECTORY_MULTIPLIERS[key];

  if (game.status === 'Completed') return 1.3;
  if (game.status === 'On Hold') return 0.6;
  if (game.status === 'Playing' || game.status === 'Playing Now') return 1.0;
  if (game.removedAt) return 0.2;
  return 0.5;
}

// ─── Layer 5: Content Similarity (Cosine — tag-based) ──────────────────────────

type FeatureVector = Map<string, number>;

function profileToVector(profile: TasteProfile): FeatureVector {
  const vec: FeatureVector = new Map();
  const add = (features: FeatureWeight[], prefix: string) => {
    for (const f of features) vec.set(`${prefix}:${f.name}`, f.weight);
  };
  add(profile.genres, 'g');
  add(profile.themes, 't');
  add(profile.gameModes, 'm');
  add(profile.perspectives, 'p');
  add(profile.developers.slice(0, 20), 'd');
  return vec;
}

function candidateToVector(c: CandidateGame): FeatureVector {
  const vec: FeatureVector = new Map();
  for (const g of c.genres) {
    const can = toCanonicalGenre(g);
    if (can) vec.set(`g:${norm(can)}`, 1);
  }
  for (const t of c.themes) vec.set(`t:${norm(t)}`, 1);
  for (const m of c.gameModes) vec.set(`m:${norm(m)}`, 1);
  for (const p of c.perspectives) vec.set(`p:${norm(p)}`, 1);
  if (c.developer) vec.set(`d:${norm(c.developer)}`, 1);
  return vec;
}

function cosineSimilarity(a: FeatureVector, b: FeatureVector): number {
  let dot = 0, magA = 0, magB = 0;
  for (const [key, valA] of a) {
    magA += valA * valA;
    const valB = b.get(key);
    if (valB !== undefined) dot += valA * valB;
  }
  for (const [, valB] of b) magB += valB * valB;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Layer 6: Semantic Similarity (Embedding cosine — optional) ─────────────────

function computeSemanticSimilarity(
  userEmbeddings: { embedding: number[]; weight: number }[],
  candidateEmbedding: number[] | undefined,
): number {
  if (!candidateEmbedding || candidateEmbedding.length === 0 || userEmbeddings.length === 0) return 0;

  const dim = candidateEmbedding.length;
  const tasteVec = new Float64Array(dim);
  let totalWeight = 0;

  for (const { embedding, weight } of userEmbeddings) {
    if (embedding.length !== dim) continue;
    for (let i = 0; i < dim; i++) tasteVec[i] += embedding[i] * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  for (let i = 0; i < dim; i++) tasteVec[i] /= totalWeight;

  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < dim; i++) {
    dot += tasteVec[i] * candidateEmbedding[i];
    magA += tasteVec[i] * tasteVec[i];
    magB += candidateEmbedding[i] * candidateEmbedding[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Layer 7: Co-Occurrence Graph + Similar-Games Graph ──────────────────────────

function buildCoOccurrenceEdges(
  candidates: CandidateGame[],
): Map<string, Map<string, number>> {
  const tagSets = new Map<string, Set<string>>();
  for (const c of candidates) {
    const tags = new Set<string>();
    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (can) tags.add(`g:${norm(can)}`);
    }
    for (const t of c.themes) tags.add(`t:${norm(t)}`);
    for (const m of c.gameModes) tags.add(`m:${norm(m)}`);
    tagSets.set(c.gameId, tags);
  }

  const genreIndex = new Map<string, string[]>();
  for (const c of candidates) {
    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (!can) continue;
      const key = norm(can);
      if (!genreIndex.has(key)) genreIndex.set(key, []);
      genreIndex.get(key)!.push(c.gameId);
    }
  }

  const edges = new Map<string, Map<string, number>>();
  const MAX_NEIGHBORS = 150; // cap to avoid O(n²) explosion on popular genres

  for (const c of candidates) {
    const myTags = tagSets.get(c.gameId)!;
    const neighborIds = new Set<string>();

    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (!can) continue;
      const ids = genreIndex.get(norm(can));
      if (ids) for (const id of ids) if (id !== c.gameId) neighborIds.add(id);
    }

    let neighborCount = 0;
    for (const otherId of neighborIds) {
      if (neighborCount >= MAX_NEIGHBORS) break;
      const otherTags = tagSets.get(otherId);
      if (!otherTags) continue;

      // Inline intersection count — avoids array + filter allocation per pair
      let intersection = 0;
      for (const t of myTags) {
        if (otherTags.has(t)) intersection++;
      }
      if (intersection < 3) continue;

      // Union via inclusion-exclusion — avoids new Set allocation
      const union = myTags.size + otherTags.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;

      if (!edges.has(c.gameId)) edges.set(c.gameId, new Map());
      edges.get(c.gameId)!.set(otherId, jaccard);
      neighborCount++;
    }
  }

  return edges;
}

/** Pre-computed user-game lookup tables — built once per pipeline run. */
interface GraphUserContext {
  ugSimilarNormSets: Map<string, Set<string>>;
  ugTitleNorms: Map<string, string>;
  ugWeights: Map<string, number>;
}

function buildGraphUserContext(userGames: UserGameSnapshot[], now: number): GraphUserContext {
  const ugSimilarNormSets = new Map<string, Set<string>>();
  const ugTitleNorms = new Map<string, string>();
  const ugWeights = new Map<string, number>();

  for (const ug of userGames) {
    ugSimilarNormSets.set(ug.gameId, new Set(ug.similarGameTitles.map(norm)));
    ugTitleNorms.set(ug.gameId, norm(ug.title));
    ugWeights.set(ug.gameId, computeEngagementScore(ug, now) * getTrajectoryMultiplier(ug));
  }

  return { ugSimilarNormSets, ugTitleNorms, ugWeights };
}

function computeGraphSignal(
  candidate: CandidateGame,
  userGames: UserGameSnapshot[],
  coOccurrence: Map<string, Map<string, number>>,
  gCtx: GraphUserContext,
): { score: number; similarTo: string[] } {
  const candidateTitleNorm = norm(candidate.title);
  const candidateSimilarNorm = new Set(candidate.similarGameTitles.map(norm));
  let totalSignal = 0;
  const similarTo: string[] = [];

  for (const ug of userGames) {
    if (similarTo.length >= 3) break; // early termination — enough signal

    const weight = gCtx.ugWeights.get(ug.gameId)!;
    const ugSimilarNorm = gCtx.ugSimilarNormSets.get(ug.gameId)!;

    if (ugSimilarNorm.has(candidateTitleNorm)) {
      totalSignal += weight * 1.0;
      similarTo.push(ug.title);
      continue;
    }

    const ugTitleNorm = gCtx.ugTitleNorms.get(ug.gameId)!;
    if (candidateSimilarNorm.has(ugTitleNorm)) {
      totalSignal += weight * 0.8;
      similarTo.push(ug.title);
      continue;
    }

    let hop2Found = false;
    for (const st of ugSimilarNorm) {
      if (candidateSimilarNorm.has(st)) {
        totalSignal += weight * 0.4;
        similarTo.push(ug.title);
        hop2Found = true;
        break;
      }
    }

    if (!hop2Found) {
      const candidateEdges = coOccurrence.get(candidate.gameId);
      if (candidateEdges) {
        for (const [neighborId, jaccard] of candidateEdges) {
          if (ugTitleNorm === norm(neighborId) || ugSimilarNorm.has(norm(neighborId))) {
            totalSignal += weight * jaccard * 0.3;
            break;
          }
        }
      }
    }
  }

  return { score: clamp01(totalSignal / 3), similarTo: [...new Set(similarTo)].slice(0, 3) };
}

// ─── Layer 8: Quality Signal (multi-factor + review sentiment) ──────────────────

function computeQualitySignal(
  c: CandidateGame,
  maxRecommendations: number,
  maxReviewVolume: number,
): number {
  // Metacritic component
  const metacriticComponent = c.metacriticScore
    ? clamp01((c.metacriticScore - 50) / 50)
    : 0.3;

  // User recommendations component
  const recoComponent = c.recommendations && maxRecommendations > 0
    ? clamp01(Math.log(c.recommendations + 1) / Math.log(maxRecommendations + 1))
    : 0.3;

  // Review sentiment component — positivity ratio weighted by volume
  const hasReviewData = c.reviewPositivity !== undefined && c.reviewVolume !== undefined && c.reviewVolume > 0;
  let reviewComponent = 0;
  if (hasReviewData) {
    const positivity = clamp01(c.reviewPositivity!);
    const volumeNorm = maxReviewVolume > 0
      ? clamp01(Math.log(c.reviewVolume! + 1) / Math.log(maxReviewVolume + 1))
      : 0.3;
    reviewComponent = positivity * 0.7 + volumeNorm * 0.3;
  }

  // Achievement depth component
  const achievementComponent = c.achievements
    ? clamp01(c.achievements / 100)
    : 0.3;

  // Maintenance signal
  const releaseYear = new Date(c.releaseDate).getFullYear();
  const currentYear = new Date().getFullYear();
  const yearsOld = currentYear - releaseYear;
  const maintenanceComponent = isNaN(yearsOld) ? 0.3 : clamp01(1 - yearsOld / 15);

  // Dynamic weights: redistribute review weight to metacritic + reco when absent
  if (hasReviewData) {
    return (
      metacriticComponent * 0.30 +
      recoComponent * 0.20 +
      reviewComponent * 0.20 +
      achievementComponent * 0.15 +
      maintenanceComponent * 0.15
    );
  }

  // No review data: shift that 20% to metacritic (10%) and recommendations (10%)
  return (
    metacriticComponent * 0.40 +
    recoComponent * 0.30 +
    achievementComponent * 0.15 +
    maintenanceComponent * 0.15
  );
}

// ─── Layer 9: Popularity Debiasing ─────────────────────────────────────────────

function computePopularityAdjustment(playerCount: number | null, maxPlayerCount: number): number {
  if (!playerCount || playerCount <= 0 || maxPlayerCount <= 0) return 1.0;
  return 1.0 - (Math.log(playerCount + 1) / Math.log(maxPlayerCount + 1)) * 0.25;
}

// ─── Layer 10: Time-of-Day Contextual Boost ────────────────────────────────────

interface TimeOfDayContext {
  affinity: Map<string, number>;
  hasSufficientData: boolean;
}

/** Build time-of-day genre affinity ONCE per pipeline run (not per candidate). */
function buildTimeOfDayContext(
  userGames: UserGameSnapshot[],
  currentHour: number,
): TimeOfDayContext {
  const bucket = currentHour < 6 ? 'night' : currentHour < 12 ? 'morning' : currentHour < 18 ? 'afternoon' : 'evening';

  const affinity = new Map<string, number>();
  let totalSessionsInBucket = 0;

  for (const ug of userGames) {
    for (let i = 0; i < ug.sessionTimestamps.length; i++) {
      const sessionHour = new Date(ug.sessionTimestamps[i]).getHours();
      const sessionBucket = sessionHour < 6 ? 'night' : sessionHour < 12 ? 'morning' : sessionHour < 18 ? 'afternoon' : 'evening';

      if (sessionBucket === bucket) {
        totalSessionsInBucket++;
        for (const g of ug.genres) {
          const can = toCanonicalGenre(g);
          if (can) {
            const key = norm(can);
            affinity.set(key, (affinity.get(key) || 0) + 1);
          }
        }
      }
    }
  }

  if (totalSessionsInBucket < 3) return { affinity: new Map(), hasSufficientData: false };

  for (const [k, v] of affinity) {
    affinity.set(k, v / totalSessionsInBucket);
  }

  return { affinity, hasSufficientData: true };
}

function computeTimeOfDayBoost(candidate: CandidateGame, ctx: TimeOfDayContext): number {
  if (!ctx.hasSufficientData) return 0;

  let affinitySum = 0;
  let count = 0;
  for (const g of candidate.genres) {
    const can = toCanonicalGenre(g);
    const key = can ? norm(can) : norm(g);
    const aff = ctx.affinity.get(key);
    if (aff !== undefined) {
      affinitySum += aff;
      count++;
    }
  }

  return count > 0 ? clamp01(affinitySum / count) : 0;
}

// ─── Layer 11: Franchise Detection & Scoring ────────────────────────────────────

/** Common franchise suffixes/numbering patterns to strip. */
const FRANCHISE_STRIP_PATTERNS = [
  // Numbered sequels: "Game 2", "Game II", "Game III", "Game IV"
  /\s+([\divxlc]+|\d+)$/i,
  // Common suffixes
  /\s*:\s*(remastered|goty|game of the year|deluxe|ultimate|definitive|complete|enhanced|anniversary|remake|hd|collection|gold|premium|special|digital|standard)(\s+edition)?$/i,
  /\s+edition$/i,
  // Parenthetical year/platform markers
  /\s*\([^)]*\)$/,
  // Subtitled entries: keep "Game:" → "Game"
  /\s*:\s+[^:]+$/,
  // " - " subtitle separator
  /\s+-\s+.*$/,
];

/** Extract the base franchise name from a game title. */
function extractFranchiseBase(title: string): string {
  let base = title.trim();
  // Apply patterns iteratively (some titles have multiple suffixes)
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const pattern of FRANCHISE_STRIP_PATTERNS) {
      const stripped = base.replace(pattern, '').trim();
      if (stripped.length >= 3 && stripped !== base) {
        base = stripped;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return norm(base);
}

/** Detect all franchises from user + candidate game titles. */
function detectFranchises(
  userGames: UserGameSnapshot[],
  candidates: CandidateGame[],
): FranchiseCluster[] {
  // Build base name → entries map
  const baseMap = new Map<string, {
    entries: Map<string, { gameId: string; title: string; releaseDate: string; isUserOwned: boolean }>;
    developers: Map<string, number>;
    userRatings: number[];
    userHours: number;
  }>();

  const addToMap = (gameId: string, title: string, releaseDate: string, isUser: boolean, developer: string, rating: number, hours: number) => {
    const baseName = extractFranchiseBase(title);
    if (!baseName || baseName.length < 3) return;

    if (!baseMap.has(baseName)) {
      baseMap.set(baseName, {
        entries: new Map(),
        developers: new Map(),
        userRatings: [],
        userHours: 0,
      });
    }

    const cluster = baseMap.get(baseName)!;

    if (!cluster.entries.has(gameId)) {
      cluster.entries.set(gameId, { gameId, title, releaseDate, isUserOwned: isUser });
    } else if (isUser) {
      cluster.entries.get(gameId)!.isUserOwned = true;
    }

    if (developer) {
      cluster.developers.set(norm(developer), (cluster.developers.get(norm(developer)) || 0) + 1);
    }

    if (isUser) {
      if (rating > 0) cluster.userRatings.push(rating);
      cluster.userHours += hours;
    }
  };

  for (const ug of userGames) {
    addToMap(ug.gameId, ug.title, ug.releaseDate, true, ug.developer, ug.rating, ug.hoursPlayed);
  }

  for (const c of candidates) {
    addToMap(c.gameId, c.title, c.releaseDate, false, c.developer, 0, 0);
  }

  // Build franchise clusters: must have ≥2 entries total AND ≥1 user entry
  const franchises: FranchiseCluster[] = [];

  for (const [baseName, data] of baseMap) {
    if (data.entries.size < 2) continue;

    const hasUserEntry = [...data.entries.values()].some(e => e.isUserOwned);
    if (!hasUserEntry) continue;

    // Sort entries by release date for sequence indexing
    const entries: FranchiseEntry[] = [...data.entries.values()]
      .sort((a, b) => {
        const dateA = new Date(a.releaseDate).getTime();
        const dateB = new Date(b.releaseDate).getTime();
        if (isNaN(dateA) && isNaN(dateB)) return 0;
        if (isNaN(dateA)) return 1;
        if (isNaN(dateB)) return -1;
        return dateA - dateB;
      })
      .map((e, i) => ({ ...e, sequenceIndex: i }));

    // Primary developer
    let topDev = '';
    let topDevCount = 0;
    for (const [dev, count] of data.developers) {
      if (count > topDevCount) { topDev = dev; topDevCount = count; }
    }

    const userPlayedIds = entries.filter(e => e.isUserOwned).map(e => e.gameId);
    const avgRating = data.userRatings.length > 0
      ? data.userRatings.reduce((s, r) => s + r, 0) / data.userRatings.length
      : 0;

    // Pretty display name: use the first entry's title base
    const firstEntry = entries[0];
    const displayParts = firstEntry.title.split(/[:\-–]/);
    const displayName = displayParts[0].trim();

    franchises.push({
      baseName,
      displayName,
      entries,
      userPlayedIds,
      userAvgRating: avgRating,
      userTotalHours: data.userHours,
      developer: topDev,
    });
  }

  return franchises.sort((a, b) => b.userTotalHours - a.userTotalHours);
}

/** Compute franchise boost for a single candidate. */
function computeFranchiseBoost(
  candidate: CandidateGame,
  franchises: FranchiseCluster[],
  userGameIds: Set<string>,
): { boost: number; franchiseName?: string; isFranchiseEntry: boolean } {
  if (userGameIds.has(candidate.gameId)) {
    return { boost: 0, isFranchiseEntry: false };
  }

  const candidateBase = extractFranchiseBase(candidate.title);

  for (const franchise of franchises) {
    // Check if this candidate belongs to a franchise the user has played
    const belongsToFranchise = franchise.baseName === candidateBase ||
      franchise.entries.some(e => e.gameId === candidate.gameId);

    if (!belongsToFranchise) continue;

    // The user has played at least one entry in this franchise
    const userPlayed = franchise.userPlayedIds.length;
    const totalEntries = franchise.entries.length;

    // Higher boost if user rated the franchise entries highly
    const ratingMult = franchise.userAvgRating >= 4 ? 1.5
      : franchise.userAvgRating >= 3 ? 1.0
      : 0.5;

    // Higher boost for completing more of the series
    const completionFactor = Math.min(userPlayed / totalEntries, 0.8);

    // Strong base boost for franchise membership (0.4 – 0.9)
    const boost = clamp01((0.4 + completionFactor * 0.5) * ratingMult);

    return {
      boost,
      franchiseName: franchise.displayName,
      isFranchiseEntry: true,
    };
  }

  return { boost: 0, isFranchiseEntry: false };
}

// ─── Layer 12: Studio Loyalty Boost ─────────────────────────────────────────────

function computeStudioLoyaltyBoost(
  candidate: CandidateGame,
  loyalDevelopers: string[],
  _profile: TasteProfile,
): number {
  if (loyalDevelopers.length === 0) return 0;

  const candDev = norm(candidate.developer);
  const candPub = norm(candidate.publisher);

  for (const dev of loyalDevelopers) {
    if (candDev === dev || candPub === dev) {
      return 0.35; // strong boost for loyal studio
    }
  }

  return 0;
}

// ─── Layer 13: Cross-Game Session Sequencing ────────────────────────────────────

interface SequencingContext {
  transitions: Map<string, Map<string, number>>;
  transitionTotals: Map<string, number>;
  recentGameGenres: string[][];
  hasSufficientData: boolean;
}

/** Build session sequencing context ONCE per pipeline run (not per candidate). */
function buildSequencingContext(userGames: UserGameSnapshot[]): SequencingContext {
  const allSessions: { gameId: string; timestamp: number; genres: string[] }[] = [];

  for (const ug of userGames) {
    const canonNorm = ug.genres.map(g => toCanonicalGenre(g)).filter(Boolean).map((c: string) => norm(c));
    for (const ts of ug.sessionTimestamps) {
      allSessions.push({
        gameId: ug.gameId,
        timestamp: ts,
        genres: canonNorm,
      });
    }
  }

  if (allSessions.length < 4) {
    return { transitions: new Map(), transitionTotals: new Map(), recentGameGenres: [], hasSufficientData: false };
  }

  allSessions.sort((a, b) => a.timestamp - b.timestamp);

  const transitions = new Map<string, Map<string, number>>();
  for (let i = 0; i < allSessions.length - 1; i++) {
    const current = allSessions[i];
    const next = allSessions[i + 1];
    if (current.gameId === next.gameId) continue;

    for (const fromGenre of current.genres) {
      if (!transitions.has(fromGenre)) transitions.set(fromGenre, new Map());
      const trans = transitions.get(fromGenre)!;
      for (const toGenre of next.genres) {
        trans.set(toGenre, (trans.get(toGenre) || 0) + 1);
      }
    }
  }

  // Pre-compute transition totals so we don't recalculate per candidate
  const transitionTotals = new Map<string, number>();
  for (const [fromGenre, trans] of transitions) {
    let total = 0;
    for (const v of trans.values()) total += v;
    transitionTotals.set(fromGenre, total);
  }

  const recentGames = [...userGames]
    .filter(g => g.lastSessionDate)
    .sort((a, b) => new Date(b.lastSessionDate!).getTime() - new Date(a.lastSessionDate!).getTime())
    .slice(0, 3);

  return {
    transitions,
    transitionTotals,
    recentGameGenres: recentGames.map(g => g.genres.map(x => toCanonicalGenre(x)).filter(Boolean).map((c: string) => norm(c))),
    hasSufficientData: recentGames.length > 0,
  };
}

function computeSequencingBoost(candidate: CandidateGame, ctx: SequencingContext): number {
  if (!ctx.hasSufficientData) return 0;

  const candidateGenresNorm = candidate.genres.map(g => toCanonicalGenre(g)).filter(Boolean).map((c: string) => norm(c));
  let totalAffinity = 0;
  let affinityCount = 0;

  for (const genreSet of ctx.recentGameGenres) {
    for (const fromGenre of genreSet) {
      const trans = ctx.transitions.get(fromGenre);
      if (!trans) continue;
      const totalTrans = ctx.transitionTotals.get(fromGenre) || 0;
      if (totalTrans === 0) continue;

      for (const candidateGenre of candidateGenresNorm) {
        const count = trans.get(candidateGenre) || 0;
        totalAffinity += count / totalTrans;
        affinityCount++;
      }
    }
  }

  return affinityCount > 0 ? clamp01((totalAffinity / affinityCount) * 2) : 0;
}

// ─── Layer 14: MMR Diversity Re-Ranking ─────────────────────────────────────────

function mmrRerank(scored: ScoredGame[], lambda: number, limit: number): ScoredGame[] {
  if (scored.length <= 1) return scored.slice(0, limit);

  // Pre-compute normalized canonical genre sets — avoids creating them in the O(n²) loop
  const genreSets = new Map<string, Set<string>>();
  for (const s of scored) {
    const canonNorm = new Set(s.genres.map(g => toCanonicalGenre(g)).filter(Boolean).map((c: string) => norm(c)));
    genreSets.set(s.gameId, canonNorm);
  }

  const selected: ScoredGame[] = [];
  const remaining = [...scored];

  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);
  const negLambda = 1 - lambda;

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const setA = genreSets.get(candidate.gameId)!;
      let maxSim = 0;

      for (const sel of selected) {
        const setB = genreSets.get(sel.gameId)!;
        let intersection = 0;
        for (const g of setA) {
          if (setB.has(g)) intersection++;
        }
        const union = setA.size + setB.size - intersection;
        const jaccard = union > 0 ? intersection / union : 0;
        if (jaccard > maxSim) maxSim = jaccard;
      }

      const mmrScore = lambda * candidate.score - negLambda * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ─── Layer 15: Taste Cluster Detection ──────────────────────────────────────────

function detectTasteClusters(
  userGames: UserGameSnapshot[],
  now: number,
  k: number = 3,
): TasteCluster[] {
  if (userGames.length < k * 2) return [];

  type GameVec = { gameId: string; title: string; vec: Map<string, number>; engagement: number };
  const gameVecs: GameVec[] = userGames.map(g => {
    const vec = new Map<string, number>();
    for (const genre of g.genres) {
      const can = toCanonicalGenre(genre);
      if (can) vec.set(`g:${norm(can)}`, 1);
    }
    for (const theme of g.themes) vec.set(`t:${norm(theme)}`, 1);
    for (const mode of g.gameModes) vec.set(`m:${norm(mode)}`, 1);
    return { gameId: g.gameId, title: g.title, vec, engagement: computeEngagementScore(g, now) };
  });

  const allKeys = new Set<string>();
  for (const gv of gameVecs) for (const k of gv.vec.keys()) allKeys.add(k);
  const keyArr = [...allKeys];

  const vectors: number[][] = gameVecs.map(gv =>
    keyArr.map(k => gv.vec.get(k) || 0),
  );

  const dim = keyArr.length;
  if (dim === 0) return [];

  const used = new Set<number>();
  const centroids: number[][] = [];
  for (let i = 0; i < k; i++) {
    let idx: number;
    do { idx = Math.floor(Math.random() * vectors.length); } while (used.has(idx) && used.size < vectors.length);
    used.add(idx);
    centroids.push([...vectors[idx]]);
  }

  const assignments = new Array<number>(vectors.length).fill(0);

  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < vectors.length; i++) {
      let bestDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = vectors[i][d] - centroids[c][d];
          dist += diff * diff;
        }
        if (dist < bestDist) { bestDist = dist; bestC = c; }
      }
      assignments[i] = bestC;
    }

    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = members.reduce((s, v) => s + v[d], 0) / members.length;
      }
    }
  }

  const clusters: TasteCluster[] = [];
  for (let c = 0; c < k; c++) {
    const memberGames = userGames.filter((_, i) => assignments[i] === c);
    if (memberGames.length < 2) continue;

    const profile = buildTasteProfile(memberGames, now);
    const topGames = [...memberGames]
      .sort((a, b) => computeEngagementScore(b, now) - computeEngagementScore(a, now))
      .slice(0, 3)
      .map(g => g.title);

    const label = profile.topGenre
      ? profile.topGenre.charAt(0).toUpperCase() + profile.topGenre.slice(1)
      : `Cluster ${c + 1}`;

    clusters.push({
      id: c,
      label,
      profile,
      gameCount: memberGames.length,
      topGames,
    });
  }

  return clusters.sort((a, b) => b.gameCount - a.gameCount);
}

// ─── Layer 16: Explanation Generation ───────────────────────────────────────────

function generateExplanation(
  scored: ScoredGame,
  _userGames: UserGameSnapshot[],
  profile: TasteProfile,
): string {
  const parts: string[] = [];
  const matchPct = Math.round(scored.score * 100);

  // Franchise entry callout (top priority)
  if (scored.reasons.isFranchiseEntry && scored.reasons.franchiseOf) {
    parts.push(`part of the ${scored.reasons.franchiseOf} series you love`);
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

function runPipeline(input: RecoWorkerInput): { tasteProfile: TasteProfile; shelves: RecoShelf[] } {
  const { userGames, candidates, now, currentHour, hasEmbeddings, dismissedGameIds } = input;
  const dismissedSet = new Set(dismissedGameIds);

  // Reset per-run caches
  _engagementCache.clear();

  // Filter out dismissed candidates
  const filteredCandidates = candidates.filter(c => !dismissedSet.has(c.gameId));

  // ── 1. Build taste profile ──
  progress('Analyzing your library...', 5);
  const tasteProfile = buildTasteProfile(userGames, now);

  if (filteredCandidates.length === 0) {
    return { tasteProfile, shelves: buildShelvesFromScored([], [], userGames, tasteProfile, [], []) };
  }

  // ── 2. Classify engagement curves ──
  progress('Analyzing play patterns...', 8);
  for (const ug of userGames) {
    if (!ug.engagementPattern || ug.engagementPattern === 'unknown') {
      ug.engagementPattern = classifyEngagementCurve(ug);
    }
  }

  // ── 3. Build negative taste profile ──
  progress('Mining negative signals...', 12);
  const negativeProfile = buildNegativeProfile(userGames, now);

  // ── 4. Pre-compute taste vectors ──
  progress('Building taste vectors...', 16);
  const profileVec = profileToVector(tasteProfile);

  // ── 5. Build co-occurrence graph ──
  progress('Building similarity graph...', 20);
  const coOccurrence = buildCoOccurrenceEdges(filteredCandidates);

  // ── 6. Pre-compute user embeddings for semantic similarity ──
  const userEmbeddings = hasEmbeddings
    ? userGames
        .filter(ug => ug.embedding && ug.embedding.length > 0)
        .map(ug => ({ embedding: ug.embedding!, weight: computeEngagementScore(ug, now) }))
    : [];

  // ── 7. Detect franchises ──
  progress('Detecting game franchises...', 24);
  const franchises = detectFranchises(userGames, filteredCandidates);
  const userGameIds = new Set(userGames.map(g => g.gameId));

  // ── 8. Build hoisted contexts (PERF: built once, not per candidate) ──
  progress('Building scoring contexts...', 26);
  const graphCtx = buildGraphUserContext(userGames, now);
  const todCtx = buildTimeOfDayContext(userGames, currentHour);
  const seqCtx = buildSequencingContext(userGames);

  // Pre-compute per-user-game normalized canonical genre sets for engagement curve bonus
  const ugGenreNorms = new Map<string, Set<string>>();
  for (const ug of userGames) {
    const canon = ug.genres.map(g => toCanonicalGenre(g)).filter(Boolean) as string[];
    ugGenreNorms.set(ug.gameId, new Set(canon.map(norm)));
  }

  // Pre-compute profile feature sets (normalized for comparison; profile.genres use canonical display names)
  const profileGenresNorm = new Set(tasteProfile.genres.map(g => norm(g.name)));
  const profileThemes = new Set(tasteProfile.themes.map(t => t.name));
  const profileModes = new Set(tasteProfile.gameModes.map(m => m.name));

  // ── Score candidates ──
  progress('Scoring candidates...', 28);
  const maxPlayerCount = Math.max(1, ...filteredCandidates.map(c => c.playerCount ?? 0));
  const maxRecommendations = Math.max(1, ...filteredCandidates.map(c => c.recommendations ?? 0));
  const maxReviewVolume = Math.max(1, ...filteredCandidates.map(c => c.reviewVolume ?? 0));
  const currentYear = new Date(now).getFullYear();
  const logMaxPlayerCount = Math.log(maxPlayerCount + 1);

  // v3 dynamic weight table — 17 layers
  const W_CONTENT      = hasEmbeddings ? 0.15 : 0.23;
  const W_SEMANTIC     = hasEmbeddings ? 0.12 : 0.00;
  const W_GRAPH        = hasEmbeddings ? 0.14 : 0.19;
  const W_QUALITY      = 0.11;
  const W_POPULARITY   = 0.06;
  const W_RECENCY      = 0.06;
  const W_DIVERSITY    = 0.04;
  const W_TIME         = 0.03;
  const W_CURVE        = 0.03;
  const W_NEGATIVE     = 0.06;
  const W_FRANCHISE    = 0.08;
  const W_STUDIO       = 0.05;
  const W_SEQUENCING   = 0.04;

  const maxGenreWeight = tasteProfile.genres[0]?.weight ?? 1;
  const scored: ScoredGame[] = [];
  const progressStep = Math.max(1, Math.floor(filteredCandidates.length / 5));

  for (let i = 0; i < filteredCandidates.length; i++) {
    const c = filteredCandidates[i];

    // Layer 5: Content similarity — compute candidate vector ONCE (reused for negative signal)
    const candidateVec = candidateToVector(c);
    const contentSimilarity = cosineSimilarity(profileVec, candidateVec);

    // Layer 6: Semantic similarity
    const semanticSimilarity = hasEmbeddings
      ? computeSemanticSimilarity(userEmbeddings, c.embedding)
      : 0;

    // Layer 7: Graph traversal (uses pre-built context — no per-candidate Set allocations)
    const graph = computeGraphSignal(c, userGames, coOccurrence, graphCtx);
    const graphSignal = graph.score;

    // Layer 8: Quality signal (with review sentiment)
    const qualitySignal = computeQualitySignal(c, maxRecommendations, maxReviewVolume);

    // Layer 9: Popularity debiasing
    const popularityRaw = c.playerCount
      ? clamp01(Math.log(c.playerCount + 1) / logMaxPlayerCount)
      : 0.3;
    const popularityAdj = computePopularityAdjustment(c.playerCount, maxPlayerCount);
    const popularitySignal = popularityRaw * popularityAdj;

    // Recency boost
    const releaseYear = new Date(c.releaseDate).getFullYear();
    const yearDiff = currentYear - releaseYear;
    const recencyBoost = isNaN(yearDiff) ? 0.3 : clamp01(1 - yearDiff / 10);

    // Diversity bonus (uses pre-computed profile genre weights; canonical genres)
    const cCanonGenres = c.genres.map(g => toCanonicalGenre(g)).filter(Boolean) as string[];
    const genreWeightSum = cCanonGenres.reduce((sum, g) => {
      const found = tasteProfile.genres.find(fg => norm(fg.name) === norm(g));
      return sum + (found ? found.weight : 0);
    }, 0);
    const avgGenreWeight = cCanonGenres.length > 0 ? genreWeightSum / cCanonGenres.length : 0;
    const diversityBonus = maxGenreWeight > 0
      ? clamp01(1 - avgGenreWeight / maxGenreWeight) * 0.5
      : 0;

    // Layer 10: Time-of-day contextual boost (uses hoisted context)
    const timeOfDayBoost = computeTimeOfDayBoost(c, todCtx);

    // Layer 11: Franchise boost
    const franchise = computeFranchiseBoost(c, franchises, userGameIds);
    const franchiseBoost = franchise.boost;

    // Layer 12: Studio loyalty boost
    const studioLoyaltyBoost = computeStudioLoyaltyBoost(c, tasteProfile.loyalDevelopers, tasteProfile);

    // Layer 13: Session sequencing (uses hoisted context)
    const sequencingBoost = computeSequencingBoost(c, seqCtx);

    // Layer 3: Negative signal — reuse candidateVec (was computed twice before)
    const negativeSignal = negativeProfile.strength > 0
      ? cosineSimilarity(negativeProfile.vec, candidateVec) * negativeProfile.strength
      : 0;

    // Engagement curve bonus (uses pre-computed canonical genre norm sets)
    let engagementCurveBonus = 0;
    const cGenresNorm = new Set(c.genres.map(g => toCanonicalGenre(g)).filter(Boolean).map((can: string) => norm(can)));
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
    const sharedGenres = [...new Set(c.genres.map(g => toCanonicalGenre(g)).filter(Boolean).filter((can: string) => profileGenresNorm.has(norm(can))))];
    const sharedThemes = c.themes.filter(t => profileThemes.has(norm(t)));
    const sharedModes = c.gameModes.filter(m => profileModes.has(norm(m)));

    const isHiddenGem = (c.metacriticScore ?? 0) >= 80
      && (c.playerCount ?? Infinity) < maxPlayerCount * 0.1;
    const isStretchPick = cCanonGenres.length > 0 && sharedGenres.length === 0;
    const isOnSale = !!c.price?.discountPercent && c.price.discountPercent > 0;

    // Final composite score
    const score = clamp01(
      contentSimilarity * W_CONTENT +
      semanticSimilarity * W_SEMANTIC +
      graphSignal * W_GRAPH +
      qualitySignal * W_QUALITY +
      popularitySignal * W_POPULARITY +
      recencyBoost * W_RECENCY +
      diversityBonus * W_DIVERSITY +
      timeOfDayBoost * W_TIME +
      engagementCurveBonus * W_CURVE +
      franchiseBoost * W_FRANCHISE +
      studioLoyaltyBoost * W_STUDIO +
      sequencingBoost * W_SEQUENCING -
      negativeSignal * W_NEGATIVE
    );

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
        graphSignal,
        qualitySignal,
        popularitySignal,
        recencyBoost,
        diversityBonus,
        trajectoryMultiplier: 1,
        negativeSignal,
        timeOfDayBoost,
        engagementCurveBonus,
        franchiseBoost,
        studioLoyaltyBoost,
        sequencingBoost,
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
        explanation: '',
      },
      ...(c.price ? { price: c.price } : {}),
    });

    if (i % progressStep === 0) {
      progress('Scoring candidates...', 28 + Math.floor((i / filteredCandidates.length) * 30));
    }
  }

  // ── 14. Diversity re-ranking (MMR) ──
  progress('Applying diversity filter...', 62);
  scored.sort((a, b) => b.score - a.score);
  const reranked = mmrRerank(scored, 0.7, 80);

  // ── 15. Taste cluster detection ──
  progress('Detecting taste clusters...', 70);
  const clusters = detectTasteClusters(userGames, now, 3);
  tasteProfile.clusters = clusters;

  // ── 16. Generate explanations ──
  progress('Generating insights...', 76);
  for (const s of reranked) {
    s.reasons.explanation = generateExplanation(s, userGames, tasteProfile);
  }

  // ── 17. Shelf assembly ──
  progress('Building shelves...', 84);
  const shelves = buildShelvesFromScored(reranked, scored, userGames, tasteProfile, clusters, franchises);

  return { tasteProfile, shelves };
}

// ─── Shelf Assembly ────────────────────────────────────────────────────────────

function buildShelvesFromScored(
  reranked: ScoredGame[],
  allScored: ScoredGame[],
  userGames: UserGameSnapshot[],
  profile: TasteProfile,
  clusters: TasteCluster[],
  franchises: FranchiseCluster[],
): RecoShelf[] {
  const shelves: RecoShelf[] = [];
  const usedGameIds = new Set<string>();

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
    if (franchise.userAvgRating < 3 && franchise.userTotalHours < 10) continue;

    const missingEntries = franchise.entries
      .filter(e => !e.isUserOwned)
      .map(e => reranked.find(r => r.gameId === e.gameId) || allScored.find(s => s.gameId === e.gameId))
      .filter((s): s is ScoredGame => !!s && !usedGameIds.has(s.gameId));

    if (missingEntries.length >= 1) {
      shelves.push({
        type: 'complete-the-series',
        title: `Complete the ${franchise.displayName} Series`,
        subtitle: `You've played ${franchise.userPlayedIds.length} of ${franchise.entries.length} entries`,
        games: missingEntries.slice(0, 10),
      });
      addToUsed(missingEntries.slice(0, 10));
    }
  }

  // "Because you loved X"
  const bestUserGame = [...userGames]
    .filter(g => g.rating >= 4 || g.hoursPlayed >= 20)
    .sort((a, b) => (b.rating * 10 + b.hoursPlayed) - (a.rating * 10 + a.hoursPlayed))[0];

  if (bestUserGame) {
    const becauseGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.reasons.similarTo.some(t => norm(t) === norm(bestUserGame.title)))
      .slice(0, 12);

    if (becauseGames.length >= 2) {
      shelves.push({
        type: 'because-you-loved',
        title: `Because you loved ${bestUserGame.title}`,
        seedGameTitle: bestUserGame.title,
        games: becauseGames,
      });
      addToUsed(becauseGames);
    }
  }

  // "From Studios You Love"
  if (profile.loyalDevelopers.length > 0) {
    const studioGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.layerScores.studioLoyaltyBoost > 0)
      .slice(0, 12);

    if (studioGames.length >= 2) {
      shelves.push({
        type: 'from-studios-you-love',
        title: 'From Studios You Love',
        subtitle: `Games by ${profile.loyalDevelopers.slice(0, 3).map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}`,
        games: studioGames,
      });
      addToUsed(studioGames);
    }
  }

  // "Deep in [Genre]"
  if (profile.topGenre) {
    const topGenreNorm = norm(profile.topGenre);
    const genreGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.genres.some(g => norm(toCanonicalGenre(g) ?? g) === topGenreNorm))
      .slice(0, 12);

    if (genreGames.length >= 2) {
      const displayGenre = profile.topGenre.charAt(0).toUpperCase() + profile.topGenre.slice(1);
      shelves.push({
        type: 'deep-in-genre',
        title: `Deep in ${displayGenre}`,
        subtitle: 'More from your favourite genre',
        games: genreGames,
      });
      addToUsed(genreGames);
    }
  }

  // "For your [mood]"
  for (const cluster of clusters) {
    if (!cluster.label || cluster.gameCount < 2) continue;
    const clusterGenresNorm = new Set(cluster.profile.genres.slice(0, 3).map(g => norm(g.name)));
    const clusterGames = reranked
      .filter(s => !usedGameIds.has(s.gameId) && s.genres.some(g => clusterGenresNorm.has(norm(toCanonicalGenre(g) ?? g))))
      .slice(0, 10);

    if (clusterGames.length >= 3) {
      shelves.push({
        type: 'for-your-mood',
        title: `For your ${cluster.label} side`,
        subtitle: `Based on ${cluster.topGames.slice(0, 2).join(' & ')}`,
        games: clusterGames,
      });
      addToUsed(clusterGames);
    }
  }

  // Hidden Gems
  const hiddenGems = reranked.filter(s => !usedGameIds.has(s.gameId) && s.reasons.isHiddenGem).slice(0, 12);
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
  const deals = reranked
    .filter(s => !usedGameIds.has(s.gameId) && s.reasons.isOnSale && s.price?.discountPercent && s.price.discountPercent >= 20)
    .sort((a, b) => (b.price?.discountPercent ?? 0) - (a.price?.discountPercent ?? 0))
    .slice(0, 12);

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
  const freeGames = reranked
    .filter(s => !usedGameIds.has(s.gameId) && s.price?.isFree)
    .slice(0, 12);

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
  const criticsChoice = reranked
    .filter(s => !usedGameIds.has(s.gameId) && (s.metacriticScore ?? 0) >= 85)
    .sort((a, b) => (b.metacriticScore ?? 0) - (a.metacriticScore ?? 0))
    .slice(0, 12);

  if (criticsChoice.length >= 2) {
    shelves.push({
      type: 'critics-choice',
      title: "Critics' Choice",
      subtitle: 'Top-rated by reviewers, matched to your taste',
      games: criticsChoice,
    });
    addToUsed(criticsChoice);
  }

  // Stretch Picks
  const stretchPicks = reranked
    .filter(s => !usedGameIds.has(s.gameId) && s.reasons.isStretchPick && s.score > 0.12)
    .slice(0, 12);

  if (stretchPicks.length >= 2) {
    shelves.push({
      type: 'stretch-picks',
      title: 'Stretch Picks',
      subtitle: 'Outside your comfort zone, but you might love them',
      games: stretchPicks,
    });
    addToUsed(stretchPicks);
  }

  // New Releases For You
  const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const newReleases = reranked
    .filter(s => {
      if (usedGameIds.has(s.gameId)) return false;
      const rd = new Date(s.releaseDate).getTime();
      return !isNaN(rd) && rd > sixtyDaysAgo && rd <= Date.now();
    })
    .slice(0, 12);

  if (newReleases.length >= 2) {
    shelves.push({
      type: 'new-releases-for-you',
      title: 'New Releases For You',
      subtitle: 'Recently launched games matching your taste',
      games: newReleases,
    });
    addToUsed(newReleases);
  }

  // Upcoming Sequels — franchise entries not yet released
  const upcomingSequels = allScored
    .filter(s => {
      if (usedGameIds.has(s.gameId)) return false;
      if (!s.reasons.isFranchiseEntry) return false;
      const rd = new Date(s.releaseDate).getTime();
      return (!isNaN(rd) && rd > Date.now()) || s.releaseDate === '';
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (upcomingSequels.length >= 1) {
    shelves.push({
      type: 'upcoming-sequels',
      title: 'Upcoming Sequels',
      subtitle: 'New entries in franchises you love',
      games: upcomingSequels,
    });
    addToUsed(upcomingSequels);
  }

  // Coming Soon For You (general)
  const comingSoon = allScored
    .filter(s => {
      if (usedGameIds.has(s.gameId)) return false;
      const rd = new Date(s.releaseDate).getTime();
      return (!isNaN(rd) && rd > Date.now()) || s.releaseDate === '';
    })
    .filter(s => s.score > 0.15)
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
  const trending = reranked
    .filter(s => !usedGameIds.has(s.gameId) && (s.playerCount ?? 0) > 0)
    .sort((a, b) => (b.playerCount ?? 0) - (a.playerCount ?? 0))
    .slice(0, 12);

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
  const onHoldGames = userGames.filter(g => g.status === 'On Hold');
  if (onHoldGames.length > 0) {
    const topOnHold = onHoldGames.sort((a, b) => b.hoursPlayed - a.hoursPlayed)[0];
    const topOnHoldCanonNorm = new Set(topOnHold.genres.map(g => toCanonicalGenre(g)).filter(Boolean).map((c: string) => norm(c)));
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
    .filter(g => g.status === 'Playing' || g.status === 'On Hold' || g.status === 'Playing Now')
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
        contentSimilarity: 0, semanticSimilarity: 0, graphSignal: 0,
        qualitySignal: 0, popularitySignal: 0, recencyBoost: 0,
        diversityBonus: 0, trajectoryMultiplier: 0, negativeSignal: 0,
        timeOfDayBoost: 0, engagementCurveBonus: 0,
        franchiseBoost: 0, studioLoyaltyBoost: 0, sequencingBoost: 0,
      },
      reasons: {
        sharedGenres: [], sharedThemes: [], sharedModes: [],
        similarTo: [], metacriticScore: null, popularityRank: null,
        isHiddenGem: false, isStretchPick: false,
        isFranchiseEntry: false, isOnSale: false,
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

  return shelves;
}

// ─── Worker Entry ──────────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<RecoWorkerInput>) => {
  const t0 = performance.now();

  try {
    const { tasteProfile, shelves } = runPipeline(e.data);
    const computeTimeMs = Math.round(performance.now() - t0);

    self.postMessage({
      type: 'result',
      tasteProfile,
      shelves,
      computeTimeMs,
    } satisfies RecoWorkerMessage);
  } catch (err) {
    console.error('[reco.worker] Pipeline failed:', err);
    self.postMessage({
      type: 'result',
      tasteProfile: {
        genres: [], themes: [], gameModes: [], perspectives: [],
        developers: [], publishers: [], eras: [], clusters: [],
        totalGames: 0, totalHours: 0, avgRating: 0, topGenre: '', topTheme: '',
        loyalDevelopers: [],
      },
      shelves: [],
      computeTimeMs: Math.round(performance.now() - t0),
    } satisfies RecoWorkerMessage);
  }
};
