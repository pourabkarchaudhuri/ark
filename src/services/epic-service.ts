/**
 * Epic Games Service
 * Handles Epic Games Store API interactions and data transformation.
 * Mirrors the pattern of steam-service.ts.
 */

import { Game, LibraryGameEntry } from '@/types/game';
import { EpicCatalogItem } from '@/types/epic';
import { libraryStore } from './library-store';

// Genre map (mirrored from electron/epic-api.ts for tag → string fallback)
const EPIC_GENRE_MAP: Record<number, string> = {
  1216: 'Action', 1210: 'Shooter', 1370: 'RPG', 1115: 'Strategy',
  1218: 'Adventure', 9541: 'Survival', 1621: 'Sport', 1100: 'Indie',
  1117: 'Simulation', 10719: 'FPS', 21122: 'Rogue-Lite', 1367: 'Puzzle',
  1307: 'Open World', 1381: 'Platformer', 1298: 'Horror', 9547: 'Racing',
  1364: 'Fighting', 1074: 'MMO', 21894: 'Tower Defense', 21141: 'Turn-Based',
  21138: 'Dungeon Crawler', 21127: 'City Builder', 21120: 'Metroidvania',
  21680: 'Souls-like', 21668: 'Card Game', 22776: 'Stealth', 1183: 'Casual',
  21146: 'Party', 1342: 'Quiz/Trivia',
};

/**
 * Resolve the best image from an Epic game's keyImages array.
 * Prefers tall cover images for game cards, wide for header/detail.
 */
function resolveImage(
  keyImages: Array<{ type: string; url: string }> | undefined,
  preferTall: boolean = true
): string | undefined {
  if (!keyImages || keyImages.length === 0) return undefined;

  const tallPriority = [
    'DieselStoreFrontTall', 'OfferImageTall', 'DieselGameBoxTall', 'DieselGameBox',
  ];
  const widePriority = [
    'DieselStoreFrontWide', 'OfferImageWide', 'Thumbnail',
  ];

  const priority = preferTall
    ? [...tallPriority, ...widePriority]
    : [...widePriority, ...tallPriority];

  for (const type of priority) {
    const img = keyImages.find(i => i.type === type);
    if (img?.url) return img.url;
  }
  return keyImages[0]?.url;
}

/**
 * Transform an Epic catalog item into our universal Game type.
 */
export function transformEpicGame(
  item: EpicCatalogItem,
  libraryEntry?: LibraryGameEntry,
): Game {
  const gameId = `epic-${item.namespace}:${item.id}`;

  // Extract genres from tags
  const genres: string[] = [];
  if (item.tags) {
    for (const tag of item.tags) {
      const name = tag.name || EPIC_GENRE_MAP[tag.id];
      if (name && !genres.includes(name)) genres.push(name);
    }
  }

  // Extract platforms from customAttributes or categories; default to Windows
  const platforms: string[] = [];
  if (item.customAttributes) {
    for (const attr of item.customAttributes) {
      const key = attr.key?.toLowerCase() ?? '';
      if (key.includes('platform')) {
        const val = attr.value?.toLowerCase() ?? '';
        if ((val.includes('win') || val === 'pc') && !platforms.includes('Windows')) platforms.push('Windows');
        if ((val.includes('mac') || val === 'osx') && !platforms.includes('Mac')) platforms.push('Mac');
        if (val.includes('linux') && !platforms.includes('Linux')) platforms.push('Linux');
      }
    }
  }
  if (item.categories) {
    for (const cat of item.categories) {
      const p = cat.path?.toLowerCase() ?? '';
      if (p.includes('windows') && !platforms.includes('Windows')) platforms.push('Windows');
      if (p.includes('mac') && !platforms.includes('Mac')) platforms.push('Mac');
      if (p.includes('linux') && !platforms.includes('Linux')) platforms.push('Linux');
    }
  }
  if (platforms.length === 0) platforms.push('Windows');

  // Parse release / effective date
  let releaseDate = '';
  if (item.effectiveDate) {
    try {
      const d = new Date(item.effectiveDate);
      if (!isNaN(d.getTime()) && d.getFullYear() > 1970) {
        releaseDate = d.toISOString();
      }
    } catch { /* ignore */ }
  }

  // Price
  const tp = item.price?.totalPrice;
  const isFree = tp ? tp.discountPrice === 0 : false;
  const discountPercent = tp && tp.originalPrice > 0
    ? Math.round(((tp.originalPrice - tp.discountPrice) / tp.originalPrice) * 100)
    : 0;

  // Images
  const coverUrl = resolveImage(item.keyImages, true);
  const headerImage = resolveImage(item.keyImages, false);

  // Collect unique wide/landscape images for the media carousel.
  // Prefer actual screenshots and wide hero images; skip tiny thumbnails
  // and tall/portrait covers (those are used for coverUrl, not the gallery).
  const SCREENSHOT_TYPES = [
    'Screenshot',            // actual gameplay screenshots (if available)
    'featuredMedia',         // featured media images
    'DieselStoreFrontWide',  // wide hero image
    'OfferImageWide',        // wide offer image
  ];
  const SKIP_TYPES = new Set([
    'CodeRedemption_340x440',
    'Thumbnail',
    'VaultClosed',
    'DieselStoreFrontTall',
    'OfferImageTall',
    'DieselGameBoxTall',
    'DieselGameBox',
    'DieselGameBoxLogo',
    'ProductLogo',
  ]);

  const screenshots: string[] = [];
  const seen = new Set<string>();

  // First pass: add preferred types in order
  if (item.keyImages) {
    for (const type of SCREENSHOT_TYPES) {
      for (const img of item.keyImages) {
        if (img.type === type && img.url && !seen.has(img.url)) {
          screenshots.push(img.url);
          seen.add(img.url);
        }
      }
    }
    // Second pass: add any remaining non-skipped images
    for (const img of item.keyImages) {
      if (img.url && !seen.has(img.url) && !SKIP_TYPES.has(img.type)) {
        screenshots.push(img.url);
        seen.add(img.url);
      }
    }
  }

  // Coming soon?
  const comingSoon = item.effectiveDate
    ? new Date(item.effectiveDate).getTime() > Date.now()
    : false;

  // Epic slug for store URL generation (e.g. https://store.epicgames.com/en-US/p/{slug})
  //
  // Priority:
  //   1. catalogNs.mappings pageSlug  — most reliable, set by Epic for product pages
  //   2. offerMappings pageSlug       — same idea, offer-level mapping
  //   3. url field                    — authoritative relative path from the API (e.g. "/p/slug")
  //   4. productSlug                  — deprecated by Epic but still present on older titles
  //   5. urlSlug                      — only if not a hex UUID (often useless)
  const catalogPageSlug = item.catalogNs?.mappings?.find(
    (m: { pageSlug: string; pageType: string }) => m.pageType === 'productHome',
  )?.pageSlug;
  const offerPageSlug = item.offerMappings?.find(
    (m: { pageSlug: string; pageType: string }) => m.pageType === 'productHome',
  )?.pageSlug;
  // Extract slug from the `url` field (relative path like "/p/some-slug" or "/en-US/p/some-slug")
  const urlFieldSlug = item.url?.match(/\/p\/([^/]+)/)?.[1] || undefined;
  const cleanProductSlug = item.productSlug?.replace(/\/home$/, '') || undefined;
  // urlSlug is only useful if it's a human-readable slug, not a UUID
  const isUuid = /^[0-9a-f]{32}$/i.test(item.urlSlug || '');
  const safeUrlSlug = item.urlSlug && !isUuid ? item.urlSlug : undefined;
  const epicSlug = catalogPageSlug || offerPageSlug || urlFieldSlug || cleanProductSlug || safeUrlSlug || undefined;

  const game: Game = {
    id: gameId,
    store: 'epic',
    epicNamespace: item.namespace,
    epicOfferId: item.id,
    title: item.title,
    developer: item.developer || item.seller?.name || 'Unknown Developer',
    publisher: item.publisher || item.seller?.name || 'Unknown Publisher',
    genre: genres.length > 0 ? genres : ['Game'],
    platform: platforms,
    metacriticScore: null, // Epic API doesn't provide Metacritic data
    releaseDate,
    summary: item.description || '',
    longDescription: item.longDescription || '',
    epicSlug,
    coverUrl,
    headerImage,
    screenshots,
    videos: [],

    // Price
    price: {
      isFree,
      finalFormatted: tp?.fmtPrice?.discountPrice,
      discountPercent: discountPercent > 0 ? discountPercent : undefined,
    },
    comingSoon,

    // Library fields
    status: libraryEntry?.status || 'Want to Play',
    priority: libraryEntry?.priority || 'Medium',
    publicReviews: libraryEntry?.publicReviews || '',
    recommendationSource: libraryEntry?.recommendationSource || '',

    // Metadata
    createdAt: libraryEntry?.addedAt || new Date(),
    updatedAt: libraryEntry?.updatedAt || new Date(),
    isInLibrary: !!libraryEntry,
  };

  return game;
}

// Check if running in Electron with Epic bridge
function isEpicAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.epic;
}

/**
 * Epic Service Class
 * Provides the same interface pattern as SteamService for consistency.
 */
class EpicService {
  /**
   * Search Epic Games Store
   */
  async searchGames(query: string, limit: number = 20): Promise<Game[]> {
    if (!query.trim()) return [];
    if (!isEpicAvailable()) {
      console.warn('[Epic Service] Not available');
      return [];
    }

    try {
      console.log(`[Epic Service] searchGames: "${query}" (limit ${limit})`);
      const items = await window.epic!.searchGames(query, limit);
      return items.map(item => transformEpicGame(item, libraryStore.getEntry(`epic-${item.namespace}:${item.id}`)));
    } catch (error) {
      console.error('[Epic Service] Search error:', error);
      return [];
    }
  }

  /**
   * Get details for a single Epic game
   */
  async getGameDetails(namespace: string, offerId: string): Promise<Game | null> {
    if (!isEpicAvailable()) return null;

    try {
      const item = await window.epic!.getGameDetails(namespace, offerId);
      if (!item) return null;
      const gameId = `epic-${item.namespace}:${item.id}`;
      return transformEpicGame(item, libraryStore.getEntry(gameId));
    } catch (error) {
      console.error(`[Epic Service] Error getting details for ${namespace}/${offerId}:`, error);
      return null;
    }
  }

  /**
   * Get new releases from Epic
   */
  async getNewReleases(): Promise<Game[]> {
    if (!isEpicAvailable()) return [];
    try {
      const items = await window.epic!.getNewReleases();
      return items.map(item => transformEpicGame(item));
    } catch (error) {
      console.error('[Epic Service] Error getting new releases:', error);
      return [];
    }
  }

  /**
   * Get coming soon from Epic
   */
  async getComingSoon(): Promise<Game[]> {
    if (!isEpicAvailable()) return [];
    try {
      const items = await window.epic!.getComingSoon();
      return items.map(item => transformEpicGame(item));
    } catch (error) {
      console.error('[Epic Service] Error getting coming soon:', error);
      return [];
    }
  }

  /**
   * Get current free games on Epic
   */
  async getFreeGames(): Promise<Game[]> {
    if (!isEpicAvailable()) return [];
    try {
      const items = await window.epic!.getFreeGames();
      return items.map(item => transformEpicGame(item));
    } catch (error) {
      console.error('[Epic Service] Error getting free games:', error);
      return [];
    }
  }

  /**
   * Browse the full Epic catalog — returns hundreds of games (paginated on backend).
   * Unlike getNewReleases/getComingSoon which are date-filtered, this fetches
   * the full catalog sorted by release date.
   */
  async browseCatalog(limit: number = 0): Promise<Game[]> {
    if (!isEpicAvailable()) return [];
    try {
      console.log(`[Epic Service] browseCatalog (limit ${limit || 'ALL'})`);
      const items = await window.epic!.browseCatalog(limit);
      return items.map(item =>
        transformEpicGame(item, libraryStore.getEntry(`epic-${item.namespace}:${item.id}`)),
      );
    } catch (error) {
      console.error('[Epic Service] Error browsing catalog:', error);
      return [];
    }
  }

  /**
   * Clear Epic cache
   */
  async clearCache(): Promise<void> {
    if (isEpicAvailable()) {
      await window.epic!.clearCache();
    }
    console.log('[Epic Service] Cache cleared');
  }
}

// Export singleton
export const epicService = new EpicService();
