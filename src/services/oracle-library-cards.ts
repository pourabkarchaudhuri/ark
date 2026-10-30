/**
 * Oracle cards that show the user's own games (Unfinished Business, Backlog Advisor, or any id the
 * library or the custom game store owns) are not recommendations: dismissing one must not mute its
 * franchise and developer, thumbs-down must not feed the negative profile, and "Add to Library" must not
 * write a second entry (for a custom game, under its custom id).
 */
import type { RecoShelf, ShelfType } from '@/types/reco';
import { libraryStore } from './library-store';
import { customGameStore } from './custom-game-store';

/** Shelves whose cards are the user's own library games. */
export const LIBRARY_BACKED_SHELVES: ReadonlySet<ShelfType | string> = new Set(['unfinished-business', 'backlog-advisor']);

export function isLibraryBackedOracleGame(gameId: string, shelfType?: string): boolean {
  if (shelfType && LIBRARY_BACKED_SHELVES.has(shelfType)) return true;
  if (gameId.startsWith('custom-')) return true;
  return libraryStore.isInLibrary(gameId) || !!customGameStore.getGame(gameId);
}

/**
 * What a dismissal from an Oracle shelf records. A recommendation keeps its title and developer (so the
 * franchise and studio are muted for a while); a library game records neither, so only that card is hidden.
 */
export function oracleDismissMeta(
  gameId: string,
  shelves: ReadonlyArray<Pick<RecoShelf, 'type' | 'games'>>,
): { title?: string; developer?: string } {
  const shelf = shelves.find(s => s.games.some(g => g.gameId === gameId));
  if (isLibraryBackedOracleGame(gameId, shelf?.type)) return {};
  const game = shelf?.games.find(g => g.gameId === gameId);
  return { title: game?.title, developer: game?.developer };
}
