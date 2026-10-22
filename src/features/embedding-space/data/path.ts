import type { GraphNode } from '@/services/galaxy-cache';
import type { JourneyEntry } from '@/types/game';

/** One stop on The Path: a played game placed in the galaxy, in play chronology. */
export interface PathStop {
  node: GraphNode;
  hoursPlayed: number;
  /** Year the game was first played (labels the strip ends / anchors). 0 if unknown. */
  playedYear: number;
  x: number; y: number; z: number;
}

export interface PathBuild { stops: PathStop[]; disabledReason: string | null }

/**
 * The Path = played games with hours > 0, ordered by first-played date
 * (journey store), restricted to games that have a position in the galaxy.
 */
export function buildPath(entries: JourneyEntry[], nodeMap: Map<string, GraphNode>): PathBuild {
  const dated = entries
    .filter(e => !e.removedAt && e.firstPlayedAt && Number.isFinite(new Date(e.firstPlayedAt).getTime()))
    .sort((a, b) => new Date(a.firstPlayedAt!).getTime() - new Date(b.firstPlayedAt!).getTime());
  if (dated.length < 2) {
    return { stops: [], disabledReason: 'Play at least 2 games with a first-played date to unlock The Path' };
  }
  const stops: PathStop[] = [];
  const seen = new Set<string>();
  let mappedCount = 0;
  for (const e of dated) {
    const node = nodeMap.get(e.gameId);
    if (!node || seen.has(node.id)) continue;
    mappedCount++;
    const hours = Math.max(e.hoursPlayed ?? 0, node.hoursPlayed ?? 0);
    if (hours <= 0) continue;
    seen.add(node.id);
    stops.push({ node, hoursPlayed: hours, playedYear: new Date(e.firstPlayedAt!).getFullYear(), x: node.x, y: node.y, z: node.z });
  }
  if (stops.length >= 2) return { stops, disabledReason: null };
  if (mappedCount === 0) {
    return { stops: [], disabledReason: `${dated.length} played games aren't in the galaxy yet — wait for projection or rebuild embeddings` };
  }
  return { stops: [], disabledReason: `Only ${stops.length} played game${stops.length === 1 ? '' : 's'} with tracked hours ${stops.length === 1 ? 'is' : 'are'} in the galaxy — need 2+` };
}

/** Mock-galaxy path: library nodes with hours, ordered by release year as a stand-in chronology. */
export function buildMockPath(nodes: GraphNode[]): PathBuild {
  const stops = nodes
    .filter(n => n.isLibrary && n.hoursPlayed > 0)
    .sort((a, b) => a.releaseYear - b.releaseYear)
    .map(node => ({ node, hoursPlayed: node.hoursPlayed, playedYear: node.releaseYear, x: node.x, y: node.y, z: node.z }));
  return stops.length >= 2 ? { stops, disabledReason: null } : { stops: [], disabledReason: 'Need at least 2 library games for The Path' };
}
