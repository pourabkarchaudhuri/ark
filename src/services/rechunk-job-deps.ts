/**
 * Assemble RechunkJobDeps from live stores (Settings / splash / idle).
 */

import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';
import { catalogStore } from '@/services/catalog-store';
import { epicCatalogStore } from '@/services/epic-catalog-store';
import type { RechunkJobDeps, RechunkLibraryGame } from '@/services/embedding-service';

export function collectRechunkLibraryGames(): RechunkLibraryGame[] {
  const out: RechunkLibraryGame[] = [];

  for (const entry of libraryStore.getAllEntries()) {
    const meta = entry.cachedMeta;
    out.push({
      id: entry.gameId,
      title: meta?.title?.trim() || 'Unknown',
      genres: meta?.genre,
      themes: meta?.themes,
      modes: meta?.gameModes,
      playerPerspectives: meta?.playerPerspectives,
      developer: meta?.developer,
      publisher: meta?.publisher,
      summary: meta?.summary,
      description: meta?.longDescription,
      userNotes: entry.publicReviews || undefined,
      similarGames: meta?.similarGames?.map((s) => ({ name: s.name })),
    });
  }

  for (const game of customGameStore.getAllGames()) {
    out.push({
      id: game.id,
      title: game.title,
      userNotes: game.publicReviews || undefined,
    });
  }

  return out;
}

export async function buildRechunkJobDeps(): Promise<RechunkJobDeps> {
  const [steamTotal, epicTotal] = await Promise.all([
    catalogStore.getEntryCount(),
    epicCatalogStore.getEntryCount(),
  ]);
  return {
    libraryGames: collectRechunkLibraryGames(),
    steamIterator: (onBatch) => catalogStore.getAllEntries(onBatch),
    epicIterator: (onBatch) => epicCatalogStore.getAllEntries(onBatch),
    steamTotal,
    epicTotal,
  };
}
