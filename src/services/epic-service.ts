/**
 * Epic Games Service
 * Handles Epic Games Store API interactions and data transformation.
 * Mirrors the pattern of steam-service.ts.
 * When Epic GraphQL is blocked, falls back to egdata for search.
 */

import { Game, LibraryGameEntry } from '@/types/game';
import { EpicCatalogItem } from '@/types/epic';
import { libraryStore } from './library-store';
import { egdataOfferToEpicCatalogItem } from './egdata-adapter';
import type { EgdataOfferLike } from './egdata-adapter';

// API-verified genre tag IDs (groupName === "genre"). Fallback when groupName absent.
const EPIC_GENRE_IDS: ReadonlySet<number> = new Set([
  1080, 1083, 1084, 1110, 1115, 1116, 1117, 1120, 1121, 1146,
  1151, 1170, 1181, 1210, 1212, 1216, 1218, 1263, 1283, 1287,
  1294, 1296, 1307, 1336, 1367, 1381, 1386, 1393, 1395,
]);

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

/** Approximate USD → INR for display when Epic returns USD (e.g. cached or US response). Update periodically or make configurable. */
const USD_TO_INR = 83;

/**
 * If the formatted price looks like USD (e.g. "$29.99"), convert to INR and return "₹X,XXX".
 * Otherwise returns the string unchanged (already INR or other).
 */
function ensureInrFormattedPrice(formatted: string): string {
  const trimmed = formatted.trim();
  if (!trimmed.startsWith('$')) return trimmed;
  const match = trimmed.replace(/,/g, '').match(/^\$\s*([\d.]+)/);
  if (!match) return trimmed;
  const usd = parseFloat(match[1]);
  if (Number.isNaN(usd) || usd < 0) return trimmed;
  const inr = Math.round(usd * USD_TO_INR);
  return `₹${inr.toLocaleString('en-IN')}`;
}

/**
 * Transform an Epic catalog item into our universal Game type.
 */
export function transformEpicGame(
  item: EpicCatalogItem,
  libraryEntry?: LibraryGameEntry,
): Game {
  const gameId = `epic-${item.namespace}:${item.id}`;

  // Extract genres from tags — only genre-group tags, not community/platform/feature
  const genreSet = new Set<string>();
  if (item.tags) {
    for (const tag of item.tags) {
      const isGenre = tag.groupName === 'genre' || (!tag.groupName && EPIC_GENRE_IDS.has(tag.id));
      if (isGenre && tag.name) genreSet.add(tag.name);
    }
  }
  const genres = Array.from(genreSet);

  // Extract platforms from customAttributes or categories; default to Windows
  const platforms: string[] = [];
  if (Array.isArray(item.customAttributes)) {
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
  if (Array.isArray(item.categories)) {
    for (const cat of item.categories) {
      const p = (typeof cat === 'object' && cat && 'path' in cat
        ? (cat as { path?: string }).path
        : typeof cat === 'string'
          ? cat
          : '')?.toLowerCase() ?? '';
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
  // The Epic GraphQL API can return price in several incomplete states:
  //   • price: null                          — no pricing data at all
  //   • fmtPrice.discountPrice: ""           — formatted string empty
  //   • discountPrice: 0  + originalPrice: 0 — genuinely free OR pricing not set
  // We build a robust fallback chain to handle all cases.
  const tp = item.price?.totalPrice;
  const fmtDiscount = tp?.fmtPrice?.discountPrice || '';
  const fmtOriginal = tp?.fmtPrice?.originalPrice || '';

  // A game is truly free when the current price is 0 AND we can confirm it's
  // intentionally free (not just missing pricing data):
  //   (a) positive original price → 100% discount / free promo, OR
  //   (b) formatted original price is "0" or "Free" → genuinely F2P
  const isFree = tp
    ? tp.discountPrice === 0 && (
        tp.originalPrice > 0
        || fmtOriginal === '0'
        || fmtOriginal.toLowerCase() === 'free'
      )
    : false;

  // Formatted price: prefer discountPrice (current price after any sale),
  // fall back to originalPrice string, then compute from numeric (paise when country=IN).
  // If Epic returns USD strings (e.g. cached US response), convert to INR for display.
  const rawFormatted =
    (fmtDiscount && fmtDiscount !== '0' ? fmtDiscount : null)
    || (fmtOriginal && fmtOriginal !== '0' ? fmtOriginal : null)
    || (tp && tp.discountPrice > 0
      ? `₹${(tp.discountPrice / 100).toLocaleString('en-IN')}`
      : null)
    || (tp && tp.originalPrice > 0
      ? `₹${(tp.originalPrice / 100).toLocaleString('en-IN')}`
      : null)
    || undefined;
  const finalFormatted = rawFormatted ? ensureInrFormattedPrice(rawFormatted) : undefined;

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
  // Epic's effectiveDate is when the *offer* was published, which can differ
  // from the actual consumer release date.  If the game already has a real
  // price (finalFormatted is a currency string like "$69.99"), it's clearly
  // purchasable → override comingSoon to false regardless of effectiveDate.
  const effectiveDateFuture = item.effectiveDate
    ? new Date(item.effectiveDate).getTime() > Date.now()
    : false;
  const hasPurchasablePrice = !!finalFormatted && !isFree;
  const comingSoon = hasPurchasablePrice ? false : effectiveDateFuture;

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
      finalFormatted: finalFormatted || undefined,
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
   * Search Epic Games Store.
   * When Epic GraphQL is blocked (Cloudflare), falls back to egdata autocomplete + offer detail.
   */
  async searchGames(query: string, limit: number = 20): Promise<Game[]> {
    if (!query.trim()) return [];
    if (!isEpicAvailable()) {
      console.warn('[Epic Service] Not available');
      return [];
    }

    try {
      const epicBlocked =
        typeof window.epic?.isEpicBlocked === 'function'
          ? await window.epic.isEpicBlocked().catch(() => false)
          : false;

      if (epicBlocked && typeof window.egdata?.getAutocomplete === 'function' && window.egdata.getOffer) {
        const result = await window.egdata.getAutocomplete(query, Math.min(limit, 20));
        const elements = (result?.elements ?? []) as EgdataOfferLike[];
        const games: Game[] = [];
        for (const el of elements.slice(0, 20)) {
          const id = el?.id;
          if (!id) continue;
          const full = await window.egdata.getOffer(id) as EgdataOfferLike | null;
          const item = full ? egdataOfferToEpicCatalogItem(full) : null;
          if (item) {
            games.push(transformEpicGame(item, libraryStore.getEntry(`epic-${item.namespace}:${item.id}`)));
          }
        }
        return games;
      }

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
   * Get Epic's curated Top Sellers (99) from Storefront.collectionLayout(slug: "top-sellers").
   * Returns [] if Epic is unavailable or the query fails (e.g. blocked).
   */
  async getTopSellersFromCollection(): Promise<Game[]> {
    if (!isEpicAvailable() || typeof window.epic?.getTopSellersCollection !== 'function') return [];
    try {
      const items = await window.epic.getTopSellersCollection();
      return items.map(item =>
        transformEpicGame(item, libraryStore.getEntry(`epic-${item.namespace}:${item.id}`)),
      );
    } catch (error) {
      console.warn('[Epic Service] getTopSellersFromCollection failed:', error);
      return [];
    }
  }

  /**
   * Browse the full Epic catalog — returns hundreds of games (paginated on backend).
   * When Epic GraphQL is blocked, falls back to egdata top-sellers (99) so prefetch still gets Epic data.
   */
  async browseCatalog(limit: number = 0): Promise<Game[]> {
    if (!isEpicAvailable()) return [];
    try {
      const epicBlocked =
        typeof window.epic?.isEpicBlocked === 'function'
          ? await window.epic.isEpicBlocked().catch(() => false)
          : false;

      if (epicBlocked && typeof window.egdata?.getTopSellers === 'function') {
        const result = await window.egdata.getTopSellers(99, 0);
        const elements = (result?.elements ?? []) as EgdataOfferLike[];
        return elements
          .map((o) => egdataOfferToEpicCatalogItem(o))
          .filter((item): item is EpicCatalogItem => item != null)
          .map((item) =>
            transformEpicGame(item, libraryStore.getEntry(`epic-${item.namespace}:${item.id}`)),
          );
      }

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
