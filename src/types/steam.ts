/**
 * Steam API Type Definitions
 * Types for Steam Web API and Store API responses
 */

// Most Played Games Response
export interface SteamMostPlayedGame {
  rank: number;
  appid: number;
  last_week_rank: number;
  peak_in_game: number;
}

/**
 * App Details from Steam Store API
 * 
 * NOTE: Steam Store API does NOT provide information about:
 * - Awards/prizes won by the game (The Game Awards, etc.)
 * - User-generated content counts
 * - Detailed sales data
 * 
 * To get awards information, consider integrating with:
 * - IGDB API (has awards data)
 * - Wikipedia/Wikidata APIs
 * - Manual curation
 */
export interface SteamAppDetails {
  type: string;
  name: string;
  steam_appid: number;
  required_age: number;
  is_free: boolean;
  detailed_description: string;
  about_the_game: string;
  short_description: string;
  supported_languages: string;
  header_image: string;
  capsule_image: string;
  capsule_imagev5: string;
  website: string | null;
  pc_requirements: {
    minimum?: string;
    recommended?: string;
  };
  developers?: string[];
  publishers?: string[];
  price_overview?: {
    currency: string;
    initial: number;
    final: number;
    discount_percent: number;
    final_formatted: string;
  };
  platforms: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  metacritic?: {
    score: number;
    url: string;
  };
  categories?: Array<{ id: number; description: string }>;
  genres?: Array<{ id: string; description: string }>;
  screenshots?: Array<{
    id: number;
    path_thumbnail: string;
    path_full: string;
  }>;
  movies?: Array<{
    id: number;
    name: string;
    thumbnail: string;
    webm?: { '480': string; max: string };
    mp4?: { '480': string; max: string };
  }>;
  recommendations?: { total: number };
  achievements?: { total: number };
  release_date?: {
    coming_soon: boolean;
    date: string;
  };
  background?: string;
  background_raw?: string;
}

// Search Result Item
export interface SteamSearchItem {
  type: string;
  name: string;
  id: number;
  tiny_image: string;
  metascore?: string;
  platforms?: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  streamingvideo: boolean;
}

// Featured Category Item
export interface SteamFeaturedItem {
  id: number;
  type: number;
  name: string;
  discounted: boolean;
  discount_percent: number;
  original_price?: number;
  final_price: number;
  currency: string;
  large_capsule_image: string;
  small_capsule_image: string;
  windows_available: boolean;
  mac_available: boolean;
  linux_available: boolean;
  streamingvideo_available: boolean;
  header_image: string;
}

// Transformed Steam Game (for UI)
export interface SteamGame {
  appid: number;
  name: string;
  headerImage: string;
  capsuleImage?: string;
  shortDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  releaseDate?: string;
  comingSoon?: boolean;
  metacriticScore?: number;
  playerCount?: number;
  rank?: number;
  price?: {
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
  screenshots?: string[];
  movies?: Array<{
    id: number;
    name: string;
    thumbnail: string;
    webm?: string;
    mp4?: string;
  }>;
  platforms: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  achievements?: number;
  recommendations?: number;
}

// Queue Status
export interface QueueStatus {
  queueSize: number;
}

// Game Recommendation
export interface GameRecommendation {
  appId: number;
  name: string;
  score: number;
  reasons: string[];
}

// Steam Reviews API Types
export interface SteamReviewAuthor {
  steamid: string;
  num_games_owned: number;
  num_reviews: number;
  playtime_forever: number;
  playtime_last_two_weeks: number;
  playtime_at_review: number;
  last_played: number;
}

export interface SteamReview {
  recommendationid: string;
  author: SteamReviewAuthor;
  language: string;
  review: string;
  timestamp_created: number;
  timestamp_updated: number;
  voted_up: boolean;
  votes_up: number;
  votes_funny: number;
  weighted_vote_score: string;
  comment_count: number;
  steam_purchase: boolean;
  received_for_free: boolean;
  written_during_early_access: boolean;
}

export interface SteamReviewsResponse {
  success: number;
  query_summary: {
    num_reviews?: number;
    review_score?: number;
    review_score_desc?: string;
    total_positive: number;
    total_negative: number;
    total_reviews: number;
  };
  reviews: SteamReview[];
}

// Window interface for Steam API exposure
declare global {
  interface Window {
    steam?: {
      getMostPlayedGames: () => Promise<SteamMostPlayedGame[]>;
      getAppDetails: (appId: number) => Promise<SteamAppDetails | null>;
      getMultipleAppDetails: (appIds: number[]) => Promise<Array<{ appId: number; details: SteamAppDetails }>>;
      searchGames: (query: string, limit?: number) => Promise<SteamSearchItem[]>;
      getNewReleases: () => Promise<Array<{ id: number; name: string; image: string }>>;
      getTopSellers: () => Promise<Array<{ id: number; name: string; image: string }>>;
      getComingSoon: () => Promise<Array<{ id: number; name: string; image: string }>>;
      getGameReviews: (appId: number, limit?: number) => Promise<SteamReviewsResponse>;
      getQueueStatus: () => Promise<QueueStatus>;
      clearCache: () => Promise<void>;
      // Background prefetch for faster navigation
      prefetchGameDetails: (appIds: number[]) => Promise<boolean>;
      isCached: (appId: number) => Promise<boolean>;
      // Cache statistics
      getCacheStats: () => Promise<{ total: number; fresh: number; stale: number }>;
      // Get cached game names for multiple app IDs
      getCachedGameNames: (appIds: number[]) => Promise<Record<number, string>>;
      // Game recommendations
      getRecommendations: (currentAppId: number, libraryAppIds: number[], limit?: number) => Promise<GameRecommendation[]>;
      // Helper functions for image URLs
      getCoverUrl: (appId: number) => string;
      getHeaderUrl: (appId: number) => string;
    };
  }
}

// Steam CDN base URL (for use in renderer when window.steam is not available)
export const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

/**
 * Get cover image URL for a Steam game (600x900 vertical)
 */
export function getSteamCoverUrl(appId: number): string {
  return `${STEAM_CDN_BASE}/${appId}/library_600x900.jpg`;
}

/**
 * Get header image URL for a Steam game (460x215 horizontal)
 */
export function getSteamHeaderUrl(appId: number): string {
  return `${STEAM_CDN_BASE}/${appId}/header.jpg`;
}

export {};

