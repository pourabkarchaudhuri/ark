/**
 * Resolve graphScores for Oracle compute without blocking on cold ANN builds.
 *
 * Behavior:
 *  1. Already ready → pack immediately (optional background PPR seed repair).
 *  2. Prefer tryRestore → pack if cache hits.
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
};

function packGraphScores(userGames: UserGameSnapshot[]): GraphScoresPack {
  const graphScoresMap = gameGraphStore.getAllScores() ?? undefined;
  if (!graphScoresMap) {
    return { graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined };
  }
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

function kickPprSeedRepair(sig: string, librarySeed: LibrarySeed | null): void {
  if (!needsPprSeedRepair(librarySeed)) return;
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
 */
export async function resolveGraphScores(
  userGames: UserGameSnapshot[],
  timeoutMs = GRAPH_BUILD_TIMEOUT_MS,
): Promise<GraphScoresPack> {
  const seed = buildLibrarySeed(userGames);

  if (gameGraphStore.isReady) {
    if (annIndex.isReady) {
      kickPprSeedRepair(`ann-${annIndex.vectorCount}`, seed);
    }
    return packGraphScores(userGames);
  }

  if (!annIndex.isReady) {
    return { graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined };
  }

  const sig = `ann-${annIndex.vectorCount}`;

  try {
    // In-flight build: single deadline wait (no post-timeout second waitReady).
    if (gameGraphStore.state.phase === 'building') {
      await waitReady(timeoutMs);
      if (gameGraphStore.isReady) {
        kickPprSeedRepair(sig, seed);
        return packGraphScores(userGames);
      }
      console.log('[RecoStore] graphScores unavailable this run — skipping cleanly');
      return { graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined };
    }

    // Prefer restore — Galaxy-unseeded cache still yields PR/community this run.
    const restored = await gameGraphStore.tryRestore(sig);
    if (restored || gameGraphStore.isReady) {
      kickPprSeedRepair(sig, seed);
      return packGraphScores(userGames);
    }

    // Cold miss: kick build without awaiting full rebuild.
    void gameGraphStore.build(sig, { librarySeed: seed }).catch((err) => {
      console.warn('[RecoStore] graph build failed (skipping graphScores):', err);
    });
    console.log('[RecoStore] graphScores unavailable this run — skipping cleanly');
    return { graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined };
  } catch (err) {
    console.warn('[RecoStore] graph build failed (skipping graphScores):', err);
    return { graphScoresMap: undefined, userCommunityCounts: undefined, userCommunityTotal: undefined };
  }
}
