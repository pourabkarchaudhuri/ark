/**
 * Game details page: what to show when Steam appdetails comes back empty.
 *
 * Steam answers success:false for delisted / region-locked games ("not found"), but an empty
 * answer also happens while Steam is rate limiting (the app-wide 429 pause) or the network is
 * down. The page used to treat every empty answer as "Game not found" and bounce the user to
 * the dashboard after 5 s. Pure helpers so the decision is unit-testable.
 */
import type { CachedGameMeta, Game, JourneyEntry } from '@/types/game';
import type { SteamAppDetailsStatus } from '@/types/steam';

/** The Game fields the minimal details view is built from. */
export type MinimalGameMeta = Partial<Pick<Game,
  'title' | 'coverUrl' | 'headerImage' | 'developer' | 'publisher' | 'genre' | 'platform'
  | 'releaseDate' | 'summary' | 'longDescription' | 'screenshots'>>;

/**
 * Metadata Ark already stores for a game: the library snapshot taken at add time (cachedMeta),
 * else the journey entry (kept even after removal from the library). Null when neither has a title.
 */
export function storedGameMeta(
  cachedMeta: CachedGameMeta | undefined | null,
  journey: Pick<JourneyEntry, 'title' | 'coverUrl' | 'genre' | 'platform' | 'releaseDate'> | undefined | null,
): MinimalGameMeta | null {
  if (cachedMeta?.title) {
    return {
      title: cachedMeta.title,
      coverUrl: cachedMeta.coverUrl,
      headerImage: cachedMeta.headerImage,
      developer: cachedMeta.developer,
      publisher: cachedMeta.publisher,
      genre: cachedMeta.genre,
      platform: cachedMeta.platform,
      releaseDate: cachedMeta.releaseDate,
      summary: cachedMeta.summary,
      longDescription: cachedMeta.longDescription,
    };
  }
  if (journey?.title) {
    return {
      title: journey.title,
      coverUrl: journey.coverUrl,
      genre: journey.genre,
      platform: journey.platform,
      releaseDate: journey.releaseDate,
    };
  }
  return null;
}

/**
 * True when an empty appdetails answer is probably temporary (rate limited, network/HTTP
 * error, or the machine is offline) — show a retry state instead of "Game not found".
 */
export function isTransientDetailsFailure(status: SteamAppDetailsStatus, online: boolean): boolean {
  if (!online) return true;
  return status === 'rate_limited' || status === 'error';
}
