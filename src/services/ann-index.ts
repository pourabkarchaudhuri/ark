/**
 * ANN Index Service (Renderer Side)
 *
 * Communicates with the main-process usearch HNSW index via IPC.
 * Observable singleton — UI components can subscribe for status updates.
 *
 * Graceful degradation: if the main process ANN module is unavailable
 * (e.g., native addon failed to load), all methods return cleanly
 * and the recommendation pipeline falls back to metadata-only retrieval.
 */

declare global {
  interface Window {
    ann?: {
      load: () => Promise<boolean>;
      save: () => Promise<boolean>;
      addVectors: (entries: Array<{ id: string; vector: number[] }>) => Promise<number>;
      query: (centroid: number[], k: number) => Promise<Array<{ id: string; distance: number }>>;
      queryBatch: (entries: Array<{ id: string; vector: number[] }>, k: number) => Promise<Record<string, Array<{ id: string; distance: number }>>>;
      status: () => Promise<{ ready: boolean; vectorCount: number; dims: number }>;
      clear: () => Promise<boolean>;
    };
  }
}

class AnnIndexService {
  private _listeners = new Set<() => void>();
  private _ready = false;
  private _vectorCount = 0;
  private _buildProgress = { done: 0, total: 0 };
  private _building = false;

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() { this._listeners.forEach(fn => fn()); }

  get isReady(): boolean { return this._ready; }
  get vectorCount(): number { return this._vectorCount; }
  get isBuilding(): boolean { return this._building; }
  get buildProgress(): Readonly<{ done: number; total: number }> { return this._buildProgress; }

  async load(): Promise<boolean> {
    if (!window.ann) return false;
    try {
      const loaded = await window.ann.load();
      if (loaded) {
        const s = await window.ann.status();
        this._ready = s.ready;
        this._vectorCount = s.vectorCount;
        this._notify();
      }
      return loaded;
    } catch (err) {
      console.warn('[AnnIndex] load failed:', err);
      return false;
    }
  }

  async save(): Promise<boolean> {
    if (!window.ann) return false;
    try {
      return await window.ann.save();
    } catch (err) {
      console.warn('[AnnIndex] save failed:', err);
      return false;
    }
  }

  async addVectors(entries: Array<{ id: string; vector: number[] }>): Promise<number> {
    if (!window.ann || entries.length === 0) return 0;
    try {
      const added = await window.ann.addVectors(entries);
      if (added > 0) {
        this._vectorCount += added;
        this._ready = true;
        this._notify();
      }
      return added;
    } catch (err) {
      console.warn('[AnnIndex] addVectors failed:', err);
      return 0;
    }
  }

  async query(centroid: number[] | Float32Array, k: number): Promise<string[]> {
    if (!window.ann || !this._ready) return [];
    try {
      const centroidArray = centroid instanceof Float32Array ? Array.from(centroid) : centroid;
      const results = await window.ann.query(centroidArray, k);
      return results.map(r => r.id);
    } catch (err) {
      console.warn('[AnnIndex] query failed:', err);
      return [];
    }
  }

  async queryWithDistances(centroid: number[] | Float32Array, k: number): Promise<Array<{ id: string; distance: number }>> {
    if (!window.ann || !this._ready) return [];
    try {
      const centroidArray = centroid instanceof Float32Array ? Array.from(centroid) : centroid;
      return await window.ann.query(centroidArray, k);
    } catch (err) {
      console.warn('[AnnIndex] queryWithDistances failed:', err);
      return [];
    }
  }

  async queryBatch(entries: Array<{ id: string; vector: number[] }>, k: number): Promise<Record<string, Array<{ id: string; distance: number }>>> {
    if (!window.ann || !this._ready) return {};
    try {
      return await window.ann.queryBatch(entries, k);
    } catch (err) {
      console.warn('[AnnIndex] queryBatch failed:', err);
      return {};
    }
  }

  async refreshStatus(): Promise<void> {
    if (!window.ann) return;
    try {
      const s = await window.ann.status();
      this._ready = s.ready;
      this._vectorCount = s.vectorCount;
      this._notify();
    } catch { /* ignore */ }
  }

  setBuildProgress(done: number, total: number) {
    this._building = done < total;
    this._buildProgress = { done, total };
    this._notify();
  }

  finishBuild() {
    this._building = false;
    this._notify();
  }
}

export const annIndex = new AnnIndexService();
