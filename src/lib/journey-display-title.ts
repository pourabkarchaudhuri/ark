import { isPlaceholderJourneyTitle } from '@/services/journey-store';
import { libraryStore } from '@/services/library-store';
import { customGameStore } from '@/services/custom-game-store';

/**
 * Display title for Voyage / OCD / Ark: prefer denormalized journey title,
 * but when it is still a placeholder, resolve from library cachedMeta or custom game entry.
 */
export function resolveJourneyDisplayTitle(gameId: string, journeyTitle: string): string {
  if (!isPlaceholderJourneyTitle(journeyTitle)) return journeyTitle;

  if (gameId.startsWith('custom-')) {
    const t = customGameStore.getGame(gameId)?.title?.trim();
    if (t && !isPlaceholderJourneyTitle(t)) return t;
    return journeyTitle;
  }

  const metaTitle = libraryStore.getEntry(gameId)?.cachedMeta?.title?.trim();
  if (metaTitle && !isPlaceholderJourneyTitle(metaTitle)) return metaTitle;

  return journeyTitle;
}
