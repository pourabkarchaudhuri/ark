import {
  CustomGameEntry,
  CreateCustomGameEntry,
  UpdateCustomGameEntry,
  Game,
} from '@/types/game';

const STORAGE_KEY = 'ark-custom-games';
const STORAGE_VERSION = 1;

interface StoredData {
  version: number;
  entries: CustomGameEntry[];
  nextId: number; // Counter for generating negative IDs
  lastUpdated: string;
}

/**
 * Custom Game Store - Manages user-created games not from IGDB
 * Uses negative IDs to distinguish from IGDB games
 */
class CustomGameStore {
  private entries: Map<number, CustomGameEntry> = new Map(); // keyed by custom game id (negative)
  private nextId: number = -1; // Start from -1, decrement for each new game
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;

  constructor() {
    this.initialize();
  }

  private initialize() {
    if (this.isInitialized) return;

    try {
      const stored = this.loadFromStorage();
      if (stored) {
        stored.entries.forEach((entry) => {
          this.entries.set(entry.id, {
            ...entry,
            addedAt: new Date(entry.addedAt),
            updatedAt: new Date(entry.updatedAt),
          });
        });
        this.nextId = stored.nextId;
      }
    } catch (error) {
      console.error('Failed to load custom games data:', error);
    }

    this.isInitialized = true;
  }

  private loadFromStorage(): StoredData | null {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;

      const parsed = JSON.parse(data) as StoredData;
      if (parsed.version !== STORAGE_VERSION) {
        console.log('Custom games storage version mismatch, resetting data');
        return null;
      }

      return parsed;
    } catch (error) {
      console.error('Failed to parse custom games data:', error);
      return null;
    }
  }

  private saveToStorage() {
    try {
      const data: StoredData = {
        version: STORAGE_VERSION,
        entries: Array.from(this.entries.values()),
        nextId: this.nextId,
        lastUpdated: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save custom games to storage:', error);
    }
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }

  // Add a custom game
  addGame(input: CreateCustomGameEntry): CustomGameEntry {
    const now = new Date();
    const id = this.nextId--;
    
    const entry: CustomGameEntry = {
      id,
      title: input.title,
      platform: input.platform,
      status: input.status,
      addedAt: now,
      updatedAt: now,
    };

    this.entries.set(id, entry);
    this.saveToStorage();
    this.notifyListeners();
    return entry;
  }

  // Remove a custom game
  removeGame(id: number): boolean {
    if (id >= 0) return false; // Only allow removing negative IDs (custom games)
    
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.saveToStorage();
      this.notifyListeners();
    }
    return deleted;
  }

  // Update a custom game
  updateGame(id: number, input: UpdateCustomGameEntry): CustomGameEntry | undefined {
    if (id >= 0) return undefined; // Only allow updating negative IDs
    
    const existing = this.entries.get(id);
    if (!existing) return undefined;

    const updated: CustomGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(),
    };

    this.entries.set(id, updated);
    this.saveToStorage();
    this.notifyListeners();
    return updated;
  }

  // Get a custom game by ID
  getGame(id: number): CustomGameEntry | undefined {
    return this.entries.get(id);
  }

  // Get all custom games
  getAllGames(): CustomGameEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
  }

  // Get count
  getCount(): number {
    return this.entries.size;
  }

  // Check if ID is a custom game
  isCustomGame(id: number): boolean {
    return id < 0;
  }

  // Convert custom game to Game type for display
  toGame(entry: CustomGameEntry): Game {
    return {
      id: `custom-${entry.id}`,
      igdbId: entry.id, // Negative ID indicates custom game
      title: entry.title,
      developer: 'Custom Entry',
      publisher: '',
      genre: [],
      platform: entry.platform,
      metacriticScore: null,
      releaseDate: '',
      summary: '',
      coverUrl: undefined,
      screenshots: [],
      status: entry.status,
      priority: 'Medium',
      publicReviews: '',
      recommendationSource: '',
      createdAt: entry.addedAt,
      updatedAt: entry.updatedAt,
      isInLibrary: true,
      isCustom: true,
    };
  }

  // Get all custom games as Game type
  getAllAsGames(): Game[] {
    return this.getAllGames().map((entry) => this.toGame(entry));
  }

  // Clear all custom games
  clear() {
    this.entries.clear();
    this.nextId = -1;
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton instance
export const customGameStore = new CustomGameStore();

