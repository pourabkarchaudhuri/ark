/**
 * Deduplication utilities — pure functions with no DOM/window dependencies.
 * Safe to import from both the main thread and Web Workers.
 */

import type { Game } from '@/types/game';

// ---------------------------------------------------------------------------
// Title normalisation for deduplication
// ---------------------------------------------------------------------------

/**
 * Normalise a game title for fuzzy matching across stores.
 * Aggressively strips edition suffixes, symbols, and normalises Roman
 * numerals so "Cyberpunk 2077: Ultimate Edition" on Steam and
 * "Cyberpunk 2077" on Epic resolve to the same key.
 */
export function normalizeTitle(title: string | undefined | null): string {
  if (!title) return '';
  let t = title
    .toLowerCase()
    .replace(/['\u2018\u2019\u201A\u201B]/g, '')   // ASCII + smart single quotes
    .replace(/["\u201C\u201D\u201E\u201F]/g, '')   // ASCII + smart double quotes
    .replace(/[\u2122\u00AE\u00A9]/g, '')           // ™ ® ©
    .replace(/&/g, 'and')                            // ampersand
    .replace(/[^a-z0-9\s]/g, ' ')                    // all remaining special chars → space
    // Strip common edition / variant phrase suffixes (longer phrases first)
    .replace(/\b(game of the year|goty|directors cut|digital deluxe|digital edition|special edition|anniversary edition|legendary edition|ultimate edition|definitive edition|complete edition|deluxe edition|premium edition|gold edition|standard edition|first edition|limited edition|collectors edition)\b/g, '')
    // Strip standalone edition / packaging words that are always suffixes
    .replace(/\b(edition|deluxe|ultimate|standard|remastered|definitive|enhanced|complete|premium|gold|anniversary|remake|hd|redux|classic|collection|bundle|pack|trilogy|anthology)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Normalise Roman numerals to Arabic (up to 20 covers virtually all games)
  const romanMap: [RegExp, string][] = [
    [/\bxx\b/g, '20'], [/\bxix\b/g, '19'], [/\bxviii\b/g, '18'],
    [/\bxvii\b/g, '17'], [/\bxvi\b/g, '16'], [/\bxv\b/g, '15'],
    [/\bxiv\b/g, '14'], [/\bxiii\b/g, '13'], [/\bxii\b/g, '12'],
    [/\bxi\b/g, '11'], [/\bx\b/g, '10'], [/\bix\b/g, '9'],
    [/\bviii\b/g, '8'], [/\bvii\b/g, '7'], [/\bvi\b/g, '6'],
    [/\bv\b/g, '5'], [/\biv\b/g, '4'], [/\biii\b/g, '3'],
    [/\bii\b/g, '2'],
  ];
  for (const [rx, num] of romanMap) {
    t = t.replace(rx, num);
  }

  return t.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Merge a list of Steam + Epic games by normalised title.
 * If the same title exists on both stores the Steam version is kept as the
 * primary and gets `availableOn: ['steam', 'epic']` + `secondaryId` set.
 * Also preserves Epic-specific metadata (namespace, offerId, price, images)
 * and Steam-specific metadata (appId) on the merged entry so the details
 * page can show cross-store links and pricing.
 */
export function deduplicateGames(games: Game[]): Game[] {
  const seen = new Map<string, Game>();

  for (const game of games) {
    const key = normalizeTitle(game.title);
    if (!key) continue; // skip untitled entries

    const existing = seen.get(key);

    if (!existing) {
      // First occurrence — mark availableOn
      const store: 'steam' | 'epic' = game.store === 'epic' ? 'epic' : 'steam';
      seen.set(key, {
        ...game,
        availableOn: game.availableOn && game.availableOn.length > 0
          ? game.availableOn          // preserve existing dual-store info from cache
          : [store],
      });
    } else {
      // Duplicate — merge availableOn arrays
      const existingStore: 'steam' | 'epic' = existing.store === 'epic' ? 'epic' : 'steam';
      const newStore: 'steam' | 'epic' = game.store === 'epic' ? 'epic' : 'steam';

      if (existingStore !== newStore) {

        const stores = new Set(existing.availableOn || [existingStore]);
        stores.add(newStore);

        // Prefer Steam as primary — richer data (metacritic, player count, reviews)
        let primary = existing;
        let secondary = game;
        if (newStore === 'steam' && existingStore === 'epic') {
          primary = game;
          secondary = existing;
        }

        // Identify which half is Epic and which is Steam for metadata merging
        const epicSide  = game.store === 'epic' ? game : existing;
        const steamSide = game.store === 'epic' ? existing : game;

        seen.set(key, {
          ...primary,
          availableOn: Array.from(stores) as ('steam' | 'epic')[],
          secondaryId: secondary.id,
          // Always keep both stores' key identifiers
          epicNamespace: epicSide.epicNamespace,
          epicOfferId:  epicSide.epicOfferId,
          epicSlug:     epicSide.epicSlug,
          steamAppId:   steamSide.steamAppId,
          // Preserve Epic price for cross-store display when Steam is primary
          epicPrice: epicSide.price ?? undefined,
          // Preserve Epic cover if Steam doesn't have one
          coverUrl: primary.coverUrl || secondary.coverUrl,
          headerImage: primary.headerImage || secondary.headerImage,
        });
      }
      // If same store appears twice, skip the later duplicate
    }
  }

  return Array.from(seen.values());
}

// Sentinel year threshold — Epic uses 2099-01-01 (and similar) as a placeholder
// for games without a confirmed release date.
const SENTINEL_YEAR = 2090;

/**
 * Dedup + sort + pre-compute numeric release timestamp.
 * Also normalises far-future sentinel dates (2099 etc.) to "Coming Soon".
 * This is the combined pipeline used by the dedup worker.
 */
export function dedupSortAndStamp(games: Game[]): Game[] {
  const deduped = deduplicateGames(games);

  // Pre-compute numeric timestamp for O(1) sorting downstream
  for (const g of deduped) {
    const ts = g.releaseDate ? new Date(g.releaseDate).getTime() : 0;
    (g as any)._releaseTs = ts;

    // Normalise far-future sentinel dates → "Coming Soon"
    // These are Epic placeholder dates (e.g. 2099-01-01) that clutter the browse grid.
    if (ts > 0) {
      const year = new Date(ts).getFullYear();
      if (year >= SENTINEL_YEAR) {
        g.releaseDate = 'Coming Soon';
        g.comingSoon = true;
        (g as any)._releaseTs = 0; // sort them to the end
      }
    }
  }

  // Sort by release date descending (newest first)
  deduped.sort((a, b) => ((b as any)._releaseTs ?? 0) - ((a as any)._releaseTs ?? 0));

  return deduped;
}
