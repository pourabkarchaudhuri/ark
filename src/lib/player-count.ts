/**
 * Live player counts: plausibility rules and the one shared formatter.
 *
 * Steam's GetNumberOfCurrentPlayers reports concurrent players for one exact appid. Launcher-style
 * store pages (several Call of Duty entries play through Call of Duty HQ) report a handful of
 * players while the game has hundreds of thousands, and DLC/soundtrack apps report 0. Showing those
 * numbers ("1 playing now" on a mega-franchise) is wrong, so counts that contradict a game's review
 * volume are treated as unknown.
 */

/** Below this many concurrent players a count is suspicious for a game with many reviews. */
export const SUSPICIOUS_PLAYER_COUNT = 20;
/** Review volume above which a tiny concurrent count is not believable. */
export const MANY_REVIEWS = 500;

/**
 * A count fit to show, or null when it is unknown / not believable.
 * @param reviews total Steam reviews (or recommendations) for the game, when known
 */
export function sanitizePlayerCount(count: number | null | undefined, reviews?: number | null): number | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  if (count < SUSPICIOUS_PLAYER_COUNT && typeof reviews === 'number' && reviews >= MANY_REVIEWS) return null;
  return Math.round(count);
}

/** Compact number: 950, 1.2K, 12K, 1.5M, 12M. */
export function formatPlayerCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return count.toString();
}

/** "1 player now" / "1.2K playing now" (suffix replaces " now", e.g. " on Steam"). */
export function formatPlayingNow(count: number, suffix = ' now'): string {
  return count === 1 ? `1 player${suffix}` : `${formatPlayerCount(count)} playing${suffix}`;
}
