/**
 * IndexedDB Cache Store for offline support
 * Stores games, genres, platforms, and sync queue
 */

// Generic cached game/genre/platform types (formerly IGDB-specific)
interface CachedGame {
  id: string | number; // String for new format ("steam-730"), number for legacy
  name: string;
  [key: string]: unknown;
}

interface CachedGenre {
  id: number;
  name: string;
  slug?: string;
}

interface CachedPlatform {
  id: number;
  name: string;
  abbreviation?: string;
}

const DB_NAME = 'ark-game-cache';
const DB_VERSION = 2; // v2: game id keyPath now supports strings

// Store names
const STORES = {
  games: 'games',
  genres: 'genres',
  platforms: 'platforms',
  searchResults: 'searchResults',
  metadata: 'metadata',
  syncQueue: 'syncQueue',
} as const;

interface CacheMetadata {
  key: string;
  value: string | number;
  updatedAt: number;
}

interface SyncQueueItem {
  id: string;
  action: 'add' | 'remove' | 'update';
  gameId: string;
  data?: unknown;
  timestamp: number;
}

interface SearchCacheEntry {
  query: string;
  results: CachedGame[];
  cachedAt: number;
}

class CacheStore {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private listeners: Set<() => void> = new Set();
  
  // Cache expiration times (in milliseconds)
  private readonly GAME_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  private getDB(): Promise<IDBDatabase> {
    if (this.db) {
      return Promise.resolve(this.db);
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

        // v1 → v2: wipe games store (cache is disposable) to support string IDs
        if (oldVersion >= 1 && oldVersion < 2) {
          if (db.objectStoreNames.contains(STORES.games)) {
            db.deleteObjectStore(STORES.games);
          }
          if (db.objectStoreNames.contains(STORES.searchResults)) {
            db.deleteObjectStore(STORES.searchResults);
          }
        }

        // Games store - indexed by id (now supports string or number keys)
        if (!db.objectStoreNames.contains(STORES.games)) {
          const gamesStore = db.createObjectStore(STORES.games, { keyPath: 'id' });
          gamesStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }

        // Genres store
        if (!db.objectStoreNames.contains(STORES.genres)) {
          db.createObjectStore(STORES.genres, { keyPath: 'id' });
        }

        // Platforms store
        if (!db.objectStoreNames.contains(STORES.platforms)) {
          db.createObjectStore(STORES.platforms, { keyPath: 'id' });
        }

        // Search results cache
        if (!db.objectStoreNames.contains(STORES.searchResults)) {
          const searchStore = db.createObjectStore(STORES.searchResults, { keyPath: 'query' });
          searchStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }

        // Metadata store (last sync time, etc.)
        if (!db.objectStoreNames.contains(STORES.metadata)) {
          db.createObjectStore(STORES.metadata, { keyPath: 'key' });
        }

        // Sync queue for offline changes
        if (!db.objectStoreNames.contains(STORES.syncQueue)) {
          const syncStore = db.createObjectStore(STORES.syncQueue, { keyPath: 'id' });
          syncStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });

    return this.dbPromise;
  }

  // Subscribe to cache changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }

  // Game caching
  async cacheGame(game: CachedGame): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.games, 'readwrite');
      const store = transaction.objectStore(STORES.games);
      
      const gameWithMeta = {
        ...game,
        cachedAt: Date.now(),
      };
      
      const request = store.put(gameWithMeta);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.notify();
        resolve();
      };
    });
  }

  async cacheGames(games: CachedGame[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.games, 'readwrite');
      const store = transaction.objectStore(STORES.games);
      const now = Date.now();
      
      games.forEach(game => {
        store.put({ ...game, cachedAt: now });
      });
      
      transaction.oncomplete = () => {
        this.notify();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getGame(id: string | number): Promise<CachedGame | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.games, 'readonly');
      const store = transaction.objectStore(STORES.games);
      const request = store.get(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        if (result && this.isValidCache(result.cachedAt, this.GAME_CACHE_TTL)) {
          resolve(result);
        } else {
          resolve(null);
        }
      };
    });
  }

  async getGames(ids: (string | number)[]): Promise<CachedGame[]> {
    const db = await this.getDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORES.games, 'readonly');
      const store = transaction.objectStore(STORES.games);
      const results: CachedGame[] = [];
      
      let completed = 0;
      ids.forEach(id => {
        const request = store.get(id);
        request.onsuccess = () => {
          const result = request.result;
          if (result && this.isValidCache(result.cachedAt, this.GAME_CACHE_TTL)) {
            results.push(result);
          }
          completed++;
          if (completed === ids.length) {
            resolve(results);
          }
        };
        request.onerror = () => {
          completed++;
          if (completed === ids.length) {
            resolve(results);
          }
        };
      });
      
      if (ids.length === 0) resolve([]);
    });
  }

  async getAllCachedGames(): Promise<CachedGame[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.games, 'readonly');
      const store = transaction.objectStore(STORES.games);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const validGames = request.result.filter(
          (game: CachedGame & { cachedAt: number }) => 
            this.isValidCache(game.cachedAt, this.GAME_CACHE_TTL)
        );
        resolve(validGames);
      };
    });
  }

  // Search results caching
  async cacheSearchResults(query: string, results: CachedGame[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.searchResults, 'readwrite');
      const store = transaction.objectStore(STORES.searchResults);
      
      const entry: SearchCacheEntry = {
        query: query.toLowerCase(),
        results,
        cachedAt: Date.now(),
      };
      
      const request = store.put(entry);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getSearchResults(query: string): Promise<CachedGame[] | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.searchResults, 'readonly');
      const store = transaction.objectStore(STORES.searchResults);
      const request = store.get(query.toLowerCase());
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result as SearchCacheEntry | undefined;
        if (result && this.isValidCache(result.cachedAt, this.SEARCH_CACHE_TTL)) {
          resolve(result.results);
        } else {
          resolve(null);
        }
      };
    });
  }

  // Genres caching
  async cacheGenres(genres: CachedGenre[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.genres, 'readwrite');
      const store = transaction.objectStore(STORES.genres);
      
      // Clear and refill
      store.clear();
      genres.forEach(genre => store.put(genre));
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getGenres(): Promise<CachedGenre[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.genres, 'readonly');
      const store = transaction.objectStore(STORES.genres);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  // Platforms caching
  async cachePlatforms(platforms: CachedPlatform[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.platforms, 'readwrite');
      const store = transaction.objectStore(STORES.platforms);
      
      store.clear();
      platforms.forEach(platform => store.put(platform));
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getPlatforms(): Promise<CachedPlatform[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.platforms, 'readonly');
      const store = transaction.objectStore(STORES.platforms);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  // Sync queue for offline operations
  async addToSyncQueue(item: Omit<SyncQueueItem, 'timestamp'>): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.syncQueue, 'readwrite');
      const store = transaction.objectStore(STORES.syncQueue);
      
      const queueItem: SyncQueueItem = {
        ...item,
        timestamp: Date.now(),
      };
      
      const request = store.put(queueItem);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getSyncQueue(): Promise<SyncQueueItem[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.syncQueue, 'readonly');
      const store = transaction.objectStore(STORES.syncQueue);
      const index = store.index('timestamp');
      const request = index.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async clearSyncQueue(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.syncQueue, 'readwrite');
      const store = transaction.objectStore(STORES.syncQueue);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async removeSyncQueueItem(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.syncQueue, 'readwrite');
      const store = transaction.objectStore(STORES.syncQueue);
      const request = store.delete(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // Metadata
  async setMetadata(key: string, value: string | number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.metadata, 'readwrite');
      const store = transaction.objectStore(STORES.metadata);
      
      const metadata: CacheMetadata = { key, value, updatedAt: Date.now() };
      const request = store.put(metadata);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getMetadata(key: string): Promise<CacheMetadata | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.metadata, 'readonly');
      const store = transaction.objectStore(STORES.metadata);
      const request = store.get(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  // Utility methods
  private isValidCache(cachedAt: number, ttl: number): boolean {
    return Date.now() - cachedAt < ttl;
  }

  async clearExpiredCache(): Promise<void> {
    const db = await this.getDB();

    // Clear expired games
    const gamesTransaction = db.transaction(STORES.games, 'readwrite');
    const gamesStore = gamesTransaction.objectStore(STORES.games);
    const gamesCursor = gamesStore.openCursor();
    
    gamesCursor.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        if (!this.isValidCache(cursor.value.cachedAt, this.GAME_CACHE_TTL)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };

    // Clear expired search results
    const searchTransaction = db.transaction(STORES.searchResults, 'readwrite');
    const searchStore = searchTransaction.objectStore(STORES.searchResults);
    const searchCursor = searchStore.openCursor();
    
    searchCursor.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        if (!this.isValidCache(cursor.value.cachedAt, this.SEARCH_CACHE_TTL)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
  }

  async clearAll(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const storeNames = Object.values(STORES);
      const transaction = db.transaction(storeNames, 'readwrite');
      
      storeNames.forEach(name => {
        transaction.objectStore(name).clear();
      });
      
      transaction.oncomplete = () => {
        this.notify();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // Get cache statistics
  async getStats(): Promise<{ games: number; searches: number; syncQueue: number }> {
    const db = await this.getDB();
    return new Promise((resolve) => {
      const transaction = db.transaction([STORES.games, STORES.searchResults, STORES.syncQueue], 'readonly');
      
      let games = 0;
      let searches = 0;
      let syncQueue = 0;
      let completed = 0;
      
      const checkComplete = () => {
        completed++;
        if (completed === 3) {
          resolve({ games, searches, syncQueue });
        }
      };
      
      const gamesRequest = transaction.objectStore(STORES.games).count();
      gamesRequest.onsuccess = () => { games = gamesRequest.result; checkComplete(); };
      gamesRequest.onerror = checkComplete;
      
      const searchRequest = transaction.objectStore(STORES.searchResults).count();
      searchRequest.onsuccess = () => { searches = searchRequest.result; checkComplete(); };
      searchRequest.onerror = checkComplete;
      
      const syncRequest = transaction.objectStore(STORES.syncQueue).count();
      syncRequest.onsuccess = () => { syncQueue = syncRequest.result; checkComplete(); };
      syncRequest.onerror = checkComplete;
    });
  }
}

// Export singleton
export const cacheStore = new CacheStore();

