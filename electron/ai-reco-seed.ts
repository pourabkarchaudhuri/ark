/**
 * Seed choice and result-cache key for the AI chat's getGameRecommendations tool.
 * Pure (no Electron / LangChain imports) so it is unit-testable.
 */

export interface RecoLibraryEntry {
  gameId: string;
  status: string;
  priority: string;
  addedAt?: string;
  hoursPlayed?: number;
  rating?: number;
}

/** Steam app id of a library entry ("steam-730" or legacy "730"), else null. */
export function steamAppIdOf(gameId: string): number | null {
  if (typeof gameId !== 'string') return null;
  const m = gameId.match(/^(?:steam-)?(\d+)$/);
  return m ? Number(m[1]) : null;
}

const STATUS_RANK: Record<string, number> = {
  'Playing Now': 4,
  Playing: 3,
  Completed: 2,
  'On Hold': 1,
};
const PRIORITY_RANK: Record<string, number> = { High: 2, Medium: 1 };

/**
 * The Steam game recommendations are seeded from: most played, then highest rated, then the
 * game being played / finished (over wishlist entries), then priority, then most recently added.
 * The tool used to seed from steamAppIds[0] — whatever happened to be first in the library.
 */
export function pickRecommendationSeed(entries: RecoLibraryEntry[]): number | null {
  let best: { id: number; key: number[] } | null = null;
  for (const e of entries) {
    const id = steamAppIdOf(e.gameId);
    if (id === null) continue;
    const added = e.addedAt ? Date.parse(e.addedAt) : 0;
    const key = [
      Number.isFinite(e.hoursPlayed) ? e.hoursPlayed! : 0,
      Number.isFinite(e.rating) ? e.rating! : 0,
      STATUS_RANK[e.status] ?? 0,
      PRIORITY_RANK[e.priority] ?? 0,
      Number.isFinite(added) ? added : 0,
    ];
    if (!best || compareKeys(key, best.key) > 0) best = { id, key };
  }
  return best?.id ?? null;
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Cache key for one library + limit: the sorted Steam ids, so reordering does not miss. */
export function librarySignature(steamAppIds: number[], seed: number, limit: number): string {
  return `${seed}|${limit}|${[...steamAppIds].sort((a, b) => a - b).join(',')}`;
}
