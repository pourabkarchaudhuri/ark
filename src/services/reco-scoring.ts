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
  TasteCluster,
} from '@/types/reco';
import { toCanonicalGenre, toCanonicalGenres, CANONICAL_GENRES } from '@/data/canonical-genres';
import {
  applyTemporalDecayMultiplier,
  computeEngagementWeight,
  computeNegativeWeight,
} from '@/services/engagement-weight';
import { dotUnit, embeddingSimilarityToUnit } from '@/services/mmr-embedding';
import { canonicalFranchiseBase } from '@/services/franchise';

/** ANN cosine-distance ceiling for Taste Match pill (mirrors reco-store). */
export const ANN_TASTE_MATCH_CEILING = 0.45;

/** Words that carry no taste signal in notes/titles. */
const NOTE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'was', 'were', 'are', 'but', 'not', 'you', 'your', 'its',
  'game', 'games', 'play', 'played', 'playing', 'edition', 'remastered', 'definitive', 'deluxe', 'complete',
  'from', 'have', 'has', 'had', 'very', 'really', 'just', 'about', 'than', 'then', 'into', 'out', 'all',
]);

/** Tokenize notes / titles for light lexical overlap (F8), minus stopwords. */
export function noteTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !NOTE_STOPWORDS.has(t)),
  );
}

/** Largest additive contribution of the notes-overlap bonus (F8). */
export const NOTES_BONUS_MAX = 0.03;

/**
 * Notes overlap bonus: the share of the candidate's own tokens that appear in the user's
 * loved-game notes, scaled to NOTES_BONUS_MAX. Normalised by the candidate (not by the size of
 * the user's notes, which made the bonus vanish for anyone who writes a lot).
 */
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
  return NOTES_BONUS_MAX * (hit / hay.size);
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

  // A short run that ended in completion is a finished game, not a dropped one.
  if (spanDays <= 3 && sessionCount >= 3) return snap.status === 'Completed' ? 'unknown' : 'binge-drop';

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
    // Rejected games (1-2 stars, removed, bounced) are not positive taste: they must not add
    // weight, game counts, hours or ratings to a feature (that would also inflate "loyal" studios).
    if (engagement <= 0) continue;
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

const LEGAL_SUFFIX = /(?:\s+|^)(?:inc|llc|ltd|co|corp|corporation|company|gmbh|ag|sa|bv|pty|limited)\.?$/i;
const PLACEHOLDER_NAMES = new Set(['unknown', 'unknown developer', 'unknown publisher', 'n/a', 'none', 'tbd', 'various']);

/**
 * Lower-cased individual names from a credit line ("A, B / C; D", "A & B"). Trailing legal suffixes
 * ("Foo, Inc." / "Capcom Co., Ltd.") are not separate studios and are stripped; placeholders are dropped.
 */
export function splitCreditedNames(credit: string | undefined | null): string[] {
  if (!credit) return [];
  const out: string[] = [];
  for (const raw of credit.split(/\s*[,;/]\s*|\s+&\s+|\s+\+\s+/)) {
    let name = raw.toLowerCase().trim();
    // Repeatedly strip suffixes so "capcom co" (from "Capcom Co., Ltd.") reduces to "capcom".
    for (let i = 0; i < 3 && LEGAL_SUFFIX.test(name); i++) name = name.replace(LEGAL_SUFFIX, '').trim();
    name = name.replace(/[.\s]+$/, '');
    if (!name || PLACEHOLDER_NAMES.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
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
  const developers = buildFeatureMap(games, now, g => splitCreditedNames(g.developer));
  const publishers = buildFeatureMap(games, now, g => splitCreditedNames(g.publisher));
  const eras = buildFeatureMap(games, now, g => g.releaseDate ? [getReleaseBucket(g.releaseDate)] : []);

  const totalHours = games.reduce((s, g) => s + g.hoursPlayed, 0);
  const ratedGames = games.filter(g => g.rating > 0);
  const avgRating = ratedGames.length > 0
    ? ratedGames.reduce((s, g) => s + g.rating, 0) / ratedGames.length
    : 0;

  // Loyal studio: at least two games they actually played (10h+ in total) AND, when rated, liked.
  const isLoyal = (f: { gameCount: number; totalHours: number; avgRating: number }) =>
    f.gameCount >= 2 && f.totalHours >= 10 && (f.avgRating === 0 || f.avgRating >= 3.5);
  const loyalDevelopers = developers.filter(isLoyal).map(d => d.name);
  const loyalPublishers = publishers.filter(isLoyal).map(p => p.name);

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
  const negativeGames = games.filter(g => computeNegativeWeight(g) > 0);

  const vec: FeatureVector = new Map();
  const addFeatures = (genres: string[], themes: string[], developer: string, weight = 1) => {
    for (const genre of genres) {
      const can = toCanonicalGenre(genre);
      if (can) vec.set(`g:${norm(can)}`, (vec.get(`g:${norm(can)}`) || 0) + weight);
    }
    for (const theme of themes) vec.set(`t:${norm(theme)}`, (vec.get(`t:${norm(theme)}`) || 0) + weight);
    for (const d of splitCreditedNames(developer)) vec.set(`d:${d}`, (vec.get(`d:${d}`) || 0) + weight);
  };

  for (const g of negativeGames) {
    addFeatures(g.genres, g.themes, g.developer, computeNegativeWeight(g));
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
    for (const d of splitCreditedNames(c.developer)) push(this.dict.get(`d:${d}`));
    for (const p of splitCreditedNames(c.publisher)) push(this.dict.get(`pub:${p}`));
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

/** Minimum matched-feature count in the cosine denominator (stops a 1-tag candidate scoring as a perfect match). */
export const COSINE_MIN_MATCHED_FEATURES = 3;

/**
 * Cosine between a dense profile vector and a binary candidate, over the features the profile
 * actually weights. Candidate features the profile has no opinion on neither help nor hurt, so
 * metadata completeness is not rewarded or penalised. `_candidateMag` is kept for call-site
 * compatibility.
 */
export function fastCosineProfileVsCandidate(
  profileVec: Float32Array, profileMag: number,
  candidateIndices: number[], _candidateMag: number,
): number {
  if (candidateIndices.length === 0 || profileMag === 0) return 0;
  let dot = 0;
  let matched = 0;
  for (let i = 0; i < candidateIndices.length; i++) {
    const w = profileVec[candidateIndices[i]];
    if (w > 0) { dot += w; matched++; }
  }
  if (matched === 0) return 0;
  return dot / (profileMag * Math.sqrt(Math.max(matched, COSINE_MIN_MATCHED_FEATURES)));
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

// ─── Layer 7: Library-similarity graph signal ────────────────────────────────────
//
// How strongly is this candidate related to games the user actually engaged
// with? Three evidence paths, taking the strongest per library game:
//   1. the library game's own "similar games" list names the candidate (1.0)
//   2. the candidate's similar-games list names the library game (0.8) / shares a neighbour (0.4)
//   3. the candidate is one of the library game's nearest embedding neighbours
//      (computed once per library game on the main thread — see
//      RecoStore.computeLibraryNeighbors — and passed in as `neighborHits`).
// Contributions are engagement-weighted and normalised by the weight mass of
// the user's strongest games, then saturated smoothly, so relating to eight
// loved games scores clearly higher than relating to one.

/** Strip diacritics, ™/®, punctuation and "… Edition" / "Remastered" / "GOTY" suffix noise for title matching. */
export function normalizeTitleKey(raw: string): string {
  return (raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .replace(/\b(?:game of the year|goty|deluxe|complete|enhanced|ultimate|gold|special|collector'?s|anniversary|standard|definitive|director'?s)\s+(?:edition|cut|version)\b/g, ' ')
    .replace(/\b(?:remastered|remaster|goty|game of the year)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A library game's strongest-N weight mass is the "fully related" reference. */
export const GRAPH_MASS_TOP_N = 8;
/** Cosine-distance ceiling shared with ANN taste retrieval; hits farther than this carry no signal. */
export const GRAPH_NEIGHBOR_DISTANCE_CEILING = 0.45;
/** Saturation steepness: score = 1 - exp(-K * matchedMass / referenceMass). */
export const GRAPH_SATURATION_K = 3;
/** Neighbour hits weaker than this (cosine distance near the ceiling) carry no usable signal. */
export const GRAPH_MIN_HIT_STRENGTH = 0.15;
/** A candidate only counts toward graph "coverage" (and keeps the weight) at or above this score. */
export const GRAPH_COVERAGE_MIN_SCORE = 0.05;

/** One embedding-neighbour hit: library game `u` has this candidate at cosine distance `d`. */
export interface GraphNeighborHit {
  u: string;
  d: number;
}

/** Pre-computed user-game lookup tables — built once per pipeline run. */
export interface GraphUserContext {
  ugSimilarKeySets: Map<string, Set<string>>;
  ugTitleKeys: Map<string, string>;
  ugWeights: Map<string, number>;
  /** Sum of the weights of the user's GRAPH_MASS_TOP_N strongest games (>= epsilon). */
  massRef: number;
}

export function buildGraphUserContext(userGames: UserGameSnapshot[], now: number): GraphUserContext {
  const ugSimilarKeySets = new Map<string, Set<string>>();
  const ugTitleKeys = new Map<string, string>();
  const ugWeights = new Map<string, number>();

  for (const ug of userGames) {
    ugSimilarKeySets.set(ug.gameId, new Set(ug.similarGameTitles.map(normalizeTitleKey).filter(k => k !== '')));
    ugTitleKeys.set(ug.gameId, normalizeTitleKey(ug.title));
    // Removed games must not set the "fully related" reference mass or contribute evidence.
    ugWeights.set(ug.gameId, ug.removedAt ? 0 : computeEngagementScore(ug, now) * getTrajectoryMultiplier(ug));
  }

  const top = [...ugWeights.values()].filter(w => w > 0).sort((a, b) => b - a).slice(0, GRAPH_MASS_TOP_N);
  const massRef = Math.max(top.reduce((sum, w) => sum + w, 0), 1e-9);
  return { ugSimilarKeySets, ugTitleKeys, ugWeights, massRef };
}

export function computeGraphSignal(
  candidate: CandidateGame,
  userGames: UserGameSnapshot[],
  neighborHits: GraphNeighborHit[] | undefined,
  gCtx: GraphUserContext,
): { score: number; similarTo: string[] } {
  const candidateKey = normalizeTitleKey(candidate.title);
  const candidateSimilarKeys = new Set(candidate.similarGameTitles.map(normalizeTitleKey).filter(k => k !== ''));

  const neighborStrength = new Map<string, number>();
  if (neighborHits) {
    for (const hit of neighborHits) {
      const strength = clamp01(1 - hit.d / GRAPH_NEIGHBOR_DISTANCE_CEILING);
      if (strength < GRAPH_MIN_HIT_STRENGTH) continue;
      if (strength > (neighborStrength.get(hit.u) ?? 0)) neighborStrength.set(hit.u, strength);
    }
  }

  let matchedMass = 0;
  const contributions: Array<{ title: string; value: number }> = [];

  for (const ug of userGames) {
    const weight = gCtx.ugWeights.get(ug.gameId) ?? 0;
    if (weight <= 0) continue;

    let strength = 0;
    const ugSimilar = gCtx.ugSimilarKeySets.get(ug.gameId)!;
    const ugTitleKey = gCtx.ugTitleKeys.get(ug.gameId)!;
    if (candidateKey !== '' && ugSimilar.has(candidateKey)) {
      strength = 1.0;
    } else if (ugTitleKey !== '' && candidateSimilarKeys.has(ugTitleKey)) {
      strength = 0.8;
    } else {
      for (const st of ugSimilar) {
        if (candidateSimilarKeys.has(st)) { strength = 0.4; break; }
      }
    }
    const viaNeighbor = neighborStrength.get(ug.gameId);
    if (viaNeighbor !== undefined && viaNeighbor > strength) strength = viaNeighbor;

    if (strength > 0) {
      matchedMass += weight * strength;
      contributions.push({ title: ug.title, value: weight * strength });
    }
  }

  const score = clamp01(1 - Math.exp(-GRAPH_SATURATION_K * (matchedMass / gCtx.massRef)));
  contributions.sort((a, b) => b.value - a.value);
  return { score, similarTo: [...new Set(contributions.map(c => c.title).filter(Boolean))].slice(0, 3) };
}

// ─── Layer 8: Quality Signal (multi-factor + small-sample-safe review sentiment) ─

/** Quality of a candidate with no usable stats: below any present-but-low score. */
export const QUALITY_UNKNOWN = 0.05;
/** Stable normaliser for the "recommendations" count (not the current pool's maximum). */
const RECO_LOG_CEIL = Math.log(1_000_001);
/** One-sided ~90% confidence for the Wilson lower bound. */
const WILSON_Z = 1.2816;

/** Wilson lower bound of a positive ratio `p` observed over `n` reviews. */
export function wilsonLowerBound(p: number, n: number): number {
  if (!(n > 0)) return 0;
  const pp = clamp01(p);
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const centre = pp + z2 / (2 * n);
  const margin = WILSON_Z * Math.sqrt((pp * (1 - pp) + z2 / (4 * n)) / n);
  return clamp01((centre - margin) / denom);
}

/**
 * Quality from the evidence that exists, weighted-averaged over the components that are present
 * (a missing stat is unknown, not a free 0.3). Review sentiment uses the Wilson lower bound, so a
 * 3-of-3 positive game cannot beat a 900-of-1000 one and positivity outweighs raw volume.
 * Depends only on the candidate itself — no pool maxima, no wall-clock; recency is its own layer.
 */
export function computeQualitySignal(c: CandidateGame): number {
  let sum = 0;
  let weight = 0;
  const add = (value: number, w: number) => { sum += value * w; weight += w; };

  if (c.metacriticScore && c.metacriticScore > 0) add(clamp01((c.metacriticScore - 50) / 50), 0.30);
  if (c.recommendations && c.recommendations > 0) add(clamp01(Math.log(c.recommendations + 1) / RECO_LOG_CEIL), 0.15);
  if (c.reviewPositivity !== undefined && c.reviewVolume !== undefined && c.reviewVolume > 0) {
    add(wilsonLowerBound(c.reviewPositivity, c.reviewVolume), 0.35);
  }
  // Achievement count says little about quality: small, capped contribution.
  if (c.achievements && c.achievements > 0) add(clamp01(c.achievements / 100), 0.05);

  return weight > 0 ? clamp01(sum / weight) : QUALITY_UNKNOWN;
}

// ─── Layer 9: Popularity debiasing ─────────────────────────────────────────────

/**
 * A real debias: the less crowded a game is, the higher the signal (blockbusters are already
 * served by the quality layer). Unknown player count is neutral (0.5).
 */
export function computePopularitySignal(playerCount: number | null | undefined, maxPlayerCount: number): number {
  if (!playerCount || !(playerCount > 0) || !(maxPlayerCount > 0)) return 0.5;
  const raw = clamp01(Math.log(playerCount + 1) / Math.log(maxPlayerCount + 1));
  return clamp01(1 - 0.7 * raw);
}

/** Value at quantile `q` (0..1) of an ascending-sorted array; NaN when empty. */
export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

// ─── Recency ───────────────────────────────────────────────────────────────────

/**
 * Newer is better over a 10-year window. Uses UTC years against the pipeline's `now` (so a
 * "2026-01-01" release is not read as 2025 west of UTC). Unreleased and unparseable dates are
 * neutral (0.3) — a future year must never clamp to the maximum boost.
 */
export function computeRecencyBoost(releaseDate: string | undefined, nowMs: number): number {
  const t = releaseDate ? Date.parse(releaseDate) : Number.NaN;
  if (Number.isNaN(t) || t > nowMs) return 0.3;
  const diff = new Date(nowMs).getUTCFullYear() - new Date(t).getUTCFullYear();
  return clamp01(1 - diff / 10);
}

// ─── Diversity ─────────────────────────────────────────────────────────────────

/** Bonus for genres the user engages with least; 0 (not the maximum) when no genre is recognised. */
export function computeDiversityBonus(
  candidateCanonGenres: string[],
  tasteGenres: Array<{ name: string; weight: number }>,
  maxGenreWeight: number,
): number {
  if (candidateCanonGenres.length === 0 || !(maxGenreWeight > 0)) return 0;
  const sum = candidateCanonGenres.reduce((acc, g) => {
    const found = tasteGenres.find(fg => norm(fg.name) === norm(g));
    return acc + (found ? found.weight : 0);
  }, 0);
  const avg = sum / candidateCanonGenres.length;
  return clamp01(1 - avg / maxGenreWeight) * 0.5;
}

// ─── Layer 10: Time-of-Day Contextual Boost ────────────────────────────────────

export interface TimeOfDayContext {
  affinity: Map<string, number>;
  hasSufficientData: boolean;
}

/** Sessions needed in the current time bucket before claiming a time-of-day habit. */
export const TOD_MIN_BUCKET_SESSIONS = 8;
/** Sessions of one genre in the bucket before it can carry a time-of-day boost. */
const TOD_MIN_GENRE_SESSIONS = 3;
const TOD_SMOOTH_K = 3;
/** Lift over the user's overall genre mix at which the boost saturates is 1 + this. */
const TOD_LIFT_SPAN = 1.5;

function hourBucket(hour: number): 'night' | 'morning' | 'afternoon' | 'evening' {
  return hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/**
 * Time-of-day genre affinity, built ONCE per pipeline run: how much more a genre is played in
 * the current bucket than across the day (lift over the user's own baseline, so a genre they
 * simply play most of the time is not "a night habit").
 */
export function buildTimeOfDayContext(
  userGames: UserGameSnapshot[],
  currentHour: number,
): TimeOfDayContext {
  const bucket = hourBucket(currentHour);

  const inBucket = new Map<string, number>();
  const overall = new Map<string, number>();
  let bucketTotal = 0;
  let overallTotal = 0;

  for (const ug of userGames) {
    if (computeEngagementWeight(ug) <= 0) continue; // sessions of rejected games say nothing about preference
    const genres = [...new Set(ug.genres.map(g => toCanonicalGenre(g)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c)))];
    if (genres.length === 0) continue;
    for (const ts of ug.sessionTimestamps) {
      const inThisBucket = hourBucket(new Date(ts).getHours()) === bucket;
      overallTotal++;
      if (inThisBucket) bucketTotal++;
      for (const key of genres) {
        overall.set(key, (overall.get(key) ?? 0) + 1);
        if (inThisBucket) inBucket.set(key, (inBucket.get(key) ?? 0) + 1);
      }
    }
  }

  if (bucketTotal < TOD_MIN_BUCKET_SESSIONS) return { affinity: new Map(), hasSufficientData: false };

  const affinity = new Map<string, number>();
  for (const [key, count] of inBucket) {
    if (count < TOD_MIN_GENRE_SESSIONS) continue;
    const overallShare = (overall.get(key) ?? 0) / overallTotal;
    if (overallShare <= 0) continue;
    // Add-k smoothing toward the overall share: a genre seen once or twice cannot saturate the lift.
    const bucketShare = (count + TOD_SMOOTH_K * overallShare) / (bucketTotal + TOD_SMOOTH_K);
    const lift = bucketShare / overallShare;
    const boost = clamp01((lift - 1) / TOD_LIFT_SPAN);
    if (boost > 0) affinity.set(key, boost);
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
  // Roles are not interchangeable: a loyal developer is matched against developers only,
  // a loyal publisher against publishers only. Co-credits are split first.
  const candDevs = splitCreditedNames(candidate.developer);
  const candPubs = splitCreditedNames(candidate.publisher);

  if (loyalDevelopers.some(dev => candDevs.includes(dev))) return 0.35;
  if (profile.loyalPublishers.some(pub => candPubs.includes(pub))) return 0.25;
  return 0;
}

// ─── Layer 13: Cross-Game Session Sequencing ────────────────────────────────────

export interface SequencingContext {
  transitions: Map<string, Map<string, number>>;
  transitionTotals: Map<string, number>;
  /** Share of all sessions in which each genre appears (the baseline transitions are compared to). */
  genreBaseline: Map<string, number>;
  recentGameGenres: string[][];
  hasSufficientData: boolean;
}

/** Sessions needed before claiming a cross-game sequencing habit. */
export const SEQUENCING_MIN_SESSIONS = 8;
/** Transitions out of a genre needed before it can predict the next one. */
export const SEQUENCING_MIN_TRANSITIONS = 4;
const SEQUENCING_SMOOTH_K = 3;

/** Build session sequencing context ONCE per pipeline run (not per candidate). */
export function buildSequencingContext(userGames: UserGameSnapshot[]): SequencingContext {
  const allSessions: { gameId: string; timestamp: number; genres: string[] }[] = [];

  for (const ug of userGames) {
    if (computeEngagementWeight(ug) <= 0) continue;
    const canonNorm = ug.genres.map(g => toCanonicalGenre(g)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c));
    for (const ts of ug.sessionTimestamps) {
      allSessions.push({
        gameId: ug.gameId,
        timestamp: ts,
        genres: canonNorm,
      });
    }
  }

  if (allSessions.length < SEQUENCING_MIN_SESSIONS) {
    return { transitions: new Map(), transitionTotals: new Map(), genreBaseline: new Map(), recentGameGenres: [], hasSufficientData: false };
  }

  allSessions.sort((a, b) => a.timestamp - b.timestamp);

  // Baseline = share of genre *mentions* (same unit as the next-genre shares below, which sum to 1).
  const genreBaseline = new Map<string, number>();
  let mentions = 0;
  for (const sess of allSessions) {
    for (const g of new Set(sess.genres)) { genreBaseline.set(g, (genreBaseline.get(g) ?? 0) + 1); mentions++; }
  }
  for (const [g, n] of genreBaseline) genreBaseline.set(g, n / Math.max(1, mentions));

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
    .filter(g => g.lastSessionDate && computeEngagementWeight(g) > 0)
    .sort((a, b) => new Date(b.lastSessionDate!).getTime() - new Date(a.lastSessionDate!).getTime())
    .slice(0, 3);

  return {
    transitions,
    transitionTotals,
    genreBaseline,
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
      if (totalTrans < SEQUENCING_MIN_TRANSITIONS) continue;

      for (const candidateGenre of candidateGenresNorm) {
        const count = trans.get(candidateGenre) || 0;
        // Lift over how often the candidate genre is played anyway: following RPG with Puzzle
        // means little when Puzzle is half of everything the user plays.
        const baseline = Math.max(ctx.genreBaseline.get(candidateGenre) ?? 0, 0.05);
        // Add-k smoothing toward "no lift" so a handful of transitions cannot saturate the signal.
        const lift = (count + SEQUENCING_SMOOTH_K * baseline) / (totalTrans + SEQUENCING_SMOOTH_K) / baseline;
        totalAffinity += clamp01((lift - 1) / 2);
        affinityCount++;
      }
    }
  }

  return affinityCount > 0 ? clamp01(totalAffinity / affinityCount) : 0;
}

// ─── Layer 14: MMR Diversity Re-Ranking ─────────────────────────────────────────

/** Scale of genre-Jaccard similarity relative to the rescaled embedding cosine. */
const MMR_JACCARD_SCALE = 0.6;

export interface MmrOptions {
  /**
   * Relevance of a game. Defaults to `score`. The worker passes the evidence-aligned hero key so the
   * first pick (the hero) is not overridden by a plain score re-sort.
   */
  relevance?: (g: ScoredGame) => number;
  /** Unit-length embedding sketches by gameId (see mmr-embedding.ts). Missing → genre-Jaccard similarity. */
  vectors?: Record<string, ArrayLike<number>>;
}

/**
 * Maximal Marginal Relevance with incremental max-similarity (O(pool × limit)).
 *   mmr = λ·relevance − (1−λ)·maxSim(candidate, selected)
 * Relevance is min-max normalised over the pool so it is on the same 0–1 scale as the similarity
 * (raw scores sit in a narrow low band and the penalty used to dominate). Similarity is the embedding
 * cosine (rescaled so "unrelated" ≈ 0) when both games have a sketch, else genre-Jaccard, and is
 * lifted to 1 for the same franchise and 0.8 for the same developer. Per-game canonical sets are
 * computed once, not per pair.
 */
export function mmrRerank(
  scored: ScoredGame[],
  lambda: number,
  limit: number,
  onProgress?: (fraction: number) => void,
  opts: MmrOptions = {},
): ScoredGame[] {
  if (limit <= 0 || scored.length === 0) return [];
  if (scored.length <= 1) return scored.slice(0, limit);

  const rel = opts.relevance ?? ((g: ScoredGame) => g.score);
  const n = scored.length;
  // Non-finite relevance counts as the pool minimum (it must never win the hero pick).
  const finiteVals = scored.map(rel).filter(Number.isFinite).sort((a, b) => a - b);
  const floorVal = finiteVals.length > 0 ? finiteVals[0] : 0;
  const relRaw = scored.map(g => { const v = rel(g); return Number.isFinite(v) ? v : floorVal; });
  // 2nd–98th percentile clamp: one outlier must not compress everyone else (and hand the similarity penalty control).
  const lo = finiteVals.length > 0 ? finiteVals[Math.floor(0.02 * (finiteVals.length - 1))] : 0;
  const hi = finiteVals.length > 0 ? finiteVals[Math.ceil(0.98 * (finiteVals.length - 1))] : 0;
  const span = hi - lo;
  const relNorm = relRaw.map(v => (span > 1e-12 ? Math.min(1, Math.max(0, (v - lo) / span)) : 1));

  const genreSets = scored.map(g => new Set(
    g.genres.map(x => toCanonicalGenre(x)).filter((c): c is NonNullable<typeof c> => c !== null).map(c => norm(c)),
  ));
  const bases = scored.map(g => canonicalFranchiseBase(g.title));
  const devs = scored.map(g => norm(g.developer));
  const vecs = scored.map(g => opts.vectors?.[g.gameId]);

  const sim = (i: number, j: number): number => {
    let s0: number;
    const vi = vecs[i];
    const vj = vecs[j];
    if (vi && vj) {
      s0 = embeddingSimilarityToUnit(dotUnit(vi, vj));
    } else {
      let inter = 0;
      for (const g of genreSets[i]) if (genreSets[j].has(g)) inter++;
      const union = genreSets[i].size + genreSets[j].size - inter;
      // Jaccard sits on a coarser, higher scale than the rescaled embedding cosine; damp it so games without
      // a sketch are not penalised harder than embedded ones.
      s0 = union > 0 ? (inter / union) * MMR_JACCARD_SCALE : 0;
    }
    if (bases[i] && bases[i] === bases[j]) s0 = 1;
    else if (devs[i] && devs[i] === devs[j]) s0 = Math.max(s0, 0.8);
    return s0;
  };

  const negLambda = 1 - lambda;
  const maxSim = new Float64Array(n); // vs the selected set (0 while empty)
  const taken = new Uint8Array(n);
  const selected: ScoredGame[] = [];

  // Hero: the most relevant game (by the caller's relevance key).
  let first = 0;
  for (let i = 1; i < n; i++) if (relRaw[i] > relRaw[first]) first = i;
  const take = (idx: number) => {
    taken[idx] = 1;
    selected.push(scored[idx]);
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      const s0 = sim(i, idx);
      if (s0 > maxSim[i]) maxSim[i] = s0;
    }
  };
  take(first);

  while (selected.length < limit && selected.length < n) {
    let bestIdx = -1;
    let bestMMR = -Infinity;
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      const m = lambda * relNorm[i] - negLambda * maxSim[i];
      if (m > bestMMR) { bestMMR = m; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    take(bestIdx);
    if (onProgress && selected.length % 10 === 0) onProgress(selected.length / limit);
  }

  return selected;
}

// ─── Layer 15: Taste Cluster Detection ──────────────────────────────────────────

/** FNV-1a 32-bit string hash (seed material for deterministic clustering). */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32) — returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adaptive K: sqrt(N/2) clamped to [2, 6] — scales with library size without fragmenting small collections. */
export function adaptiveK(n: number): number {
  return Math.max(2, Math.min(6, Math.floor(Math.sqrt(n / 2))));
}

export function detectTasteClusters(
  userGames: UserGameSnapshot[],
  now: number,
  k?: number,
): TasteCluster[] {
  // Rejected games are not a taste group: they would form their own cluster and reward look-alikes.
  userGames = userGames.filter(g => computeEngagementWeight(g) > 0);
  const effectiveK = k ?? adaptiveK(userGames.length);
  if (userGames.length < effectiveK * 2) return [];

  // Deterministic + order-independent: the main thread and the worker must
  // derive identical clusters from the same library. Sort by id and seed the
  // k-means init from the ids (it used Math.random(), so clusters, shelves and
  // labels changed on every run).
  userGames = [...userGames].sort((x, y) => (x.gameId < y.gameId ? -1 : x.gameId > y.gameId ? 1 : 0));
  const rand = seededRandom(hashString(userGames.map(g => g.gameId).join('|')));

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
  for (let i = 0; i < effectiveK; i++) {
    let idx: number;
    do { idx = Math.floor(rand() * vectors.length); } while (used.has(idx) && used.size < vectors.length);
    used.add(idx);
    centroids.push([...vectors[idx]]);
  }

  const assignments = new Array<number>(vectors.length).fill(0);

  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < vectors.length; i++) {
      let bestDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < effectiveK; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = vectors[i][d] - centroids[c][d];
          dist += diff * diff;
        }
        if (dist < bestDist) { bestDist = dist; bestC = c; }
      }
      assignments[i] = bestC;
    }

    for (let c = 0; c < effectiveK; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = members.reduce((s, v) => s + v[d], 0) / members.length;
      }
    }
  }

  const clusters: TasteCluster[] = [];
  for (let c = 0; c < effectiveK; c++) {
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

    // Compute semantic centroid from member games that have embeddings
    let semanticCentroid: number[] | undefined;
    const embeddedMembers = memberGames.filter(g => g.embedding && g.embedding.length > 0);
    if (embeddedMembers.length >= 2) {
      const embDim = embeddedMembers[0].embedding!.length;
      const centroid = new Float64Array(embDim);
      for (const g of embeddedMembers) {
        const emb = g.embedding!;
        for (let d = 0; d < embDim; d++) centroid[d] += emb[d];
      }
      const invN = 1 / embeddedMembers.length;
      for (let d = 0; d < embDim; d++) centroid[d] *= invN;
      // L2-normalize for cosine comparisons
      let mag = 0;
      for (let d = 0; d < embDim; d++) mag += centroid[d] * centroid[d];
      if (mag > 0) {
        const invMag = 1 / Math.sqrt(mag);
        semanticCentroid = new Array(embDim);
        for (let d = 0; d < embDim; d++) semanticCentroid[d] = centroid[d] * invMag;
      }
    }

    clusters.push({
      id: c,
      label,
      profile,
      gameCount: memberGames.length,
      topGames,
      semanticCentroid,
    });
  }

  return clusters.sort((a, b) => b.gameCount - a.gameCount);
}

// ─── Cluster similarity (main thread) ───────────────────────────────────────────

/** A taste cluster's semantic centroid as a typed array (fast inner loop on the main thread). */
export interface PreparedCluster {
  label: string;
  centroid: Float64Array;
}

export function prepareClusterCentroids(clusters: TasteCluster[]): PreparedCluster[] {
  const out: PreparedCluster[] = [];
  for (const cl of clusters) {
    if (cl.semanticCentroid && cl.semanticCentroid.length > 0) {
      out.push({ label: cl.label, centroid: Float64Array.from(cl.semanticCentroid) });
    }
  }
  return out;
}

/**
 * Best cosine similarity between a candidate embedding and any taste-cluster
 * semantic centroid. Runs on the main thread because candidate embeddings are
 * stripped before the worker (25K x 1024 floats would blow the structured
 * clone budget). Returns null when no centroid matches the dimension or none
 * is positively similar (a negative cosine would subtract from the score).
 */
export function bestPreparedClusterSimilarity(
  embedding: ArrayLike<number>,
  prepared: PreparedCluster[],
): { sim: number; label: string } | null {
  let magB = 0;
  for (let d = 0; d < embedding.length; d++) magB += embedding[d] * embedding[d];
  if (magB === 0) return null;
  const invMagB = 1 / Math.sqrt(magB);
  let best: { sim: number; label: string } | null = null;
  for (const { label, centroid } of prepared) {
    if (centroid.length !== embedding.length) continue;
    let dot = 0;
    for (let d = 0; d < embedding.length; d++) dot += centroid[d] * embedding[d];
    // Centroids are L2-normalised in detectTasteClusters.
    const sim = dot * invMagB;
    if (!best || sim > best.sim) best = { sim, label };
  }
  return best && best.sim > 0 ? best : null;
}

/** Convenience wrapper (tests, one-off use). The hot loop should prepare once and reuse. */
export function bestClusterSimilarity(
  embedding: ArrayLike<number>,
  clusters: TasteCluster[],
): { sim: number; label: string } | null {
  return bestPreparedClusterSimilarity(embedding, prepareClusterCentroids(clusters));
}

// ─── Weight assembly ────────────────────────────────────────────────────────────

/** A graph layer needs this fraction of candidates non-zero before it keeps its full weight. */
export const GRAPH_FULL_COVERAGE = 0.10;

export interface ScoringWeights {
  W_SEMANTIC: number;
  W_CLUSTER_SEM: number;
  W_CONTENT: number;
  W_GRAPH: number;
  W_QUALITY: number;
  W_POPULARITY: number;
  W_RECENCY: number;
  W_DIVERSITY: number;
  W_TIME: number;
  W_CURVE: number;
  W_NEGATIVE: number;
  W_POSITIVE: number;
  W_FRANCHISE: number;
  W_STUDIO: number;
  W_SEQUENCING: number;
  W_GRAPH_COMMUNITY: number;
  W_GRAPH_PAGERANK: number;
  W_ML: number;
  W_CONTENT_ML: number;
  W_QUALITY_ML: number;
}

/**
 * The composite-score weight table (v3, 18 layers). Budgets that a layer
 * cannot use are redistributed rather than wasted:
 *  - semantic budget (0.12 x embedding coverage) is split 65/35 with the
 *    cluster layer when cluster scores exist, else all semantic;
 *  - the uncovered part of that budget (0.12 x (1 - coverage)) goes to content + graph;
 *  - the graph layer keeps its full weight only when it actually fires for
 *    >= GRAPH_FULL_COVERAGE of candidates — the shortfall moves to content;
 *  - unused ML budget goes 60/40 to content / quality.
 * Content + semantic + cluster + graph always total 0.41.
 */
/** Defined total of the positive layer weights. */
export const WEIGHT_TOTAL = 1;

export function assembleWeights(p: {
  embeddingCoverage: number;
  hasClusterScores: boolean;
  hasGraphScores: boolean;
  mlCoverage: number;
  /** Share (0–1) of candidates whose graph signal is non-zero. */
  graphSignalCoverage: number;
}): ScoringWeights {
  const semanticBudget = 0.12 * p.embeddingCoverage;
  const residual = 0.12 * (1 - p.embeddingCoverage);

  const graphBase = 0.14 + residual * 0.42;
  const graphShare = clamp01(p.graphSignalCoverage / GRAPH_FULL_COVERAGE);
  const W_GRAPH = graphBase * graphShare;
  const graphShortfall = graphBase - W_GRAPH;

  const graphBudget = p.hasGraphScores ? 0.06 : 0;
  const mlBudget = 0.10;
  const mlResidual = mlBudget * (1 - p.mlCoverage);

  const raw: ScoringWeights = {
    W_SEMANTIC: p.hasClusterScores ? semanticBudget * 0.65 : semanticBudget,
    W_CLUSTER_SEM: p.hasClusterScores ? semanticBudget * 0.35 : 0,
    W_CONTENT: 0.15 + residual * 0.58 + graphShortfall,
    W_GRAPH,
    W_QUALITY: 0.11,
    W_POPULARITY: 0.06,
    W_RECENCY: 0.06,
    W_DIVERSITY: 0.04,
    W_TIME: 0.03,
    W_CURVE: 0.03,
    W_NEGATIVE: 0.06,
    W_POSITIVE: 0.05,
    W_FRANCHISE: 0.08,
    W_STUDIO: 0.05,
    W_SEQUENCING: 0.04,
    W_GRAPH_COMMUNITY: graphBudget * 0.60,
    W_GRAPH_PAGERANK: graphBudget * 0.40,
    W_ML: mlBudget * p.mlCoverage,
    W_CONTENT_ML: mlResidual * 0.60,
    W_QUALITY_ML: mlResidual * 0.40,
  };

  // Normalise so the positive layers sum to exactly WEIGHT_TOTAL (the negative layer scales with
  // them): a defined total makes scores comparable across runs and stops the raw sum (>1) from
  // clamping strong candidates to the same 1.0.
  let positive = 0;
  for (const [k, v] of Object.entries(raw)) if (k !== 'W_NEGATIVE') positive += v;
  const scale = positive > 0 ? WEIGHT_TOTAL / positive : 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v * scale;
  return out as unknown as ScoringWeights;
}

/** Map a raw score onto 0–100 across the pool's [lo, hi] range (raw scores sit in a narrow low band). */
export function calibrateMatchPercent(score: number, lo: number, hi: number): number {
  if (!(hi > lo)) return Math.round(clamp01(score) * 100);
  return Math.round(clamp01((score - lo) / (hi - lo)) * 100);
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
