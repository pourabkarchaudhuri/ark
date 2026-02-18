/**
 * Canonical genre list used across the app:
 * - Release Calendar: filter chips and genre filtering
 * - DNA Taste Profile & genre radar: Voyage overview and Oracle page
 *
 * Raw API genres (Steam/Epic) are mapped to these canonical values so that
 * e.g. "FPS" and "Shooter" merge into "FPS & Shooter", "Sport" and "Sports" into "Sports".
 */

export const CANONICAL_GENRES = [
  'Action',
  'Adventure',
  'Casual',
  'Fighting',
  'FPS & Shooter',
  'Horror & Gore',
  'MMO',
  'Puzzle',
  'Racing',
  'RPG',
  'Simulation',
  'Sports',
  'Strategy',
  'Survival',
  'Souls-like',
] as const;

export type CanonicalGenre = (typeof CANONICAL_GENRES)[number];

/** Map raw genre strings (lowercase, trimmed) to canonical genre. */
const RAW_TO_CANONICAL: Record<string, CanonicalGenre> = {
  action: 'Action',
  adventure: 'Adventure',
  casual: 'Casual',
  fighting: 'Fighting',
  fps: 'FPS & Shooter',
  shooter: 'FPS & Shooter',
  horror: 'Horror & Gore',
  gore: 'Horror & Gore',
  violent: 'Horror & Gore',
  mmo: 'MMO',
  'massively multiplayer': 'MMO',
  puzzle: 'Puzzle',
  racing: 'Racing',
  rpg: 'RPG',
  simulation: 'Simulation',
  sport: 'Sports',
  sports: 'Sports',
  strategy: 'Strategy',
  survival: 'Survival',
  'souls-like': 'Souls-like',
  soulslike: 'Souls-like',
};

/**
 * Map a raw genre string (from Steam/Epic API) to the canonical genre, or null if not in our list.
 */
export function toCanonicalGenre(raw: string | undefined | null): CanonicalGenre | null {
  if (raw == null || typeof raw !== 'string') return null;
  const key = raw.toLowerCase().trim();
  if (!key) return null;
  return RAW_TO_CANONICAL[key] ?? null;
}

/**
 * Map an array of raw genres to canonical genres (deduplicated, order preserved by first occurrence).
 */
export function toCanonicalGenres(raw: readonly string[] | undefined | null): CanonicalGenre[] {
  if (!raw || !Array.isArray(raw)) return [];
  const seen = new Set<CanonicalGenre>();
  const out: CanonicalGenre[] = [];
  for (const r of raw) {
    const can = toCanonicalGenre(r);
    if (can != null && !seen.has(can)) {
      seen.add(can);
      out.push(can);
    }
  }
  return out;
}

/**
 * Return the canonical genre list for filter chips and fixed axes.
 */
export function getCanonicalGenres(): readonly CanonicalGenre[] {
  return CANONICAL_GENRES;
}
