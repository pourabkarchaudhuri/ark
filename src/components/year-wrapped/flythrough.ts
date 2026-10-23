import type { WrappedStats } from './stats';

export interface FlythroughKeyframe {
  gameId: string;
  title: string;
  subtitle: string;
}

/** localStorage key consumed (and removed) by the Embedding Space controller. */
export const FLYTHROUGH_PENDING_KEY = 'ark.flythrough.pending';

/**
 * Build up to 8 keyframes for the Galaxy flythrough from the year's stats.
 * Picks distinct story beats so the camera tour spans the year's arc:
 * first game added → #1 game → the rest of the top 4 → first two completions.
 */
export function buildFlythroughKeyframes(stats: Pick<WrappedStats, 'firstGameAdded' | 'topGame' | 'top5Games' | 'completedGames'>): FlythroughKeyframe[] {
  const out: FlythroughKeyframe[] = [];
  const seen = new Set<string>();
  const push = (gameId: string | undefined, title: string, subtitle: string) => {
    if (!gameId || seen.has(gameId)) return;
    seen.add(gameId);
    out.push({ gameId, title, subtitle });
  };
  if (stats.firstGameAdded) {
    push(stats.firstGameAdded.gameId, stats.firstGameAdded.title, `Where your year began — ${stats.firstGameAdded.date}`);
  }
  if (stats.topGame) {
    push(stats.topGame.gameId, stats.topGame.title, `${Math.round(stats.topGame.hours)}h · the centre of your year`);
  }
  for (const g of stats.top5Games.slice(1, 4)) {
    push(g.gameId, g.title, `${Math.round(g.hours)}h played${g.rating ? ` · rated ${g.rating}/5` : ''}`);
  }
  for (const g of stats.completedGames.slice(0, 2)) push(g.gameId, g.title, 'Finished this year');
  return out.slice(0, 8);
}

/** Stash keyframes for the Embedding Space. Returns true when a flythrough was queued. */
export function stashFlythrough(stats: WrappedStats): boolean {
  const keyframes = buildFlythroughKeyframes(stats);
  if (keyframes.length < 2) return false;
  try {
    localStorage.setItem(FLYTHROUGH_PENDING_KEY, JSON.stringify({ keyframes, year: stats.year, generatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
