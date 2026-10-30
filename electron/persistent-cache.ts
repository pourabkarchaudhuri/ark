/**
 * PersistentCache — Shared disk-backed cache with stale-while-revalidate strategy.
 *
 * Used by both steam-api.ts and epic-api.ts. Each consumer provides a unique
 * filename to avoid collisions (e.g., 'steam-cache.json', 'epic-cache.json').
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import { logger } from './safe-logger.js';
import { atomicWriteFileSync, atomicWriteFile } from './safe-write.js';

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

/** Entries with a TTL at least this long (app list, tag list, catalog crawls) always persist. */
const LONG_LIVED_TTL = 60 * 60 * 1000;

/** Debounce for disk saves — each save stringifies the whole cache on the main thread. */
const SAVE_DEBOUNCE_MS = 15_000;

/**
 * Max time a dirty cache waits for a save. A trailing-only debounce never fired
 * during a long burst of sets, so a crash lost the whole burst.
 */
const SAVE_MAX_WAIT_MS = 60_000;

/**
 * Hard expiry: STALE_TTL, or the entry's own TTL when longer. Using STALE_TTL alone
 * threw away the 7-day tag list (and similar) after a day, forcing refetches.
 */
const expiresAfter = (e: CacheEntry<unknown>) => Math.max(STALE_TTL, e.ttl);

/**
 * Entries to write: every unexpired long-lived entry plus the newest short-lived ones.
 * A plain `.slice(-500)` by insertion order used to push the app list (set once a day)
 * off disk after a few hundred detail fetches, so it was refetched every launch.
 */
function entriesToPersist(store: Map<string, CacheEntry<unknown>>): Array<[string, CacheEntry<unknown>]> {
  const now = Date.now();
  const live = Array.from(store.entries()).filter(([, e]) => now - e.timestamp < expiresAfter(e));
  const long = live.filter(([, e]) => e.ttl >= LONG_LIVED_TTL);
  const short = live.filter(([, e]) => e.ttl < LONG_LIVED_TTL).slice(-Math.max(0, MAX_CACHE_SIZE - long.length));
  return [...long, ...short];
}

// ---------------------------------------------------------------------------
// PersistentCache class
// ---------------------------------------------------------------------------

export class PersistentCache {
  private memoryStore: Map<string, CacheEntry<unknown>> = new Map();
  private cacheFilePath: string;
  /**
   * Bumped by every mutation; `savedVersion` is the newest version known to be on disk.
   * A plain isDirty flag was cleared by an async save that finished after a newer set(),
   * so that set was never written (and flushSync couldn't skip clean caches safely).
   */
  private version = 0;
  private savedVersion = 0;
  private saveTimeout: NodeJS.Timeout | null = null;
  /** When the pending debounced save was first armed (for SAVE_MAX_WAIT_MS). */
  private firstDirtyAt = 0;
  private loaded = false;
  private label: string;

  constructor(filename: string = 'cache.json') {
    const userDataPath = app?.getPath('userData') || './cache';
    this.cacheFilePath = path.join(userDataPath, filename);
    this.label = filename.replace('.json', '');
  }

  private get isDirty(): boolean {
    return this.version !== this.savedVersion;
  }

  /**
   * Load from disk on first use rather than at construction: the caches are created at
   * module import, before the window exists, and the sync read + parse blocked startup.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(data);

        let loadedCount = 0;
        for (const [key, entry] of Object.entries(parsed)) {
          const cacheEntry = entry as CacheEntry<unknown>;
          if (Date.now() - cacheEntry.timestamp < expiresAfter(cacheEntry)) {
            this.memoryStore.set(key, cacheEntry);
            loadedCount++;
          }
        }
        logger.log(`[Cache:${this.label}] Loaded ${loadedCount} entries from disk`);
      }
    } catch (error) {
      logger.warn(`[Cache:${this.label}] Failed to load disk cache:`, error);
    }
  }

  private serialize(): { json: string; count: number } {
    const entries = entriesToPersist(this.memoryStore);
    const obj: Record<string, CacheEntry<unknown>> = {};
    for (const [key, value] of entries) obj[key] = value;
    return { json: JSON.stringify(obj), count: entries.length };
  }

  /**
   * Schedule a disk save: debounced by SAVE_DEBOUNCE_MS, but never later than
   * SAVE_MAX_WAIT_MS after the first unsaved change.
   */
  private saveToDisk(): void {
    let delay = SAVE_DEBOUNCE_MS;
    if (this.saveTimeout) {
      const elapsed = Date.now() - this.firstDirtyAt;
      if (elapsed >= SAVE_MAX_WAIT_MS) return; // overdue save is about to fire — don't push it back
      clearTimeout(this.saveTimeout);
      delay = Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed);
    } else {
      this.firstDirtyAt = Date.now();
    }

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.firstDirtyAt = 0;
      try {
        const v = this.version;
        const { json, count } = this.serialize();
        atomicWriteFile(
          this.cacheFilePath,
          json,
          (err) => {
            if (err) {
              // Stays dirty: the next save (or the quit flush) retries
              logger.error(`[Cache:${this.label}] Failed to save disk cache:`, err);
            } else {
              this.savedVersion = Math.max(this.savedVersion, v);
              logger.log(`[Cache:${this.label}] Saved ${count} entries to disk`);
            }
          },
          // A flushSync that ran while this write was in flight already put newer data on disk
          () => this.savedVersion < v,
        );
      } catch (error) {
        logger.error(`[Cache:${this.label}] Failed to save disk cache:`, error);
      }
    }, delay);
  }

  private markChanged(): void {
    this.version++;
    this.saveToDisk();
  }

  /**
   * Bring the store back under MAX_MEMORY_SIZE. Fully expired entries go first, then the
   * oldest short-lived ones; long-lived entries (app list, tag list, catalog crawls) are
   * only evicted when they alone exceed the cap. Plain write-order eviction dropped the
   * long-lived entries after a long browsing session, forcing big re-downloads.
   */
  private evictOverCap(): void {
    const store = this.memoryStore;
    if (store.size <= MAX_MEMORY_SIZE) return;
    const now = Date.now();
    for (const [k, e] of store) {
      if (now - e.timestamp > expiresAfter(e)) store.delete(k);
    }
    for (const [k, e] of store) {
      if (store.size <= MAX_MEMORY_SIZE) return;
      if (e.ttl < LONG_LIVED_TTL) store.delete(k);
    }
    for (const k of store.keys()) {
      if (store.size <= MAX_MEMORY_SIZE) return;
      store.delete(k);
    }
  }

  set<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
    this.ensureLoaded();
    // Re-insert so Map order tracks recency (Map.set on an existing key keeps its old slot)
    this.memoryStore.delete(key);
    this.memoryStore.set(key, { data, timestamp: Date.now(), ttl });
    this.evictOverCap();
    this.markChanged();
  }

  /** Remove one entry. */
  delete(key: string): void {
    this.ensureLoaded();
    if (this.memoryStore.delete(key)) this.markChanged();
  }

  /**
   * Get cached data
   * @param allowStale — If true, returns stale data (useful for stale-while-revalidate)
   */
  get<T>(key: string, allowStale: boolean = false): T | null {
    this.ensureLoaded();
    const entry = this.memoryStore.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;

    // Fresh data
    if (age <= entry.ttl) {
      return entry.data as T;
    }

    // Stale but usable
    if (allowStale && age <= expiresAfter(entry)) {
      return entry.data as T;
    }

    // Completely expired
    if (age > expiresAfter(entry)) {
      this.memoryStore.delete(key);
    }

    return null;
  }

  /** Check if key exists and is fresh (within normal TTL) */
  has(key: string): boolean {
    this.ensureLoaded();
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    return Date.now() - entry.timestamp <= entry.ttl;
  }

  /** Check if key exists (even if stale, within STALE_TTL) */
  hasStale(key: string): boolean {
    this.ensureLoaded();
    const entry = this.memoryStore.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > expiresAfter(entry)) {
      this.memoryStore.delete(key);
      return false;
    }
    return true;
  }

  /** Check if cached data is stale (exists but beyond normal TTL) */
  isStale(key: string): boolean {
    this.ensureLoaded();
    const entry = this.memoryStore.get(key);
    if (!entry) return true;
    return Date.now() - entry.timestamp > entry.ttl;
  }

  clear(): void {
    this.loaded = true; // nothing on disk is wanted any more
    this.memoryStore.clear();
    this.markChanged();
  }

  /**
   * Synchronously flush dirty cache to disk (for use in before-quit).
   * Bypasses the debounce timer so nothing is lost on shutdown; a clean cache is
   * not rewritten (re-serializing the big Steam/Epic caches slowed every quit).
   */
  flushSync(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
      this.firstDirtyAt = 0;
    }
    this.ensureLoaded(); // never write an unloaded (empty) map over the file
    if (!this.isDirty) return;
    try {
      const v = this.version;
      const { json, count } = this.serialize();
      atomicWriteFileSync(this.cacheFilePath, json);
      this.savedVersion = v;
      logger.log(`[Cache:${this.label}] flushSync — saved ${count} entries`);
    } catch (err) {
      logger.error(`[Cache:${this.label}] flushSync failed:`, err);
    }
  }

  /** Get cache statistics */
  getStats(): { total: number; fresh: number; stale: number } {
    this.ensureLoaded();
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
