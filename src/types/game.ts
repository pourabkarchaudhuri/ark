// Store identifier — which store a game originates from
export type GameStore = 'steam' | 'epic' | 'custom';

// Game type that combines Steam/Epic data with user library data
export interface Game {
  // Core fields
  id: string; // Universal string ID (e.g., "steam-730", "epic-fn:fortnite")
  store?: GameStore; // Which store this game comes from
  steamAppId?: number; // Steam app ID (for Steam games)
  epicNamespace?: string; // Epic namespace (for Epic games)
  epicOfferId?: string; // Epic offer ID (for Epic games)
  title: string;
  developer: string;
  publisher: string;
  genre: string[];
  platform: string[]; // e.g. ['Windows', 'Mac', 'Linux']
  metacriticScore: number | null;
  releaseDate: string;
  summary?: string;
  longDescription?: string; // Full "About the Game" text (Epic longDescription / Steam detailed_description)
  coverUrl?: string;
  headerImage?: string; // API-provided header image URL (uses current CDN format)
  screenshots?: string[];
  videos?: string[]; // YouTube video IDs or Steam movie URLs
  websites?: { url: string; category: number }[]; // Store links
  epicSlug?: string; // Epic product slug for store URL generation
  
  // Multi-store deduplication
  availableOn?: ('steam' | 'epic')[]; // Stores where this game is available
  secondaryId?: string; // ID on the other store (for dedup-linked games)
  epicPrice?: { // Epic pricing preserved during dedup (when Steam is primary)
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
  
  // Player count (Steam-only — Epic does not expose this data)
  playerCount?: number; // Live concurrent players (from Steam API)
  playerCountSource?: 'steam'; // Where the count came from (for label clarity)
  rank?: number; // Rank in most played
  price?: {
    isFree: boolean;
    finalFormatted?: string;
    discountPercent?: number;
  };
  achievements?: number;
  recommendations?: number;
  comingSoon?: boolean;
  
  // Extended metadata
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
  isCustom?: boolean; // True for user-added games not from Steam/Epic
}

export type GameStatus = 'Want to Play' | 'Playing' | 'Playing Now' | 'Completed' | 'On Hold';
export type GamePriority = 'High' | 'Medium' | 'Low';

export type GameCategory = 'all' | 'most-played' | 'trending' | 'recent' | 'award-winning' | 'catalog' | 'free';

export interface GameFilters {
  search: string;
  status: GameStatus | 'All';
  priority: GamePriority | 'All';
  genre: string | 'All';
  platform: string | 'All';
  category: GameCategory;
  releaseYear: string | 'All'; // Filter by release year (e.g., "2025", "2024")
  store: GameStore[]; // Filter by store (empty = all stores)
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

// Cached game metadata stored alongside the library entry so we can always
// display the game even when the remote API (Epic GQL, etc.) is unreachable.
export interface CachedGameMeta {
  title: string;
  store?: GameStore;
  coverUrl?: string;
  headerImage?: string;
  developer?: string;
  publisher?: string;
  genre?: string[];
  platform?: string[];
  releaseDate?: string;
  metacriticScore?: number | null;
  summary?: string;
  epicSlug?: string;
  epicNamespace?: string;
  epicOfferId?: string;
  steamAppId?: number;
  // v3: extended metadata for recommendation engine
  themes?: string[];
  gameModes?: string[];
  playerPerspectives?: string[];
  similarGames?: { id: number; name: string }[];
}

// Library-specific game entry (stored in localStorage)
export interface LibraryGameEntry {
  gameId: string; // Universal ID (e.g., "steam-730", "epic-fn:fortnite", "custom-1")
  steamAppId?: number; // Steam app ID (for backwards compat / Steam-specific lookups)
  status: GameStatus;
  priority: GamePriority;
  publicReviews: string;
  recommendationSource: string;
  // Progress tracking fields
  hoursPlayed: number; // Total hours played
  rating: number; // User rating 1-5 stars (0 = not rated)
  executablePath?: string; // Path to game executable for session tracking
  secondaryGameId?: string; // ID on another store (for dedup-linked games)
  cachedMeta?: CachedGameMeta; // Snapshot of game metadata at add-time (fallback when API unavailable)
  lastPlayedAt?: string; // ISO date — last time the game was played (from sessions or Steam)
  addedAt: Date;
  updatedAt: Date;
}

export type CreateLibraryEntry = Omit<LibraryGameEntry, 'addedAt' | 'updatedAt' | 'hoursPlayed' | 'rating'> & {
  hoursPlayed?: number;
  rating?: number;
};
export type UpdateLibraryEntry = Partial<Omit<LibraryGameEntry, 'addedAt'>>;

// Custom game entry (user-added games not from Steam/Epic)
export interface CustomGameEntry {
  id: string; // String ID like "custom-1", "custom-2"
  title: string;
  platform: string[];
  status: GameStatus;
  priority?: GamePriority;
  executablePath?: string; // Path to game executable for session tracking
  hoursPlayed?: number; // Total hours played (updated from session tracker)
  rating?: number; // User rating 1-5 stars (0 = not rated)
  lastPlayedAt?: string; // ISO date — last time the game was played
  publicReviews?: string; // Personal notes / reviews
  recommendationSource?: string; // How the user discovered this game
  addedAt: Date;
  updatedAt: Date;
}

export type CreateCustomGameEntry = Omit<CustomGameEntry, 'id' | 'addedAt' | 'updatedAt'>;
export type UpdateCustomGameEntry = Partial<Omit<CustomGameEntry, 'id' | 'addedAt'>>;

/** Helper to determine the store from a universal game ID */
export function getStoreFromId(gameId: string): GameStore {
  if (gameId.startsWith('epic-')) return 'epic';
  if (gameId.startsWith('custom-')) return 'custom';
  return 'steam';
}

/** Helper to extract numeric Steam appId from a universal game ID */
export function getSteamAppIdFromId(gameId: string): number | null {
  if (gameId.startsWith('steam-')) {
    const num = parseInt(gameId.replace('steam-', ''), 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

/** Migrate a legacy numeric gameId to the new string format */
export function migrateGameId(entry: { gameId?: number | string; steamAppId?: number; igdbId?: number }): string {
  if (typeof entry.gameId === 'string') return entry.gameId; // already migrated
  if (typeof entry.gameId === 'number') {
    return entry.gameId < 0
      ? `custom-${Math.abs(entry.gameId)}`
      : `steam-${entry.gameId}`;
  }
  const fallback = entry.steamAppId || (entry as any).igdbId || 0;
  return fallback < 0 ? `custom-${Math.abs(fallback)}` : `steam-${fallback}`;
}

// Session tracking entry — records a play session detected via executable monitoring.
export interface GameSession {
  id: string;              // UUID
  gameId: string;          // Universal ID (e.g., "steam-730", "custom-1")
  executablePath: string;  // The exe that was tracked
  startTime: string;       // ISO timestamp
  endTime: string;         // ISO timestamp
  durationMinutes: number; // Active play time (raw - idle)
  idleMinutes: number;     // Total idle detected
}

// Status change log entry — records every status transition for tracking/analytics.
export interface StatusChangeEntry {
  gameId: string;               // Universal ID (e.g., "steam-730")
  title: string;                // Game title for readability
  previousStatus: GameStatus | null; // null when game is first added
  newStatus: GameStatus;
  timestamp: string;            // ISO date string
}

// Journey history entry — a snapshot persisted when a game is added to the library.
// Survives library removal so the Journey timeline always reflects the user's full history.
export interface JourneyEntry {
  gameId: string;             // Universal ID (e.g., "steam-730", "epic-fn:fortnite")
  title: string;
  coverUrl?: string;
  genre: string[];
  platform: string[];
  releaseDate?: string;
  status: GameStatus;         // Status at time of capture (updated on library changes)
  hoursPlayed: number;        // Synced while in library
  rating: number;             // Synced while in library
  firstPlayedAt?: string;     // ISO date — when status first became Playing (entry shows in that month)
  lastPlayedAt?: string;      // ISO date — last time the game was played (entry also shows in that month)
  addedAt: string;            // ISO date — when the game was first added to the library
  removedAt?: string;         // ISO date — set when the game is removed from the library
}
