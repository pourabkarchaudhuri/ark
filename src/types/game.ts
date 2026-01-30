// Game type that combines Steam/IGDB data with user library data
export interface Game {
  // Core fields (works with both Steam and IGDB)
  id: string; // We use string IDs internally (e.g., "steam-123" or "igdb-456")
  steamAppId?: number; // Steam app ID (if from Steam)
  igdbId?: number; // IGDB ID (if from IGDB - deprecated)
  title: string;
  developer: string;
  publisher: string;
  genre: string[];
  platform: string[]; // For Steam: ['Windows', 'Mac', 'Linux']
  metacriticScore: number | null;
  releaseDate: string;
  summary?: string;
  coverUrl?: string;
  screenshots?: string[];
  videos?: string[]; // YouTube video IDs or Steam movie URLs
  websites?: { url: string; category: number }[]; // Store links
  
  // Steam-specific fields
  playerCount?: number; // Current/peak players
  rank?: number; // Rank in most played
  price?: {
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
  achievements?: number;
  recommendations?: number;
  comingSoon?: boolean;
  
  // Legacy IGDB fields (may be removed later)
  gameModes?: string[];
  themes?: string[];
  playerPerspectives?: string[];
  storyline?: string;
  similarGames?: { id: number; name: string; coverUrl?: string }[];
  
  // User library fields (only present if game is in library)
  status: GameStatus;
  priority: GamePriority;
  publicReviews: string; // User's notes
  recommendationSource: string;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  isInLibrary?: boolean;
  isCustom?: boolean; // True for user-added games not from Steam/IGDB
}

export type GameStatus = 'Want to Play' | 'Playing' | 'Completed' | 'On Hold' | 'Dropped';
export type GamePriority = 'High' | 'Medium' | 'Low';

export type GameCategory = 'all' | 'most-played' | 'trending' | 'recent' | 'award-winning';

export interface GameFilters {
  search: string;
  status: GameStatus | 'All';
  genre: string | 'All';
  platform: string | 'All';
  category: GameCategory;
  releaseYear: string | 'All'; // Filter by release year (e.g., "2025", "2024")
}

export interface GameStats {
  total: number;
  byStatus: Record<GameStatus, number>;
  byPriority: Record<GamePriority, number>;
  averageMetacritic: number;
  highestRated: Game | null;
}

export type CreateGameInput = Omit<Game, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateGameInput = Partial<CreateGameInput>;

// Library-specific game entry (stored in localStorage)
export interface LibraryGameEntry {
  gameId: number; // Steam appId or IGDB ID
  steamAppId?: number; // Steam app ID (preferred)
  igdbId?: number; // IGDB ID (legacy)
  status: GameStatus;
  priority: GamePriority;
  publicReviews: string;
  recommendationSource: string;
  addedAt: Date;
  updatedAt: Date;
}

export type CreateLibraryEntry = Omit<LibraryGameEntry, 'addedAt' | 'updatedAt'>;
export type UpdateLibraryEntry = Partial<Omit<LibraryGameEntry, 'igdbId' | 'addedAt'>>;

// Custom game entry (user-added games not from IGDB)
export interface CustomGameEntry {
  id: number; // Negative ID to distinguish from IGDB games
  title: string;
  platform: string[];
  status: GameStatus;
  addedAt: Date;
  updatedAt: Date;
}

export type CreateCustomGameEntry = Omit<CustomGameEntry, 'id' | 'addedAt' | 'updatedAt'>;
export type UpdateCustomGameEntry = Partial<Omit<CustomGameEntry, 'id' | 'addedAt'>>;
