/**
 * Embedding Service (Renderer Side)
 *
 * Manages semantic embeddings for the recommendation engine:
 *  - Checks if Ollama is available via IPC
 *  - Generates embeddings for games (user library + candidates)
 *  - Caches embeddings in IndexedDB so they persist across sessions
 *  - Injects the embedding cache into reco-store before each compute
 *
 * Graceful degradation: if Ollama is unavailable, all methods return
 * cleanly and the recommendation engine runs without embeddings.
 */

import { setEmbeddingCache } from './reco-store';

// ─── Types ─────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    ollama?: {
      healthCheck: () => Promise<{ running: boolean; version: string | null }>;
      setup: () => Promise<{
        ollamaDetected: boolean;
        ollamaVersion: string | null;
        embeddingModelReady: boolean;
        error: string | null;
      }>;
      generateEmbedding: (text: string) => Promise<number[] | null>;
      generateEmbeddings: (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>;
    };
  }
}

interface CachedEmbedding {
  gameId: string;
  embedding: number[];
  textHash: string;
  timestamp: number;
}

// ─── IDB Helpers ───────────────────────────────────────────────────────────────

const DB_NAME = 'ark-embeddings';
const DB_VERSION = 1;
const STORE_NAME = 'embeddings';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'gameId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function getCachedEmbeddings(): Promise<Map<string, CachedEmbedding>> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const map = new Map<string, CachedEmbedding>();
      const now = Date.now();
      for (const entry of (req.result as CachedEmbedding[])) {
        if (now - entry.timestamp < CACHE_TTL) {
          map.set(entry.gameId, entry);
        }
      }
      db.close();
      resolve(map);
    };
    req.onerror = () => {
      db.close();
      resolve(new Map());
    };
  });
}

async function saveCachedEmbeddings(entries: CachedEmbedding[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const entry of entries) {
      store.put(entry);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}

// ─── Text Hashing (simple djb2) ────────────────────────────────────────────────

function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(36);
}

/**
 * Build the embedding text for a game.
 * v3 enrichment: includes summary/description and user notes when available
 * for much richer semantic understanding.
 */
function buildEmbeddingText(game: {
  title: string;
  genres?: string[];
  themes?: string[];
  developer?: string;
  summary?: string;
  description?: string;
  userNotes?: string;
}): string {
  const parts = [game.title];
  if (game.genres?.length) parts.push(`genres: ${game.genres.join(', ')}`);
  if (game.themes?.length) parts.push(`themes: ${game.themes.join(', ')}`);
  if (game.developer) parts.push(`by ${game.developer}`);
  // v3: include summary/description for richer embeddings (truncated to keep token count sane)
  if (game.summary) parts.push(game.summary.slice(0, 300));
  if (game.description && !game.summary) parts.push(game.description.slice(0, 300));
  // v3: include user's personal notes for personalized embeddings
  if (game.userNotes) parts.push(`player notes: ${game.userNotes.slice(0, 200)}`);
  return parts.join('. ');
}

// ─── Embedding Service ─────────────────────────────────────────────────────────

class EmbeddingService {
  private ollamaAvailable: boolean | null = null;
  private embeddingModelReady = false;
  private _embeddingsLoaded = false;
  private _loadedCount = 0;

  /** Number of embeddings currently loaded (survives across component mounts). */
  get loadedCount(): number {
    return this._loadedCount;
  }

  /**
   * Check if Ollama is available and has the embedding model.
   * Returns true if embeddings can be generated.
   */
  async isAvailable(): Promise<boolean> {
    if (this.ollamaAvailable !== null) return this.ollamaAvailable && this.embeddingModelReady;

    try {
      if (!window.ollama) {
        this.ollamaAvailable = false;
        return false;
      }

      const health = await window.ollama.healthCheck();
      this.ollamaAvailable = health.running;

      if (!health.running) {
        console.log('[EmbeddingService] Ollama not available — running without embeddings');
        return false;
      }

      // Run setup to ensure model is pulled
      const setup = await window.ollama.setup();
      this.embeddingModelReady = setup.embeddingModelReady;

      if (!setup.embeddingModelReady) {
        console.log('[EmbeddingService] Embedding model not ready:', setup.error);
        return false;
      }

      console.log(`[EmbeddingService] Ollama v${setup.ollamaVersion} ready with embedding model`);
      return true;
    } catch (err) {
      console.warn('[EmbeddingService] Error checking availability:', err);
      this.ollamaAvailable = false;
      return false;
    }
  }

  /**
   * Load cached embeddings from IDB and inject them into the reco-store.
   * Returns the number of cached embeddings found.
   *
   * Skips the IDB read if embeddings were already loaded in this session
   * (avoids redundant IDB reads on refresh).
   */
  async loadCachedEmbeddings(forceReload = false): Promise<number> {
    if (this._embeddingsLoaded && !forceReload) {
      return this._loadedCount;
    }

    try {
      const cached = await getCachedEmbeddings();
      if (cached.size === 0) {
        this._embeddingsLoaded = true;
        this._loadedCount = 0;
        return 0;
      }

      const embeddingMap = new Map<string, number[]>();
      for (const [gameId, entry] of cached) {
        embeddingMap.set(gameId, entry.embedding);
      }

      setEmbeddingCache(embeddingMap);
      this._embeddingsLoaded = true;
      this._loadedCount = embeddingMap.size;
      console.log(`[EmbeddingService] Loaded ${embeddingMap.size} cached embeddings`);
      return embeddingMap.size;
    } catch (err) {
      console.warn('[EmbeddingService] Failed to load cached embeddings:', err);
      this._embeddingsLoaded = true;
      this._loadedCount = 0;
      return 0;
    }
  }

  /**
   * Generate embeddings for a batch of games that don't have cached embeddings.
   * Automatically updates the reco-store embedding cache.
   *
   * @param games Array of games with id, title, genres, themes, developer
   * @param onProgress Optional progress callback
   * @returns Number of new embeddings generated
   */
  async generateMissing(
    games: Array<{
      id: string;
      title: string;
      genres?: string[];
      themes?: string[];
      developer?: string;
      summary?: string;
      description?: string;
      userNotes?: string;
    }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    if (!(await this.isAvailable())) return 0;
    if (games.length === 0) return 0;

    try {
      // Load existing cache
      const cached = await getCachedEmbeddings();

      // Filter out games that already have valid embeddings
      const needsEmbedding: Array<{ id: string; text: string; hash: string }> = [];

      for (const game of games) {
        const text = buildEmbeddingText(game);
        const hash = hashText(text);
        const existing = cached.get(game.id);

        if (existing && existing.textHash === hash) {
          continue; // Already have a current embedding
        }

        needsEmbedding.push({ id: game.id, text, hash });
      }

      if (needsEmbedding.length === 0) {
        console.log('[EmbeddingService] All embeddings already cached');
        return 0;
      }

      console.log(`[EmbeddingService] Generating ${needsEmbedding.length} new embeddings...`);

      // Batch generate via IPC
      const BATCH_SIZE = 100;
      const newEntries: CachedEmbedding[] = [];
      let completed = 0;

      for (let i = 0; i < needsEmbedding.length; i += BATCH_SIZE) {
        const batch = needsEmbedding.slice(i, i + BATCH_SIZE);
        const items = batch.map(b => ({ id: b.id, text: b.text }));

        const results = await window.ollama!.generateEmbeddings(items);

        for (const item of batch) {
          if (results[item.id]) {
            newEntries.push({
              gameId: item.id,
              embedding: results[item.id],
              textHash: item.hash,
              timestamp: Date.now(),
            });
          }
        }

        completed += batch.length;
        onProgress?.(completed, needsEmbedding.length);
      }

      // Save to IDB
      await saveCachedEmbeddings(newEntries);

      // Update reco-store cache
      const embeddingMap = new Map<string, number[]>();
      for (const [gameId, entry] of cached) {
        embeddingMap.set(gameId, entry.embedding);
      }
      for (const entry of newEntries) {
        embeddingMap.set(entry.gameId, entry.embedding);
      }
      setEmbeddingCache(embeddingMap);

      console.log(`[EmbeddingService] Generated ${newEntries.length} new embeddings, total cached: ${embeddingMap.size}`);
      return newEntries.length;
    } catch (err) {
      console.warn('[EmbeddingService] Error generating embeddings:', err);
      return 0;
    }
  }

  /** Reset availability check (e.g. after user changes Ollama settings). */
  resetAvailability() {
    this.ollamaAvailable = null;
    this.embeddingModelReady = false;
    this._embeddingsLoaded = false;
    this._loadedCount = 0;
  }
}

// Singleton
export const embeddingService = new EmbeddingService();
