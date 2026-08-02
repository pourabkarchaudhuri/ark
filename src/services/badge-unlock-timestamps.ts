/**
 * Persists first-unlock timestamp per badge id so we can show
 * "Obtained: <date>" on vault cards.
 *
 * v1.0.61+: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface. The public sync API is unchanged — an in-memory
 * cache is hydrated on init and every read still returns synchronously. When
 * `window.store` is unavailable (unit tests, jsdom, pre-preload boot window)
 * the store transparently falls back to the previous localStorage path.
 */

/** Legacy localStorage key — retained for boot-time hydrate + rollback. */
const STORAGE_KEY = 'ark-badge-unlock-timestamps';
/** One-shot migration sentinel — stamped after the first successful copy. */
const MIGRATION_MARKER_KEY = 'ark-badge-unlock-timestamps-migrated-v1';
/** LevelDB namespace this store owns. Keys are stringified badge ids. */
const LEVEL_NAMESPACE = 'badge-unlock-timestamps';

type Stored = Record<number, number>;

/** Gate flag captured once at module load — LevelDB path vs. legacy fallback. */
const _useLevelDB =
  typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';

let _cache: Stored = {};
/** Set of badge ids currently persisted in LevelDB (used to diff writes). */
let _knownKeys: Set<number> = new Set();
let _isInitialized = false;

/** Best-effort feature detect for the preload-exposed LevelDB bridge. */
type StoreBridge = NonNullable<Window['store']>;
function getStore(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  return window.store ?? null;
}

function initFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Stored;
      if (parsed && typeof parsed === 'object') {
        _cache = { ...parsed };
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([k, v]) => Number.isFinite(Number(k)) && typeof v === 'number' && Number.isFinite(v),
    ) as Array<[string, number]>;

    if (entries.length === 0) {
      localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
      return false;
    }

    const ops = entries.map(([badgeId, ts]) => ({
      type: 'put' as const,
      namespace: LEVEL_NAMESPACE,
      key: badgeId,
      value: ts,
    }));

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[BadgeUnlockTimestamps] Migration batch failed:', res.error);
      return false;
    }

    // Preserve the legacy STORAGE_KEY for one release as rollback insurance.
    localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
    _cache = Object.fromEntries(entries.map(([k, v]) => [Number(k), v])) as Stored;
    _knownKeys = new Set(entries.map(([k]) => Number(k)));
    console.log(
      `[BadgeUnlockTimestamps] Migrated ${entries.length} unlock timestamps from localStorage -> LevelDB`,
    );
    return true;
  } catch (err) {
    console.error('[BadgeUnlockTimestamps] Migration failed:', err);
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
    const res = await store.getAll<number>(LEVEL_NAMESPACE);
    if (res && res.error) {
      console.error('[BadgeUnlockTimestamps] getAll IPC error:', res.error);
      initFromLocalStorage();
      return;
    }
    const rows = res?.rows ?? [];
    if (rows.length > 0) {
      const next: Stored = {};
      const keys = new Set<number>();
      for (const r of rows) {
        const id = Number(r.key);
        if (!Number.isFinite(id)) continue;
        if (typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
        next[id] = r.value;
        keys.add(id);
      }
      _cache = next;
      _knownKeys = keys;
      return;
    }
    // LevelDB empty — attempt one-shot migration from localStorage.
    await tryMigrateFromLocalStorage();
  } catch (err) {
    console.error('[BadgeUnlockTimestamps] Failed to init from LevelDB, falling back:', err);
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
    const currentIds = new Set<number>();
    const ops: Array<
      | { type: 'put'; namespace: string; key: string; value: unknown }
      | { type: 'del'; namespace: string; key: string }
    > = [];

    for (const [k, v] of Object.entries(_cache)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      currentIds.add(id);
      ops.push({ type: 'put', namespace: LEVEL_NAMESPACE, key: String(id), value: v });
    }
    for (const oldKey of _knownKeys) {
      if (!currentIds.has(oldKey)) {
        ops.push({ type: 'del', namespace: LEVEL_NAMESPACE, key: String(oldKey) });
      }
    }

    if (ops.length === 0) return;

    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[BadgeUnlockTimestamps] batch save failed:', res.error);
      return;
    }
    _knownKeys = currentIds;
  } catch (err) {
    console.error('[BadgeUnlockTimestamps] save failed:', err);
  }
}

function persist(): void {
  if (_useLevelDB) {
    void persistLevelDB();
    return;
  }
  persistLocalStorage();
}

export function getBadgeUnlockedAt(badgeId: number): number | undefined {
  const ts = _cache[badgeId];
  return ts === undefined ? undefined : ts;
}

export function setBadgeUnlockedAt(badgeId: number, timestamp: number): void {
  if (_cache[badgeId] !== undefined) return;
  _cache[badgeId] = timestamp;
  persist();
}

export function ensureUnlockedAt(badgeId: number): number {
  const existing = _cache[badgeId];
  if (existing !== undefined) return existing;
  const now = Date.now();
  _cache[badgeId] = now;
  persist();
  return now;
}

/**
 * Resolves after the async hydrate (LevelDB path) finishes. Exposed for
 * tests + boot-time callers that need to sequence work after hydration.
 */
export function badgeUnlockTimestampsReady(): Promise<void> {
  return _ready;
}

/** Clear all unlock timestamps. LevelDB namespace + legacy key + marker. */
export function clearBadgeUnlockTimestamps(): void {
  _cache = {};
  _knownKeys = new Set();
  if (_useLevelDB) {
    const store = getStore();
    if (store) {
      void (async () => {
        try {
          const res = await store.clearNamespace(LEVEL_NAMESPACE);
          if (res && res.error) {
            console.error('[BadgeUnlockTimestamps] clearNamespace failed:', res.error);
          }
        } catch (err) {
          console.error('[BadgeUnlockTimestamps] clear failed:', err);
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
}
