/**
 * Storage for the full Steam app list (~155k entries, ~7 MB).
 *
 * It used to live in steam-cache.json, so it was parsed synchronously at module
 * import (before the window existed) and re-stringified by every debounced cache
 * save and every quit flush. It now has its own file, written only when the list
 * is refreshed and read lazily (async, once) on the first getAppList().
 */

import { logger } from './safe-logger.js';

export interface AppListEntry {
  appid: number;
  name: string;
}

export interface AppListFile {
  /** ms epoch of the fetch; 0 = unknown age (migrated) → treated as stale. */
  savedAt: number;
  apps: AppListEntry[];
}

/** The PersistentCache key the list was stored under before it moved out. */
export const LEGACY_APP_LIST_KEY = 'full-app-list-v2';

export interface AppListStoreDeps {
  filePath: string;
  readFile: (filePath: string) => Promise<string>;
  /** Should be atomic (temp + rename). */
  writeFile: (filePath: string, data: string) => Promise<void>;
  /** Old home of the list (steam-cache.json); migrated once, then the key is removed. */
  legacy?: {
    get<T>(key: string, allowStale?: boolean): T | null;
    delete(key: string): void;
  };
  now: () => number;
}

function isAppListFile(v: unknown): v is AppListFile {
  const f = v as AppListFile;
  return !!f && typeof f.savedAt === 'number' && Array.isArray(f.apps);
}

export class SteamAppListStore {
  private loadPromise: Promise<AppListFile | null> | null = null;
  private current: AppListFile | null = null;

  constructor(private readonly deps: AppListStoreDeps) {}

  /** Memoised: the file is read at most once per process. */
  load(): Promise<AppListFile | null> {
    return this.loadPromise ??= this.loadOnce();
  }

  private async loadOnce(): Promise<AppListFile | null> {
    try {
      const parsed: unknown = JSON.parse(await this.deps.readFile(this.deps.filePath));
      if (isAppListFile(parsed)) this.current = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn('[Steam] App list file unreadable — will refetch:', err);
      }
    }

    // One-time migration out of steam-cache.json
    const legacy = this.deps.legacy;
    if (legacy) {
      try {
        const old = legacy.get<AppListEntry[]>(LEGACY_APP_LIST_KEY, true);
        if (!this.current && Array.isArray(old) && old.length > 0) {
          this.current = { savedAt: 0, apps: old };
          await this.write(this.current);
          logger.log(`[Steam] Migrated app list (${old.length} apps) out of steam-cache.json`);
        }
        legacy.delete(LEGACY_APP_LIST_KEY);
      } catch (err) {
        logger.warn('[Steam] App list migration failed (list will be refetched):', err);
      }
    }
    return this.current;
  }

  /** Replace the stored list. Never throws: a failed write only costs a refetch next launch. */
  async save(apps: AppListEntry[]): Promise<void> {
    this.current = { savedAt: this.deps.now(), apps };
    this.loadPromise = Promise.resolve(this.current);
    await this.write(this.current);
  }

  private async write(file: AppListFile): Promise<void> {
    try {
      await this.deps.writeFile(this.deps.filePath, JSON.stringify(file));
    } catch (err) {
      logger.warn('[Steam] Failed to write app list file:', err);
    }
  }
}
