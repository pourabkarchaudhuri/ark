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
import { getEmbeddingDB, readPooledVector, type CachedEmbedding as PooledEmbedding } from './embedding-service';

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

interface GraphEmbeddingRow { gameId: string; embedding: number[] }

/** Read every cached embedding from both library and catalog stores (decode boundary). */
async function readAllEmbeddings(): Promise<GraphEmbeddingRow[]> {
  let db: IDBDatabase;
  try {
    db = await getEmbeddingDB();
  } catch {
    return [];
  }
  const all: GraphEmbeddingRow[] = [];
  const seen = new Set<string>();
  for (const storeName of ['embeddings', 'catalog-embeddings']) {
    if (!db.objectStoreNames.contains(storeName)) continue;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        for (const entry of (req.result as PooledEmbedding[])) {
          if (!entry?.gameId) continue;
          const vec = readPooledVector(entry);
          if (!vec) continue;
          if (seen.has(entry.gameId)) continue;
          seen.add(entry.gameId);
          all.push({ gameId: entry.gameId, embedding: Array.from(vec) });
        }
        resolve();
      };
      req.onerror = () => resolve();
    });
  }
  // Do not close the shared embedding DB — owned by embedding-service.
  return all;
}

class GameGraphStore {
  private _listeners = new Set<() => void>();
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

  /** Try restoring from IDB. Returns true if cached graph matches current ANN signature. */
  async tryRestore(annSignature: string): Promise<boolean> {
    try {
      const meta = await idbGet<GraphMeta>(META_KEY);
      if (!meta || meta.signature !== annSignature) return false;

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
  async build(annSignature: string, opts?: { force?: boolean; librarySeed?: LibrarySeed | null }): Promise<boolean> {
    if (!opts?.force && this._state.phase === 'building') return false;
    if (!opts?.force && await this.tryRestore(annSignature)) {
      return true;
    }
    if (!annIndex.isReady) {
      this._state = { phase: 'error', error: 'ANN index not ready' };
      this._notify();
      return false;
    }

    this._state = { phase: 'building', stage: 'Reading embeddings...', percent: 0 };
    this._notify();

    const embeddings = await readAllEmbeddings();
    if (embeddings.length === 0) {
      this._state = { phase: 'error', error: 'No embeddings cached' };
      this._notify();
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
      workerResult = await this._runMetricsWorker(nodeIds, edges, personalization);
    } catch (err) {
      this._state = { phase: 'error', error: err instanceof Error ? err.message : 'Metrics worker failed' };
      this._notify();
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
    this._adjacency = this._buildAdjacencyFromEdges(edges, nodeIds);
    this._meta = meta;

    await idbPut(META_KEY, meta);
    await idbPut(NODE_IDS_KEY, nodeIds);
    await idbPut(EDGES_KEY, edges);
    await idbPut(SCORES_KEY, this._scores);

    this._state = { phase: 'ready', meta };
    this._notify();
    return true;
  }

  private _runMetricsWorker(
    nodeIds: string[],
    edges: Float32Array,
    personalization: Float32Array | null,
  ): Promise<{
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
  }> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('../workers/graph-metrics.worker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        reject(err);
        return;
      }

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg?.type === 'progress') {
          const pct = 60 + Math.round((msg.percent / 100) * 40);
          this._state = { phase: 'building', stage: msg.stage, percent: pct };
          this._notify();
        } else if (msg?.type === 'result') {
          worker.terminate();
          // Defensive re-wrap. Structured-clone preserves typed-array types, but if a
          // worker host serializes via JSON or transfers buffers without the view,
          // we'd silently get plain ArrayBuffers and fail downstream `instanceof` checks.
          const wrapF = (v: Float32Array | null | undefined): Float32Array | null =>
            v ? (v instanceof Float32Array ? v : new Float32Array(v as unknown as ArrayBuffer)) : null;
          const wrapI32 = (v: Int32Array | undefined): Int32Array =>
            v instanceof Int32Array ? v : new Int32Array((v as unknown as ArrayBuffer) ?? 0);
          const wrapU16 = (v: Uint16Array | undefined): Uint16Array =>
            v instanceof Uint16Array ? v : new Uint16Array((v as unknown as ArrayBuffer) ?? 0);
          resolve({
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
          });
        } else if (msg?.type === 'error') {
          worker.terminate();
          reject(new Error(msg.error));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err.error ?? new Error(err.message ?? 'Worker errored'));
      };

      const transfers: ArrayBuffer[] = [edges.buffer as ArrayBuffer];
      if (personalization) transfers.push(personalization.buffer as ArrayBuffer);
      worker.postMessage({ type: 'compute', nodeIds, edges, personalization }, transfers);
    });
  }
}

export const gameGraphStore = new GameGraphStore();
