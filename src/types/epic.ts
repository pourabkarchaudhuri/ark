/**
 * Epic Games Store types for the renderer process.
 * Mirrors the data structures from electron/epic-api.ts.
 */

export interface EpicKeyImage {
  type: string;
  url: string;
}

export interface EpicCatalogItem {
  namespace: string;
  id: string; // offerId
  title: string;
  description?: string;
  longDescription?: string;
  keyImages?: EpicKeyImage[];
  categories?: Array<{ path: string }>;
  tags?: Array<{ id: number; name?: string }>;
  effectiveDate?: string;
  developer?: string;
  publisher?: string;
  seller?: { name: string };
  url?: string;
  urlSlug?: string;
  productSlug?: string;
  offerMappings?: Array<{ pageSlug: string; pageType: string }>;
  catalogNs?: { mappings?: Array<{ pageSlug: string; pageType: string }> };
  price?: {
    totalPrice: {
      discountPrice: number;
      originalPrice: number;
      fmtPrice: {
        originalPrice: string;
        discountPrice: string;
        intermediatePrice: string;
      };
    };
  };
  promotions?: {
    promotionalOffers: Array<{
      promotionalOffers: Array<{
        startDate: string;
        endDate: string;
        discountSetting: { discountType: string; discountPercentage: number };
      }>;
    }>;
    upcomingPromotionalOffers: Array<{
      promotionalOffers: Array<{
        startDate: string;
        endDate: string;
        discountSetting: { discountType: string; discountPercentage: number };
      }>;
    }>;
  };
  customAttributes?: Array<{ key: string; value: string }>;
}

export interface EpicUpcomingRelease {
  title: string;
  date: string;
  capsule: string;
  discount: boolean;
  free: boolean;
  namespace: string;
  offerId: string;
}

/**
 * Global window.epic interface — exposed by the preload bridge.
 */
declare global {
  interface Window {
    epic?: {
      searchGames: (query: string, limit?: number) => Promise<EpicCatalogItem[]>;
      getGameDetails: (namespace: string, offerId: string) => Promise<EpicCatalogItem | null>;
      getNewReleases: () => Promise<EpicCatalogItem[]>;
      getComingSoon: () => Promise<EpicCatalogItem[]>;
      getFreeGames: () => Promise<EpicCatalogItem[]>;
      getUpcomingReleases: () => Promise<EpicUpcomingRelease[]>;
      browseCatalog: (limit?: number) => Promise<EpicCatalogItem[]>;
      getCoverUrl: (namespace: string, offerId: string) => string | null;
      clearCache: () => Promise<void>;
      getCacheStats: () => Promise<{ total: number; fresh: number; stale: number }>;
      /** Rich product page content — full About description, system requirements, gallery */
      getProductContent: (slug: string) => Promise<{
        about?: string;
        requirements?: Array<{
          systemType: string;
          details: Array<{
            title: string;
            minimum: Record<string, string>;
            recommended: Record<string, string>;
          }>;
        }>;
        gallery?: Array<{ type: 'image' | 'video'; url: string; thumbnail?: string }>;
      } | null>;
      /** News/blog articles related to a game (filtered by keyword) */
      getNewsFeed: (keyword: string, limit?: number) => Promise<EpicNewsArticle[]>;
      /** Product reviews/ratings for a game */
      getProductReviews: (slug: string) => Promise<EpicProductReviews | null>;
      /** DLC and add-ons for a game namespace */
      getAddons: (namespace: string, limit?: number) => Promise<EpicAddon[]>;
    };
  }
}

export interface EpicNewsArticle {
  title: string;
  url: string;
  date: string;
  image?: string;
  body?: string;
  source?: string;
}

export interface EpicProductReviews {
  overallScore: string;
  totalReviews: number;
  averageRating: number;
  recentReviews?: Array<{
    rating: number;
    body: string;
    date: string;
    userName?: string;
  }>;
}

export interface EpicAddon {
  id: string;
  title: string;
  description: string;
  image?: string;
  price?: string;
  isFree: boolean;
  releaseDate?: string;
  slug?: string;
}

export {};
