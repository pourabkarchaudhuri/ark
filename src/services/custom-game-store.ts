import {
  CustomGameEntry,
  CreateCustomGameEntry,
  UpdateCustomGameEntry,
  Game,
} from '@/types/game';
import { journeyStore } from '@/services/journey-store';

const STORAGE_KEY = 'ark-custom-games';
const STORAGE_VERSION = 2; // v2: id migrated from negative number to "custom-N" string

interface StoredData {
  version: number;
  entries: CustomGameEntry[];
  nextCounter: number; // Counter for generating custom IDs
  lastUpdated: string;
}

/**
 * Custom Game Store - Manages user-created games not from Steam/Epic
 * Uses "custom-N" string IDs to distinguish from store games
 */
class CustomGameStore {
  private entries: Map<string, CustomGameEntry> = new Map(); // keyed by "custom-N"
  private nextCounter: number = 1; // Start from 1, increment for each new game
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.initialize();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushSave());
    }
  }

  private scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveToStorage();
    }, 300);
  }

  private flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveToStorage();
    }
  }

  private initialize() {
    if (this.isInitialized) return;

    let needsResave = false;
    try {
      const stored = this.loadFromStorage();
      if (stored) {
        stored.entries.forEach((entry) => {
          // Migrate legacy negative numeric IDs to "custom-N" format
          const id = this.migrateId(entry.id);
          this.entries.set(id, {
            ...entry,
            id,
            addedAt: new Date(entry.addedAt),
            updatedAt: new Date(entry.updatedAt),
          });
        });
        if (stored.version < STORAGE_VERSION) {
          // Recalculate nextCounter from migrated entries
          let maxCounter = 0;
          for (const key of this.entries.keys()) {
            const num = parseInt(key.replace('custom-', ''), 10);
            if (!isNaN(num) && num > maxCounter) maxCounter = num;
          }
          this.nextCounter = maxCounter + 1;
          needsResave = true;
        } else {
          this.nextCounter = stored.nextCounter;
        }
      }
    } catch (error) {
      console.error('Failed to load custom games data:', error);
    }

    this.isInitialized = true;

    if (needsResave) {
      this.saveToStorage();
      console.log('[CustomGameStore] Migrated entries to v2 (string id)');
    }

    // Backfill: ensure custom games that are Playing, Playing Now, or Completed have a journey entry (so they appear in Your Ark / Logs)
    const arkStatuses: Array<'Playing' | 'Playing Now' | 'Completed'> = ['Playing', 'Playing Now', 'Completed'];
    for (const entry of this.entries.values()) {
      if (!arkStatuses.includes(entry.status as any) || journeyStore.has(entry.id)) continue;
      const addedAtIso = entry.addedAt instanceof Date ? entry.addedAt.toISOString() : String(entry.addedAt);
      const sortDate = entry.lastPlayedAt ?? addedAtIso;
      journeyStore.record({
        gameId: entry.id,
        title: entry.title,
        coverUrl: undefined,
        genre: [],
        platform: entry.platform,
        releaseDate: undefined,
        status: entry.status,
        hoursPlayed: entry.hoursPlayed ?? 0,
        rating: entry.rating ?? 0,
        firstPlayedAt: sortDate,
        lastPlayedAt: entry.lastPlayedAt ?? (entry.status === 'Completed' ? sortDate : undefined),
        addedAt: addedAtIso,
      });
    }
  }

  /** Migrate legacy negative numeric ID to "custom-N" string format */
  private migrateId(id: string | number): string {
    if (typeof id === 'string') {
      return id.startsWith('custom-') ? id : `custom-${id}`;
    }
    // Legacy negative numeric IDs: -1 → "custom-1", -2 → "custom-2"
    return `custom-${Math.abs(id)}`;
  }

  private loadFromStorage(): StoredData | null {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;

      const parsed = JSON.parse(data);
      // Accept v1 or v2 data (v1 will be migrated in initialize())
      if (!parsed.version || parsed.version < 1) {
        console.log('Custom games storage version too old, resetting data');
        return null;
      }

      return {
        version: parsed.version,
        entries: parsed.entries || [],
        nextCounter: parsed.nextCounter ?? Math.abs(parsed.nextId ?? -1),
        lastUpdated: parsed.lastUpdated,
      };
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
        nextCounter: this.nextCounter,
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
    const id = `custom-${this.nextCounter++}`;
    
    const entry: CustomGameEntry = {
      id,
      title: input.title,
      platform: input.platform,
      status: input.status,
      executablePath: input.executablePath,
      addedAt: now,
      updatedAt: now,
    };

    this.entries.set(id, entry);
    this.scheduleSave();
    this.notifyListeners();

    // Create journey entry when status is Playing, Playing Now, or Completed (so they appear in Your Ark / Logs)
    const showInArk = entry.status === 'Playing' || entry.status === 'Playing Now' || entry.status === 'Completed';
    if (showInArk) {
      const nowIso = new Date().toISOString();
      const addedAtIso = entry.addedAt instanceof Date ? entry.addedAt.toISOString() : String(entry.addedAt);
      const sortDate = entry.status === 'Completed' ? (entry.lastPlayedAt ?? addedAtIso ?? nowIso) : nowIso;
      journeyStore.record({
        gameId: id,
        title: entry.title,
        coverUrl: undefined,
        genre: [],
        platform: entry.platform,
        releaseDate: undefined,
        status: entry.status,
        hoursPlayed: entry.hoursPlayed ?? 0,
        rating: 0,
        firstPlayedAt: sortDate,
        lastPlayedAt: entry.lastPlayedAt ?? (entry.status === 'Completed' ? sortDate : undefined),
        addedAt: addedAtIso,
      });
    }

    return entry;
  }

  // Remove a custom game
  removeGame(id: string): boolean {
    if (!this.isCustomGame(id)) return false;
    
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.scheduleSave();
      this.notifyListeners();

      // Mark as removed in journey store (preserves history)
      journeyStore.markRemoved(id);
    }
    return deleted;
  }

  // Update a custom game
  updateGame(id: string, input: UpdateCustomGameEntry): CustomGameEntry | undefined {
    if (!this.isCustomGame(id)) return undefined;

    const existing = this.entries.get(id);
    if (!existing) return undefined;

    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const updatedStatus = input.status ?? existing.status;
    const isNowPlaying = updatedStatus === 'Playing' || updatedStatus === 'Playing Now';

    const updated: CustomGameEntry = {
      ...existing,
      ...input,
      updatedAt: new Date(),
    };

    this.entries.set(id, updated);
    this.scheduleSave();
    this.notifyListeners();

    const hasJourney = journeyStore.has(id);
    const addedAtIso = existing.addedAt instanceof Date ? existing.addedAt.toISOString() : String(existing.addedAt);
    const nowIso = new Date().toISOString();

    // Create journey entry when status first becomes Playing, Playing Now, or Completed (so they appear in Your Ark / Logs)
    if (statusChanged && isNowPlaying && !hasJourney) {
      journeyStore.record({
        gameId: id,
        title: updated.title,
        coverUrl: undefined,
        genre: [],
        platform: updated.platform,
        releaseDate: undefined,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        firstPlayedAt: nowIso,
        lastPlayedAt: updated.lastPlayedAt,
        addedAt: addedAtIso,
      });
    } else if (statusChanged && updatedStatus === 'Completed' && !hasJourney) {
      const sortDate = updated.lastPlayedAt ?? addedAtIso ?? nowIso;
      journeyStore.record({
        gameId: id,
        title: updated.title,
        coverUrl: undefined,
        genre: [],
        platform: updated.platform,
        releaseDate: undefined,
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        firstPlayedAt: sortDate,
        lastPlayedAt: updated.lastPlayedAt ?? sortDate,
        addedAt: addedAtIso,
      });
    } else {
      journeyStore.syncProgress(id, {
        status: updated.status,
        hoursPlayed: updated.hoursPlayed ?? 0,
        rating: updated.rating ?? 0,
        lastPlayedAt: updated.lastPlayedAt,
      });
    }

    return updated;
  }

  // Get a custom game by ID
  getGame(id: string): CustomGameEntry | undefined {
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
  isCustomGame(id: string | number): boolean {
    if (typeof id === 'string') return id.startsWith('custom-');
    return id < 0; // Legacy check
  }

  // Convert custom game to Game type for display
  toGame(entry: CustomGameEntry): Game {
    return {
      id: entry.id,
      store: 'custom',
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
      priority: entry.priority || 'Medium',
      publicReviews: entry.publicReviews || '',
      recommendationSource: entry.recommendationSource || '',
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
    this.nextCounter = 1;
    this.flushSave();
    localStorage.removeItem(STORAGE_KEY);
    this.notifyListeners();
  }
}

// Singleton instance
export const customGameStore = new CustomGameStore();
