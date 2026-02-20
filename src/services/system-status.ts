/**
 * System Status Service
 *
 * Unified live tracking of all background operations: sync pipelines,
 * recommendation engine, embedding generation, and storage metrics.
 * Singleton with subscribe/notify — UI components observe without driving.
 */

import { catalogStore } from './catalog-store';
import { recoStore } from './reco-store';
import { embeddingService } from './embedding-service';
import { annIndex } from './ann-index';
import { getBuildStage, getBuildNodeCount, subscribeGalaxy } from './galaxy-cache';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SyncStatus {
  label: string;
  stage: 'idle' | 'running' | 'done' | 'error';
  detail: string;
  percent: number;
  elapsed: number; // ms
  itemsDone: number;
  itemsTotal: number;
}

export interface StorageMetric {
  label: string;
  /** Optional clarification shown beneath the label (e.g. "excl. DLCs, software") */
  subtitle?: string;
  dbName: string;
  sizeBytes: number;
  entryCount: number;
}

export interface SystemStatusSnapshot {
  epicSync: SyncStatus;
  steamBrowseSync: SyncStatus;
  steamCatalogSync: SyncStatus;
  recoPipeline: SyncStatus;
  catalogEmbeddings: SyncStatus;
  annIndexStatus: SyncStatus;
  galaxyBuild: SyncStatus;
  storage: StorageMetric[];
  totalStorageBytes: number;
}

type Listener = () => void;

// ─── IDB Size Estimation ────────────────────────────────────────────────────────

const IDB_DATABASES: Array<{ label: string; subtitle?: string; dbName: string; version: number; stores: string[] }> = [
  { label: 'Steam Catalog', subtitle: 'excl. DLCs, demos & non-game apps', dbName: 'ark-steam-catalog', version: 1, stores: ['entries', 'meta'] },
  { label: 'Browse Cache', dbName: 'ark-browse-cache', version: 1, stores: ['data'] },
  { label: 'Game Cache', dbName: 'ark-game-cache', version: 2, stores: ['games', 'genres', 'platforms', 'searchResults', 'metadata'] },
  { label: 'Catalog Cache', dbName: 'ark-catalog-cache', version: 1, stores: ['appList', 'meta'] },
  { label: 'Embeddings', dbName: 'ark-embeddings', version: 2, stores: ['embeddings', 'catalog-embeddings'] },
  { label: 'Galaxy Cache', dbName: 'galaxy-cache', version: 1, stores: ['data'] },
];

async function measureIdbStore(dbName: string, version: number, stores: string[]): Promise<{ size: number; count: number }> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName, version);
      req.onerror = () => resolve({ size: 0, count: 0 });
      req.onblocked = () => resolve({ size: 0, count: 0 });
      req.onsuccess = () => {
        const db = req.result;
        let totalSize = 0;
        let totalCount = 0;
        let pending = 0;

        const existingStores = Array.from(db.objectStoreNames);
        const validStores = stores.filter(s => existingStores.includes(s));

        if (validStores.length === 0) {
          db.close();
          resolve({ size: 0, count: 0 });
          return;
        }

        for (const storeName of validStores) {
          pending++;
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const countReq = store.count();
            countReq.onsuccess = () => {
              const cnt = countReq.result ?? 0;
              totalCount += cnt;
              // Rough size estimate: 200 bytes per entry for metadata stores,
              // 4KB for embedding entries, 2KB for game entries
              const avgSize = storeName.includes('embedding') ? 4096
                : storeName === 'entries' ? 512
                : storeName === 'data' || storeName === 'games' ? 2048
                : 256;
              totalSize += cnt * avgSize;
              pending--;
              if (pending === 0) { db.close(); resolve({ size: totalSize, count: totalCount }); }
            };
            countReq.onerror = () => {
              pending--;
              if (pending === 0) { db.close(); resolve({ size: totalSize, count: totalCount }); }
            };
          } catch {
            pending--;
            if (pending === 0) { db.close(); resolve({ size: totalSize, count: totalCount }); }
          }
        }
      };
      req.onupgradeneeded = () => {
        // Don't create new stores, just cancel
        req.transaction?.abort();
        resolve({ size: 0, count: 0 });
      };
    } catch {
      resolve({ size: 0, count: 0 });
    }
  });
}

// ─── Prefetch progress tracking ─────────────────────────────────────────────────

let _prefetchEpicStatus: SyncStatus = { label: 'Epic Sync', stage: 'idle', detail: '', percent: 0, elapsed: 0, itemsDone: 0, itemsTotal: 0 };
let _prefetchSteamStatus: SyncStatus = { label: 'Steam Browse', stage: 'idle', detail: '', percent: 0, elapsed: 0, itemsDone: 0, itemsTotal: 0 };
let _prefetchStartTime = 0;
// Track individual source game counts so reportPrefetchDone shows accurate per-platform numbers
let _epicGameCount = 0;
let _steamGameCount = 0;

export function reportPrefetchStart() {
  _prefetchStartTime = performance.now();
  _epicGameCount = 0;
  _steamGameCount = 0;
  _prefetchEpicStatus = { ..._prefetchEpicStatus, stage: 'running', detail: 'Starting...', percent: 0 };
  _prefetchSteamStatus = { ..._prefetchSteamStatus, stage: 'running', detail: 'Starting...', percent: 0 };
  systemStatus._notify();
}

export function reportPrefetchStep(step: string, current: number, total: number, sourceGameCount?: number) {
  const elapsed = _prefetchStartTime ? performance.now() - _prefetchStartTime : 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  const isEpic = step.toLowerCase().includes('epic');
  const isSteam = step.toLowerCase().includes('steam');
  const isDedup = step.toLowerCase().includes('dedup') || step.toLowerCase().includes('aggregat');

  if (isEpic && sourceGameCount !== undefined) {
    _epicGameCount += sourceGameCount;
    _prefetchEpicStatus = { ..._prefetchEpicStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed, itemsDone: _epicGameCount, itemsTotal: total };
  } else if (isEpic) {
    _prefetchEpicStatus = { ..._prefetchEpicStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed, itemsDone: current, itemsTotal: total };
  }

  if (isSteam && sourceGameCount !== undefined) {
    _steamGameCount += sourceGameCount;
    _prefetchSteamStatus = { ..._prefetchSteamStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed, itemsDone: _steamGameCount, itemsTotal: total };
  } else if (isSteam) {
    _prefetchSteamStatus = { ..._prefetchSteamStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed, itemsDone: current, itemsTotal: total };
  }

  if (isDedup) {
    _prefetchEpicStatus = { ..._prefetchEpicStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed };
    _prefetchSteamStatus = { ..._prefetchSteamStatus, stage: 'running', detail: step, percent: Math.min(pct, 99), elapsed };
  }

  systemStatus._notify();
}

export function reportPrefetchDone(gameCount: number) {
  const elapsed = _prefetchStartTime ? performance.now() - _prefetchStartTime : 0;
  const fromCache = _epicGameCount === 0 && _steamGameCount === 0 && gameCount > 0;

  if (fromCache) {
    // Served from cache — no per-source breakdown available
    _prefetchEpicStatus = {
      ..._prefetchEpicStatus,
      stage: 'done',
      detail: 'Ready (cached)',
      percent: 100,
      elapsed,
    };
    _prefetchSteamStatus = {
      ..._prefetchSteamStatus,
      stage: 'done',
      detail: `${gameCount.toLocaleString()} games (cached)`,
      percent: 100,
      elapsed,
      itemsDone: gameCount,
      itemsTotal: gameCount,
    };
  } else {
    _prefetchEpicStatus = {
      ..._prefetchEpicStatus,
      stage: 'done',
      detail: _epicGameCount > 0 ? `${_epicGameCount.toLocaleString()} games` : 'No data',
      percent: 100,
      elapsed,
      itemsDone: _epicGameCount,
      itemsTotal: _epicGameCount,
    };
    _prefetchSteamStatus = {
      ..._prefetchSteamStatus,
      stage: 'done',
      detail: _steamGameCount > 0 ? `${_steamGameCount.toLocaleString()} games` : 'No data',
      percent: 100,
      elapsed,
      itemsDone: _steamGameCount,
      itemsTotal: _steamGameCount,
    };
  }
  systemStatus._notify();
}

export function reportPrefetchError(err: string) {
  const elapsed = _prefetchStartTime ? performance.now() - _prefetchStartTime : 0;
  if (_prefetchEpicStatus.stage !== 'done') _prefetchEpicStatus = { ..._prefetchEpicStatus, stage: 'error', detail: err, elapsed };
  if (_prefetchSteamStatus.stage !== 'done') _prefetchSteamStatus = { ..._prefetchSteamStatus, stage: 'error', detail: err, elapsed };
  systemStatus._notify();
}

// ─── System Status Singleton ────────────────────────────────────────────────────

class SystemStatus {
  private _listeners = new Set<Listener>();
  private _storageCache: StorageMetric[] = [];
  private _catalogSyncStartTime = 0;
  private _recoPipelineStartTime = 0;
  private _initialized = false;

  subscribe(fn: Listener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() { this._listeners.forEach(fn => fn()); }

  /** Start listening to all sub-services. Call once at app boot. */
  init() {
    if (this._initialized) return;
    this._initialized = true;

    catalogStore.subscribe(() => this._notify());
    recoStore.subscribe(() => this._notify());
    embeddingService.subscribe(() => this._notify());

    // Track when catalog sync starts for duration
    catalogStore.subscribe(() => {
      const p = catalogStore.syncProgress;
      if (p.stage === 'fetching-ids' && this._catalogSyncStartTime === 0) {
        this._catalogSyncStartTime = performance.now();
      }
      if (p.stage === 'done' || p.stage === 'error' || p.stage === 'idle') {
        // keep the elapsed time, don't reset
      }
    });

    recoStore.subscribe(() => {
      const s = recoStore.getState();
      if (s.status === 'computing' && this._recoPipelineStartTime === 0) {
        this._recoPipelineStartTime = performance.now();
      }
      if (s.status === 'done' || s.status === 'error') {
        // keep elapsed
      }
    });

    annIndex.subscribe(() => this._notify());
    subscribeGalaxy(() => this._notify());

    // Refresh storage metrics every 30s
    this._refreshStorage();
    setInterval(() => this._refreshStorage(), 30_000);
  }

  private async _refreshStorage() {
    const metrics: StorageMetric[] = [];
    for (const db of IDB_DATABASES) {
      const { size, count } = await measureIdbStore(db.dbName, db.version, db.stores);
      metrics.push({ label: db.label, subtitle: db.subtitle, dbName: db.dbName, sizeBytes: size, entryCount: count });
    }

    // Also measure localStorage
    let lsSize = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) lsSize += (localStorage.getItem(key)?.length ?? 0) * 2; // UTF-16
      }
    } catch { /* ignore */ }
    metrics.push({ label: 'LocalStorage', dbName: 'localStorage', sizeBytes: lsSize, entryCount: localStorage.length });

    this._storageCache = metrics;
    this._notify();
  }

  /** Force an immediate storage refresh. */
  refreshStorage() { this._refreshStorage(); }

  getSnapshot(): SystemStatusSnapshot {
    // Steam Catalog Sync
    const catP = catalogStore.syncProgress;
    const catElapsed = this._catalogSyncStartTime > 0
      ? performance.now() - this._catalogSyncStartTime : 0;
    const steamCatalogSync: SyncStatus = {
      label: 'Steam Catalog',
      stage: catP.stage === 'done' ? 'done'
        : catP.stage === 'error' ? 'error'
          : catP.stage === 'idle' ? 'idle' : 'running',
      detail: catP.stage === 'fetching-ids' ? 'Fetching app list...'
        : catP.stage === 'fetching-tags' ? 'Resolving tags...'
          : catP.stage === 'fetching-metadata' ? `Batch ${catP.batchesCompleted}/${catP.batchesTotal}`
            : catP.stage === 'done' ? `${catP.gamesStored.toLocaleString()} games`
              : catP.stage === 'error' ? (catP.error ?? 'Failed') : '',
      percent: catP.stage === 'done' ? 100
        : catP.batchesTotal > 0 ? Math.round((catP.batchesCompleted / catP.batchesTotal) * 100)
          : catP.stage === 'fetching-ids' ? 5
            : catP.stage === 'fetching-tags' ? 10 : 0,
      elapsed: catElapsed,
      itemsDone: catP.batchesCompleted,
      itemsTotal: catP.batchesTotal,
    };

    // Reco Pipeline
    const recoS = recoStore.getState();
    const recoElapsed = this._recoPipelineStartTime > 0
      ? (recoS.status === 'done' && recoS.computeTimeMs > 0 ? recoS.computeTimeMs : performance.now() - this._recoPipelineStartTime)
      : 0;
    const recoPipeline: SyncStatus = {
      label: 'Recommendation Engine',
      stage: recoS.status === 'done' ? 'done'
        : recoS.status === 'error' ? 'error'
          : recoS.status === 'computing' ? 'running' : 'idle',
      detail: recoS.status === 'computing'
        ? `${recoS.progress.stage}${recoS.progress.percent > 0 ? ` (${recoS.progress.percent}%)` : ''}`
        : recoS.status === 'done' ? `${recoS.shelves.length} shelves · ${recoS.candidateCount.toLocaleString()} candidates`
          : recoS.status === 'error' ? (recoS.error ?? 'Failed') : '',
      percent: recoS.progress.percent,
      elapsed: recoElapsed,
      itemsDone: recoS.libraryCount,
      itemsTotal: recoS.candidateCount,
    };

    // Catalog Embeddings
    const embP = embeddingService.catalogProgress;
    const embRunning = embeddingService.isCatalogRunning;
    const catalogEmbeddings: SyncStatus = {
      label: 'Catalog Embeddings',
      stage: embRunning ? 'running' : embP.total > 0 && embP.completed >= embP.total ? 'done' : 'idle',
      detail: embRunning
        ? (embP.total > 0 ? `${embP.completed.toLocaleString()} / ${embP.total.toLocaleString()}` : 'Comparing Embedding Deltas')
        : embP.total > 0 ? `${embP.total.toLocaleString()} vectors` : '',
      percent: embP.total > 0 ? Math.round((embP.completed / embP.total) * 100) : 0,
      elapsed: 0,
      itemsDone: embP.completed,
      itemsTotal: embP.total,
    };

    // ANN Index
    const annP = annIndex.buildProgress;
    const annReady = annIndex.isReady;
    const annBuilding = annIndex.isBuilding;
    const annIndexStatus: SyncStatus = {
      label: 'Approx Nearest Neighbors Index',
      stage: annBuilding ? 'running' : annReady ? 'done' : 'idle',
      detail: annReady
        ? `${annIndex.vectorCount.toLocaleString()} vectors`
        : annBuilding
          ? `${annP.done.toLocaleString()} / ${annP.total.toLocaleString()}`
          : '',
      percent: annBuilding && annP.total > 0
        ? Math.round((annP.done / annP.total) * 100)
        : annReady ? 100 : 0,
      elapsed: 0,
      itemsDone: annP.done,
      itemsTotal: annP.total,
    };

    // Galaxy Build (Embedding Space)
    const gStage = getBuildStage();
    const gNodeCount = getBuildNodeCount();
    const galaxyBuild: SyncStatus = {
      label: 'Embedding Space',
      stage: gStage === 'running' || gStage === 'waiting' || gStage === 'scheduled' ? 'running' : gStage === 'done' ? 'done' : 'idle',
      detail: gStage === 'scheduled' ? 'Queued'
        : gStage === 'waiting' ? 'Waiting for embeddings'
          : gStage === 'running' ? 'Building galaxy map'
            : gStage === 'done' ? `${gNodeCount.toLocaleString()} nodes` : '',
      percent: gStage === 'done' ? 100
        : gStage === 'running' ? 50
          : gStage === 'waiting' ? 10
            : gStage === 'scheduled' ? 5 : 0,
      elapsed: 0,
      itemsDone: gStage === 'done' ? gNodeCount : 0,
      itemsTotal: gNodeCount,
    };

    const totalStorageBytes = this._storageCache.reduce((s, m) => s + m.sizeBytes, 0);

    return {
      epicSync: { ..._prefetchEpicStatus },
      steamBrowseSync: { ..._prefetchSteamStatus },
      steamCatalogSync,
      recoPipeline,
      catalogEmbeddings,
      annIndexStatus,
      galaxyBuild,
      storage: [...this._storageCache],
      totalStorageBytes,
    };
  }
}

export const systemStatus = new SystemStatus();
