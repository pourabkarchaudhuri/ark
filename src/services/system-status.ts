/**
 * System Status Service
 *
 * Unified live tracking of all background operations: sync pipelines,
 * recommendation engine, embedding generation, and storage metrics.
 * Singleton with subscribe/notify — UI components observe without driving.
 */

import { catalogStore } from './catalog-store';
import { epicCatalogStore } from './epic-catalog-store';
import { recoStore } from './reco-store';
import { embeddingService } from './embedding-service';
import { annIndex } from './ann-index';
import { getBuildStage, getBuildNodeCount, getBuildStepIndex, getBuildStepDetail, GALAXY_STEP_LABELS, subscribeGalaxy } from './galaxy-cache';
import { RERANK_TIER_LABELS, type RerankTier } from './oracle-rerank';

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

export interface EmbeddingModelStatus {
  name: string;
  installed: boolean;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
}

/** Qwen3 reranker — same shape as embedding model row in status panels. */
export type RerankModelStatus = EmbeddingModelStatus;

export interface MLModelStatus {
  loaded: boolean;
  modelCount: number;
  gameProfileCount: number;
  tagCount: number;
}

export interface SystemStatusSnapshot {
  epicSync: SyncStatus;
  epicCatalogSync: SyncStatus;
  steamBrowseSync: SyncStatus;
  steamCatalogSync: SyncStatus;
  recoPipeline: SyncStatus;
  catalogEmbeddings: SyncStatus;
  annIndexStatus: SyncStatus;
  galaxyBuild: SyncStatus;
  ollamaSetup: SyncStatus;
  rerankSetup: SyncStatus;
  embeddingModel: EmbeddingModelStatus | null;
  rerankModel: RerankModelStatus | null;
  mlModel: MLModelStatus | null;
  storage: StorageMetric[];
  totalStorageBytes: number;
}

type Listener = () => void;

/** Must match `EMBEDDING_MODEL_NAME` in electron/ollama-setup.ts (splash embedding row). */
const EMBEDDING_MODEL_DISPLAY_NAME = 'snowflake-arctic-embed2';

/** Fallback display name when IPC has not resolved the configured Qwen tag yet. */
const RERANK_QWEN_MODEL_DISPLAY_NAME = 'dengcao/Qwen3-Reranker-0.6B:Q8_0';

// ─── IDB Size Estimation ────────────────────────────────────────────────────────

const IDB_DATABASES: Array<{ label: string; subtitle?: string; dbName: string; version: number; stores: string[] }> = [
  { label: 'Steam Catalog', subtitle: 'excl. DLCs, demos & non-game apps', dbName: 'ark-steam-catalog', version: 1, stores: ['entries', 'meta'] },
  { label: 'Epic Catalog', dbName: 'ark-epic-catalog', version: 1, stores: ['entries', 'meta'] },
  { label: 'Browse Cache', dbName: 'ark-browse-cache', version: 1, stores: ['data'] },
  { label: 'Game Cache', dbName: 'ark-game-cache', version: 2, stores: ['games', 'genres', 'platforms', 'searchResults', 'metadata'] },
  { label: 'Catalog Cache', dbName: 'ark-catalog-cache', version: 1, stores: ['appList', 'meta'] },
  {
    label: 'Embeddings',
    dbName: 'ark-embeddings',
    version: 4,
    stores: ['embeddings', 'catalog-embeddings', 'embedding-meta', 'chunk-embeddings'],
  },
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
              // Rough size estimate: pooled int8 ~1536B, chunk rows ~1400B,
              // legacy float pooled was ~4KB; metadata/game stores smaller.
              const avgSize = storeName === 'chunk-embeddings' ? 1400
                : storeName === 'embeddings' || storeName === 'catalog-embeddings' ? 1536
                : storeName.includes('embedding') ? 1536
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

// ─── Ollama setup progress tracking ─────────────────────────────────────────────

let _ollamaSetupStatus: SyncStatus = { label: 'Ollama Setup', stage: 'idle', detail: '', percent: 0, elapsed: 0, itemsDone: 0, itemsTotal: 0 };
let _ollamaSetupStartTime = 0;

export function reportOllamaProgress(status: string, pct: number) {
  if (_ollamaSetupStartTime === 0) _ollamaSetupStartTime = performance.now();
  const elapsed = performance.now() - _ollamaSetupStartTime;
  const isFailed = /fail|error|not detected|timed? ?out/i.test(status);
  const isReady = !isFailed && (/ready|already installed|success/i.test(status));

  _ollamaSetupStatus = {
    ..._ollamaSetupStatus,
    stage: isReady ? 'done' : isFailed ? 'error' : 'running',
    detail: status,
    percent: isReady ? 100 : pct,
    elapsed,
  };
  systemStatus._notify();
  if (isReady) systemStatus.refreshStorage();
}

export function reportOllamaDone(available: boolean) {
  const elapsed = _ollamaSetupStartTime > 0 ? performance.now() - _ollamaSetupStartTime : 0;
  _ollamaSetupStatus = {
    ..._ollamaSetupStatus,
    stage: 'done',
    detail: available ? 'Model ready' : 'Running without embeddings',
    percent: 100,
    elapsed,
  };
  if (available) {
    systemStatus.seedEmbeddingModelKnownInstalled();
  }
  systemStatus._notify();
  systemStatus.refreshStorage();
}

// ─── Reranker setup / download tracking ─────────────────────────────────────────
//
// Fed by the dedicated `ollama:rerank-progress` IPC channel, which is separate
// from `ollama:setup-progress` because the ~600 MB Qwen3 pull outlives
// `ollama:setup`. Mirrors `RerankSetupProgress` in electron/ollama-setup.ts.

export interface RerankProgressEvent {
  status: string;
  pct: number;
  /** Only the terminal event sets this. */
  done?: boolean;
  tier?: string | null;
  tierLabel?: string | null;
  error?: string | null;
  /** False when Ollama never answered — then there is nothing to call an error. */
  ollamaUp?: boolean;
}

let _rerankSetupStatus: SyncStatus = { label: 'Reranker Setup', stage: 'idle', detail: '', percent: 0, elapsed: 0, itemsDone: 0, itemsTotal: 0 };
let _rerankSetupStartTime = 0;
let _rerankProgressSubscribed = false;

/**
 * Subscribe to `ollama:rerank-progress` for the app lifetime. Splash calls this
 * immediately; `systemStatus.init()` calls it again as a no-op. The channel
 * outlives `ollama:setup`, so the navbar must keep listening after splash exit.
 */
export function initRerankProgressListener(): void {
  if (_rerankProgressSubscribed) return;
  if (typeof window === 'undefined' || !window.ollama?.onRerankProgress) return;
  _rerankProgressSubscribed = true;
  window.ollama.onRerankProgress((ev) => reportRerankProgress(ev));
}

function asRerankTier(value: unknown): RerankTier | null {
  return value === 'native' || value === 'qwen_graded' || value === 'qwen_binary' || value === 'embed_fallback'
    ? value
    : null;
}

/**
 * The tier name always wins over the label the main process sent. A binary
 * Qwen3 tier must never be able to read as graded because of a stale or
 * mismatched label string.
 */
function rerankDetail(ev: RerankProgressEvent, tier: RerankTier | null): string {
  if (tier) return RERANK_TIER_LABELS[tier];
  return ev.tierLabel || ev.status || '';
}

export function reportRerankProgress(ev: RerankProgressEvent) {
  if (_rerankSetupStartTime === 0) _rerankSetupStartTime = performance.now();
  if (ev.done) {
    reportRerankDone(ev);
    return;
  }
  const pct = Number.isFinite(ev.pct) ? Math.max(0, Math.min(99, Math.round(ev.pct))) : 0;
  _rerankSetupStatus = {
    ..._rerankSetupStatus,
    stage: 'running',
    detail: ev.status,
    percent: pct,
    elapsed: performance.now() - _rerankSetupStartTime,
  };
  systemStatus._notify();
}

/**
 * Terminal event. `error` is reserved for the case where Ollama answered and
 * every tier above cosine still failed — an unreachable Ollama is a normal
 * degraded install, not a fault worth lighting the aggregate LED red.
 */
export function reportRerankDone(ev: RerankProgressEvent) {
  if (_rerankSetupStartTime === 0) _rerankSetupStartTime = performance.now();
  const tier = asRerankTier(ev.tier);
  const ollamaUp = ev.ollamaUp !== false;
  const failed = ollamaUp && !!ev.error;
  const detail = failed
    ? `${rerankDetail(ev, tier)} — ${ev.error}`
    : rerankDetail(ev, tier);

  _rerankSetupStatus = {
    ..._rerankSetupStatus,
    stage: failed ? 'error' : 'done',
    detail,
    percent: 100,
    elapsed: performance.now() - _rerankSetupStartTime,
  };
  if (!failed && (tier === 'qwen_graded' || tier === 'qwen_binary')) {
    systemStatus.seedRerankModelKnownInstalled();
  }
  systemStatus._notify();
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
  private _embeddingModelCache: EmbeddingModelStatus | null = null;
  private _rerankModelCache: RerankModelStatus | null = null;
  private _mlModelCache: MLModelStatus | null = null;
  private _catalogSyncStartTime = 0;
  private _recoPipelineStartTime = 0;
  private _initialized = false;
  private _storageTimer: ReturnType<typeof setInterval> | null = null;
  private _modelTimer: ReturnType<typeof setInterval> | null = null;
  private _rerankModelTimer: ReturnType<typeof setInterval> | null = null;
  private _mlModelTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumps when a newer model-info request supersedes older in-flight IPC — avoids stale "not installed". */
  private _modelInfoSeq = 0;
  private _rerankModelInfoSeq = 0;

  /** Refcount of UIs that want periodic IDB/Ollama probes (splash, open dropdown). */
  private _heavyPollingRefs = 0;
  private _baselineFetched = false;

  subscribe(fn: Listener): () => void {
    this._listeners.add(fn);
    // One-shot baseline only — no interval until acquireHeavyPolling()
    // (splash / dropdown open). Pipeline progress still arrives via _notify
    // from catalog/embedding/reco subscriptions in init().
    if (this._listeners.size === 1) this._ensureBaseline();
    return () => {
      this._listeners.delete(fn);
      if (this._listeners.size === 0) {
        this._heavyPollingRefs = 0;
        this._stopHeavyTimers();
        this._baselineFetched = false;
      }
    };
  }

  _notify() { this._listeners.forEach(fn => fn()); }

  private _ensureBaseline() {
    if (this._baselineFetched) return;
    this._baselineFetched = true;
    this._refreshStorage();
    this._refreshModelInfo();
    this._refreshRerankModelInfo();
    this._refreshMlModelInfo();
  }

  /**
   * Acquire periodic IDB + Ollama/ML probes while a status UI is visible.
   * Refcounted so splash + navbar dropdown don't stomp each other.
   * Leave unacquired while gaming so probes can't introduce jitter.
   */
  acquireHeavyPolling(): () => void {
    this._heavyPollingRefs += 1;
    if (this._heavyPollingRefs === 1) {
      this._ensureBaseline();
      if (!this._storageTimer) {
        this._storageTimer = setInterval(() => this._refreshStorage(), 120_000);
        this._modelTimer = setInterval(() => this._refreshModelInfo(), 300_000);
        this._rerankModelTimer = setInterval(() => this._refreshRerankModelInfo(), 300_000);
        this._mlModelTimer = setInterval(() => this._refreshMlModelInfo(), 300_000);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._heavyPollingRefs = Math.max(0, this._heavyPollingRefs - 1);
      if (this._heavyPollingRefs === 0) this._stopHeavyTimers();
    };
  }

  private _stopHeavyTimers() {
    if (this._storageTimer) { clearInterval(this._storageTimer); this._storageTimer = null; }
    if (this._modelTimer) { clearInterval(this._modelTimer); this._modelTimer = null; }
    if (this._rerankModelTimer) { clearInterval(this._rerankModelTimer); this._rerankModelTimer = null; }
    if (this._mlModelTimer) { clearInterval(this._mlModelTimer); this._mlModelTimer = null; }
    this._mlLoadAttempts = 0;
  }

  /** Start listening to all sub-services. Call once at app boot. */
  init() {
    if (this._initialized) return;
    this._initialized = true;

    initRerankProgressListener();

    catalogStore.subscribe(() => this._notify());
    epicCatalogStore.subscribe(() => this._notify());
    recoStore.subscribe(() => this._notify());
    embeddingService.subscribe(() => this._notify());

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

  private async _refreshModelInfo() {
    const seq = ++this._modelInfoSeq;
    try {
      if (!window.ollama?.getModelInfo) return;
      const info = await window.ollama.getModelInfo();
      if (seq !== this._modelInfoSeq) return;
      if (info) {
        this._embeddingModelCache = info;
        this._notify();
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Called when `ollama:setup` reports the embedding model is ready. Prevents the splash
   * panel from showing "Not installed" while an earlier timed-out `getModelInfo` is still
   * in flight, and supplies a correct row before Ollama responds to `/api/show` again.
   */
  seedEmbeddingModelKnownInstalled(): void {
    this._modelInfoSeq++;
    const prev = this._embeddingModelCache;
    this._embeddingModelCache = {
      name: EMBEDDING_MODEL_DISPLAY_NAME,
      installed: true,
      sizeBytes: prev?.sizeBytes ?? 0,
      parameterSize: prev?.parameterSize ?? '568M',
      quantization: prev?.quantization ?? 'F16',
    };
    this._notify();
  }

  private async _refreshRerankModelInfo() {
    const seq = ++this._rerankModelInfoSeq;
    try {
      if (!window.ollama?.getRerankModelInfo) return;
      const info = await window.ollama.getRerankModelInfo();
      if (seq !== this._rerankModelInfoSeq) return;
      if (info) {
        this._rerankModelCache = info;
        this._notify();
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Called when rerank setup reports a working Qwen tier. Prevents the status
   * panel from flashing "Not installed" while a stale IPC probe is in flight.
   */
  seedRerankModelKnownInstalled(): void {
    this._rerankModelInfoSeq++;
    const prev = this._rerankModelCache;
    this._rerankModelCache = {
      name: prev?.name ?? RERANK_QWEN_MODEL_DISPLAY_NAME,
      installed: true,
      sizeBytes: prev?.sizeBytes ?? 0,
      parameterSize: prev?.parameterSize ?? '0.6B',
      quantization: prev?.quantization ?? 'Q8_0',
    };
    this._notify();
  }

  private _mlLoadAttempts = 0;

  private async _refreshMlModelInfo() {
    try {
      if (!window.ml?.status) return;
      let info = await window.ml.status();
      if (info && !info.loaded && this._mlLoadAttempts < 3) {
        this._mlLoadAttempts++;
        const ok = await window.ml.load();
        if (ok) {
          info = await window.ml.status();
        }
      }
      if (info) {
        this._mlModelCache = info;
        this._notify();
      }
    } catch { /* non-fatal */ }
  }

  /** Force an immediate storage refresh. */
  refreshStorage() {
    this._refreshStorage();
    this._refreshModelInfo();
    this._refreshRerankModelInfo();
    this._refreshMlModelInfo();
  }

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
    const gStepIdx = getBuildStepIndex();
    const gStepDetail = getBuildStepDetail();

    // Map 4 build steps to progress ranges: 0→5%, 1→15%, 2→20-85%, 3→90%
    // Step 2 (UMAP/PCA projection) is the longest — its internal detail
    // carries epoch progress like "Optimizing layout... (234/500)".
    let gPercent = 0;
    let gDetail = '';
    if (gStage === 'done') {
      gPercent = 100;
      gDetail = `${gNodeCount.toLocaleString()} nodes`;
    } else if (gStage === 'running' && gStepIdx >= 0) {
      const stepLabel = GALAXY_STEP_LABELS[gStepIdx] ?? `Step ${gStepIdx}`;
      gDetail = gStepDetail ? `${stepLabel}: ${gStepDetail}` : stepLabel;
      // Fine-grained percent from step index + epoch detail
      if (gStepIdx === 0) {
        gPercent = 5;
      } else if (gStepIdx === 1) {
        gPercent = 15;
      } else if (gStepIdx === 2) {
        // Parse epoch progress from detail like "Optimizing layout... (234/500)"
        const epochMatch = gStepDetail?.match(/\((\d+)\/(\d+)\)/);
        if (epochMatch) {
          const epoch = parseInt(epochMatch[1], 10);
          const total = parseInt(epochMatch[2], 10);
          gPercent = total > 0 ? 20 + Math.round((epoch / total) * 65) : 30;
        } else {
          gPercent = 20;
        }
      } else if (gStepIdx === 3) {
        gPercent = 90;
      }
    } else if (gStage === 'running') {
      gPercent = 10;
      gDetail = 'Building galaxy map';
    } else if (gStage === 'waiting') {
      gPercent = 8;
      gDetail = 'Waiting for embeddings';
    } else if (gStage === 'scheduled') {
      gPercent = 3;
      gDetail = 'Queued';
    }

    const galaxyBuild: SyncStatus = {
      label: 'Embedding Space',
      stage: gStage === 'running' || gStage === 'waiting' || gStage === 'scheduled' ? 'running' : gStage === 'done' ? 'done' : 'idle',
      detail: gDetail,
      percent: gPercent,
      elapsed: 0,
      itemsDone: gStage === 'done' ? gNodeCount : 0,
      itemsTotal: gNodeCount,
    };

    // Epic Catalog Sync
    const epicCatP = epicCatalogStore.syncProgress;
    const epicCatalogSync: SyncStatus = {
      label: 'Epic Catalog',
      stage: epicCatP.stage === 'done' ? 'done'
        : epicCatP.stage === 'error' ? 'error'
          : epicCatP.stage === 'idle' ? 'idle' : 'running',
      detail: epicCatP.stage === 'fetching' ? 'Fetching catalog...'
        : epicCatP.stage === 'persisting' ? `Persisting ${epicCatP.itemsFetched.toLocaleString()} games`
          : epicCatP.stage === 'done' ? `${epicCatP.itemsStored.toLocaleString()} games`
            : epicCatP.stage === 'error' ? (epicCatP.error ?? 'Failed') : '',
      percent: epicCatP.stage === 'done' ? 100
        : epicCatP.stage === 'fetching' ? 30
          : epicCatP.stage === 'persisting' && epicCatP.itemsFetched > 0
            ? Math.round((epicCatP.itemsStored / epicCatP.itemsFetched) * 100)
            : 0,
      elapsed: 0,
      itemsDone: epicCatP.itemsStored,
      itemsTotal: epicCatP.itemsFetched,
    };

    const totalStorageBytes = this._storageCache.reduce((s, m) => s + m.sizeBytes, 0);

    return {
      epicSync: { ..._prefetchEpicStatus },
      epicCatalogSync,
      steamBrowseSync: { ..._prefetchSteamStatus },
      steamCatalogSync,
      recoPipeline,
      catalogEmbeddings,
      annIndexStatus,
      galaxyBuild,
      ollamaSetup: { ..._ollamaSetupStatus },
      rerankSetup: { ..._rerankSetupStatus },
      embeddingModel: this._embeddingModelCache ? { ...this._embeddingModelCache } : null,
      rerankModel: this._rerankModelCache ? { ...this._rerankModelCache } : null,
      mlModel: this._mlModelCache ? { ...this._mlModelCache } : null,
      storage: [...this._storageCache],
      totalStorageBytes,
    };
  }
}

export const systemStatus = new SystemStatus();
