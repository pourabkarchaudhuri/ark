/**
 * PersistentCache — Shared disk-backed cache with stale-while-revalidate strategy.
 *
 * Used by both steam-api.ts and epic-api.ts. Each consumer provides a unique
 * filename to avoid collisions (e.g., 'steam-cache.json', 'epic-cache.json').
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const { app } = electron;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Data older than this is completely expired and evicted */
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum number of entries to persist to disk */
const MAX_CACHE_SIZE = 500;

/** Maximum in-memory entries (disk cap is MAX_CACHE_SIZE, memory can be higher
 *  but we still evict to prevent unbounded growth during long sessions) */
const MAX_MEMORY_SIZE = 2_000;

/** Default TTL for fresh data (5 minutes) */
const DEFAULT_TTL = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// PersistentCache class
// ---------------------------------------------------------------------------

export class PersistentCache {
  private memoryStore: Map<string, CacheEntry<unknown>> = new Map();
  private cacheFilePath: string;
  private isDirty: boolean = false;
  private saveTimeout: NodeJS.Timeout | null = null;
  private label: string;

  constructor(filename: string = 'cache.json') {
    const userDataPath = app?.getPath('userData') || './cache';
    this.cacheFilePath = path.join(userDataPath, filename);
    this.label = filename.replace('.json', '');
    this.loadFromDisk();
  }

  /**
   * Load cache from disk on startup
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(data);

        let loadedCount = 0;
        for (const [key, entry] of Object.entries(parsed)) {
          const cacheEntry = entry as CacheEntry<unknown>;
          if (Date.now() - cacheEntry.timestamp < STALE_TTL) {
            this.memoryStore.set(key, cacheEntry);
            loadedCount++;
          }
        }
        console.log(`[Cache:${this.label}] Loaded ${loadedCount} entries from disk`);
      }
    } catch (error) {
      console.warn(`[Cache:${this.label}] Failed to load disk cache:`, error);
    }
  }

  /**
   * Save cache to disk (debounced by 5 seconds)
   */
  private saveToDisk(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      try {
        const entries = Array.from(this.memoryStore.entries())
          .filter(([, entry]) => Date.now() - entry.timestamp < STALE_TTL)
          .slice(-MAX_CACHE_SIZE);

        const obj: Record<string, CacheEntry<unknown>> = {};
        for (const [key, value] of entries) {
          obj[key] = value;
        }

        const json = JSON.stringify(obj);
        fs.writeFile(this.cacheFilePath, json, 'utf-8', (err) => {
          if (err) {
            console.error(`[Cache:${this.label}] Failed to save disk cache:`, err);
          } else {
            console.log(`[Cache:${this.label}] Saved ${entries.length} entries to disk`);
          }
        });
        this.isDirty = false;
      } catch (error) {
        console.error(`[Cache:${this.label}] Failed to save disk cache:`, error);
      }
    }, 5000);
  }

  set<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
    this.memoryStore.set(key, { data, timestamp: Date.now(), ttl });

    // Evict oldest in-memory entries when over the cap
    if (this.memoryStore.size > MAX_MEMORY_SIZE) {
      const excess = this.memoryStore.size - MAX_MEMORY_SIZE;
      let removed = 0;
      for (const k of this.memoryStore.keys()) {
        if (removed >= excess) break;
        this.memoryStore.delete(k);
        removed++;
      }
    }

    this.isDirty = true;
    this.saveToDisk();
  }

  /**
   * Get cached data
   * @param allowStale — If true, returns stale data (useful for stale-while-revalidate)
   */
  get<T>(key: string, allowStale: boolean = false): T | null {
    const entry = this.memoryStore.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;

    // Fresh data
    if (age <= entry.ttl) {
      return entry.data as T;
    }

    // Stale but usable
    if (allowStale && age <= STALE_TTL) {
      return entry.data as T;
    }

    // Completely expired
    if (age > STALE_TTL) {
      this.memoryStore.delete(key);
    }

    return null;
  }

  /** Check if key exists and is fresh (within normal TTL) */
  has(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    return Date.now() - entry.timestamp <= entry.ttl;
  }

  /** Check if key exists (even if stale, within STALE_TTL) */
  hasStale(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > STALE_TTL) {
      this.memoryStore.delete(key);
      return false;
    }
    return true;
  }

  /** Check if cached data is stale (exists but beyond normal TTL) */
  isStale(key: string): boolean {
    const entry = this.memoryStore.get(key);
    if (!entry) return true;
    return Date.now() - entry.timestamp > entry.ttl;
  }

  clear(): void {
    this.memoryStore.clear();
    this.isDirty = true;
    this.saveToDisk();
  }

  /** Get cache statistics */
  getStats(): { total: number; fresh: number; stale: number } {
    let fresh = 0;
    let stale = 0;

    for (const entry of this.memoryStore.values()) {
      const age = Date.now() - entry.timestamp;
      if (age <= entry.ttl) {
        fresh++;
      } else if (age <= STALE_TTL) {
        stale++;
      }
    }

    return { total: this.memoryStore.size, fresh, stale };
  }
}
