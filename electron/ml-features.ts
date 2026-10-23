/**
 * Pure ML feature construction (no electron / onnxruntime imports, so vitest can load it).
 *
 * The model was trained on Steam review rows. At recommendation time there is no
 * review, so the "review-level" features describe a hypothetical review by this user
 * with their typical playtime. Those features must be internally consistent
 * (zscore/dev/ratio features derived from the same hours the row claims) or the
 * trees see combinations that never occur in training.
 */

export const N_FEATURES = 242;
export const TOP_K_TAGS = 200;
export const N_NUMERIC = 42;

export interface FeatureDefaults extends Record<string, number> {}

export interface GameProfile {
  g_rec_rate: number;
  g_avg_hours: number;
  g_std_hours: number;
  g_n_reviews: number;
  g_avg_helpful: number;
  g_pct_high_hours: number;
  price?: number;
  discount?: number;
  win?: boolean;
  mac?: boolean;
  linux?: boolean;
  steam_deck?: boolean;
  positive_ratio?: number;
  user_reviews?: number;
  tags?: number[];
}

export interface UserProfile {
  u_rec_rate: number;
  u_avg_hours: number;
  u_std_hours: number;
  u_n_reviews: number;
  u_avg_helpful: number;
  u_avg_funny: number;
  u_pct_high_hours: number;
  log_products: number;
  log_user_rev: number;
}

export interface ProfileGame {
  gameId: string;
  hoursPlayed: number;
  rating: number;
  status: string;
}

export interface ProfileSpec {
  globalRecRate: number;
  smoothM: number;
  defaults: Record<string, number>;
}

const FALLBACK_SPEC: ProfileSpec = { globalRecRate: 0.85, smoothM: 10, defaults: {} };

/** Minutes-of-evidence thresholds: a game only counts as evidence if the user acted on it. */
const MIN_EVIDENCE_HOURS = 0.5;

function statusKey(g: ProfileGame): string {
  return (g.status || '').toLowerCase();
}

/**
 * A game is "evidence" when the user rated it or actually played it.
 * Want to Play / On Hold / unrated-unplayed entries say nothing about taste
 * and must not count as dislikes.
 */
export function isEvidenceGame(g: ProfileGame): boolean {
  return g.rating > 0 || (g.hoursPlayed || 0) >= MIN_EVIDENCE_HOURS || statusKey(g) === 'completed';
}

/** Positive evidence: rated >= 3, or completed / currently playing. */
function isPositiveGame(g: ProfileGame): boolean {
  const s = statusKey(g);
  if (g.rating > 0) return g.rating >= 3;
  return s === 'completed' || s === 'playing' || s === 'playing now';
}

/**
 * Approximate user profile from library data.
 * - Only evidence games drive u_rec_rate (Bayesian-smoothed toward the training mean).
 * - Hours statistics are computed over played games only (zero-hour backlog would drag them down).
 * - u_n_reviews / log_user_rev reflect evidence count, not library size.
 * - helpful/funny are unavailable from app data, so they take the training defaults
 *   rather than 0 (0 is outside the trained distribution for active reviewers).
 */
export function buildUserProfileFromGames(
  games: ProfileGame[],
  spec: ProfileSpec = FALLBACK_SPEC,
): UserProfile {
  const d = spec.defaults;
  const globalRate = spec.globalRecRate;
  const neutral: UserProfile = {
    u_rec_rate: globalRate,
    u_avg_hours: d.u_avg_hours ?? 3.0,
    u_std_hours: d.u_std_hours ?? 1.5,
    u_n_reviews: 0,
    u_avg_helpful: d.u_avg_helpful ?? 0.3,
    u_avg_funny: d.u_avg_funny ?? 0.1,
    u_pct_high_hours: d.u_pct_high_hours ?? 0.3,
    log_products: Math.log1p(games.length),
    log_user_rev: 0,
  };
  if (games.length === 0) return neutral;

  const evidence = games.filter(isEvidenceGame);
  const played = games.filter(g => (g.hoursPlayed || 0) >= MIN_EVIDENCE_HOURS);

  const recommended = evidence.filter(isPositiveGame).length;
  const recRate = (recommended + spec.smoothM * globalRate) / (evidence.length + spec.smoothM);

  let avgLogH = neutral.u_avg_hours;
  let stdLogH = neutral.u_std_hours;
  let pctHigh = neutral.u_pct_high_hours;
  if (played.length >= 3) {
    const logHours = played.map(g => Math.log1p(Math.min(g.hoursPlayed || 0, 999.9)));
    avgLogH = logHours.reduce((s, h) => s + h, 0) / logHours.length;
    const varH = logHours.reduce((s, h) => s + (h - avgLogH) ** 2, 0) / logHours.length;
    stdLogH = Math.sqrt(varH);
    pctHigh = played.filter(g => g.hoursPlayed > 20).length / played.length;
  }

  return {
    ...neutral,
    u_rec_rate: recRate,
    u_avg_hours: avgLogH,
    u_std_hours: stdLogH,
    u_n_reviews: Math.log1p(evidence.length),
    u_pct_high_hours: pctHigh,
    log_user_rev: Math.log1p(games.filter(g => g.rating > 0).length),
  };
}

/** Trained review_year range in the feature spec's normalised units. */
const REVIEW_YEAR_MIN = 0;
const REVIEW_YEAR_MAX = 1;

/**
 * Feature vector for one (user, game) pair. Order matches feature_spec.feature_names.
 */
export function buildFeatureVector(
  userProfile: UserProfile,
  gp: GameProfile | undefined,
  defaults: Record<string, number>,
): Float32Array {
  const vec = new Float32Array(N_FEATURES);
  const d = defaults;
  const g = gp || ({} as Partial<GameProfile>);

  const gRate = g.g_rec_rate ?? d.g_rec_rate;
  const gAvgHours = g.g_avg_hours ?? d.g_avg_hours;
  const gStdHours = g.g_std_hours ?? d.g_std_hours;
  const gAvgHelpful = g.g_avg_helpful ?? d.g_avg_helpful;
  const posRatio = g.positive_ratio != null ? g.positive_ratio / 100.0 : d.positive_ratio_norm;

  // Hypothetical review: the user plays this game for their typical (log) hours.
  const logHours = userProfile.u_avg_hours;
  const gStd = gStdHours > 1e-6 ? gStdHours : d.g_std_hours;

  vec[0] = logHours;
  vec[1] = g.price != null ? g.price / 60.0 : d.price_norm;
  vec[2] = g.discount ?? d.discount;
  vec[3] = g.win != null ? (g.win ? 1 : 0) : d.win;
  vec[4] = g.mac != null ? (g.mac ? 1 : 0) : d.mac;
  vec[5] = g.linux != null ? (g.linux ? 1 : 0) : d.linux;
  vec[6] = g.steam_deck != null ? (g.steam_deck ? 1 : 0) : d.steam_deck;
  vec[7] = d.log_helpful;
  vec[8] = d.log_funny;
  vec[9] = userProfile.log_products;
  vec[10] = userProfile.log_user_rev;
  vec[11] = Math.min(REVIEW_YEAR_MAX, Math.max(REVIEW_YEAR_MIN, d.review_year));
  vec[12] = d.review_month;
  vec[13] = posRatio;
  vec[14] = g.user_reviews != null ? Math.log1p(g.user_reviews) : d.log_game_reviews;
  vec[15] = d.review_age_days;
  vec[16] = d.game_age_days;
  vec[17] = d.hours_per_game_age;

  vec[18] = userProfile.u_rec_rate;
  vec[19] = userProfile.u_avg_hours;
  vec[20] = userProfile.u_std_hours;
  vec[21] = userProfile.u_n_reviews;
  vec[22] = userProfile.u_avg_helpful;
  vec[23] = userProfile.u_avg_funny;
  vec[24] = userProfile.u_pct_high_hours;

  vec[25] = gRate;
  vec[26] = gAvgHours;
  vec[27] = gStdHours;
  vec[28] = g.g_n_reviews ?? d.g_n_reviews;
  vec[29] = gAvgHelpful;
  vec[30] = g.g_pct_high_hours ?? d.g_pct_high_hours;

  // Interaction features derived from the hypothetical hours above.
  vec[31] = 1.0;                                                   // hours_vs_user_avg (typical hours)
  vec[32] = gAvgHours > 1e-6 ? logHours / gAvgHours : d.hours_vs_game_avg;
  vec[33] = logHours > gAvgHours ? 1 : 0;                          // user_above_game_avg
  vec[34] = logHours - gAvgHours;                                  // hours_dev_from_game
  vec[35] = 0;                                                     // hours_dev_from_user
  vec[36] = 0;                                                     // hours_zscore_user
  vec[37] = (logHours - gAvgHours) / gStd;                         // hours_zscore_game
  vec[38] = logHours * posRatio;                                   // hours_x_pos_ratio
  vec[39] = gAvgHelpful > 1e-6 ? userProfile.u_avg_helpful / gAvgHelpful : d.helpful_vs_game;

  vec[40] = userProfile.u_rec_rate * gRate;
  vec[41] = userProfile.u_rec_rate - gRate;

  if (gp?.tags) {
    for (const idx of gp.tags) {
      if (idx >= 0 && idx < TOP_K_TAGS) vec[N_NUMERIC + idx] = 1.0;
    }
  }
  return vec;
}
