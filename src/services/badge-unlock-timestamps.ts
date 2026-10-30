/**
 * Persists first-unlock timestamp per badge id so we can show
 * "Obtained: <date>" on vault cards.
 *
 * v1.0.61+: Primary persistence moved from `localStorage` to LevelDB via the
 * `window.store` IPC surface. The public sync API is unchanged — an in-memory
 * cache is hydrated on init and every read still returns synchronously. When
 * `window.store` is unavailable (unit tests, jsdom, pre-preload boot window)
 * the store transparently falls back to the previous localStorage path.
 *
 * v1.0.97: writes come from the app-level stamper (badge-unlock-stamper), not
 * from card renders. Persistence is per key (only new ids are put), setters
 * before hydration are queued and merged with stored values winning, and a
 * version/subscribe pair lets useBadgeProgress re-derive latched badges.
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
/** Ids set before hydration finished; merged (stored values win) on init. */
let _pending: Stored = {};
/** Bumped on hydration and on every new stamp. */
let _version = 0;
const _listeners = new Set<() => void>();

function notify(): void {
  _version++;
  for (const l of _listeners) {
    try { l(); } catch { /* listener errors must not break stamping */ }
  }
}

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
  // Merge stamps queued before hydration; a stored (historical) date wins.
  const queued = _pending;
  _pending = {};
  const fresh: number[] = [];
  for (const [k, v] of Object.entries(queued)) {
    const id = Number(k);
    if (_cache[id] !== undefined) continue;
    _cache[id] = v;
    fresh.push(id);
  }
  if (fresh.length > 0) persist(fresh);
  notify();
}

const _ready = initialize();

function persistLocalStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
  } catch {
    // ignore quota / serialization errors
  }
}

/** Puts only the given ids; stored rows are never re-written. */
async function persistLevelDB(ids: number[]): Promise<void> {
  const store = getStore();
  if (!store) return;
  const ops = ids
    .filter(id => _cache[id] !== undefined && !_knownKeys.has(id))
    .map(id => ({ type: 'put' as const, namespace: LEVEL_NAMESPACE, key: String(id), value: _cache[id] }));
  if (ops.length === 0) return;
  try {
    const res = await store.batch(ops);
    if (res && res.error) {
      console.error('[BadgeUnlockTimestamps] batch save failed:', res.error);
      return;
    }
    for (const op of ops) _knownKeys.add(Number(op.key));
  } catch (err) {
    console.error('[BadgeUnlockTimestamps] save failed:', err);
  }
}

function persist(ids: number[]): void {
  if (_useLevelDB) {
    void persistLevelDB(ids);
    return;
  }
  persistLocalStorage();
}

export function getBadgeUnlockedAt(badgeId: number): number | undefined {
  const ts = _cache[badgeId];
  return ts === undefined ? undefined : ts;
}

/** True when the badge has a stamped unlock date (hydrated or stamped this session). */
export function hasBadgeUnlockedAt(badgeId: number): boolean {
  return _cache[badgeId] !== undefined || _pending[badgeId] !== undefined;
}

/**
 * Stamps every id that has no date yet in one write. Before hydration the
 * stamps are queued and merged on init (stored dates win). Returns how many
 * ids were newly stamped.
 */
export function setBadgeUnlockedAtMany(entries: Iterable<readonly [number, number]>): number {
  const fresh: number[] = [];
  for (const [id, ts] of entries) {
    if (!Number.isFinite(id) || !Number.isFinite(ts)) continue;
    if (hasBadgeUnlockedAt(id)) continue;
    if (_isInitialized) _cache[id] = ts;
    else _pending[id] = ts;
    fresh.push(id);
  }
  if (fresh.length === 0) return 0;
  if (_isInitialized) persist(fresh);
  notify();
  return fresh.length;
}

export function setBadgeUnlockedAt(badgeId: number, timestamp: number): void {
  setBadgeUnlockedAtMany([[badgeId, timestamp]]);
}

export function ensureUnlockedAt(badgeId: number): number {
  const existing = _cache[badgeId] ?? _pending[badgeId];
  if (existing !== undefined) return existing;
  const now = Date.now();
  setBadgeUnlockedAt(badgeId, now);
  return now;
}

export function isBadgeUnlockTimestampsHydrated(): boolean {
  return _isInitialized;
}

/** For useSyncExternalStore: fires on hydration and on each new stamp. */
export function subscribeBadgeUnlockTimestamps(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getBadgeUnlockTimestampsVersion(): number {
  return _version;
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
  _pending = {};
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
  notify();
}
