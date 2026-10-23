/**
 * Neighbour pipeline for Embedding Space: ANN cosine kNN (K = 12) →
 * heuristic rerank (genre IDF/taxonomy, themes, franchise, dev/pub, era,
 * quality) → optional Ollama cross-encoder rerank → 3D spatial fallback.
 */
import type { GraphNode, NeighborInfo } from '@/services/galaxy-cache';
import { getEmbeddingById, extractFranchiseBase } from '@/services/embedding-service';
import { isUmbrellaBrand, hasStudioOverlap } from '@/services/franchise';
import { annIndex } from '@/services/ann-index';
import { queryAnnNeighborGames, annNeighborOverFetch, isChunkAnnMaxSimEnabled } from '@/services/ann-neighbor-query';
import { applyOllamaNeighborRerank, NEIGHBOR_HEURISTIC_POOL, type NeighborRerankStatus } from '@/services/ollama-rerank';
import { rerankTierLabel } from '@/services/oracle-rerank';

export const NEIGHBOR_K = 12;
/**
 * Raw cosine distance a neighbour must be within to be shown (Similar Games uses the
 * same bar). The old cap was 1.5 on a 0–2 scale — effectively none — so the list was
 * always padded to 12 with whatever ANN returned, related or not.
 */
export const SIMILARITY_FLOOR = 0.45;
/** When fewer than MIN_SHOWN pass the floor, allow up to this before giving up. */
const RELAXED_FLOOR = 0.6;
const MIN_SHOWN = 3;
/**
 * Heuristic adjustments (genre, franchise, era…) are capped relative to the raw cosine
 * distance. Uncapped they reached ±0.25+ while true neighbours span ~0.1–0.4, so metadata
 * coincidences outranked real similarity.
 */
const MAX_ADJ_DOWN = 0.08;
const MAX_ADJ_UP = 0.15;
/** Candidates handed to the cross-encoder (was 72 — deep enough to pull in noise). */
export const NEIGHBOR_RERANK_POOL = 24;
/** Final order = blend of similarity rank and rerank rank (0 = similarity only, 1 = rerank only). */
const RERANK_RANK_BLEND = 0.5;

// ─── Genre IDF weights (lower frequency → more discriminating match) ─────────
const GENRE_FREQ: Record<string, number> = {
  'action': 0.40, 'action-adventure': 0.30, 'adventure': 0.32,
  'casual': 0.20, 'rpg': 0.25, 'shooter': 0.18,
  'strategy': 0.15, 'simulation': 0.12, 'survival': 0.10,
  'fps': 0.12, 'first person': 0.12, 'open world': 0.15,
  'horror': 0.06, 'puzzle': 0.08, 'sports': 0.07,
  'racing': 0.05, 'platformer': 0.06, 'roguelike': 0.04,
  'roguelite': 0.04, 'rogue-lite': 0.04, 'souls-like': 0.02,
  'soulslike': 0.02, 'metroidvania': 0.03, 'visual novel': 0.03,
  'city builder': 0.02, 'tower defense': 0.03, 'fighting': 0.04,
  'rhythm': 0.02, 'mmo': 0.05, 'mmorpg': 0.04,
  'hack and slash': 0.04, 'turn-based': 0.05,
  'real-time strategy': 0.04, 'grand strategy': 0.02,
  'rts': 0.04, 'card game': 0.03, 'stealth': 0.04,
  'exploration': 0.10, 'narration': 0.05, 'comedy': 0.05,
  'space': 0.03, 'party': 0.03, 'indie': 0.35, 'fantasy': 0.15,
  'sandbox': 0.08, 'battle royale': 0.04,
  'crpg': 0.02, 'tactical': 0.04, 'isometric': 0.03,
  'point and click': 0.03, 'walking simulator': 0.02,
  'life sim': 0.02, 'farming': 0.02,
  'management': 0.04, 'building': 0.05, 'crafting': 0.06,
  'co-op': 0.10,
};

function genreIdf(genre: string): number {
  return Math.log2(1 / (GENRE_FREQ[genre] ?? 0.10));
}

export function idfWeightedJaccard(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let sharedW = 0, unionW = 0;
  for (const g of new Set([...selGenres, ...nbSet])) {
    const w = genreIdf(g);
    if (selGenres.has(g) && nbSet.has(g)) sharedW += w;
    unionW += w;
  }
  return unionW > 0 ? sharedW / unionW : 0;
}

// Parent-child sub-genre relationships for partial credit
const GENRE_PARENT: Record<string, string> = {
  'fps': 'shooter', 'first person': 'shooter', 'third-person shooter': 'shooter',
  'action rpg': 'rpg', 'crpg': 'rpg', 'jrpg': 'rpg', 'mmorpg': 'rpg',
  'roguelite': 'roguelike', 'rogue-lite': 'roguelike',
  'soulslike': 'action', 'souls-like': 'action',
  'hack and slash': 'action', 'beat em up': 'action',
  'stealth': 'action', 'action-adventure': 'action',
  'grand strategy': 'strategy', 'real-time strategy': 'strategy',
  'rts': 'strategy', 'turn-based': 'strategy', 'tactical': 'strategy',
  'tower defense': 'strategy', 'card game': 'strategy',
  'city builder': 'simulation', 'life sim': 'simulation',
  'farming': 'simulation', 'management': 'simulation',
  'battle royale': 'shooter',
  'metroidvania': 'platformer',
  'exploration': 'adventure', 'narration': 'adventure',
  'visual novel': 'adventure', 'point and click': 'adventure',
  'walking simulator': 'adventure',
  'party': 'casual', 'rhythm': 'casual',
};

export function genreTaxonomyBonus(selGenres: Set<string>, nbGenres: string[]): number {
  const nbSet = new Set(nbGenres);
  let bonus = 0;
  for (const sg of selGenres) {
    if (nbSet.has(sg)) continue;
    const selParent = GENRE_PARENT[sg];
    for (const ng of nbGenres) {
      if (selGenres.has(ng)) continue;
      const nbParent = GENRE_PARENT[ng];
      if (selParent && selParent === ng) { bonus += 0.015; break; }
      if (nbParent && nbParent === sg) { bonus += 0.015; break; }
      if (selParent && nbParent && selParent === nbParent) { bonus += 0.01; break; }
    }
  }
  return bonus;
}

/** Heuristic rerank of raw ANN candidates; keeps only drawable (in-galaxy) neighbours. */
export function rerankNeighbors(
  selectedNode: GraphNode,
  candidates: Array<{ id: string; distance: number }>,
  nodeMap: Map<string, GraphNode>,
  k: number,
): NeighborInfo[] {
  const selGenresLower = new Set(selectedNode.genres.map(g => g.toLowerCase()));
  const selThemesLower = new Set((selectedNode.themes ?? []).map(t => t.toLowerCase()));
  const selColor = selectedNode.colorIdx;
  const selDev = selectedNode.developer?.toLowerCase().trim() ?? '';
  const selPub = selectedNode.publisher?.toLowerCase().trim() ?? '';
  const selFranchise = extractFranchiseBase(selectedNode.title);
  const selPopLog = selectedNode.reviewCount >= 0 ? Math.log10(Math.max(selectedNode.reviewCount, 1)) : -1;
  const selYear = selectedNode.releaseYear ?? 0;
  const selLum = selectedNode.luminance ?? 0.5;

  const scored = candidates.map(r => {
    const nd = nodeMap.get(r.id);
    if (!nd) return { id: r.id, distance: r.distance, node: nd, adj: r.distance + 0.30 };
    if (nd.title.startsWith('Unknown Game')) return { id: r.id, distance: r.distance, node: nd, adj: r.distance + 0.50 };

    const nbGenresLower = nd.genres.map(g => g.toLowerCase());
    const sameCategory = nd.colorIdx === selColor;
    const nbThemesLower = (nd.themes ?? []).map(t => t.toLowerCase());
    let adj = r.distance;

    // Popularity: smooth log curve (skipped when review data is absent, e.g. Epic)
    const nbHasReviews = nd.reviewCount >= 0;
    const nbPopLog = nbHasReviews ? Math.log10(Math.max(nd.reviewCount, 1)) : -1;
    if (nbHasReviews && !nd.isLibrary && nd.reviewCount < 500) {
      adj += 0.12 * Math.max(0, 1 - Math.log10(nd.reviewCount + 1) / 2.7);
    }
    if (selPopLog > 2 && nbPopLog > 2 && Math.abs(selPopLog - nbPopLog) < 1.5) adj -= 0.02;

    // Genre: IDF-weighted Jaccard with smooth penalty/bonus curve
    const idfJ = idfWeightedJaccard(selGenresLower, nbGenresLower);
    if (nbGenresLower.length === 0) adj += 0.10;
    else if (idfJ === 0) adj += sameCategory ? 0.10 : 0.25;
    else {
      const mismatchPenalty = 0.22 * (1 - idfJ) * (1 - idfJ) * (sameCategory ? 0.45 : 1.0);
      const overlapBonus = 0.10 * Math.pow(idfJ, 1.5);
      adj += mismatchPenalty - overlapBonus;
    }
    adj -= genreTaxonomyBonus(selGenresLower, nbGenresLower);

    // Themes: proportional Jaccard
    let themeJaccard = 0;
    if (selThemesLower.size > 0 && nbThemesLower.length > 0) {
      const intersection = nbThemesLower.filter(t => selThemesLower.has(t)).length;
      const union = new Set([...selThemesLower, ...nbThemesLower]).size;
      themeJaccard = union > 0 ? intersection / union : 0;
    }
    adj -= 0.06 * themeJaccard;

    // Franchise / series boost (strong — sequels must cluster). Umbrella brands (Star Wars,
    // LEGO, Warhammer…) span unrelated genres: only count them with a shared studio.
    const nbFranchise = extractFranchiseBase(nd.title);
    const isFranchise = selFranchise.length >= 3 && nbFranchise === selFranchise
      && (!isUmbrellaBrand(selFranchise) || hasStudioOverlap(nd, [selectedNode]));
    if (isFranchise) adj -= 0.20;

    // Developer + publisher affinity (publisher weaker, avoids double counting)
    const nbDev = nd.developer?.toLowerCase().trim() ?? '';
    const isDev = selDev !== '' && nbDev !== '' && nbDev === selDev;
    if (isDev) adj -= 0.04;
    const nbPub = nd.publisher?.toLowerCase().trim() ?? '';
    const isPub = selPub !== '' && nbPub !== '' && nbPub === selPub && nbPub !== selDev && nbDev !== selPub;
    if (isPub) adj -= 0.02;

    // Release-era proximity
    let eraMatch = false;
    if (selYear > 0 && nd.releaseYear > 0) {
      const yearGap = Math.abs(selYear - nd.releaseYear);
      if (yearGap <= 2) { adj -= 0.03; eraMatch = true; }
      else if (yearGap <= 5) { adj -= 0.01; eraMatch = true; }
      else if (yearGap >= 15) adj += 0.03;
    }

    // Review-quality proximity
    const nbLum = nd.luminance ?? 0.5;
    if (selLum > 0 && nbLum > 0) {
      const lumDiff = Math.abs(selLum - nbLum);
      if (lumDiff < 0.15) adj -= 0.015;
      else if (lumDiff > 0.5) adj += 0.02;
    }

    // Multi-signal synergy
    let signals = 0;
    if (idfJ >= 0.5) signals++;
    if (themeJaccard >= 0.3) signals++;
    if (eraMatch) signals++;
    if (isFranchise) signals++;
    if (isDev) signals++;
    if (signals >= 3) adj -= 0.02 * (signals - 2);

    const delta = Math.min(MAX_ADJ_UP, Math.max(-MAX_ADJ_DOWN, adj - r.distance));
    return { id: r.id, distance: r.distance, node: nd, adj: r.distance + delta };
  });

  scored.sort((a, b) => a.adj - b.adj);
  const drawable = scored.filter((s) => !!s.node && !s.node.title.startsWith('Unknown Game'));
  // Show fewer rather than pad with unrelated games; relax only to avoid an empty panel.
  let kept = drawable.filter((s) => s.distance <= SIMILARITY_FLOOR);
  if (kept.length < MIN_SHOWN) kept = drawable.filter((s) => s.distance <= RELAXED_FLOOR).slice(0, MIN_SHOWN);
  return kept.slice(0, k).map((s) => ({ id: s.id, distance: s.distance, node: s.node }));
}

/**
 * Blend the cross-encoder order with the similarity order by rank. The rerank used to
 * replace the order outright (and its `1 - relevance` pseudo-distance replaced the real
 * one), so a weak or short-text reranker could promote far candidates over true neighbours.
 * Distances shown are always the raw cosine distances.
 */
export function blendRerankOrder(base: NeighborInfo[], reranked: NeighborInfo[], k: number, blend = RERANK_RANK_BLEND): NeighborInfo[] {
  const rerankRank = new Map(reranked.map((nb, i) => [nb.id, i]));
  return base
    .map((nb, i) => ({ nb, score: (1 - blend) * i + blend * (rerankRank.get(nb.id) ?? reranked.length + i) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, k)
    .map((s) => s.nb);
}

/** 3D spatial nearest neighbours — used when the ANN index is empty/unavailable. */
export function spatialNeighbors(node: GraphNode, nodes: GraphNode[], k: number, exclude?: Set<string>): NeighborInfo[] {
  const dists: NeighborInfo[] = [];
  for (const other of nodes) {
    if (other.id === node.id || exclude?.has(other.id)) continue;
    const dx = other.x - node.x, dy = other.y - node.y, dz = other.z - node.z;
    dists.push({ id: other.id, distance: Math.sqrt(dx * dx + dy * dy + dz * dz), node: other });
  }
  dists.sort((a, b) => a.distance - b.distance);
  return dists.slice(0, k);
}

/** Cosine distance (1 − cos), clamped to [0, 2]. */
export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? Math.max(0, 1 - dot / denom) : 1;
}

export type NeighborStatusChip = 'ann_rebuilding' | 'spatial_fallback' | null;
/** `tone` — 'ok' for a real rerank, 'info' for a coarse / skipped one, 'warn' for a failure. */
export interface RerankHint { label: string; title: string; tone?: 'ok' | 'info' | 'warn' }

/**
 * Badge for the neighbour dock header. A successful pass is shown too
 * ("Qwen3 graded · 5 moved") — it used to return null, so a working reranker
 * was indistinguishable from one that never ran.
 */
export function neighborRerankBadge(status: NeighborRerankStatus): RerankHint | null {
  const { outcome, tier } = status;
  if (outcome === 'applied') {
    const moved = typeof status.moved === 'number' ? ` · ${status.moved} moved` : '';
    if (tier === 'qwen_binary') return { label: `Binary rerank${moved}`, title: 'Ollama predates logprobs support, so the reranker could only answer yes/no — ordering is coarse', tone: 'info' };
    if (tier === 'embed_fallback') return { label: `Cosine rerank${moved}`, title: 'No cross-encoder available — neighbors were ordered by arctic-embed cosine similarity', tone: 'info' };
    return {
      label: `Reranked · ${rerankTierLabel(tier)}${moved}`,
      title: `Neighbors reordered by ${rerankTierLabel(tier)}${typeof status.meanAbsDelta === 'number' && status.moved ? ` — ${status.moved} moved, ${status.meanAbsDelta.toFixed(1)} places on average` : ''}`,
      tone: 'ok',
    };
  }
  if (outcome === 'skipped_disabled') return { label: 'Rerank off', title: 'Neighbor rerank is off in Settings', tone: 'info' };
  if (outcome === 'skipped_no_client') return { label: 'Rerank unavailable', title: 'Ollama rerank not available — connect in Settings', tone: 'info' };
  if (outcome === 'skipped_timeout') return { label: 'Rerank timed out', title: 'The reranker did not answer within its time budget; using heuristic order', tone: 'info' };
  if (outcome === 'no_signal') return { label: 'Rerank no signal', title: `${rerankTierLabel(tier)} gave every neighbor the same score; using heuristic order`, tone: 'info' };
  if (outcome === 'empty_results') return { label: 'No rerank scores', title: 'Rerank returned no scores; using heuristic order', tone: 'warn' };
  if (outcome === 'error') return { label: 'Rerank failed', title: `Rerank failed (${rerankTierLabel(tier)}); using heuristic order`, tone: 'warn' };
  return null;
}

export interface NeighborQuery {
  nodes: GraphNode[];
  nodeMap: Map<string, GraphNode>;
  useMock: boolean;
  neighborRerankEnabled: boolean;
  /** Ids that must not appear (secondary web around a focused neighbour). */
  exclude?: Set<string>;
  /** Return true when the caller no longer wants this result (selection moved on). */
  isStale: () => boolean;
}

export interface NeighborResult {
  neighbors: NeighborInfo[];
  statusChip: NeighborStatusChip;
  rerankHint: RerankHint | null;
}

/** Full neighbour pipeline. Resolves null when the request went stale mid-flight. */
export async function fetchNeighbors(node: GraphNode, q: NeighborQuery, k = NEIGHBOR_K): Promise<NeighborResult | null> {
  if (q.useMock) return { neighbors: spatialNeighbors(node, q.nodes, k, q.exclude), statusChip: null, rerankHint: null };
  const vec = await getEmbeddingById(node.id, { ignoreTtl: true });
  if (q.isStale()) return null;
  if (!vec || !annIndex.isReady) {
    return {
      neighbors: q.nodes.length ? spatialNeighbors(node, q.nodes, k, q.exclude) : [],
      statusChip: annIndex.isReady ? 'spatial_fallback' : 'ann_rebuilding',
      rerankHint: null,
    };
  }
  const maxSim = await isChunkAnnMaxSimEnabled();
  if (q.isStale()) return null;
  const results = await queryAnnNeighborGames(vec, annNeighborOverFetch(k, maxSim), node.id);
  if (q.isStale()) return null;
  const filtered = results.filter(r => r.id !== node.id && !q.exclude?.has(r.id));
  const pool = rerankNeighbors(node, filtered, q.nodeMap, Math.min(NEIGHBOR_RERANK_POOL, NEIGHBOR_HEURISTIC_POOL, filtered.length));
  const rr = await applyOllamaNeighborRerank(node, pool, k, { neighborRerankEnabled: q.neighborRerankEnabled });
  if (q.isStale()) return null;
  // Coarse rerankers (cosine over short metadata strings, yes/no Qwen) reorder by title
  // words and generic genres — keep the similarity order rather than let them decide.
  const coarse = rr.status.outcome === 'applied' && (rr.status.tier === 'embed_fallback' || rr.status.tier === 'qwen_binary');
  let rerankHint = neighborRerankBadge(rr.status);
  let neighbors: NeighborInfo[];
  if (rr.status.outcome !== 'applied') neighbors = pool.slice(0, k);
  else if (coarse) {
    neighbors = pool.slice(0, k);
    rerankHint = { label: 'Similarity order', title: 'Only a coarse reranker is available (no cross-encoder) — neighbors are kept in embedding-similarity order', tone: 'info' };
  } else neighbors = blendRerankOrder(pool, rr.neighbors, k);
  neighbors = neighbors.filter(nb => !!nb.node);
  let statusChip: NeighborStatusChip = null;
  // Spatial (3D) fallback only when the similarity index gave nothing at all — an empty
  // list after the similarity floor is a real answer ("nothing close"), not an error.
  if (neighbors.length === 0 && filtered.length === 0 && q.nodes.length > 0) {
    neighbors = spatialNeighbors(node, q.nodes, k, q.exclude);
    statusChip = 'spatial_fallback';
  }
  return { neighbors, statusChip, rerankHint };
}
