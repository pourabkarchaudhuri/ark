import type { RecoShelf } from '@/types/reco';

/** Stable identity of a shelf across reranks (type alone repeats for "because you loved X" shelves). */
export function oracleShelfKey(s: Pick<RecoShelf, 'type' | 'title' | 'seedGameTitle'>): string {
  return `${s.type}\u0000${s.title}\u0000${s.seedGameTitle ?? ''}`;
}
