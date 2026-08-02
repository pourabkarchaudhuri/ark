/**
 * UserMarks Store
 *
 * Phase 2 authorship surfaces — Banners + Personal Constellations.
 *
 * Pre-v1.0.61: Banners lived in localStorage (compact, instant) and
 * constellations lived in IndexedDB (member arrays bloat fast; IDB handles
 * 100s of constellations x 10s of nodes each).
 *
 * v1.0.61+: Primary persistence moved to LevelDB via the `window.store` IPC
 * surface (see `electron/ipc/store-handlers.ts`). Both surfaces now live in
 * one namespace (`user-marks`), demuxed by key prefix:
 *   - `banner:{gameId}`         -> Banner
 *   - `constellation:{id}`      -> Constellation
 * The public sync API is unchanged — an in-memory cache is hydrated on
 * `init()` and every read still returns synchronously. When `window.store`
 * is unavailable (unit tests, jsdom, pre-preload boot window) the store
 * transparently falls back to the previous localStorage + IDB path.
 */

export type BannerColor = 'crimson' | 'gold' | 'cobalt' | 'verdant' | 'bone';

export const BANNER_COLORS: BannerColor[] = ['crimson', 'gold', 'cobalt', 'verdant', 'bone'];

export const BANNER_RGB: Record<BannerColor, [number, number, number]> = {
  crimson: [0.95, 0.25, 0.30],
  gold:    [1.00, 0.78, 0.30],
  cobalt:  [0.30, 0.55, 1.00],
  verdant: [0.30, 0.85, 0.55],
  bone:    [0.85, 0.83, 0.78],
};

export interface Banner {
  gameId: string;
  color: BannerColor;
  plantedAt: string; // ISO
}

export interface Constellation {
  id: string;
  name: string;
  nodeIds: string[];
  createdAt: string;
}

// ─── Legacy persistence constants (still used for fallback + one-shot migration) ──
const BANNER_KEY = 'ark.userMarks.banners.v1';
const CONSTELLATION_DB_NAME = 'ark-user-marks';
const CONSTELLATION_DB_VERSION = 1;
const CONSTELLATION_STORE = 'constellations';
const CONSTELLATION_HARD_CAP = 100;

// ─── LevelDB persistence constants ─────────────────────────────────────────
/** Single LevelDB namespace for both banner + constellation rows. */
const LEVEL_NAMESPACE = 'user-marks';
const BANNER_KEY_PREFIX = 'banner:';
const CONSTELLATION_KEY_PREFIX = 'constellation:';
/**
 * One-shot marker stamped in localStorage after the LevelDB migration
 * copies the legacy banners + constellations across. Presence => never
 * migrate again. The legacy BANNER_KEY (and the IDB payload) stays intact
 * for one release as rollback insurance.
 */
const MIGRATION_MARKER_KEY = `${BANNER_KEY}-migrated-v1`;

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null;
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(CONSTELLATION_DB_NAME, CONSTELLATION_DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CONSTELLATION_STORE)) {
        db.createObjectStore(CONSTELLATION_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => { dbInstance = null; dbPromise = null; };
      dbInstance.onversionchange = () => { dbInstance?.close(); dbInstance = null; dbPromise = null; };
      resolve(dbInstance);
    };
  });
  return dbPromise;
}

/** Best-effort feature detect for the preload-exposed LevelDB bridge. */
type StoreBridge = NonNullable<Window['store']>;
type StoreBatchOp =
  | { type: 'put'; namespace: string; key: string; value: unknown }
  | { type: 'del'; namespace: string; key: string };
function getStore(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  return window.store ?? null;
}

export class UserMarksStore {
  private _listeners = new Set<() => void>();
  private _banners = new Map<string, Banner>();
  private _constellations = new Map<string, Constellation>();
  private _initialized = false;

  /** Gate flag captured once at construction — LevelDB path vs. legacy fallback. */
  private readonly _useLevelDB: boolean;

  /**
   * Exposed so tests / callers that need to await the async hydration can
   * `await store.init()` (previously already the case) or reference this
   * without re-triggering. Public reads are safe before it resolves — they
   * simply return empty maps during the boot window.
   */
  private _initPromise: Promise<void> | null = null;

  constructor() {
    this._useLevelDB =
      typeof window !== 'undefined' && typeof (window as any).store !== 'undefined';
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  private _notify(): void { this._listeners.forEach((fn) => fn()); }

  async init(): Promise<void> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    if (this._useLevelDB) {
      await this._initializeFromLevelDB();
    } else {
      await this._initializeFromLegacy();
    }

    this._notify();
  }

  /**
   * LevelDB init path:
   *   1. Load rows from namespace `user-marks`. If any exist, hydrate.
   *   2. If empty AND no migration marker => copy legacy banners
   *      (localStorage) + legacy constellations (IDB) into LevelDB and
   *      stamp the marker.
   *   3. On any hard failure fall back to the legacy path so the user
   *      never loses their marks.
   */
  private async _initializeFromLevelDB(): Promise<void> {
    const store = getStore();
    if (!store) {
      await this._initializeFromLegacy();
      return;
    }
    try {
      const res = await store.getAll<Banner | Constellation>(LEVEL_NAMESPACE);
      if (res.error) {
        console.error('[UserMarks] getAll(user-marks) IPC error:', res.error);
        await this._initializeFromLegacy();
        return;
      }
      const rows = res.rows ?? [];
      if (rows.length > 0) {
        this._hydrateFromRows(rows);
        return;
      }
      // LevelDB empty — attempt one-shot migration from legacy.
      await this._tryMigrateFromLegacy(store);
    } catch (err) {
      console.error('[UserMarks] Failed to init from LevelDB, falling back:', err);
      await this._initializeFromLegacy();
    }
  }

  /**
   * Populate the in-memory maps from a list of LevelDB rows. Keys are
   * demuxed by prefix; malformed keys are ignored.
   */
  private _hydrateFromRows(rows: Array<{ key: string; value: Banner | Constellation }>): void {
    for (const { key, value } of rows) {
      if (key.startsWith(BANNER_KEY_PREFIX)) {
        const b = value as Banner;
        if (b && b.gameId && b.color) this._banners.set(b.gameId, b);
      } else if (key.startsWith(CONSTELLATION_KEY_PREFIX)) {
        const c = value as Constellation;
        if (c && c.id) this._constellations.set(c.id, c);
      }
    }
  }

  /**
   * One-shot copy of legacy banners (localStorage) + legacy constellations
   * (IDB) into LevelDB namespace `user-marks`.
   *
   * Runs only when:
   *   - migration marker is absent (never migrated before), AND
   *   - LevelDB namespace is empty (caller already checked).
   *
   * Stamps `MIGRATION_MARKER_KEY = 'yes'` on any completed run (including
   * empty-legacy) so we don't retry every boot. The original BANNER_KEY /
   * IDB payload are left intact for one-release rollback.
   */
  private async _tryMigrateFromLegacy(store: StoreBridge): Promise<void> {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_MARKER_KEY) === 'yes') {
        return;
      }

      const banners = this._readLegacyBanners();
      const constellations = await this._readLegacyConstellations();

      // Populate in-memory cache immediately so callers reading before the
      // batch resolves still see the migrated data.
      for (const b of banners) this._banners.set(b.gameId, b);
      for (const c of constellations) this._constellations.set(c.id, c);

      const ops: StoreBatchOp[] = [];
      for (const b of banners) {
        ops.push({
          type: 'put',
          namespace: LEVEL_NAMESPACE,
          key: BANNER_KEY_PREFIX + b.gameId,
          value: b,
        });
      }
      for (const c of constellations) {
        ops.push({
          type: 'put',
          namespace: LEVEL_NAMESPACE,
          key: CONSTELLATION_KEY_PREFIX + c.id,
          value: c,
        });
      }

      if (ops.length > 0) {
        const res = await store.batch(ops);
        if (res && res.error) {
          console.error('[UserMarks] Migration batch failed:', res.error);
          return;
        }
      }

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(MIGRATION_MARKER_KEY, 'yes');
        }
      } catch { /* ignore */ }

      if (ops.length > 0) {
        console.log(
          `[UserMarks] Migrated ${banners.length} banner(s) + ${constellations.length} constellation(s) to LevelDB`,
        );
      }
    } catch (err) {
      console.error('[UserMarks] Migration failed:', err);
    }
  }

  private _readLegacyBanners(): Banner[] {
    const out: Banner[] = [];
    try {
      if (typeof localStorage === 'undefined') return out;
      const raw = localStorage.getItem(BANNER_KEY);
      if (!raw) return out;
      const arr = JSON.parse(raw) as Banner[];
      if (Array.isArray(arr)) {
        for (const b of arr) if (b && b.gameId && b.color) out.push(b);
      }
    } catch {
      /* swallow malformed payload */
    }
    return out;
  }

  private async _readLegacyConstellations(): Promise<Constellation[]> {
    const out: Constellation[] = [];
    try {
      const db = await openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CONSTELLATION_STORE, 'readonly');
        const req = tx.objectStore(CONSTELLATION_STORE).getAll();
        req.onsuccess = () => {
          for (const c of (req.result as Constellation[])) {
            if (c && c.id) out.push(c);
          }
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch {
      /* no legacy IDB available — nothing to migrate */
    }
    return out;
  }

  /** Legacy path — used both as fallback and in test/jsdom environments. */
  private async _initializeFromLegacy(): Promise<void> {
    // Banners — synchronous from localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(BANNER_KEY);
        if (raw) {
          const arr = JSON.parse(raw) as Banner[];
          if (Array.isArray(arr)) {
            for (const b of arr) if (b && b.gameId && b.color) this._banners.set(b.gameId, b);
          }
        }
      }
    } catch { /* swallow malformed payload */ }
    // Constellations — async from IDB
    try {
      const db = await openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CONSTELLATION_STORE, 'readonly');
        const req = tx.objectStore(CONSTELLATION_STORE).getAll();
        req.onsuccess = () => {
          for (const c of (req.result as Constellation[])) if (c && c.id) this._constellations.set(c.id, c);
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch (err) {
      console.warn('[UserMarks] constellation load failed:', err);
    }
  }

  // ─── Banners ───
  get banners(): ReadonlyMap<string, Banner> { return this._banners; }

  setBanner(gameId: string, color: BannerColor): void {
    const banner: Banner = { gameId, color, plantedAt: new Date().toISOString() };
    this._banners.set(gameId, banner);
    this._persistBanner(banner);
    this._notify();
  }

  removeBanner(gameId: string): void {
    if (!this._banners.delete(gameId)) return;
    this._persistBannerDeletion(gameId);
    this._notify();
  }

  bannersByColor(color: BannerColor): Banner[] {
    const out: Banner[] = [];
    for (const b of this._banners.values()) if (b.color === color) out.push(b);
    return out;
  }

  /**
   * LevelDB path: put a single banner row. Legacy path: rewrite the whole
   * localStorage blob (unchanged from pre-v1.0.61).
   */
  private _persistBanner(banner: Banner): void {
    if (this._useLevelDB) {
      const store = getStore();
      if (!store) { this._persistBannersLegacy(); return; }
      void (async () => {
        try {
          const res = await store.put(
            LEVEL_NAMESPACE,
            BANNER_KEY_PREFIX + banner.gameId,
            banner,
          );
          if (res && res.error) console.error('[UserMarks] banner put failed:', res.error);
        } catch (err) {
          console.error('[UserMarks] banner put threw:', err);
        }
      })();
      return;
    }
    this._persistBannersLegacy();
  }

  private _persistBannerDeletion(gameId: string): void {
    if (this._useLevelDB) {
      const store = getStore();
      if (!store) { this._persistBannersLegacy(); return; }
      void (async () => {
        try {
          const res = await store.del(LEVEL_NAMESPACE, BANNER_KEY_PREFIX + gameId);
          if (res && res.error) console.error('[UserMarks] banner del failed:', res.error);
        } catch (err) {
          console.error('[UserMarks] banner del threw:', err);
        }
      })();
      return;
    }
    this._persistBannersLegacy();
  }

  private _persistBannersLegacy(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const arr = Array.from(this._banners.values());
      localStorage.setItem(BANNER_KEY, JSON.stringify(arr));
    } catch (err) {
      console.warn('[UserMarks] banner persist failed:', err);
    }
  }

  // ─── Constellations ───
  get constellations(): ReadonlyMap<string, Constellation> { return this._constellations; }

  /**
   * Add a constellation. Returns false if hard cap reached.
   */
  async addConstellation(name: string, nodeIds: string[]): Promise<boolean> {
    if (this._constellations.size >= CONSTELLATION_HARD_CAP) return false;
    if (nodeIds.length < 2) return false;
    const id = `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1296).toString(36)}`;
    const entry: Constellation = {
      id,
      name: name.trim().slice(0, 60) || 'Unnamed',
      nodeIds: [...nodeIds],
      createdAt: new Date().toISOString(),
    };
    this._constellations.set(id, entry);
    if (this._useLevelDB) {
      const store = getStore();
      if (store) {
        try {
          const res = await store.put(
            LEVEL_NAMESPACE,
            CONSTELLATION_KEY_PREFIX + id,
            entry,
          );
          if (res && res.error) console.error('[UserMarks] constellation put failed:', res.error);
        } catch (err) {
          console.error('[UserMarks] constellation put threw:', err);
        }
      }
    } else {
      try {
        const db = await openDB();
        await new Promise<void>((resolve) => {
          const tx = db.transaction(CONSTELLATION_STORE, 'readwrite');
          tx.objectStore(CONSTELLATION_STORE).put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch (err) {
        console.warn('[UserMarks] constellation save failed:', err);
      }
    }
    this._notify();
    return true;
  }

  async removeConstellation(id: string): Promise<void> {
    if (!this._constellations.delete(id)) return;
    if (this._useLevelDB) {
      const store = getStore();
      if (store) {
        try {
          const res = await store.del(LEVEL_NAMESPACE, CONSTELLATION_KEY_PREFIX + id);
          if (res && res.error) console.error('[UserMarks] constellation del failed:', res.error);
        } catch { /* swallow */ }
      }
    } else {
      try {
        const db = await openDB();
        await new Promise<void>((resolve) => {
          const tx = db.transaction(CONSTELLATION_STORE, 'readwrite');
          tx.objectStore(CONSTELLATION_STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch { /* swallow */ }
    }
    this._notify();
  }

  /**
   * Clear all user-marks state (banners + constellations). Wipes the
   * LevelDB namespace, the legacy localStorage banner key, and the
   * migration marker so a subsequent import cycle re-migrates cleanly.
   * Legacy IDB constellations are NOT touched here — a rollback to a
   * pre-migration build would still surface them, matching the "preserve
   * legacy for one release" contract.
   */
  clear(): void {
    this._banners.clear();
    this._constellations.clear();
    if (this._useLevelDB) {
      const store = getStore();
      if (store) {
        void (async () => {
          try {
            const res = await store.clearNamespace(LEVEL_NAMESPACE);
            if (res && res.error) console.error('[UserMarks] clearNamespace failed:', res.error);
          } catch (err) {
            console.error('[UserMarks] clearNamespace threw:', err);
          }
        })();
      }
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(BANNER_KEY);
        localStorage.removeItem(MIGRATION_MARKER_KEY);
      }
    } catch { /* ignore */ }
    this._notify();
  }
}

export const userMarksStore = new UserMarksStore();
