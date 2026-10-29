/**
 * Shared engagement weight for Oracle centroid / ANN / prefilter.
 * Caps Want-to-Play (no 1.5 floor) and applies session idle-quality (F7).
 */

export interface EngagementWeightInput {
  hoursPlayed: number;
  rating: number;
  status: string;
  /** Set when the user removed the game from the library — a rejection, never positive taste. */
  removedAt?: string;
  /** active / (active + idle); missing → 1 (no penalty). */
  activeToIdleRatio?: number;
  /** On Hold because the idle sweep moved it, not because the user put it down. */
  autoHeld?: boolean;
}

/** Clamp AFK-inflated hours so idle sessions cannot dominate. */
export function clampActiveToIdleRatio(ratio: number | undefined | null): number {
  const r = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 1;
  return Math.min(1, Math.max(0.35, r));
}

/** Evidence seed: Completed or meaningfully played (≥2h). */
export function isEvidenceGame(game: Pick<EngagementWeightInput, 'hoursPlayed' | 'status'>): boolean {
  return game.status === 'Completed' || game.hoursPlayed >= 2;
}

/** Count evidence games for cold-start gating (F9). */
export function countEvidenceLibrary(
  games: ReadonlyArray<Pick<EngagementWeightInput, 'hoursPlayed' | 'status'> & Partial<Pick<EngagementWeightInput, 'rating' | 'removedAt'>>>,
): number {
  // Rejected games (low rating / removal) are not positive evidence even if played a lot.
  return games.filter(g => isEvidenceGame(g) && computeEngagementWeight({ rating: 0, ...g }) > 0).length;
}

/** Fixed weight for entries with no play and no rating (intent only, not evidence). */
export const UNPLAYED_ENGAGEMENT_WEIGHT = 0.3;
const NEGATIVE_WEIGHT_CAP = 3;
const MIN_PLAYED_HOURS = 0.5;

/**
 * Removal is a rejection only when nothing else says the user liked the game. A removed
 * game that was completed, rated 3+ or played a lot (cleanup, merged duplicate, sold) is
 * not a dislike: it keeps half its positive weight and adds no negative weight.
 */
function isRemovalRejection(game: EngagementWeightInput): boolean {
  if (!game.removedAt) return false;
  const liked = game.rating >= 3 || game.status === 'Completed' || game.hoursPlayed >= 10;
  return !liked;
}

function isUnplayed(game: EngagementWeightInput): boolean {
  return game.rating <= 0 && game.hoursPlayed < MIN_PLAYED_HOURS && game.status !== 'Completed';
}

/**
 * Positive-taste weight for the taste centroid, ANN retrieval, genre/feature profiles and graph.
 * Rejections carry no positive weight (they feed the negative signal instead):
 *   - removed games
 *   - ratings of 1–2 stars, regardless of hours (a hated 80h game must not raise its genres)
 *   - On Hold with under 2h and no 3+ rating (bounced off)
 * Unplayed/unrated entries (Want to Play, never-started) get a small fixed weight.
 * Retrieve weight = shared; worker score may apply temporal decay on top.
 */
export function computeEngagementWeight(game: EngagementWeightInput): number {
  if (isRemovalRejection(game)) return 0;
  if (game.rating > 0 && game.rating < 3) return 0;
  if (game.status === 'On Hold' && game.hoursPlayed < 2 && game.rating < 3) return 0;
  if (isUnplayed(game)) return UNPLAYED_ENGAGEMENT_WEIGHT * clampActiveToIdleRatio(game.activeToIdleRatio);

  let w = 1;
  w += Math.min(Math.max(0, game.hoursPlayed) / 20, 3);
  w += (Math.min(5, Math.max(0, game.rating)) / 5) * 2;
  if (game.status === 'Completed') w += 1;

  // Want-to-Play with some play: still capped — intent signal, not evidence
  if (game.status === 'Want to Play') {
    w = Math.min(w, 0.85);
  }

  const removedKept = game.removedAt ? 0.5 : 1;
  return w * removedKept * clampActiveToIdleRatio(game.activeToIdleRatio);
}

/**
 * Negative-taste magnitude (≥ 0) for the negative centroid and negative feature profile:
 * low ratings (1★ = 2, 2★ = 1), removal (1), and bouncing off early (0.7). Capped at 3.
 */
export function computeNegativeWeight(game: EngagementWeightInput): number {
  let n = 0;
  if (game.rating > 0 && game.rating < 3) n += game.rating === 1 ? 2 : 1;
  if (isRemovalRejection(game)) n += 1;
  // Bouncing off early is the user putting a game down; an automatic idle hold is not.
  if (game.status === 'On Hold' && !game.autoHeld && game.hoursPlayed < 2 && game.rating < 3) n += 0.7;
  return Math.min(n, NEGATIVE_WEIGHT_CAP);
}

/**
 * Temporal decay as a multiplier only — never a WtP floor that re-inflates intent.
 */
export function applyTemporalDecayMultiplier(sharedWeight: number, decay: number): number {
  const d = Number.isFinite(decay) ? Math.max(0, decay) : 1;
  return sharedWeight * d;
}

/**
 * Hero sort key (F2): downweight pure intent when evidence alignment is low.
 * alignment ∈ [0,1] from content/semantic similarity to evidence seeds.
 */
export function heroEvidenceSortKey(score: number, evidenceAlignment: number): number {
  const a = Math.min(1, Math.max(0, evidenceAlignment));
  return score * (0.7 + 0.3 * a);
}
