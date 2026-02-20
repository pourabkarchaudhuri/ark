/**
 * Oracle v3 — Recommendation Engine Types
 *
 * Type definitions for the multi-layer scoring pipeline, taste profiles,
 * taste clusters, franchise detection, recommendation shelves, and all
 * data passed between the main thread and the reco worker.
 *
 * Graceful degradation: the engine works fully without embeddings.
 * When embeddings are available they enhance scoring; when absent the
 * pipeline silently skips the semantic similarity layer.
 */

import type { GameStatus } from './game';

// ─── Taste Profile ─────────────────────────────────────────────────────────────

/** Weighted affinity for a single feature dimension (genre, theme, mode, etc). */
export interface FeatureWeight {
  name: string;
  weight: number;       // accumulated engagement-weighted score
  gameCount: number;    // how many games contributed
  totalHours: number;   // total hours in this dimension
  avgRating: number;    // average user rating for games with this feature
}

/** A detected taste cluster — a coherent "mood" in the user's library. */
export interface TasteCluster {
  id: number;
  label: string;        // auto-generated from dominant genre/theme
  profile: TasteProfile;
  gameCount: number;
  topGames: string[];   // titles of top-engagement games in cluster
  /** Semantic centroid of member games' embeddings (768-dim). Null when no embeddings available. */
  semanticCentroid?: number[];
}

/** The full user taste profile computed from their library + journey. */
export interface TasteProfile {
  genres: FeatureWeight[];
  themes: FeatureWeight[];
  gameModes: FeatureWeight[];
  perspectives: FeatureWeight[];
  developers: FeatureWeight[];
  publishers: FeatureWeight[];
  /** Release era affinity — weight per decade/era bucket. */
  eras: FeatureWeight[];
  /** Overall engagement stats for normalisation. */
  totalGames: number;
  totalHours: number;
  avgRating: number;
  topGenre: string;
  topTheme: string;
  /** Detected taste clusters (2–4 distinct moods). */
  clusters: TasteCluster[];
  /** Developers the user is loyal to (≥3 games, avg rating ≥4). */
  loyalDevelopers: string[];
}

// ─── Franchise Detection ───────────────────────────────────────────────────────

/** A single entry in a detected franchise. */
export interface FranchiseEntry {
  gameId: string;
  title: string;
  releaseDate: string;
  isUserOwned: boolean;
  sequenceIndex: number;  // 0-based position in franchise chronology
}

/** A detected franchise/series cluster. */
export interface FranchiseCluster {
  baseName: string;           // normalized base name, e.g. "the witcher"
  displayName: string;        // pretty display name, e.g. "The Witcher"
  entries: FranchiseEntry[];  // ordered by release date
  userPlayedIds: string[];    // which entries the user has played
  userAvgRating: number;      // avg rating across played entries
  userTotalHours: number;     // total hours across played entries
  developer: string;          // primary developer
}

// ─── Scoring ───────────────────────────────────────────────────────────────────

/** Why a game was recommended — individual signal contributions. */
export interface MatchReasons {
  sharedGenres: string[];
  sharedThemes: string[];
  sharedModes: string[];
  similarTo: string[];         // titles of seed games it's similar to
  metacriticScore: number | null;
  popularityRank: number | null;
  isHiddenGem: boolean;
  isStretchPick: boolean;
  /** Franchise this game belongs to (if any). */
  franchiseOf?: string;
  /** Whether this is a sequel/prequel to a game the user played. */
  isFranchiseEntry: boolean;
  /** Whether this game is on sale. */
  isOnSale: boolean;
  /** Whether this game was surfaced via ANN embedding retrieval. */
  semanticRetrieved: boolean;
  /** Label of the taste cluster this game matched best (from cluster centroid scoring). */
  bestClusterLabel?: string;
  /** Natural-language explanation of why this game was recommended. */
  explanation: string;
}

/** A scored recommendation candidate. */
export interface ScoredGame {
  gameId: string;
  title: string;
  coverUrl?: string;
  headerImage?: string;
  developer: string;
  publisher: string;
  genres: string[];
  themes: string[];
  gameModes: string[];
  platforms: string[];
  metacriticScore: number | null;
  playerCount: number | null;
  releaseDate: string;
  /** Composite score from all layers [0–1]. */
  score: number;
  /** Individual layer scores for debugging / display. */
  layerScores: {
    contentSimilarity: number;
    semanticSimilarity: number;       // 0 when embeddings unavailable
    clusterSemanticSim: number;       // max cosine to any cluster centroid
    graphSignal: number;
    qualitySignal: number;
    popularitySignal: number;
    recencyBoost: number;
    diversityBonus: number;
    trajectoryMultiplier: number;
    negativeSignal: number;
    timeOfDayBoost: number;
    engagementCurveBonus: number;
    franchiseBoost: number;
    studioLoyaltyBoost: number;
    sequencingBoost: number;
  };
  reasons: MatchReasons;
  /** Price info (if available). */
  price?: {
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
}

// ─── Shelves ───────────────────────────────────────────────────────────────────

export type ShelfType =
  | 'hero'
  | 'because-you-loved'
  | 'deep-in-genre'
  | 'hidden-gems'
  | 'stretch-picks'
  | 'trending-now'
  | 'critics-choice'
  | 'unfinished-business'
  // v2 shelf types
  | 'for-your-mood'
  | 'new-releases-for-you'
  | 'coming-soon-for-you'
  | 'finish-and-try'
  // v3 shelf types
  | 'complete-the-series'
  | 'upcoming-sequels'
  | 'deals-for-you'
  | 'free-for-you'
  | 'from-studios-you-love';

export interface RecoShelf {
  type: ShelfType;
  title: string;
  subtitle?: string;
  /** The seed game title for "because you loved X" shelves. */
  seedGameTitle?: string;
  games: ScoredGame[];
}

// ─── Engagement Patterns ───────────────────────────────────────────────────────

export type EngagementPattern =
  | 'honeymoon'    // high first sessions, then drops
  | 'long-tail'    // spread over many weeks
  | 'binge-drop'   // all sessions in 2-3 days then nothing
  | 'slow-burn'    // session duration increases over time
  | 'unknown';     // insufficient data

// ─── Worker Messages ───────────────────────────────────────────────────────────

/** Snapshot of a library/journey game sent to the worker. */
export interface UserGameSnapshot {
  gameId: string;
  title: string;
  genres: string[];
  themes: string[];
  gameModes: string[];
  perspectives: string[];
  developer: string;
  publisher: string;
  releaseDate: string;
  status: GameStatus;
  hoursPlayed: number;
  rating: number;
  addedAt: string;
  removedAt?: string;
  /** Session pattern metrics pre-computed on main thread. */
  sessionCount: number;
  avgSessionMinutes: number;
  lastSessionDate: string | null;
  activeToIdleRatio: number;
  /** Status trajectory (ordered list of status changes). */
  statusTrajectory: GameStatus[];
  /** Similar games from game metadata (pre-resolved titles). */
  similarGameTitles: string[];
  /** Engagement curve pattern (classified on main thread). */
  engagementPattern: EngagementPattern;
  /** Per-session timestamps and durations for curve analysis. */
  sessionTimestamps: number[];   // start times as epoch ms
  sessionDurations: number[];    // minutes per session
  /** Embedding vector (optional — only present when Ollama/Gemini embeddings are cached). */
  embedding?: number[];
}

/** Candidate game to score (from cache / API browse results). */
export interface CandidateGame {
  gameId: string;
  title: string;
  coverUrl?: string;
  headerImage?: string;
  developer: string;
  publisher: string;
  genres: string[];
  themes: string[];
  gameModes: string[];
  perspectives: string[];
  platforms: string[];
  metacriticScore: number | null;
  playerCount: number | null;
  releaseDate: string;
  similarGameTitles: string[];
  /** Additional quality signals. */
  recommendations?: number;   // Steam user recommendations count
  achievements?: number;      // number of achievements (depth proxy)
  comingSoon?: boolean;        // not yet released
  /** Review sentiment (from Steam). */
  reviewPositivity?: number;   // ratio 0–1 (positive / total)
  reviewVolume?: number;       // total reviews count
  /** Price info. */
  price?: {
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
  /** Embedding vector (optional). */
  embedding?: number[];
  /** True if surfaced via ANN embedding retrieval, not metadata filter. */
  semanticRetrieved?: boolean;
}

/** Payload posted to the worker. */
export interface RecoWorkerInput {
  userGames: UserGameSnapshot[];
  candidates: CandidateGame[];
  now: number; // Date.now() for temporal decay
  /** Current hour (0–23) for time-of-day contextual scoring. */
  currentHour: number;
  /** Fraction of candidates with embeddings (0.0–1.0). Drives proportional semantic weight. */
  embeddingCoverage: number;
  /** Dismissed game IDs — filtered from results. */
  dismissedGameIds: string[];
  /** Precomputed taste centroid (768-dim). Undefined if no library embeddings. */
  tasteCentroid?: number[];
}

/** Progress updates from the worker. */
export interface RecoWorkerProgress {
  type: 'progress';
  stage: string;
  percent: number;
}

/** Final results from the worker. */
export interface RecoWorkerResult {
  type: 'result';
  tasteProfile: TasteProfile;
  shelves: RecoShelf[];
  computeTimeMs: number;
}

export type RecoWorkerMessage = RecoWorkerProgress | RecoWorkerResult;
