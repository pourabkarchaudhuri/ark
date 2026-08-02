/**
 * Transmissions Archive — save-for-later (queue for decode).
 * Keyed by news item id.
 *
 * v1.0.61+: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface. The public sync API is unchanged — an in-memory
 * cache is hydrated on init and every read still returns synchronously. When
 * `window.store` is unavailable (unit tests, jsdom, pre-preload boot window)
 * the store transparently falls back to the previous localStorage path.
 */

/** Legacy localStorage key — retained for boot-time hydrate + rollback. */
const STORAGE_KEY = 'ark-transmissions-archive';
/** One-shot migration sentinel — stamped after the first successful copy. */
const MIGRATION_MARKER_KEY = 'ark-transmissions-archive-migrated-v1';
/** LevelDB namespace this store owns. Keys within it are `SavedTransmission.id`. */
const LEVEL_NAMESPACE = 'transmissions-archive';

export interface SavedTransmission {
  id: string;
  url: string;
  title: string;
  source: string;
  publishedAt: number;
  summary?: string;
  imageUrl?: string;
}

/** Gate flag captured once at module load — LevelDB path vs. legacy fallback. */
const _useLevelDB =
  typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';

/** In-memory cache, in insertion order. */
let _cache: SavedTransmission[] = [];
/** Set of ids currently persisted in LevelDB (used to emit delta del ops). */
let _knownKeys: Set<string> = new Set();
let _isInitialized = false;

const _listeners = new Set<() => void>();

/** Best-effort feature detect for the preload-exposed LevelDB bridge. */
type StoreBridge = NonNullable<Window['store']>;
function getStore(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  return window.store ?? null;
}

function notify() {
  _listeners.forEach((cb) => cb());
}

function initFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedTransmission[];
      if (Array.isArray(parsed)) {
        _cache = parsed.filter((i) => i && typeof i.id === 'string');
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

    const valid = parsed.filter(
      (i): i is SavedTransmission => !!i && typeof (i as SavedTransmission).id === 'string',
    );
    if (valid.length === 0) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    const ops = valid.map((item) => ({
      type: 'put' as const,
      namespace: LEVEL_NAMESPACE,
      key: item.id,
      value: item,
    }));

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[TransmissionsArchiveStore] Migration batch failed:', res.error);
      return false;
    }

    // Preserve the legacy STORAGE_KEY for one release as rollback insurance.
    localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    _cache = valid;
    _knownKeys = new Set(_cache.map((i) => i.id));
    console.log(
      `[TransmissionsArchiveStore] Migrated ${valid.length} archived transmissions from localStorage -> LevelDB`,
    );
    notify();
    return true;
  } catch (err) {
    console.error('[TransmissionsArchiveStore] Migration failed:', err);
    return false;
  }
}

async function initFromLevelDB(): Promise<void> {
  const store = getStore();
  if (!store) {
    initFromLocalStorage();
    return;
  }
  try {
    const res = await store.getAll<SavedTransmission>(LEVEL_NAMESPACE);
    if (res && res.error) {
      console.error('[TransmissionsArchiveStore] getAll IPC error:', res.error);
      initFromLocalStorage();
      return;
    }
    const rows = res?.rows ?? [];
    if (rows.length > 0) {
      _cache = rows
        .map((r) => r.value)
        .filter((v): v is SavedTransmission => !!v && typeof v.id === 'string');
      _knownKeys = new Set(_cache.map((i) => i.id));
      notify();
      return;
    }
    // LevelDB empty — attempt one-shot migration from localStorage.
    await tryMigrateFromLocalStorage();
  } catch (err) {
    console.error('[TransmissionsArchiveStore] Failed to init from LevelDB, falling back:', err);
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
// synchronously so callers that read immediately after import still see
// hydrated data in the no-bridge case.
const _ready = initialize();

function persistLocalStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
  } catch {
    // ignore quota / serialization errors
  }
}

async function persistLevelDB(): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    const currentIds = new Set<string>();
    const ops: Array<
      | { type: 'put'; namespace: string; key: string; value: unknown }
      | { type: 'del'; namespace: string; key: string }
    > = [];

    for (const item of _cache) {
      if (!item.id) continue;
      currentIds.add(item.id);
      ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: item.id, value: item });
    }
    for (const oldKey of _knownKeys) {
      if (!currentIds.has(oldKey)) {
        ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: oldKey });
      }
    }

    if (ops.length === 0) return;

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[TransmissionsArchiveStore] batch save failed:', res.error);
      return;
    }
    _knownKeys = currentIds;
  } catch (err) {
    console.error('[TransmissionsArchiveStore] save failed:', err);
  }
}

function persist(): void {
  if (_useLevelDB) {
    void persistLevelDB();
    return;
  }
  persistLocalStorage();
}

export const transmissionsArchiveStore = {
  add(item: SavedTransmission): void {
    if (_cache.some((i) => i.id === item.id)) return;
    _cache.push(item);
    persist();
    notify();
  },

  remove(id: string): void {
    const before = _cache.length;
    _cache = _cache.filter((i) => i.id !== id);
    if (_cache.length === before) return;
    persist();
    notify();
  },

  getAll(): SavedTransmission[] {
    return _cache.slice();
  },

  has(id: string): boolean {
    return _cache.some((i) => i.id === id);
  },

  subscribe(callback: () => void): () => void {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  },

  /**
   * Resolves after the async hydrate (LevelDB path) finishes. The
   * localStorage path resolves synchronously.
   */
  ready(): Promise<void> {
    return _ready;
  },

  /** Clear all archived transmissions. LevelDB namespace + legacy key + marker. */
  clear(): void {
    _cache = [];
    _knownKeys = new Set();
    if (_useLevelDB) {
      const store = getStore();
      if (store) {
        void (async () => {
          try {
            const res = await store.clearNamespace(LEVEL_NAMESPACE);
            if (res && res.error) {
              console.error('[TransmissionsArchiveStore] clearNamespace failed:', res.error);
            }
          } catch (err) {
            console.error('[TransmissionsArchiveStore] clear failed:', err);
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
    notify();
  },
};
