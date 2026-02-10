import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Hardcoded cover image overrides for games whose API-provided images
 * are missing or broken. Maps normalised (lowercase) game titles to
 * a local asset path served from /public.
 */
const HARDCODED_COVERS: Record<string, string> = {
  'battlefield 6': '/images/battlefield-6-cover.png',
  'battlefield™ 6': '/images/battlefield-6-cover.png',
};

/** Return a hardcoded cover URL for a game title, or undefined if none exists. */
export function getHardcodedCover(title: string): string | undefined {
  return HARDCODED_COVERS[title.toLowerCase()];
}

const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

/**
 * Build a deduplicated chain of image URLs to try for a game.
 * Priority: hardcoded override → coverUrl → Steam CDN variants (cover, header, capsule).
 * Used by Journey views and the Release Calendar for multi-step fallback.
 */
export function buildGameImageChain(
  gameId: string,
  title: string,
  coverUrl?: string,
): string[] {
  const hardcoded = getHardcodedCover(title);
  if (hardcoded) return [hardcoded];

  const chain: string[] = [];
  if (coverUrl) chain.push(coverUrl);

  // For Steam games, add CDN fallbacks
  if (gameId.startsWith('steam-')) {
    const appId = parseInt(gameId.replace('steam-', ''), 10);
    if (!isNaN(appId)) {
      chain.push(
        `${STEAM_CDN}/${appId}/library_600x900.jpg`,
        `${STEAM_CDN}/${appId}/header.jpg`,
        `${STEAM_CDN}/${appId}/capsule_616x353.jpg`,
      );
    }
  }

  // Deduplicate consecutive identical URLs
  const deduped: string[] = [];
  for (const url of chain) {
    if (url && url !== deduped[deduped.length - 1]) deduped.push(url);
  }
  return deduped;
}

/**
 * Format a decimal-hours value (e.g. 1.52) into a human-friendly
 * hours-and-minutes string using descriptive labels.
 *
 * Examples:
 *   0      → "0 Mins"
 *   0.25   → "15 Mins"
 *   1      → "1 Hr"
 *   1.5    → "1 Hr 30 Mins"
 *   2.02   → "2 Hrs 1 Min"
 *   120.75 → "120 Hrs 45 Mins"
 */
export function formatHours(decimalHours: number): string {
  if (decimalHours <= 0) return '0 Mins';
  const totalMinutes = Math.round(decimalHours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const hrLabel = h === 1 ? 'Hr' : 'Hrs';
  const minLabel = m === 1 ? 'Min' : 'Mins';
  if (h === 0) return `${m} ${minLabel}`;
  if (m === 0) return `${h} ${hrLabel}`;
  return `${h} ${hrLabel} ${m} ${minLabel}`;
}

