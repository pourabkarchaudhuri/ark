/**
 * Shared engagement weight for Oracle centroid / ANN / prefilter.
 * Caps Want-to-Play (no 1.5 floor) and applies session idle-quality (F7).
 */

export interface EngagementWeightInput {
  hoursPlayed: number;
  rating: number;
  status: string;
  /** active / (active + idle); missing → 1 (no penalty). */
  activeToIdleRatio?: number;
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
  games: ReadonlyArray<Pick<EngagementWeightInput, 'hoursPlayed' | 'status'>>,
): number {
  return games.filter(isEvidenceGame).length;
}

/**
 * Engagement weight for taste centroid, ANN retrieval, and genre prefilter.
 * Want-to-Play is capped (mild contribution) — never floored to 1.5.
 * Retrieve weight = shared; worker score may apply temporal decay on top.
 */
export function computeEngagementWeight(game: EngagementWeightInput): number {
  let w = 1;
  w += Math.min(Math.max(0, game.hoursPlayed) / 20, 3);
  w += (Math.min(5, Math.max(0, game.rating)) / 5) * 2;
  if (game.status === 'Completed') w += 1;

  // Cap WtP for centroid/ANN — intent signal only, not evidence
  if (game.status === 'Want to Play') {
    w = Math.min(w, 0.85);
  }

  return w * clampActiveToIdleRatio(game.activeToIdleRatio);
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
