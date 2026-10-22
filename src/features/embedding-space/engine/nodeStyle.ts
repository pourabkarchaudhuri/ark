import type { GraphNode } from '@/services/galaxy-cache';

export interface PublisherFreqs { pubFreq: Map<string, number>; maxPubLog: number }

/**
 * Star magnitude — popularity (review count) drives base size; publisher
 * catalogue breadth gives a secondary boost. Library games get a floor plus a
 * small hours bonus so the user's own collection never disappears.
 */
export function starSize(nd: GraphNode, pubFreq: Map<string, number>, maxPubLog: number): number {
  const popNorm = Math.min(Math.log10(Math.max(nd.reviewCount, 1)) / 5.3, 1);
  const pf = nd.publisher ? (pubFreq.get(nd.publisher) ?? 1) : 1;
  const pubNorm = maxPubLog > 0 ? Math.log10(pf + 1) / maxPubLog : 0;
  const combined = popNorm * 0.7 + pubNorm * 0.3;
  const base = 1.2 + combined * 9;
  return nd.isLibrary ? Math.max(base, 4) + Math.min(nd.hoursPlayed * 0.03, 4) : base;
}

/** Base star brightness: luminance (review quality) blended with popularity. */
export function starBrightness(nd: GraphNode): number {
  const popNorm = Math.min(Math.log10(Math.max(nd.reviewCount, 1)) / 5.3, 1);
  const lumBlend = nd.luminance * 0.6 + popNorm * 0.4;
  const bright = 0.08 + lumBlend * 0.92;
  return nd.isLibrary ? Math.min(1.0, bright + 0.15) : bright;
}

export function buildPublisherFreqs(nodes: GraphNode[]): PublisherFreqs {
  const pubFreq = new Map<string, number>();
  for (const nd of nodes) {
    if (nd.publisher) pubFreq.set(nd.publisher, (pubFreq.get(nd.publisher) ?? 0) + 1);
  }
  let maxFreq = 1;
  for (const v of pubFreq.values()) if (v > maxFreq) maxFreq = v;
  return { pubFreq, maxPubLog: Math.log10(maxFreq + 1) };
}
