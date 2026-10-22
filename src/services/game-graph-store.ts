/**
 * Game Graph Store
 *
 * Builds a persisted graph of game-to-game similarity edges using the ANN index,
 * then computes community membership + PageRank + degree centrality via a
 * dedicated Web Worker. Edges are derived from the user's HNSW neighbor lookups.
 *
 * Persisted to IDB store `ark-game-graph` keyed by an ANN signature.
 * Invalidates automatically when the ANN index regenerates.
 *
 * Consumed by:
 *  - reco.worker.ts via `RecoWorkerInput.graphScores` (PageRank + community affinity layers)
 *  - Galaxy View (future phases) for constellation boundaries, gravity wells, brokers
 */

import { annIndex } from './ann-index';
import { embeddingService, getAllPooledEmbeddingsForGraph } from './embedding-service';

export interface GraphScores {
  pageRank: number;
  /** Personalized PageRank seeded on user library. 0 when no seed was provided at build time. */
  personalizedPageRank: number;
  /** HITS authority — high for cluster-internal "destinations". */
  authority: number;
  /** HITS hub — high for "routers" that link many authorities. */
  hub: number;
  community: number;
  degree: number;
}

export interface LibrarySeed {
  /** Map of gameId → engagement weight (e.g., log(playtime+1) + rating bonus). Non-zero entries seed PPR. */
  weights: Map<string, number>;
}

export interface GraphMeta {
  signature: string;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  builtAt: number;
  metricsBuiltAt: number;
}

type BuildState =
  | { phase: 'idle' }
  | { phase: 'building'; stage: string; percent: number }
  | { phase: 'ready'; meta: GraphMeta }
  | { phase: 'error'; error: string };

const DB_NAME = 'ark-game-graph';
const DB_VERSION = 1;
const STORE = 'graph';
const META_KEY = 'meta';
const EDGES_KEY = 'edges';
const NODE_IDS_KEY = 'nodeIds';
const SCORES_KEY = 'scores';

const NEIGHBORS_K = 10;
const QUERY_BATCH_SIZE = 200; // Tradeoff: larger = fewer IPC round-trips but bigger payloads

/**
 * Hard ceiling for the PageRank/PPR/HITS/Brandes/Louvain worker. It used to
 * have none, so a wedged worker left `phase: 'building'` forever and every
 * consumer waiting on the graph waited on nothing.
 */
export const GRAPH_METRICS_TIMEOUT_MS = 5 * 60_000;

/**
 * The ANN signature (`ann-${vectorCount}`) changes every time the background
 * catalog embedder adds vectors, so a signature mismatch alone must not force
 * a full rebuild (read every embedding + thousands of ANN queries + metrics).
 * With a graph already loaded, rebuild at most once per this interval and
 * never while catalog embedding is still running; the loaded graph keeps
 * serving in the meantime.
 */
export const GRAPH_REBUILD_MIN_INTERVAL_MS = 10 * 60_000;
/** Back-off after a failed build before another attempt is allowed. */
const GRAPH_BUILD_FAILURE_COOLDOWN_MS = 2 * 60_000;

function isCatalogEmbeddingRunning(): boolean {
  try {
    return embeddingService?.isCatalogRunning === true;
  } catch {
    return false;
  }
}

type MetricsWorkerResult = {
  pageRank: Float32Array;
  personalizedPageRank: Float32Array | null;
  authority: Float32Array;
  hub: Float32Array;
  nodeBetweenness: Float32Array | null;
  edgeBetweenness: Float32Array | null;
  prDelta: Float32Array | null;
  community: Int32Array;
  degree: Uint16Array;
  communityCount: number;
};

/**
 * Run the graph-metrics worker once with a hard timeout. On timeout the worker
 * is terminated and the promise rejects, so `build()` can flip the store to
 * `phase: 'error'` instead of staying in 'building' forever.
 */
export function runGraphMetricsWorker(
  createWorker: () => Worker,
  nodeIds: string[],
  edges: Float32Array,
  personalization: Float32Array | null,
  opts: { timeoutMs?: number; onProgress?: (stage: string, percent: number) => void } = {},
): Promise<MetricsWorkerResult> {
  const timeoutMs = opts.timeoutMs ?? GRAPH_METRICS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const settle = (apply: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* already gone */ }
      apply();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Graph metrics worker timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'progress') {
        if (!settled) opts.onProgress?.(msg.stage, msg.percent);
      } else if (msg?.type === 'result') {
        // Defensive re-wrap + copy. Structured-clone preserves typed-array types, but if a
        // worker host serializes via JSON or transfers buffers without the view,
        // we'd silently get plain ArrayBuffers and fail downstream `instanceof` checks.
        // Always allocate a fresh view so IDB never sees a detached buffer.
        const wrapF = (v: Float32Array | null | undefined): Float32Array | null => {
          if (!v) return null;
          const asF = v instanceof Float32Array ? v : new Float32Array(v as unknown as ArrayBuffer);
          return copyFloat32ForPersist(asF);
        };
        const wrapI32 = (v: Int32Array | undefined): Int32Array => {
          const asI = v instanceof Int32Array ? v : new Int32Array((v as unknown as ArrayBuffer) ?? 0);
          return copyInt32ForPersist(asI);
        };
        const wrapU16 = (v: Uint16Array | undefined): Uint16Array => {
          const asU = v instanceof Uint16Array ? v : new Uint16Array((v as unknown as ArrayBuffer) ?? 0);
          return copyUint16ForPersist(asU);
        };
        settle(() => resolve({
          pageRank: wrapF(msg.pageRank) ?? new Float32Array(0),
          personalizedPageRank: wrapF(msg.personalizedPageRank),
          authority: wrapF(msg.authority) ?? new Float32Array(0),
          hub: wrapF(msg.hub) ?? new Float32Array(0),
          nodeBetweenness: wrapF(msg.nodeBetweenness),
          edgeBetweenness: wrapF(msg.edgeBetweenness),
          prDelta: wrapF(msg.prDelta),
          community: wrapI32(msg.community),
          degree: wrapU16(msg.degree),
          communityCount: msg.communityCount,
        }));
      } else if (msg?.type === 'error') {
        settle(() => reject(new Error(msg.error)));
      }
    };
    worker.onerror = (err) => {
      settle(() => reject(err.error ?? new Error(err.message ?? 'Worker errored')));
    };

    // Transfer copies only — keep caller `edges` / `personalization` attached for
    // Phase C adjacency + idbPut (transferring would detach the originals).
    const { edgesForWorker, personalizationForWorker, transferList } =
      prepareGraphWorkerTransfer(edges, personalization);
    worker.postMessage(
      { type: 'compute', nodeIds, edges: edgesForWorker, personalization: personalizationForWorker },
      transferList,
    );
  });
}

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
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

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export type GraphScoreBuffers = {
  pageRank: Float32Array;
  personalizedPageRank: Float32Array | null;
  authority: Float32Array;
  hub: Float32Array;
  nodeBetweenness: Float32Array | null;
  edgeBetweenness: Float32Array | null;
  prDelta: Float32Array | null;
  community: Int32Array;
  degree: Uint16Array;
};

/**
 * Slice edges/personalization before worker transfer so the originals stay
 * attached for adjacency + IDB persist (transferring detaches the buffer).
 */
export function prepareGraphWorkerTransfer(
  edges: Float32Array,
  personalization: Float32Array | null,
): {
  edgesForWorker: Float32Array;
  personalizationForWorker: Float32Array | null;
  transferList: ArrayBuffer[];
} {
  const edgesForWorker = edges.slice();
  const personalizationForWorker = personalization ? personalization.slice() : null;
  const transferList: ArrayBuffer[] = [edgesForWorker.buffer as ArrayBuffer];
  if (personalizationForWorker) {
    transferList.push(personalizationForWorker.buffer as ArrayBuffer);
  }
  return { edgesForWorker, personalizationForWorker, transferList };
}

function isDetachedBuffer(view: ArrayBufferView): boolean {
  const buf = view.buffer as ArrayBuffer & { detached?: boolean };
  if (typeof buf.detached === 'boolean') return buf.detached;
  // Fallback: non-empty logical length over a zero-byte buffer ⇒ detached
  // (empty views also have byteLength 0, so length must be checked).
  return view.byteLength === 0 && (view as { length?: number }).length! > 0;
}

/** Fresh Float32Array for IDB; never returns a view over a detached buffer. */
export function copyFloat32ForPersist(
  view: Float32Array | null | undefined,
): Float32Array | null {
  if (!view) return null;
  if (isDetachedBuffer(view)) {
    return new Float32Array(view.length);
  }
  return new Float32Array(view);
}

function copyInt32ForPersist(view: Int32Array): Int32Array {
  if (isDetachedBuffer(view)) return new Int32Array(view.length);
  return new Int32Array(view);
}

function copyUint16ForPersist(view: Uint16Array): Uint16Array {
  if (isDetachedBuffer(view)) return new Uint16Array(view.length);
  return new Uint16Array(view);
}

/** Defensive copies so score buffers are always structured-clone / IDB safe. */
export function copyScoresForPersist(scores: GraphScoreBuffers): GraphScoreBuffers {
  return {
    pageRank: copyFloat32ForPersist(scores.pageRank) ?? new Float32Array(0),
    personalizedPageRank: copyFloat32ForPersist(scores.personalizedPageRank),
    authority: copyFloat32ForPersist(scores.authority) ?? new Float32Array(0),
    hub: copyFloat32ForPersist(scores.hub) ?? new Float32Array(0),
    nodeBetweenness: copyFloat32ForPersist(scores.nodeBetweenness),
    edgeBetweenness: copyFloat32ForPersist(scores.edgeBetweenness),
    prDelta: copyFloat32ForPersist(scores.prDelta),
    community: copyInt32ForPersist(scores.community),
    degree: copyUint16ForPersist(scores.degree),
  };
}

interface GraphEmbeddingRow { gameId: string; embedding: number[] }

/**
 * Read every cached embedding from both library and catalog pooled stores.
 * Routed entirely through `embedding-service.ts`'s public
 * `getAllPooledEmbeddingsForGraph()` so this file never needs to know which
 * storage backend (IndexedDB or LevelDB) actually holds the data.
 */
async function readAllEmbeddings(): Promise<GraphEmbeddingRow[]> {
  try {
    return await getAllPooledEmbeddingsForGraph();
  } catch {
    return [];
  }
}

export class GameGraphStore {
  constructor(private readonly _opts: { metricsTimeoutMs?: number } = {}) {}

  private _listeners = new Set<() => void>();
  /** Shared in-flight build — set synchronously, before any await, so concurrent callers join it. */
  private _buildPromise: Promise<boolean> | null = null;
  private _buildForced = false;
  private _lastBuildStartedAt = 0;
  private _lastBuildFailedAt = 0;
  private _maxPageRank: number | null = null;
  private _state: BuildState = { phase: 'idle' };
  private _nodeIds: string[] = [];
  private _idIndex = new Map<string, number>();
  private _scores: {
    pageRank: Float32Array;
    personalizedPageRank: Float32Array | null;
    authority: Float32Array;
    hub: Float32Array;
    /** Sampled Brandes — null when too small or computed pre-Wave-B. */
    nodeBetweenness: Float32Array | null;
    edgeBetweenness: Float32Array | null;
    /** Normalized PPR - PR signed delta — null when no library seed. */
    prDelta: Float32Array | null;
    community: Int32Array;
    degree: Uint16Array;
  } | null = null;
  private _edges: Float32Array | null = null;
  private _adjacency = new Map<string, Array<{ id: string; weight: number }>>();
  private _meta: GraphMeta | null = null;

  subscribe(fn: () => void): () => void { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  private _notify(): void { this._listeners.forEach((fn) => fn()); }

  get state(): BuildState { return this._state; }
  get isReady(): boolean { return this._state.phase === 'ready'; }
  get meta(): GraphMeta | null { return this._meta; }
  get nodeCount(): number { return this._nodeIds.length; }
  /** True while a (possibly older-signature) graph's scores are loaded in memory — usable even mid-rebuild. */
  get hasScores(): boolean { return this._scores != null; }
  /** True while a build/restore started via `build()` is in flight. */
  get isBuildInFlight(): boolean { return this._buildPromise != null; }

  hasNode(gameId: string): boolean {
    return this._idIndex.has(gameId);
  }

  /** Max PageRank across every node — the worker's global normalizer (memoized per graph). */
  getMaxPageRank(): number {
    if (!this._scores) return 0;
    if (this._maxPageRank == null) {
      let max = 0;
      const pr = this._scores.pageRank;
      for (let i = 0; i < pr.length; i++) if (pr[i] > max) max = pr[i];
      this._maxPageRank = max;
    }
    return this._maxPageRank;
  }

  /**
   * Scores for just these ids (unknown ids skipped). Oracle packs only its
   * candidate + user ids; `getAllScores()` materialized an object per node
   * (100K+) that was then structured-cloned to the worker on every compute.
   */
  getScoresFor(gameIds: Iterable<string>): Record<string, GraphScores> | null {
    if (!this._scores) return null;
    const out: Record<string, GraphScores> = {};
    const s = this._scores;
    for (const id of gameIds) {
      const i = this._idIndex.get(id);
      if (i === undefined || id in out) continue;
      out[id] = {
        pageRank: s.pageRank[i],
        personalizedPageRank: s.personalizedPageRank?.[i] ?? 0,
        authority: s.authority?.[i] ?? 0,
        hub: s.hub?.[i] ?? 0,
        community: s.community[i],
        degree: s.degree[i],
      };
    }
    return out;
  }

  /** Get aggregate graph scores for a single gameId. Returns null if graph not built. */
  getScores(gameId: string): GraphScores | null {
    if (!this._scores) return null;
    const idx = this._idIndex.get(gameId);
    if (idx === undefined) return null;
    return {
      pageRank: this._scores.pageRank[idx],
      personalizedPageRank: this._scores.personalizedPageRank?.[idx] ?? 0,
      authority: this._scores.authority[idx] ?? 0,
      hub: this._scores.hub[idx] ?? 0,
      community: this._scores.community[idx],
      degree: this._scores.degree[idx],
    };
  }

  /** Bulk lookup — used by reco-store to pre-pack into RecoWorkerInput.graphScores. */
  getAllScores(): Record<string, GraphScores> | null {
    if (!this._scores) return null;
    const out: Record<string, GraphScores> = {};
    const ppr = this._scores.personalizedPageRank;
    const auth = this._scores.authority;
    const hub = this._scores.hub;
    for (let i = 0; i < this._nodeIds.length; i++) {
      out[this._nodeIds[i]] = {
        pageRank: this._scores.pageRank[i],
        personalizedPageRank: ppr?.[i] ?? 0,
        authority: auth?.[i] ?? 0,
        hub: hub?.[i] ?? 0,
        community: this._scores.community[i],
        degree: this._scores.degree[i],
      };
    }
    return out;
  }

  /** Direct access to the typed-array score buffers — for shader attribute uploads (Galaxy view). */
  getScoreBuffers(): {
    nodeIds: string[];
    pageRank: Float32Array;
    personalizedPageRank: Float32Array | null;
    authority: Float32Array;
    hub: Float32Array;
    community: Int32Array;
    degree: Uint16Array;
  } | null {
    if (!this._scores) return null;
    return {
      nodeIds: this._nodeIds,
      pageRank: this._scores.pageRank,
      personalizedPageRank: this._scores.personalizedPageRank,
      authority: this._scores.authority,
      hub: this._scores.hub,
      community: this._scores.community,
      degree: this._scores.degree,
    };
  }

  /** Edge betweenness aligned with the input edges triple list. Null when not computed yet. */
  getEdgeBetweenness(): Float32Array | null {
    return this._scores?.edgeBetweenness ?? null;
  }

  /** Node betweenness — null when graph too small / skipped / pre-Wave-B cache. */
  getNodeBetweenness(): Float32Array | null {
    return this._scores?.nodeBetweenness ?? null;
  }

  /**
   * "Broker" set — Whisper Layer's liminal nodes.
   * Top 10% by sampled betweenness AND community size below median (per refined plan).
   * Computed lazily and memoized; reset when graph rebuilds.
   */
  private _brokerSet: Set<string> | null = null;
  getBrokerSet(): Set<string> {
    if (this._brokerSet) return this._brokerSet;
    const out = new Set<string>();
    if (!this._scores) { this._brokerSet = out; return out; }
    const nb = this._scores.nodeBetweenness;
    if (!nb || nb.length === 0) { this._brokerSet = out; return out; }
    // Community-size median (cheap on Int32Array)
    const communitySizes = new Map<number, number>();
    for (let i = 0; i < this._scores.community.length; i++) {
      const c = this._scores.community[i];
      if (c >= 0) communitySizes.set(c, (communitySizes.get(c) ?? 0) + 1);
    }
    const sizes = Array.from(communitySizes.values()).sort((a, b) => a - b);
    const medianSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0;
    // Top-10% betweenness threshold via partial sort
    const sortedBC = Array.from(nb).sort((a, b) => b - a);
    const tenthIdx = Math.max(0, Math.floor(sortedBC.length * 0.10) - 1);
    const bcThreshold = sortedBC[tenthIdx] ?? Infinity;
    for (let i = 0; i < this._nodeIds.length; i++) {
      if (nb[i] < bcThreshold) continue;
      const c = this._scores.community[i];
      const sz = communitySizes.get(c) ?? 0;
      if (sz > 0 && sz <= medianSize) out.add(this._nodeIds[i]);
    }
    this._brokerSet = out;
    return out;
  }

  /** Signed PPR-PR delta in [-1, 1]. Null when no library seed was provided. */
  getPRDelta(): Float32Array | null {
    return this._scores?.prDelta ?? null;
  }

  /** Packed edge triples [fromIdx, toIdx, weight] — needed by Fault Lines to read endpoint positions. */
  getEdges(): Float32Array | null {
    return this._edges;
  }

  /** Returns top-K neighbors (by edge weight = cosine similarity) of a gameId, or [] if none. */
  getNeighbors(gameId: string, k = 10): Array<{ id: string; weight: number }> {
    const list = this._adjacency.get(gameId);
    if (!list) return [];
    return list.slice(0, k);
  }

  /**
   * Try restoring from IDB. Returns true if cached graph matches current ANN signature.
   * With `acceptStale`, any persisted graph is restored even when the signature
   * moved on (catalog embedding churns it) — callers then decide, through the
   * throttled `build()`, whether a rebuild is due.
   */
  async tryRestore(annSignature: string, opts?: { acceptStale?: boolean }): Promise<boolean> {
    try {
      const meta = await idbGet<GraphMeta>(META_KEY);
      if (!meta) return false;
      if (meta.signature !== annSignature && !opts?.acceptStale) return false;

      const nodeIds = await idbGet<string[]>(NODE_IDS_KEY);
      const scoresRaw = await idbGet<{
        pageRank: Float32Array;
        personalizedPageRank?: Float32Array | null;
        authority?: Float32Array;
        hub?: Float32Array;
        nodeBetweenness?: Float32Array | null;
        edgeBetweenness?: Float32Array | null;
        prDelta?: Float32Array | null;
        community: Int32Array;
        degree: Uint16Array;
      }>(SCORES_KEY);
      const edgesRaw = await idbGet<Float32Array>(EDGES_KEY);
      if (!nodeIds || !scoresRaw || !edgesRaw) return false;

      this._nodeIds = nodeIds;
      this._idIndex = new Map();
      for (let i = 0; i < nodeIds.length; i++) this._idIndex.set(nodeIds[i], i);
      const pprRaw = scoresRaw.personalizedPageRank;
      // Pre-HITS persisted graphs may be missing auth/hub — treat as zeros, not a rebuild trigger.
      const n = nodeIds.length;
      const authRaw = scoresRaw.authority;
      const hubRaw = scoresRaw.hub;
      const nbRaw = scoresRaw.nodeBetweenness;
      const ebRaw = scoresRaw.edgeBetweenness;
      const prdRaw = scoresRaw.prDelta;
      this._scores = {
        pageRank: scoresRaw.pageRank instanceof Float32Array ? scoresRaw.pageRank : new Float32Array(scoresRaw.pageRank),
        personalizedPageRank: pprRaw
          ? (pprRaw instanceof Float32Array ? pprRaw : new Float32Array(pprRaw))
          : null,
        authority: authRaw
          ? (authRaw instanceof Float32Array ? authRaw : new Float32Array(authRaw))
          : new Float32Array(n),
        hub: hubRaw
          ? (hubRaw instanceof Float32Array ? hubRaw : new Float32Array(hubRaw))
          : new Float32Array(n),
        nodeBetweenness: nbRaw
          ? (nbRaw instanceof Float32Array ? nbRaw : new Float32Array(nbRaw))
          : null,
        edgeBetweenness: ebRaw
          ? (ebRaw instanceof Float32Array ? ebRaw : new Float32Array(ebRaw))
          : null,
        prDelta: prdRaw
          ? (prdRaw instanceof Float32Array ? prdRaw : new Float32Array(prdRaw))
          : null,
        community: scoresRaw.community instanceof Int32Array ? scoresRaw.community : new Int32Array(scoresRaw.community),
        degree: scoresRaw.degree instanceof Uint16Array ? scoresRaw.degree : new Uint16Array(scoresRaw.degree),
      };
      this._edges = edgesRaw instanceof Float32Array ? edgesRaw : new Float32Array(edgesRaw);
      this._adjacency = this._buildAdjacencyFromEdges(edgesRaw, nodeIds);
      this._meta = meta;
      this._brokerSet = null; // invalidate memoized broker set on restore
      this._maxPageRank = null;
      this._state = { phase: 'ready', meta };
      this._notify();
      return true;
    } catch (err) {
      console.warn('[GameGraph] restore failed:', err);
      return false;
    }
  }

  private _buildAdjacencyFromEdges(edges: Float32Array, nodeIds: string[]): Map<string, Array<{ id: string; weight: number }>> {
    const adj = new Map<string, Array<{ id: string; weight: number }>>();
    const tripleCount = edges.length / 3;
    for (let i = 0; i < tripleCount; i++) {
      const fromIdx = edges[i * 3];
      const toIdx = edges[i * 3 + 1];
      const w = edges[i * 3 + 2];
      const fromId = nodeIds[fromIdx];
      const toId = nodeIds[toIdx];
      if (!fromId || !toId) continue;
      if (!adj.has(fromId)) adj.set(fromId, []);
      if (!adj.has(toId)) adj.set(toId, []);
      adj.get(fromId)!.push({ id: toId, weight: w });
      adj.get(toId)!.push({ id: fromId, weight: w });
    }
    for (const list of adj.values()) list.sort((a, b) => b.weight - a.weight);
    return adj;
  }

  /**
   * Build the graph end-to-end:
   *  1. Read all cached embeddings
   *  2. Batch-query ANN for each → edge list
   *  3. Persist edge list
   *  4. Spawn worker for PageRank + PPR + Louvain + degree
   *  5. Persist scores
   *
   * @param librarySeed Optional engagement-weighted user library map (gameId → weight).
   *                    When provided, the worker computes Personalized PageRank seeded
   *                    on these nodes — the foundation for Frontier Aurora.
   */
  build(annSignature: string, opts?: { force?: boolean; librarySeed?: LibrarySeed | null }): Promise<boolean> {
    // Join an in-flight build instead of racing a second one. Claimed synchronously so
    // two callers in the same tick cannot both start. A forced build (PPR seed repair)
    // queues behind an unforced one rather than being absorbed by it.
    if (this._buildPromise) {
      if (opts?.force && !this._buildForced) return this._buildPromise.then(() => this.build(annSignature, opts));
      return this._buildPromise;
    }
    if (this.isRebuildThrottled(annSignature, opts?.force === true)) {
      return Promise.resolve(this._scores != null);
    }
    this._buildForced = opts?.force === true;
    const p = this._doBuild(annSignature, opts).finally(() => {
      if (this._buildPromise === p) this._buildPromise = null;
    });
    this._buildPromise = p;
    return p;
  }
  /**
   * True when a rebuild should be skipped for now: a graph is already loaded
   * and either one was (re)built recently, or catalog embedding is still
   * moving the ANN signature. Also backs off after a failed build.
   */
  isRebuildThrottled(annSignature: string, force = false): boolean {
    const now = Date.now();
    if (this._lastBuildFailedAt > 0 && now - this._lastBuildFailedAt < GRAPH_BUILD_FAILURE_COOLDOWN_MS) {
      return true;
    }
    if (!this._scores || !this._meta) return false; // nothing to serve — must build
    if (!force && this._meta.signature === annSignature) return false; // cheap restore/no-op path
    const last = Math.max(this._meta.builtAt, this._lastBuildStartedAt);
    if (now - last < GRAPH_REBUILD_MIN_INTERVAL_MS) return true;
    if (isCatalogEmbeddingRunning()) return true;
    return false;
  }

  private async _doBuild(annSignature: string, opts?: { force?: boolean; librarySeed?: LibrarySeed | null }): Promise<boolean> {
    this._lastBuildStartedAt = Date.now();
    if (!opts?.force && await this.tryRestore(annSignature)) {
      return true;
    }
    if (!annIndex.isReady) {
      this._failBuild('ANN index not ready');
      return false;
    }

    this._state = { phase: 'building', stage: 'Reading embeddings...', percent: 0 };
    this._notify();

    const embeddings = await readAllEmbeddings();
    if (embeddings.length === 0) {
      this._failBuild('No embeddings cached', { cooldown: true });
      return false;
    }

    const nodeIds = embeddings.map((e) => e.gameId);
    const idIndex = new Map<string, number>();
    for (let i = 0; i < nodeIds.length; i++) idIndex.set(nodeIds[i], i);

    // Phase A — query ANN in batches, collect deduplicated undirected edges
    const edgeSet = new Map<string, number>(); // "minIdx-maxIdx" → cosine similarity
    const totalBatches = Math.ceil(embeddings.length / QUERY_BATCH_SIZE);
    for (let b = 0; b < totalBatches; b++) {
      const slice = embeddings.slice(b * QUERY_BATCH_SIZE, (b + 1) * QUERY_BATCH_SIZE);
      const entries = slice.map((e) => ({ id: e.gameId, vector: e.embedding }));
      const result = await annIndex.queryBatch(entries, NEIGHBORS_K);

      for (const [fromId, neighbors] of Object.entries(result)) {
        const fromIdx = idIndex.get(fromId);
        if (fromIdx === undefined) continue;
        for (const n of neighbors) {
          const toIdx = idIndex.get(n.id);
          if (toIdx === undefined || toIdx === fromIdx) continue;
          // usearch returns COSINE DISTANCE; similarity = 1 - distance, clamped >= 0
          const sim = Math.max(0, 1 - n.distance);
          if (sim <= 0) continue;
          const lo = Math.min(fromIdx, toIdx);
          const hi = Math.max(fromIdx, toIdx);
          const key = `${lo}-${hi}`;
          const prev = edgeSet.get(key) ?? 0;
          if (sim > prev) edgeSet.set(key, sim);
        }
      }

      const percent = Math.round(((b + 1) / totalBatches) * 55);
      this._state = { phase: 'building', stage: `ANN queries ${b + 1}/${totalBatches}`, percent };
      this._notify();
    }

    // Pack edges into Float32Array as packed triples
    const edges = new Float32Array(edgeSet.size * 3);
    let i = 0;
    for (const [key, weight] of edgeSet) {
      const dash = key.indexOf('-');
      const from = Number(key.slice(0, dash));
      const to = Number(key.slice(dash + 1));
      edges[i * 3] = from;
      edges[i * 3 + 1] = to;
      edges[i * 3 + 2] = weight;
      i++;
    }

    this._state = { phase: 'building', stage: 'Computing graph metrics...', percent: 60 };
    this._notify();

    // Build the personalization vector for PPR. Missing seed entries map to 0.
    let personalization: Float32Array | null = null;
    if (opts?.librarySeed && opts.librarySeed.weights.size > 0) {
      personalization = new Float32Array(nodeIds.length);
      for (const [gameId, weight] of opts.librarySeed.weights) {
        const idx = idIndex.get(gameId);
        if (idx !== undefined && weight > 0) personalization[idx] = weight;
      }
    }

    // Phase B — spawn worker for PageRank/PPR/HITS/Brandes/Louvain/degree
    let workerResult: {
      pageRank: Float32Array;
      personalizedPageRank: Float32Array | null;
      authority: Float32Array;
      hub: Float32Array;
      nodeBetweenness: Float32Array | null;
      edgeBetweenness: Float32Array | null;
      prDelta: Float32Array | null;
      community: Int32Array;
      degree: Uint16Array;
      communityCount: number;
    };
    try {
      workerResult = await runGraphMetricsWorker(
        () => new Worker(new URL('../workers/graph-metrics.worker.ts', import.meta.url), { type: 'module' }),
        nodeIds,
        edges,
        personalization,
        {
          timeoutMs: this._opts.metricsTimeoutMs,
          onProgress: (stage, percent) => {
            const pct = 60 + Math.round((percent / 100) * 40);
            this._state = { phase: 'building', stage, percent: pct };
            this._notify();
          },
        },
      );
    } catch (err) {
      console.warn('[GameGraph] metrics worker failed:', err);
      this._failBuild(err instanceof Error ? err.message : 'Metrics worker failed', { cooldown: true });
      return false;
    }

    // Phase C — persist + commit in-memory
    const now = Date.now();
    const meta: GraphMeta = {
      signature: annSignature,
      nodeCount: nodeIds.length,
      edgeCount: edges.length / 3,
      communityCount: workerResult.communityCount,
      builtAt: now,
      metricsBuiltAt: now,
    };

    this._nodeIds = nodeIds;
    this._idIndex = idIndex;
    this._scores = {
      pageRank: workerResult.pageRank,
      personalizedPageRank: workerResult.personalizedPageRank,
      authority: workerResult.authority,
      hub: workerResult.hub,
      nodeBetweenness: workerResult.nodeBetweenness,
      edgeBetweenness: workerResult.edgeBetweenness,
      prDelta: workerResult.prDelta,
      community: workerResult.community,
      degree: workerResult.degree,
    };
    this._edges = edges;
    this._brokerSet = null; // invalidate memoized broker set on rebuild
    this._maxPageRank = null;
    this._lastBuildFailedAt = 0;
    this._adjacency = this._buildAdjacencyFromEdges(edges, nodeIds);
    this._meta = meta;

    await idbPut(META_KEY, meta);
    await idbPut(NODE_IDS_KEY, nodeIds);
    await idbPut(EDGES_KEY, edges);
    await idbPut(SCORES_KEY, copyScoresForPersist(this._scores));

    this._state = { phase: 'ready', meta };
    this._notify();
    return true;
  }

  /**
   * Record a failed build. When an older graph is still loaded it keeps
   * serving (phase back to 'ready' on its own meta) instead of every consumer
   * losing graph signals over a failed refresh.
   */
  private _failBuild(error: string, opts?: { cooldown?: boolean }): void {
    if (opts?.cooldown) this._lastBuildFailedAt = Date.now();
    if (this._scores && this._meta) {
      console.warn(`[GameGraph] build failed (${error}) — keeping previously loaded graph`);
      this._state = { phase: 'ready', meta: this._meta };
    } else {
      this._state = { phase: 'error', error };
    }
    this._notify();
  }
}

export const gameGraphStore = new GameGraphStore();
