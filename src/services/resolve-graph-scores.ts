/**
 * Resolve graphScores for Oracle compute without blocking on cold ANN builds.
 *
 * Behavior:
 *  1. Already ready (or an older graph still loaded mid-rebuild) → pack
 *     immediately (optional background PPR seed repair).
 *  2. Prefer tryRestore → pack if cache hits; else restore a stale-signature
 *     graph and let the throttled `build()` decide whether a rebuild is due.
 *  3. Building → single waitReady capped at GRAPH_BUILD_TIMEOUT_MS.
 *  4. Cold miss → fire-and-forget build; return undefined this run.
 */

import type { UserGameSnapshot } from '@/types/reco';
import { annIndex } from '@/services/ann-index';
import { gameGraphStore } from '@/services/game-graph-store';
import type { LibrarySeed } from '@/services/game-graph-store';
import { computeEngagementWeight } from '@/services/engagement-weight';

export const GRAPH_BUILD_TIMEOUT_MS = 8_000;

export type GraphScoresPack = {
  graphScoresMap: Record<string, {
    pageRank: number;
    personalizedPageRank: number;
    authority: number;
    hub: number;
    community: number;
    degree: number;
  }> | undefined;
  userCommunityCounts: Record<number, number> | undefined;
  userCommunityTotal: number | undefined;
  /** Global max PageRank — only set when `graphScoresMap` is a subset of the graph. */
  graphMaxPageRank?: number;
};

const EMPTY_PACK: GraphScoresPack = {
  graphScoresMap: undefined,
  userCommunityCounts: undefined,
  userCommunityTotal: undefined,
};

function packGraphScores(
  userGames: UserGameSnapshot[],
  candidateIds?: Iterable<string>,
): GraphScoresPack {
  let graphScoresMap: GraphScoresPack['graphScoresMap'];
  let graphMaxPageRank: number | undefined;
  if (candidateIds) {
    // Subset pack: candidate + user ids only (the full map is 100K+ objects
    // structured-cloned to the worker every compute). The worker needs the
    // global PageRank max to keep its normalization unchanged.
    const ids = new Set<string>(candidateIds);
    for (const ug of userGames) ids.add(ug.gameId);
    graphScoresMap = gameGraphStore.getScoresFor(ids) ?? undefined;
    if (graphScoresMap) graphMaxPageRank = gameGraphStore.getMaxPageRank();
  } else {
    graphScoresMap = gameGraphStore.getAllScores() ?? undefined;
  }
  if (!graphScoresMap) return { ...EMPTY_PACK };
  const userCommunityCounts: Record<number, number> = {};
  let total = 0;
  for (const ug of userGames) {
    const gs = graphScoresMap[ug.gameId];
    if (!gs || gs.community < 0) continue;
    userCommunityCounts[gs.community] = (userCommunityCounts[gs.community] ?? 0) + 1;
    total++;
  }
  return {
    graphScoresMap,
    userCommunityCounts,
    userCommunityTotal: total,
    ...(graphMaxPageRank != null ? { graphMaxPageRank } : {}),
  };
}

function buildLibrarySeed(userGames: UserGameSnapshot[]): LibrarySeed | null {
  const seedWeights = new Map<string, number>();
  for (const ug of userGames) {
    const w = computeEngagementWeight(ug);
    if (w > 0) seedWeights.set(ug.gameId, w);
  }
  return seedWeights.size > 0 ? { weights: seedWeights } : null;
}

/** True when library seed exists but PPR buffer is missing or all zeros. */
export function needsPprSeedRepair(librarySeed: LibrarySeed | null): boolean {
  if (!librarySeed || librarySeed.weights.size === 0) return false;
  const buffers = gameGraphStore.getScoreBuffers();
  const ppr = buffers?.personalizedPageRank;
  if (!ppr || ppr.length === 0) return true;
  for (let i = 0; i < ppr.length; i++) {
    if (ppr[i] !== 0) return false;
  }
  return true;
}

/**
 * Signatures a PPR seed repair has already been attempted for (this session).
 * A rebuild cannot fix PPR when the seed stays disjoint from the graph, so
 * without this the repair re-fired a FULL forced rebuild on every compute.
 */
const _pprRepairAttempted = new Set<string>();

/** Test hook — forget which signatures were repaired. */
export function _resetPprRepairState(): void {
  _pprRepairAttempted.clear();
}

/** True when at least one seed game is a node of the loaded graph. */
function seedOverlapsGraph(librarySeed: LibrarySeed): boolean {
  for (const id of librarySeed.weights.keys()) {
    if (gameGraphStore.hasNode(id)) return true;
  }
  return false;
}

function kickPprSeedRepair(sig: string, librarySeed: LibrarySeed | null): void {
  if (_pprRepairAttempted.has(sig)) return;
  if (!needsPprSeedRepair(librarySeed)) return;
  // No library game is a graph node → PPR would be all-zero again after the
  // rebuild. Skip until the graph (or the library) actually changes.
  if (!seedOverlapsGraph(librarySeed!)) return;
  // Throttled (recent rebuild / catalog embedding still running): don't burn
  // this signature's one attempt on a build() that would no-op.
  if (gameGraphStore.isRebuildThrottled(sig, true)) return;
  _pprRepairAttempted.add(sig);
  void gameGraphStore.build(sig, { force: true, librarySeed }).catch((err) => {
    console.warn('[RecoStore] background PPR seed repair failed:', err);
  });
}

function waitReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (gameGraphStore.isReady) return resolve(true);
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = gameGraphStore.subscribe(() => {
      if (gameGraphStore.isReady || gameGraphStore.state.phase === 'error') {
        clearTimeout(timer);
        unsub();
        resolve(gameGraphStore.isReady);
      }
    });
  });
}

/**
 * Pack graph scores for the current Oracle compute, or return undefined cleanly
 * when the graph is not ready. Never double-waits; cold builds are non-blocking.
 *
 * @param candidateIds When given, only these ids (+ the user's games) are
 *   packed and the global PageRank max is attached for normalization.
 */
export async function resolveGraphScores(
  userGames: UserGameSnapshot[],
  timeoutMs = GRAPH_BUILD_TIMEOUT_MS,
  candidateIds?: Iterable<string>,
): Promise<GraphScoresPack> {
  const seed = buildLibrarySeed(userGames);

  if (gameGraphStore.isReady) {
    if (annIndex.isReady) {
      const sig = `ann-${annIndex.vectorCount}`;
      // Serving an older graph (restored or throttled earlier): ask again — build() is
      // throttled and non-blocking here, so this just retries once the window passes.
      const loaded = gameGraphStore.meta?.signature;
      if (loaded && loaded !== sig) void gameGraphStore.build(sig, { librarySeed: seed }).catch(() => {});
      kickPprSeedRepair(sig, seed);
    }
    return packGraphScores(userGames, candidateIds);
  }

  // A rebuild is in flight but the previous graph is still loaded — serve it
  // rather than waiting (or dropping graph signals for this run).
  if (gameGraphStore.hasScores) {
    return packGraphScores(userGames, candidateIds);
  }

  if (!annIndex.isReady) {
    return { ...EMPTY_PACK };
  }

  const sig = `ann-${annIndex.vectorCount}`;

  try {
    // In-flight build: single deadline wait (no post-timeout second waitReady).
    if (gameGraphStore.state.phase === 'building') {
      await waitReady(timeoutMs);
      if (gameGraphStore.isReady) {
        kickPprSeedRepair(sig, seed);
        return packGraphScores(userGames, candidateIds);
      }
      console.log('[RecoStore] graphScores unavailable this run — skipping cleanly');
      return { ...EMPTY_PACK };
    }

    // Prefer restore — Galaxy-unseeded cache still yields PR/community this run.
    const restored = await gameGraphStore.tryRestore(sig);
    if (restored || gameGraphStore.isReady) {
      kickPprSeedRepair(sig, seed);
      return packGraphScores(userGames, candidateIds);
    }

    // Signature moved on (catalog embedding adds vectors constantly): restore
    // the last persisted graph anyway and let the throttled build() decide
    // whether a background rebuild is actually due.
    const restoredStale = await gameGraphStore.tryRestore(sig, { acceptStale: true });
    if (restoredStale || gameGraphStore.isReady) {
      const meta = gameGraphStore.meta;
      if (meta && meta.signature !== sig) {
        void gameGraphStore.build(sig, { librarySeed: seed }).catch((err) => {
          console.warn('[RecoStore] graph rebuild failed (serving stale graph):', err);
        });
      }
      return packGraphScores(userGames, candidateIds);
    }

    // Cold miss: kick build without awaiting full rebuild.
    void gameGraphStore.build(sig, { librarySeed: seed }).catch((err) => {
      console.warn('[RecoStore] graph build failed (skipping graphScores):', err);
    });
    console.log('[RecoStore] graphScores unavailable this run — skipping cleanly');
    return { ...EMPTY_PACK };
  } catch (err) {
    console.warn('[RecoStore] graph build failed (skipping graphScores):', err);
    return { ...EMPTY_PACK };
  }
}
