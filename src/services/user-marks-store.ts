/**
 * UserMarks Store
 *
 * Phase 2 authorship surfaces — Banners + Personal Constellations.
 * Banners live in localStorage (compact, instant). Constellations live in IDB
 * (member arrays bloat fast; IDB handles 100s of constellations × 10s of nodes each).
 *
 * Both expose the same singleton + subscribe pattern as the other stores so the
 * Galaxy view can react with a single subscription per surface.
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

const BANNER_KEY = 'ark.userMarks.banners.v1';
const CONSTELLATION_DB_NAME = 'ark-user-marks';
const CONSTELLATION_DB_VERSION = 1;
const CONSTELLATION_STORE = 'constellations';
const CONSTELLATION_HARD_CAP = 100;

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
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

class UserMarksStore {
  private _listeners = new Set<() => void>();
  private _banners = new Map<string, Banner>();
  private _constellations = new Map<string, Constellation>();
  private _initialized = false;

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  private _notify(): void { this._listeners.forEach((fn) => fn()); }

  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    // Banners — synchronous from localStorage
    try {
      const raw = localStorage.getItem(BANNER_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as Banner[];
        for (const b of arr) if (b.gameId && b.color) this._banners.set(b.gameId, b);
      }
    } catch { /* swallow malformed payload */ }
    // Constellations — async from IDB
    try {
      const db = await openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CONSTELLATION_STORE, 'readonly');
        const req = tx.objectStore(CONSTELLATION_STORE).getAll();
        req.onsuccess = () => {
          for (const c of (req.result as Constellation[])) if (c.id) this._constellations.set(c.id, c);
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch (err) {
      console.warn('[UserMarks] constellation load failed:', err);
    }
    this._notify();
  }

  // ─── Banners ───
  get banners(): ReadonlyMap<string, Banner> { return this._banners; }

  setBanner(gameId: string, color: BannerColor): void {
    this._banners.set(gameId, { gameId, color, plantedAt: new Date().toISOString() });
    this._persistBanners();
    this._notify();
  }

  removeBanner(gameId: string): void {
    if (!this._banners.delete(gameId)) return;
    this._persistBanners();
    this._notify();
  }

  bannersByColor(color: BannerColor): Banner[] {
    const out: Banner[] = [];
    for (const b of this._banners.values()) if (b.color === color) out.push(b);
    return out;
  }

  private _persistBanners(): void {
    try {
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
    this._notify();
    return true;
  }

  async removeConstellation(id: string): Promise<void> {
    if (!this._constellations.delete(id)) return;
    try {
      const db = await openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CONSTELLATION_STORE, 'readwrite');
        tx.objectStore(CONSTELLATION_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* swallow */ }
    this._notify();
  }
}

export const userMarksStore = new UserMarksStore();
