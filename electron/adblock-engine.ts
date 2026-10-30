/**
 * Ad-block engine lifecycle: cached engine load, filter-list download, weekly refresh.
 *
 * The cache used to be a single `adblocker-engine.bin` used forever once it existed,
 * so filter lists stayed at their first-install contents. Worse, if deserialize threw
 * (library bump changing ENGINE_VERSION, or a file truncated by a crash mid-write) the
 * whole init bailed before the request handler was registered and the bad file was
 * never deleted — tracker blocking silently stayed off on every launch.
 *
 * Now: the file name carries the engine version (older files are removed), a bad cache
 * is unlinked and rebuilt in the same launch, writes are atomic, list fetches check
 * `ok`, and a cache older than ADBLOCK_REFRESH_AGE_MS is used at once and replaced by a
 * background refresh (the old engine stays on failure). All I/O is injected for tests.
 */

import path from 'path';
import { logger } from './safe-logger.js';

export const FILTER_LIST_URLS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
];

/** A cache older than this is refreshed in the background after startup. */
export const ADBLOCK_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Delay before the background refresh, so it doesn't compete with startup work. */
export const ADBLOCK_REFRESH_DELAY_MS = 60_000;

/** Same budget the first-run download always had. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

const CACHE_FILE_RE = /^adblocker-engine.*\.bin(\.tmp)?$/;

export function adblockCachePath(dir: string, engineVersion: string | number): string {
  return path.join(dir, `adblocker-engine-${engineVersion}.bin`);
}

export interface AdblockFs {
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  stat(p: string): Promise<{ mtimeMs: number }>;
  readdir(dir: string): Promise<string[]>;
}

export interface AdblockDeps<E> {
  dir: string;
  engineVersion: string | number;
  fs: AdblockFs;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  parse: (lists: string) => E;
  deserialize: (buf: Uint8Array) => E;
  serialize: (engine: E) => Uint8Array;
  now: () => number;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T | null>;
  /** Run `fn` later (main: an unref'd setTimeout). */
  schedule: (fn: () => Promise<void>, ms: number) => void;
}

/** Best-effort removal of cache files from other engine versions (and stray temps). */
async function removeStaleCacheFiles<E>(deps: AdblockDeps<E>, keep: string): Promise<void> {
  try {
    const names = await deps.fs.readdir(deps.dir);
    for (const name of names) {
      if (!CACHE_FILE_RE.test(name) || name === keep) continue;
      await deps.fs.unlink(path.join(deps.dir, name)).catch(() => { /* best-effort */ });
    }
  } catch { /* best-effort */ }
}

/** Cached engine and its age, or null (missing / unreadable — a bad file is deleted). */
async function loadCached<E>(deps: AdblockDeps<E>, cachePath: string): Promise<{ engine: E; ageMs: number } | null> {
  let buf: Uint8Array;
  let mtimeMs: number;
  try {
    mtimeMs = (await deps.fs.stat(cachePath)).mtimeMs;
    buf = await deps.fs.readFile(cachePath);
  } catch {
    return null;
  }
  try {
    return { engine: deps.deserialize(buf), ageMs: deps.now() - mtimeMs };
  } catch (err) {
    logger.warn('[AdBlocker] Cached engine unreadable — rebuilding:', err);
    await deps.fs.unlink(cachePath).catch(() => { /* best-effort */ });
    return null;
  }
}

/** Download + parse the lists and cache the engine atomically. Null on any failure. */
async function buildEngine<E>(deps: AdblockDeps<E>, cachePath: string): Promise<E | null> {
  try {
    const lists = await deps.withTimeout(
      Promise.all(FILTER_LIST_URLS.map(async (url) => {
        const r = await deps.fetch(url);
        if (!r.ok) throw new Error(`filter list ${url} returned HTTP ${r.status}`);
        return r.text();
      })),
      DOWNLOAD_TIMEOUT_MS,
      'Ad blocker filter download',
    );
    if (!lists) {
      logger.warn('[AdBlocker] Filter download timed out');
      return null;
    }
    const engine = deps.parse(lists.join('\n'));
    try {
      const tmp = `${cachePath}.tmp`;
      await deps.fs.writeFile(tmp, deps.serialize(engine));
      await deps.fs.rename(tmp, cachePath);
    } catch (err) {
      logger.warn('[AdBlocker] Failed to cache engine (non-fatal):', err);
    }
    return engine;
  } catch (err) {
    logger.warn('[AdBlocker] Filter download failed:', err);
    return null;
  }
}

/**
 * Load (or build) the engine and hand it to `onEngine`; called again with a newer
 * engine after a successful background refresh. Never throws.
 */
export async function initAdblockEngine<E>(deps: AdblockDeps<E>, onEngine: (engine: E) => void): Promise<void> {
  const cachePath = adblockCachePath(deps.dir, deps.engineVersion);
  await removeStaleCacheFiles(deps, path.basename(cachePath));

  const cached = await loadCached(deps, cachePath);
  if (cached) {
    onEngine(cached.engine);
    logger.log('[AdBlocker] Loaded engine from cache');
    if (cached.ageMs > ADBLOCK_REFRESH_AGE_MS) {
      deps.schedule(async () => {
        const fresh = await buildEngine(deps, cachePath);
        if (fresh) {
          onEngine(fresh);
          logger.log('[AdBlocker] Filter lists refreshed');
        } else {
          logger.warn('[AdBlocker] Background refresh failed — keeping the cached engine');
        }
      }, ADBLOCK_REFRESH_DELAY_MS);
    }
    return;
  }

  const engine = await buildEngine(deps, cachePath);
  if (engine) {
    onEngine(engine);
    logger.log('[AdBlocker] Downloaded filter lists and cached engine');
  } else {
    logger.warn('[AdBlocker] Skipping — no engine this launch');
  }
}
