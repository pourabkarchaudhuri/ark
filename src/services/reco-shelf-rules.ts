/**
 * Pure predicates for Oracle shelf membership (mood + deep-in-genre + coming soon).
 */

import { toCanonicalGenre } from '@/data/canonical-genres';
import { isFutureReleaseDate } from '@/services/franchise';

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Coming Soon shelf: empty/missing date is NOT upcoming.
 * Admit when `comingSoon === true` or a parseable future releaseDate.
 */
export function isComingSoonForShelf(
  releaseDate: string | undefined | null,
  comingSoon: boolean | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (comingSoon === true) return true;
  return isFutureReleaseDate(releaseDate ?? '', nowMs);
}

/**
 * Primary genre = first successfully canonicalized genre in list order.
 * Returns null when no genre maps to a canonical value.
 */
export function primaryCanonicalGenre(genres: readonly string[] | undefined | null): string | null {
  if (!genres || genres.length === 0) return null;
  for (const g of genres) {
    const can = toCanonicalGenre(g);
    if (can) return can;
  }
  return null;
}

/**
 * Deep-in-[topGenre]: primary canonical genre must equal topGenre.
 * Fallback: if nothing canonicalizes, keep loose `some()` match on raw/canonical.
 */
export function matchesDeepInGenre(
  genres: readonly string[] | undefined | null,
  topGenre: string,
): boolean {
  const top = norm(topGenre);
  if (!top || !genres?.length) return false;

  const primary = primaryCanonicalGenre(genres);
  if (primary) return norm(primary) === top;

  return genres.some(g => norm(toCanonicalGenre(g) ?? g) === top);
}

/**
 * Mood shelf: candidate must carry the cluster label genre (after canonicalization).
 * Does not admit via secondary Action/Adventure bleed from the cluster's top-3.
 */
export function matchesMoodShelf(
  genres: readonly string[] | undefined | null,
  labelGenre: string,
): boolean {
  const label = norm(labelGenre);
  if (!label || !genres?.length) return false;

  return genres.some(g => norm(toCanonicalGenre(g) ?? g) === label);
}
