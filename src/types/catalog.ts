/**
 * Steam Catalog Types
 *
 * Types for the full Steam catalog acquired via IStoreBrowseService/GetItems.
 * These are lightweight entries optimized for the recommendation engine's
 * candidate pool and embedding generation.
 */

/** A single entry in the local Steam catalog cache. */
export interface CatalogEntry {
  appid: number;
  name: string;
  genres: string[];
  themes: string[];
  modes: string[];
  developer: string;
  publisher: string;
  shortDescription: string;
  releaseDate: number;
  /** Review summary */
  reviewScore: number;
  reviewCount: number;
  reviewPositivity: number;
  /** Platforms */
  windows: boolean;
  mac: boolean;
  linux: boolean;
  steamDeckCompat: number;
  /** Price */
  isFree: boolean;
  priceFormatted?: string;
  discountPercent?: number;
  /** Raw tag IDs (kept for future use / re-classification) */
  tagIds: number[];
}

/** Sync state persisted alongside catalog data. */
export interface CatalogSyncState {
  /** Timestamp of last successful full sync. */
  lastSyncTimestamp: number;
  /** Total entries stored. */
  totalEntries: number;
  /** Number of batches completed in current/last run. */
  batchesCompleted: number;
  /** Total batches expected. */
  batchesTotal: number;
  /** Whether a sync is currently in progress. */
  inProgress: boolean;
}

/** Raw response shape from IStoreBrowseService/GetItems/v1. */
export interface StoreBrowseItem {
  item_type: number;
  id: number;
  success: number;
  visible?: boolean;
  name?: string;
  store_url_path?: string;
  appid: number;
  type?: number;
  tagids?: number[];
  categories?: {
    supported_player_categoryids?: number[];
    feature_categoryids?: number[];
    controller_categoryids?: number[];
  };
  reviews?: {
    summary_filtered?: {
      review_count: number;
      percent_positive: number;
      review_score: number;
      review_score_label: string;
    };
  };
  basic_info?: {
    short_description?: string;
    publishers?: Array<{ name: string }>;
    developers?: Array<{ name: string }>;
  };
  tags?: Array<{ tagid: number; weight: number }>;
  release?: {
    steam_release_date?: number;
    original_release_date?: number;
  };
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
    steam_deck_compat_category?: number;
  };
  is_free?: boolean;
  best_purchase_option?: {
    formatted_final_price?: string;
    discount_pct?: number;
  };
}

/** Raw response from IStoreService/GetTagList/v1. */
export interface SteamTagDefinition {
  tagid: number;
  name: string;
}

/** Classified tag with category. */
export type TagCategory = 'genre' | 'theme' | 'mode' | 'other';

export interface ClassifiedTag {
  tagid: number;
  name: string;
  category: TagCategory;
}
