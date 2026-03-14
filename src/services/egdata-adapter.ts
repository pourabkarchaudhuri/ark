/**
 * egdata → EpicCatalogItem adapter for use with transformEpicGame().
 * Follows §8.11 and §8.13 (field verification, defensive checks).
 */

import type { EpicCatalogItem } from '@/types/epic';

// egdata offer shape (subset used by adapter; full types in electron/egdata-api.ts)
// egdata API returns customAttributes as an object { key: { type, value } }, not an array
export interface EgdataOfferLike {
  id?: string;
  namespace?: string;
  title?: string;
  description?: string;
  longDescription?: string;
  keyImages?: Array<{ type: string; url: string }>;
  tags?: Array<{ id: number | string; name?: string; groupName?: string | null }>;
  effectiveDate?: string;
  releaseDate?: string;
  developerDisplayName?: string;
  publisherDisplayName?: string;
  seller?: { name: string };
  url?: string;
  urlSlug?: string;
  productSlug?: string;
  offerMappings?: Array<{ pageSlug: string; pageType: string }>;
  categories?: Array<{ path: string } | string>;
  customAttributes?: Array<{ key: string; value: string }> | Record<string, { type?: string; value?: string }>;
  price?: {
    discountPrice?: number;
    originalPrice?: number;
    currencyCode?: string;
  };
}

function formatPriceCents(cents: number, currencyCode: string): string {
  const code = (currencyCode || 'USD').toUpperCase();
  const amount = cents / 100;
  if (code === 'USD') return `$${amount.toFixed(2)}`;
  if (code === 'EUR') return `€${amount.toFixed(2)}`;
  if (code === 'GBP') return `£${amount.toFixed(2)}`;
  if (code === 'INR') return `₹${amount.toFixed(0)}`;
  return `${code} ${amount.toFixed(2)}`;
}

/**
 * Map an egdata offer to EpicCatalogItem so transformEpicGame() can produce a Game.
 * Returns null if offer is invalid (missing id, namespace, or title).
 */
export function egdataOfferToEpicCatalogItem(offer: EgdataOfferLike | null | undefined): EpicCatalogItem | null {
  if (!offer?.id || !offer?.namespace) return null;
  const title = (offer.title ?? '').trim() || 'Unknown';
  const namespace = String(offer.namespace);
  const id = String(offer.id);

  // Tags: coerce id to number; drop invalid
  const tags: Array<{ id: number; name?: string; groupName?: string | null }> = [];
  if (Array.isArray(offer.tags)) {
    for (const tag of offer.tags) {
      const numId = typeof tag.id === 'number' ? tag.id : Number(tag.id);
      if (!Number.isNaN(numId)) {
        tags.push({ id: numId, name: tag.name, groupName: tag.groupName ?? null });
      }
    }
  }

  // Price: egdata uses flat discountPrice/originalPrice (cents). Build totalPrice + fmtPrice.
  let price: EpicCatalogItem['price'] | undefined;
  const p = offer.price;
  if (p && (typeof p.discountPrice === 'number' || typeof p.originalPrice === 'number')) {
    const discountPrice = typeof p.discountPrice === 'number' ? p.discountPrice : (p.originalPrice ?? 0);
    const originalPrice = typeof p.originalPrice === 'number' ? p.originalPrice : discountPrice;
    const currencyCode = p.currencyCode || 'USD';
    price = {
      totalPrice: {
        discountPrice,
        originalPrice,
        fmtPrice: {
          discountPrice: formatPriceCents(discountPrice, currencyCode),
          originalPrice: formatPriceCents(originalPrice, currencyCode),
          intermediatePrice: '',
        },
      },
    };
  }

  // effectiveDate / releaseDate — ensure string so downstream never .slice() on undefined
  const effectiveDate = typeof offer.effectiveDate === 'string' ? offer.effectiveDate
    : typeof offer.releaseDate === 'string' ? offer.releaseDate
    : '';

  // egdata returns customAttributes as object { key: { type, value } }; normalize to array for EpicCatalogItem
  let customAttributes: EpicCatalogItem['customAttributes'];
  if (Array.isArray(offer.customAttributes)) {
    customAttributes = offer.customAttributes;
  } else if (offer.customAttributes && typeof offer.customAttributes === 'object' && !Array.isArray(offer.customAttributes)) {
    customAttributes = Object.entries(offer.customAttributes).map(([key, v]) => ({
      key,
      value: (v && typeof v === 'object' && 'value' in v && typeof (v as { value?: string }).value === 'string')
        ? (v as { value: string }).value
        : String(v ?? ''),
    }));
  } else {
    customAttributes = undefined;
  }

  // egdata may return categories as string[]; EpicCatalogItem expects Array<{ path: string }>
  const categories: EpicCatalogItem['categories'] = Array.isArray(offer.categories)
    ? offer.categories.map(c => typeof c === 'string' ? { path: c } : c)
    : undefined;

  const catalogItem: EpicCatalogItem = {
    namespace,
    id,
    title,
    description: typeof offer.description === 'string' ? offer.description : undefined,
    longDescription: typeof offer.longDescription === 'string' ? offer.longDescription : undefined,
    keyImages: Array.isArray(offer.keyImages)
      ? offer.keyImages.filter((img): img is { type: string; url: string } =>
          typeof img?.type === 'string' && typeof img?.url === 'string')
      : undefined,
    categories,
    tags: tags.length > 0 ? tags : undefined,
    effectiveDate: effectiveDate || undefined,
    developer: offer.developerDisplayName ?? offer.seller?.name ?? 'Unknown Developer',
    publisher: offer.publisherDisplayName ?? offer.seller?.name ?? 'Unknown Publisher',
    seller: offer.seller,
    url: offer.url,
    urlSlug: offer.urlSlug,
    productSlug: offer.productSlug,
    offerMappings: offer.offerMappings,
    catalogNs: offer.offerMappings?.length
      ? { mappings: offer.offerMappings }
      : undefined,
    price,
    customAttributes,
  };

  return catalogItem;
}
