// IGDB API Response Types

export interface IGDBCover {
  id: number;
  url: string;
  image_id: string;
}

export interface IGDBGenre {
  id: number;
  name: string;
  slug?: string;
}

export interface IGDBPlatform {
  id: number;
  name: string;
  abbreviation?: string;
  platform_family?: number;
}

export interface IGDBCompany {
  id: number;
  name: string;
}

export interface IGDBInvolvedCompany {
  id: number;
  company: IGDBCompany;
  developer: boolean;
  publisher: boolean;
}

export interface IGDBScreenshot {
  id: number;
  url: string;
  image_id: string;
}

export interface IGDBVideo {
  id: number;
  video_id: string; // YouTube video ID
}

export interface IGDBWebsite {
  id: number;
  url: string;
  category: number; // 1=official, 2=wikia, 3=wikipedia, etc.
}

export interface IGDBGame {
  id: number;
  name: string;
  cover?: IGDBCover;
  genres?: IGDBGenre[];
  platforms?: IGDBPlatform[];
  involved_companies?: IGDBInvolvedCompany[];
  aggregated_rating?: number;
  rating?: number;
  total_rating?: number;
  first_release_date?: number; // Unix timestamp
  summary?: string;
  storyline?: string;
  screenshots?: IGDBScreenshot[];
  videos?: IGDBVideo[];
  websites?: IGDBWebsite[];
  similar_games?: {
    id: number;
    name: string;
    cover?: { image_id: string };
  }[];
}

// Helper function to convert IGDB image URL to high-res version
export function getIGDBImageUrl(imageId: string | undefined, size: 'thumb' | 'cover_small' | 'cover_big' | 'screenshot_med' | 'screenshot_big' | 'screenshot_huge' | '720p' | '1080p' = 'cover_big'): string {
  if (!imageId) {
    return '';
  }
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}

// Helper to get developer from involved companies
export function getIGDBDeveloper(involvedCompanies?: IGDBInvolvedCompany[]): string {
  if (!involvedCompanies) return 'Unknown Developer';
  const developer = involvedCompanies.find(ic => ic.developer);
  return developer?.company?.name || 'Unknown Developer';
}

// Helper to get publisher from involved companies
export function getIGDBPublisher(involvedCompanies?: IGDBInvolvedCompany[]): string {
  if (!involvedCompanies) return 'Unknown Publisher';
  const publisher = involvedCompanies.find(ic => ic.publisher);
  return publisher?.company?.name || 'Unknown Publisher';
}

// Helper to format IGDB date (Unix timestamp to ISO string)
export function formatIGDBDate(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

// Helper to get platform family (for grouping PC/PlayStation/Xbox)
export function getPlatformFamily(platform: IGDBPlatform): 'windows' | 'playstation' | 'xbox' | 'nintendo' | 'other' {
  const name = platform.name.toLowerCase();
  const abbrev = platform.abbreviation?.toLowerCase() || '';
  
  if (name.includes('pc') || name.includes('windows') || abbrev === 'pc') {
    return 'windows';
  }
  if (name.includes('playstation') || abbrev.startsWith('ps')) {
    return 'playstation';
  }
  if (name.includes('xbox')) {
    return 'xbox';
  }
  if (name.includes('nintendo') || name.includes('switch') || name.includes('wii')) {
    return 'nintendo';
  }
  return 'other';
}

// Rate limiting types
export interface QueueStatus {
  queueSize: number;
  maxQueueSize: number;
  rateLimit: number;
  rateLimitWindow: number;
}

// Game category types
export type IGDBGameCategory = 'all' | 'trending' | 'recent' | 'award-winning';

// Window type declarations for IPC
declare global {
  interface Window {
    igdb?: {
      getPopularGames: (limit: number, offset: number, year?: number) => Promise<IGDBGame[]>;
      searchGames: (query: string, limit: number) => Promise<IGDBGame[]>;
      getGameById: (id: number) => Promise<IGDBGame | null>;
      getGamesByIds: (ids: number[]) => Promise<IGDBGame[]>;
      getGenres: () => Promise<IGDBGenre[]>;
      getPlatforms: () => Promise<IGDBPlatform[]>;
      getGamesByCategory: (category: IGDBGameCategory, limit: number, offset: number, year?: number) => Promise<IGDBGame[]>;
      getQueueStatus: () => Promise<QueueStatus>;
      onRateLimitWarning: (callback: (queueSize: number) => void) => void;
    };
  }
}

