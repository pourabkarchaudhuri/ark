/**
 * Maps a free-form status string (typically from an LLM tool call) onto one of the five library
 * statuses. Shared by the main-process addGameToLibrary tool (so the model's confirmation text names
 * the status that will actually be saved) and the renderer that applies the action.
 *
 * Kept dependency-free so it compiles under both tsconfig.json and tsconfig.node.json.
 */

/** Mirrors GameStatus in src/types/game.ts (structurally identical, so values are assignable). */
export const GAME_STATUS_VALUES = ['Want to Play', 'Playing', 'Playing Now', 'Completed', 'On Hold'] as const;
export type NormalizedGameStatus = (typeof GAME_STATUS_VALUES)[number];

export const DEFAULT_GAME_STATUS: NormalizedGameStatus = 'Want to Play';

function canonical(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
}

const EXACT = new Map<string, NormalizedGameStatus>(GAME_STATUS_VALUES.map(v => [canonical(v), v]));

const SYNONYMS = new Map<string, NormalizedGameStatus>([
  ['dropped', 'On Hold'],
  ['paused', 'On Hold'],
  ['hold', 'On Hold'],
  ['on hold', 'On Hold'],
  ['onhold', 'On Hold'],
  ['abandoned', 'On Hold'],
  ['shelved', 'On Hold'],
  ['finished', 'Completed'],
  ['beaten', 'Completed'],
  ['complete', 'Completed'],
  ['done', 'Completed'],
  ['backlog', 'Want to Play'],
  ['wishlist', 'Want to Play'],
  ['wishlisted', 'Want to Play'],
  ['want', 'Want to Play'],
  ['wanttoplay', 'Want to Play'],
  ['plan to play', 'Want to Play'],
  ['to play', 'Want to Play'],
  ['currently playing', 'Playing'],
  ['in progress', 'Playing'],
  ['now playing', 'Playing Now'],
  ['playingnow', 'Playing Now'],
]);

/** Case/space-insensitive match against the five statuses, then known synonyms; anything else → 'Want to Play'. */
export function normalizeGameStatus(s: unknown): NormalizedGameStatus {
  if (typeof s !== 'string') return DEFAULT_GAME_STATUS;
  const key = canonical(s);
  if (!key) return DEFAULT_GAME_STATUS;
  return EXACT.get(key) ?? SYNONYMS.get(key) ?? SYNONYMS.get(key.replace(/ /g, '')) ?? DEFAULT_GAME_STATUS;
}
