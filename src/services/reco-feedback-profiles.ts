/**
 * Positive / negative feedback profile mining for Oracle ranking.
 * Shared by reco.worker (scoring) and unit tests.
 */

import type { CandidateGame, UserGameSnapshot } from '@/types/reco';
import { toCanonicalGenre } from '@/data/canonical-genres';

export type FeatureVector = Map<string, number>;

const norm = (s: string) => s.toLowerCase().trim();

function addFeatures(
  vec: FeatureVector,
  genres: string[],
  themes: string[],
  developer: string,
  weight = 1,
) {
  for (const genre of genres) {
    const can = toCanonicalGenre(genre);
    if (can) vec.set(`g:${norm(can)}`, (vec.get(`g:${norm(can)}`) || 0) + weight);
  }
  for (const theme of themes) vec.set(`t:${norm(theme)}`, (vec.get(`t:${norm(theme)}`) || 0) + weight);
  if (developer) vec.set(`d:${norm(developer)}`, (vec.get(`d:${norm(developer)}`) || 0) + weight);
}

/**
 * Mine thumbs-up Oracle feedback into a positive feature profile.
 * Same feature keys as the negative profile; thumbs-up weight ~1.5.
 */
export function buildPositiveProfile(
  games: UserGameSnapshot[],
  thumbsUpCandidates: CandidateGame[] = [],
): { vec: FeatureVector; strength: number } {
  const vec: FeatureVector = new Map();

  for (const c of thumbsUpCandidates) {
    addFeatures(vec, c.genres, c.themes, c.developer, 1.5);
  }

  const posCount = thumbsUpCandidates.length;
  if (posCount === 0) return { vec: new Map(), strength: 0 };

  const maxVal = Math.max(1, ...vec.values());
  for (const [k, v] of vec) vec.set(k, v / maxVal);

  const denom = Math.max(games.length, 1);
  return { vec, strength: Math.min(posCount / denom, 0.5) };
}
