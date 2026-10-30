/**
 * Transmissions decode history — which items have been opened in the Decode Bay.
 * Used to show "Already decoded" state on stream cards.
 *
 * v1.0.61+: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface (see `electron/ipc/store-handlers.ts`). The
 * public sync API is unchanged — an in-memory cache is hydrated on init and
 * every read still returns synchronously. When `window.store` is unavailable
 * (unit tests, jsdom, pre-preload boot window) the store transparently falls
 * back to the previous localStorage path.
 */

/** Legacy localStorage key — retained for boot-time hydrate + rollback. */
const STORAGE_KEY = 'ark-transmissions-decoded';
/** One-shot migration sentinel — stamped after the first successful copy. */
const MIGRATION_MARKER_KEY = 'ark-transmissions-decoded-migrated-v1';
/** LevelDB namespace this store owns. Keys within it are transmission ids. */
const LEVEL_NAMESPACE = 'transmissions-history';
/** Cap to avoid bloat. */
const MAX_IDS = 2000;

/** Gate flag captured once at module load — LevelDB path vs. legacy fallback. */
const _useLevelDB =
  typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';

/**
 * In-memory cache. Insertion order = decode age (oldest first), which is what
 * `_trimCache` evicts by. Each LevelDB row stores its decode time as the
 * value so that order survives a restart (rows come back in key order).
 */
let _cache: Set<string> = new Set();
/**
 * Set of ids currently persisted in LevelDB. On every write we diff `_cache`
 * against this to emit `del` ops for keys that disappeared (e.g. because they
 * were evicted by the MAX_IDS cap).
 */
let _knownKeys: Set<string> = new Set();
let _isInitialized = false;

/** Best-effort feature detect for the preload-exposed LevelDB bridge. */
type StoreBridge = NonNullable<Window['store']>;
function getStore(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  return window.store ?? null;
}

/** Trim the cache to at most MAX_IDS by dropping oldest-inserted entries. */
function _trimCache(): void {
  while (_cache.size > MAX_IDS) {
    const first = _cache.values().next().value as string;
    _cache.delete(first);
  }
}

function initFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) {
        _cache = mergePreReady(parsed);
        _trimCache();
      }
    }
  } catch {
    // corrupt payload — start empty
  }
}

async function tryMigrateFromLocalStorage(): Promise<boolean> {
  const store = getStore();
  if (!store) return false;
  try {
    if (localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes') return false;

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    // Dedupe + cap to the most recent MAX_IDS.
    const capped = Array.from(new Set(parsed.filter((v): v is string => typeof v === 'string'))).slice(-MAX_IDS);
    if (capped.length === 0) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    // Legacy array is oldest -> newest; give each id an increasing decode
    // time (all in the past) so hydrate can rebuild that order.
    const base = Date.now() - capped.length;
    const ops = capped.map((id, i) => ({
      type: 'put' as const,
      namespace: LEVEL_NAMESPACE,
      key: id,
      value: base + i,
    }));

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[TransmissionsHistoryStore] Migration batch failed:', res.error);
      return false;
    }

    // Preserve the legacy STORAGE_KEY for one release as rollback insurance.
    localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    _cache = mergePreReady(capped);
    _knownKeys = new Set(capped);
    console.log(
      `[TransmissionsHistoryStore] Migrated ${capped.length} decoded ids from localStorage -> LevelDB`,
    );
    return true;
  } catch (err) {
    console.error('[TransmissionsHistoryStore] Migration failed:', err);
    return false;
  }
}

/**
 * `ordered` (oldest first) followed by any id `markDecoded` added before the
 * hydrate finished — those are newer than every stored row and must not be
 * dropped by the hydrate replacing the cache.
 */
function mergePreReady(ordered: string[]): Set<string> {
  const merged = new Set(ordered);
  for (const id of _cache) merged.add(id);
  return merged;
}

/** Stored decode time of a row; legacy rows (value 1) and junk sort oldest. */
function decodedAt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function initFromLevelDB(): Promise<void> {
  const store = getStore();
  if (!store) {
    initFromLocalStorage();
    return;
  }
  try {
    const res = await store.getAll<number>(LEVEL_NAMESPACE);
    if (res && res.error) {
      console.error('[TransmissionsHistoryStore] getAll IPC error:', res.error);
      initFromLocalStorage();
      return;
    }
    const rows = res?.rows ?? [];
    if (rows.length > 0) {
      // getAll returns key order; rebuild decode-age order so eviction drops
      // the oldest decode, not the alphabetically first id.
      const ordered = rows
        .slice()
        .sort((a, b) => decodedAt(a.value) - decodedAt(b.value) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((r) => r.key);
      _cache = mergePreReady(ordered);
      _trimCache();
      // Every stored key: rows trimmed above are deleted by the next persist.
      _knownKeys = new Set(ordered);
      return;
    }
    // LevelDB empty — attempt one-shot migration from localStorage.
    await tryMigrateFromLocalStorage();
  } catch (err) {
    console.error('[TransmissionsHistoryStore] Failed to init from LevelDB, falling back:', err);
    initFromLocalStorage();
  }
}

async function initialize(): Promise<void> {
  if (_isInitialized) return;
  if (_useLevelDB) {
    await initFromLevelDB();
  } else {
    initFromLocalStorage();
  }
  _isInitialized = true;
}

// Kick off init at module load. The localStorage fallback path runs entirely
// synchronously (no awaits) so callers that read immediately after import
// still see hydrated data in the no-bridge case. LevelDB path is async.
const _ready = initialize();

function persistLocalStorage(): void {
  try {
    const trimmed = Array.from(_cache).slice(-MAX_IDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // ignore quota / serialization errors
  }
}

async function persistLevelDB(): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    const currentIds = new Set(_cache);
    const ops: Array<
      | { type: 'put'; namespace: string; key: string; value: unknown }
      | { type: 'del'; namespace: string; key: string }
    > = [];

    const now = Date.now();
    for (const id of currentIds) {
      if (!_knownKeys.has(id)) {
        // Value = decode time, so the next boot can evict by age.
        ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: id, value: now });
      }
    }
    for (const oldKey of _knownKeys) {
      if (!currentIds.has(oldKey)) {
        ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: oldKey });
      }
    }

    if (ops.length === 0) return;

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[TransmissionsHistoryStore] batch save failed:', res.error);
      return;
    }
    _knownKeys = currentIds;
  } catch (err) {
    console.error('[TransmissionsHistoryStore] save failed:', err);
  }
}

function persist(): void {
  if (_useLevelDB) {
    void persistLevelDB();
    return;
  }
  persistLocalStorage();
}

export const transmissionsHistoryStore = {
  markDecoded(id: string): void {
    if (_cache.has(id)) return;
    _cache.add(id);
    _trimCache();
    persist();
  },

  hasDecoded(id: string): boolean {
    return _cache.has(id);
  },

  getDecodedIds(): Set<string> {
    return new Set(_cache);
  },

  /**
   * Resolves after the async hydrate (LevelDB path) finishes. The
   * localStorage path resolves synchronously so awaiting is a no-op there.
   * Exposed primarily for tests and boot-time callers that need to sequence
   * work after hydration.
   */
  ready(): Promise<void> {
    return _ready;
  },

  /** Clear all decode history. LevelDB namespace + legacy key + marker. */
  clear(): void {
    _cache = new Set();
    _knownKeys = new Set();
    if (_useLevelDB) {
      const store = getStore();
      if (store) {
        void (async () => {
          try {
            const res = await store.clearNamespace(LEVEL_NAMESPACE);
            if (res && res.error) {
              console.error('[TransmissionsHistoryStore] clearNamespace failed:', res.error);
            }
          } catch (err) {
            console.error('[TransmissionsHistoryStore] clear failed:', err);
          }
        })();
      }
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(MIGRATION_MARKER_KEY);
    } catch {
      // ignore
    }
  },
};
