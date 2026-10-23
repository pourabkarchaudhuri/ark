/**
 * Oracle scoring primitives — extracted verbatim from reco.worker.ts (v1.0.75)
 * so they can be unit-tested without loading the worker. Behavior is
 * identical to the inline originals; later releases change them here.
 */

import type {
  UserGameSnapshot,
  CandidateGame,
  TasteProfile,
  FeatureWeight,
  ScoredGame,
  EngagementPattern,
  RecoTelemetry,
  RecoLayerStat,
} from '@/types/reco';
import { toCanonicalGenre, toCanonicalGenres, CANONICAL_GENRES } from '@/data/canonical-genres';
import {
  applyTemporalDecayMultiplier,
  computeEngagementWeight,
} from '@/services/engagement-weight';
import { mmrMaxSim } from '@/services/mmr-diversity';

/** ANN cosine-distance ceiling for Taste Match pill (mirrors reco-store). */
export const ANN_TASTE_MATCH_CEILING = 0.45;

/** Tokenize notes / titles for light lexical overlap (F8). */
export function noteTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3),
  );
}

/** Notes overlap bonus capped at 0.05 of score (F8). */
export function computeNotesThemeBonus(
  candidate: CandidateGame,
  lovedNotesTokens: Set<string>,
): number {
  if (lovedNotesTokens.size === 0) return 0;
  const hay = noteTokens([candidate.title, ...candidate.themes, ...candidate.genres].join(' '));
  if (hay.size === 0) return 0;
  let hit = 0;
  for (const t of hay) {
    if (lovedNotesTokens.has(t)) hit++;
  }
  if (hit === 0) return 0;
  return Math.min(0.05, (hit / Math.max(lovedNotesTokens.size, 1)) * 0.05);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────


export const norm = (s: string) => s.toLowerCase().trim();
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Backlog Advisor: only games that are already released (playable). Unknown/unparseable dates kept. */
export function isReleasedPlayableForBacklog(releaseDate: string, nowMs: number): boolean {
  const trimmed = releaseDate?.trim();
  if (!trimmed) return true;
  const t = new Date(trimmed).getTime();
  if (Number.isNaN(t)) return true;
  return t <= nowMs;
}

// ─── Layer 1: Taste Profile ────────────────────────────────────────────────────

// ─── Layer 2: Engagement Curve Analysis ────────────────────────────────────────

export const CURVE_MULTIPLIERS: Record<EngagementPattern, number> = {
  'long-tail': 1.4,
  'slow-burn': 1.3,
  'honeymoon': 0.9,
  'binge-drop': 0.6,
  'unknown': 1.0,
};

export function classifyEngagementCurve(snap: UserGameSnapshot): EngagementPattern {
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
export const _engagementCache = new Map<string, number>();

/**
 * Worker library-seed / evidence weight: shared computeEngagementWeight × temporal
 * decay × curve. Decay is a multiplier only — no WtP floor re-inflate.
 * Retrieve weight = shared; score may apply decay on top.
 */
export function computeEngagementScore(game: UserGameSnapshot, now: number): number {
  const cached = _engagementCache.get(game.gameId);
  if (cached !== undefined) return cached;

  const HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
  const addedTime = new Date(game.addedAt).getTime();
  const lastActivity = game.lastSessionDate
    ? new Date(game.lastSessionDate).getTime()
    : addedTime;
  const age = Math.max(0, now - (Number.isFinite(lastActivity) ? lastActivity : now));
  const temporalDecay = Math.pow(0.5, age / HALF_LIFE_MS);

  const curvePattern = game.engagementPattern || classifyEngagementCurve(game);
  const curveMult = CURVE_MULTIPLIERS[curvePattern];

  const shared = computeEngagementWeight(game);
  const result = applyTemporalDecayMultiplier(shared, temporalDecay) * curveMult;
  _engagementCache.set(game.gameId, result);
  return result;
}

export function buildFeatureMap(
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

export function getReleaseBucket(dateStr: string): string {
  const year = new Date(dateStr).getFullYear();
  if (isNaN(year)) return 'unknown';
  if (year >= 2025) return '2025+';
  if (year >= 2023) return '2023-2024';
  if (year >= 2020) return '2020-2022';
  if (year >= 2015) return '2015-2019';
  if (year >= 2010) return '2010-2014';
  if (year >= 2000) return '2000-2009';
  return 'pre-2000';
}

export function buildTasteProfile(games: UserGameSnapshot[], now: number): TasteProfile {
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

  const loyalPublishers = publishers
    .filter(p => p.gameCount >= 2 && (p.avgRating >= 3.5 || p.totalHours >= 20))
    .map(p => p.name);

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
    loyalPublishers,
  };
}

// ─── Layer 3: Negative Signal Mining ────────────────────────────────────────────

export function buildNegativeProfile(
  games: UserGameSnapshot[],
  _now: number,
  thumbsDownCandidates: CandidateGame[] = [],
): { vec: FeatureVector; strength: number } {
  const negativeGames = games.filter(g => {
    if (g.removedAt) return true;
    if (g.status === 'On Hold' && g.hoursPlayed < 2) return true;
    return false;
  });

  const vec: FeatureVector = new Map();
  const addFeatures = (genres: string[], themes: string[], developer: string, weight = 1) => {
    for (const genre of genres) {
      const can = toCanonicalGenre(genre);
      if (can) vec.set(`g:${norm(can)}`, (vec.get(`g:${norm(can)}`) || 0) + weight);
    }
    for (const theme of themes) vec.set(`t:${norm(theme)}`, (vec.get(`t:${norm(theme)}`) || 0) + weight);
    if (developer) vec.set(`d:${norm(developer)}`, (vec.get(`d:${norm(developer)}`) || 0) + weight);
  };

  for (const g of negativeGames) {
    addFeatures(g.genres, g.themes, g.developer);
  }
  // Thumbs-down cards — strong negative signal from Oracle feedback
  for (const c of thumbsDownCandidates) {
    addFeatures(c.genres, c.themes, c.developer, 1.5);
  }

  const negCount = negativeGames.length + thumbsDownCandidates.length;
  if (negCount === 0) return { vec: new Map(), strength: 0 };

  const maxVal = Math.max(1, ...vec.values());
  for (const [k, v] of vec) vec.set(k, v / maxVal);

  const denom = Math.max(games.length, 1);
  return { vec, strength: Math.min(negCount / denom, 0.5) };
}

// ─── Layer 4: Status Trajectory Scoring ─────────────────────────────────────────

export const TRAJECTORY_MULTIPLIERS: Record<string, number> = {
  'want to play|playing|completed': 1.5,
  'want to play|playing now|completed': 1.6,
  'playing|completed': 1.3,
  'playing now|completed': 1.4,
  'want to play|playing': 1.1,
  'playing|on hold': 0.6,
  'want to play': 0.8,
};

export function getTrajectoryMultiplier(game: UserGameSnapshot): number {
  if (game.statusTrajectory.length === 0) return 1.0;
  const key = game.statusTrajectory.map(s => s.toLowerCase()).join('|');

  if (TRAJECTORY_MULTIPLIERS[key] !== undefined) return TRAJECTORY_MULTIPLIERS[key];

  if (game.status === 'Completed') return 1.3;
  if (game.status === 'On Hold') return 0.6;
  if (game.status === 'Playing' || game.status === 'Playing Now') return 1.0;
  if (game.status === 'Want to Play') return 0.8;
  if (game.removedAt) return 0.2;
  return 0.5;
}

// ─── Layer 5: Content Similarity (Dense Float32Array — tag-based) ───────────────

// Map-based type retained for buildNegativeProfile (small, built once per run)
export type FeatureVector = Map<string, number>;

/**
 * Dense feature space for fast cosine similarity.
 * Built once per pipeline run from all features in the profile + candidates.
 * Replaces Map<string, number> vectors with compact Float32Arrays and
 * index-based dot products.
 */
export class DenseFeatureSpace {
  private dict = new Map<string, number>();
  private _size = 0;

  get size() { return this._size; }

  /** Normalize key to lowercase to avoid case mismatches between profile/candidate. */
  private static nk(key: string): string { return key.toLowerCase(); }

  /** Register a feature key, returning its dense index. */
  register(key: string): number {
    const nk = DenseFeatureSpace.nk(key);
    let idx = this.dict.get(nk);
    if (idx === undefined) {
      idx = this._size++;
      this.dict.set(nk, idx);
    }
    return idx;
  }

  /** Build a dense vector from a profile. */
  profileToDense(profile: TasteProfile): { vec: Float32Array; mag: number } {
    const vec = new Float32Array(this._size);
    const nk = DenseFeatureSpace.nk;
    const add = (features: FeatureWeight[], prefix: string) => {
      for (const f of features) {
        const idx = this.dict.get(nk(`${prefix}:${f.name}`));
        if (idx !== undefined) vec[idx] = f.weight;
      }
    };
    add(profile.genres, 'g');
    add(profile.themes, 't');
    add(profile.gameModes, 'm');
    add(profile.perspectives, 'p');
    add(profile.developers.slice(0, 20), 'd');
    add(profile.publishers.slice(0, 15), 'pub');

    let mag = 0;
    for (let i = 0; i < this._size; i++) mag += vec[i] * vec[i];
    return { vec, mag: Math.sqrt(mag) };
  }

  /**
   * Extract the non-zero feature indices for a candidate (binary vector).
   * Deduplicates indices — duplicate genres/themes from the source data
   * would otherwise inflate the dot product and break cosine correctness.
   * Returns unique indices array and magnitude (sqrt of count).
   */
  candidateToIndices(c: CandidateGame): { indices: number[]; mag: number } {
    const seen = new Set<number>();
    const push = (idx: number | undefined) => {
      if (idx !== undefined) seen.add(idx);
    };
    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (can) push(this.dict.get(`g:${norm(can)}`));
    }
    for (const t of c.themes) push(this.dict.get(`t:${norm(t)}`));
    for (const m of c.gameModes) push(this.dict.get(`m:${norm(m)}`));
    for (const p of c.perspectives) push(this.dict.get(`p:${norm(p)}`));
    if (c.developer) push(this.dict.get(`d:${norm(c.developer)}`));
    if (c.publisher) push(this.dict.get(`pub:${norm(c.publisher)}`));
    const indices = [...seen];
    return { indices, mag: Math.sqrt(indices.length) };
  }

  /** Convert a legacy Map-based vector to a dense Float32Array. */
  mapToDense(map: FeatureVector): { vec: Float32Array; mag: number } {
    const nk = DenseFeatureSpace.nk;
    const vec = new Float32Array(this._size);
    for (const [key, val] of map) {
      const idx = this.dict.get(nk(key));
      if (idx !== undefined) vec[idx] = val;
    }
    let mag = 0;
    for (let i = 0; i < this._size; i++) mag += vec[i] * vec[i];
    return { vec, mag: Math.sqrt(mag) };
  }
}

/** Cosine similarity between a dense profile vector and a binary candidate (index-based). */
export function fastCosineProfileVsCandidate(
  profileVec: Float32Array, profileMag: number,
  candidateIndices: number[], candidateMag: number,
): number {
  if (candidateIndices.length === 0 || profileMag === 0 || candidateMag === 0) return 0;
  let dot = 0;
  for (let i = 0; i < candidateIndices.length; i++) dot += profileVec[candidateIndices[i]];
  return dot / (profileMag * candidateMag);
}


// ─── Layer 6: Semantic Similarity (Embedding cosine — optional) ─────────────────

export function computeSemanticSimilarity(
  tasteCentroid: Float64Array | null,
  candidateEmbedding: number[] | undefined,
): number {
  if (!tasteCentroid || !candidateEmbedding || candidateEmbedding.length === 0) return 0;

  const dim = candidateEmbedding.length;
  if (tasteCentroid.length !== dim) return 0;

  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < dim; i++) {
    dot += tasteCentroid[i] * candidateEmbedding[i];
    magA += tasteCentroid[i] * tasteCentroid[i];
    magB += candidateEmbedding[i] * candidateEmbedding[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Layer 7: Co-Occurrence Graph + Similar-Games Graph ──────────────────────────

export async function buildCoOccurrenceEdges(
  candidates: CandidateGame[],
  onProgress?: (fraction: number) => void,
): Promise<Map<string, Map<string, number>>> {
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
  const MAX_NEIGHBORS = 150;
  const progressStep = Math.max(1, Math.floor(candidates.length / 10));

  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    const myTags = tagSets.get(c.gameId)!;
    // Walk genre buckets lazily and stop at the cap. This used to materialize
    // the full union of every shared-genre bucket (thousands of ids per
    // candidate in a 3K pool) before the 150 cap was ever applied. Visiting
    // order is unchanged — bucket by bucket, first occurrence wins.
    const visited = new Set<string>();

    let neighborCount = 0;
    outer:
    for (const g of c.genres) {
      const can = toCanonicalGenre(g);
      if (!can) continue;
      const ids = genreIndex.get(norm(can));
      if (!ids) continue;
      for (const otherId of ids) {
        if (neighborCount >= MAX_NEIGHBORS) break outer;
        if (otherId === c.gameId || visited.has(otherId)) continue;
        visited.add(otherId);
        const otherTags = tagSets.get(otherId);
        if (!otherTags) continue;

        let intersection = 0;
        for (const t of myTags) {
          if (otherTags.has(t)) intersection++;
        }
        if (intersection < 3) continue;

        const union = myTags.size + otherTags.size - intersection;
        const jaccard = union > 0 ? intersection / union : 0;

        if (!edges.has(c.gameId)) edges.set(c.gameId, new Map());
        edges.get(c.gameId)!.set(otherId, jaccard);
        neighborCount++;
      }
    }

    if (onProgress && ci % progressStep === 0) {
      onProgress(ci / candidates.length);
    }
    if (ci % 5000 === 0 && ci > 0) await new Promise(r => setTimeout(r, 4));
  }

  return edges;
}

/** Pre-computed user-game lookup tables — built once per pipeline run. */
export interface GraphUserContext {
  ugSimilarNormSets: Map<string, Set<string>>;
  ugTitleNorms: Map<string, string>;
  ugWeights: Map<string, number>;
}

export function buildGraphUserContext(userGames: UserGameSnapshot[], now: number): GraphUserContext {
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

export function computeGraphSignal(
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

export function computeQualitySignal(
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

export function computePopularityAdjustment(playerCount: number | null, maxPlayerCount: number): number {
  if (!playerCount || playerCount <= 0 || maxPlayerCount <= 0) return 1.0;
  return 1.0 - (Math.log(playerCount + 1) / Math.log(maxPlayerCount + 1)) * 0.25;
}

// ─── Layer 10: Time-of-Day Contextual Boost ────────────────────────────────────

export interface TimeOfDayContext {
  affinity: Map<string, number>;
  hasSufficientData: boolean;
}

/** Build time-of-day genre affinity ONCE per pipeline run (not per candidate). */
export function buildTimeOfDayContext(
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

export function computeTimeOfDayBoost(candidate: CandidateGame, ctx: TimeOfDayContext): number {
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

// ─── Layer 11: Franchise Detection & Scoring → @/services/franchise ──────────────
// ─── Layer 12: Studio Loyalty Boost ─────────────────────────────────────────────

export function computeStudioLoyaltyBoost(
  candidate: CandidateGame,
  loyalDevelopers: string[],
  profile: TasteProfile,
): number {
  const candDev = norm(candidate.developer);
  const candPub = norm(candidate.publisher);

  for (const dev of loyalDevelopers) {
    if (candDev === dev || candPub === dev) {
      return 0.35;
    }
  }

  for (const pub of profile.loyalPublishers) {
    if (candPub === pub || candDev === pub) {
      return 0.25;
    }
  }

  return 0;
}

// ─── Layer 13: Cross-Game Session Sequencing ────────────────────────────────────

export interface SequencingContext {
  transitions: Map<string, Map<string, number>>;
  transitionTotals: Map<string, number>;
  recentGameGenres: string[][];
  hasSufficientData: boolean;
}

/** Build session sequencing context ONCE per pipeline run (not per candidate). */
export function buildSequencingContext(userGames: UserGameSnapshot[]): SequencingContext {
  const allSessions: { gameId: string; timestamp: number; genres: string[] }[] = [];

  for (const ug of userGames) {
    const canonNorm = ug.genres.map(g => toCanonicalGenre(g)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c));
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
    recentGameGenres: recentGames.map(g => g.genres.map(x => toCanonicalGenre(x)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c))),
    hasSufficientData: recentGames.length > 0,
  };
}

export function computeSequencingBoost(candidate: CandidateGame, ctx: SequencingContext): number {
  if (!ctx.hasSufficientData) return 0;

  const candidateGenresNorm = candidate.genres.map(g => toCanonicalGenre(g)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c));
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

export function mmrRerank(scored: ScoredGame[], lambda: number, limit: number, onProgress?: (fraction: number) => void): ScoredGame[] {
  if (scored.length <= 1) return scored.slice(0, limit);

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
      const maxSim = mmrMaxSim(candidate, selected);
      const mmrScore = lambda * candidate.score - negLambda * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
    if (onProgress && selected.length % 10 === 0) {
      onProgress(selected.length / limit);
    }
  }

  return selected;
}

// ─── Diagnostics ───────────────────────────────────────────────────────────────

/** Layer keys reported in telemetry, in display order (matches ScoredGame.layerScores). */
export const TELEMETRY_LAYERS = [
  'contentSimilarity',
  'semanticSimilarity',
  'clusterSemanticSim',
  'graphSignal',
  'qualitySignal',
  'popularitySignal',
  'recencyBoost',
  'diversityBonus',
  'timeOfDayBoost',
  'engagementCurveBonus',
  'franchiseBoost',
  'studioLoyaltyBoost',
  'sequencingBoost',
  'mlSignal',
  'graphPageRankSignal',
  'graphCommunityAffinity',
  'positiveAffinity',
  'negativeSignal',
] as const;

/**
 * Summarise how much each scoring layer actually contributes across the
 * scored pool. Pure — the worker calls it once per run, tests call it on
 * fixtures. A layer with coverage ~0 is dead weight for this library.
 */
export function computeRecoTelemetry(args: {
  scored: ScoredGame[];
  /** Weight each layer carried in the composite (layer key → weight). */
  weights: Record<string, number>;
  funnel: RecoTelemetry['funnel'];
  embeddingCoverage: number;
  mlCoverage: number;
  graphScoresAvailable: boolean;
}): RecoTelemetry {
  const { scored, weights, funnel } = args;
  const layers: RecoLayerStat[] = TELEMETRY_LAYERS.map(layer => {
    const values: number[] = [];
    let nonZero = 0;
    for (const g of scored) {
      const v = (g.layerScores as unknown as Record<string, number>)[layer] ?? 0;
      values.push(v);
      if (v > 0) nonZero++;
    }
    values.sort((a, b) => a - b);
    const n = values.length;
    return {
      layer,
      coverage: n > 0 ? nonZero / n : 0,
      min: n > 0 ? values[0] : 0,
      median: n > 0 ? values[Math.floor(n / 2)] : 0,
      max: n > 0 ? values[n - 1] : 0,
      weight: weights[layer] ?? 0,
    };
  });

  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 20);
  const counts = new Map<number, number>();
  for (const g of top) {
    const k = Math.round(g.score * 1e6);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let top20Ties = 0;
  for (const c of counts.values()) if (c > 1) top20Ties += c;

  let weightSum = 0;
  for (const layer of TELEMETRY_LAYERS) {
    if (layer === 'negativeSignal') continue;
    weightSum += weights[layer] ?? 0;
  }

  return {
    layers,
    top20Ties,
    top20Distinct: counts.size,
    funnel,
    embeddingCoverage: args.embeddingCoverage,
    mlCoverage: args.mlCoverage,
    graphScoresAvailable: args.graphScoresAvailable,
    weightSum,
  };
}
