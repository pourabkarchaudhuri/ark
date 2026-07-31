/**
 * MMR diversity similarity helpers (F5).
 * Pure functions — safe for vitest without loading the reco worker.
 */

import { toCanonicalGenre } from '@/data/canonical-genres';
import { canonicalFranchiseBase } from '@/services/franchise';

const norm = (s: string) => s.toLowerCase().trim();

export interface MmrGameFields {
  genres: string[];
  title: string;
  developer: string;
}

/**
 * maxSim = max(genreJaccard, franchiseSame ? 1.0 : 0, sameDeveloper ? 0.8 : 0)
 */
export function mmrMaxSim(
  candidate: MmrGameFields,
  selected: ReadonlyArray<MmrGameFields>,
): number {
  const setA = new Set(
    candidate.genres
      .map(g => toCanonicalGenre(g))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map(c => norm(c)),
  );
  const candBase = canonicalFranchiseBase(candidate.title);
  const candDev = norm(candidate.developer);
  let maxSim = 0;
  for (const sel of selected) {
    const setB = new Set(
      sel.genres
        .map(g => toCanonicalGenre(g))
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map(c => norm(c)),
    );
    let intersection = 0;
    for (const g of setA) {
      if (setB.has(g)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    const franchiseSame = !!candBase && candBase === canonicalFranchiseBase(sel.title);
    const sameDeveloper = !!candDev && candDev === norm(sel.developer);
    const sim = Math.max(jaccard, franchiseSame ? 1.0 : 0, sameDeveloper ? 0.8 : 0);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}
