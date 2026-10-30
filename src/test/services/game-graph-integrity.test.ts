/**
 * GameGraphStore integrity + memory:
 *  - getNeighbors reads a lazily built CSR instead of ~2M {id, weight} objects,
 *    with the same ids / weights / order as the old per-node Map.
 *  - Phase A dedups through numeric pair keys; packed edges are unchanged.
 *  - Persist is one atomic transaction; a failed persist keeps the in-memory graph.
 *  - tryRestore treats parts that disagree as a miss.
 *  - ANN batch failures (`{}` results) fail the build instead of saving a damaged graph.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Neighbor = { id: string; distance: number };

const ann = vi.hoisted(() => ({
  isReady: true,
  vectorCount: 0,
  /** Ids whose whole batch comes back `{}` (simulated ANN error). */
  failIds: new Set<string>(),
  neighbors: new Map<string, Neighbor[]>(),
}));

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    get isReady() { return ann.isReady; },
    get vectorCount() { return ann.vectorCount; },
    queryBatch: vi.fn(async (entries: Array<{ id: string }>) => {
      if (entries.some((e) => ann.failIds.has(e.id))) return {};
      const out: Record<string, Neighbor[]> = {};
      for (const e of entries) out[e.id] = ann.neighbors.get(e.id) ?? [];
      return out;
    }),
  },
}));

const emb = vi.hoisted(() => ({ rows: [] as Array<{ gameId: string; embedding: Float32Array }> }));

vi.mock('@/services/embedding-service', () => ({
  embeddingService: { isCatalogRunning: false, isAnnRebuilding: false, isHeavyRebuildCooldown: false },
  getAllPooledEmbeddingsForGraph: vi.fn(async () => emb.rows),
  isRendererHeapPressureHigh: () => false,
}));

import {
  GameGraphStore,
  buildNeighborCsr,
  isPersistedGraphConsistent,
  putGraphRecordsAtomic,
  type GraphRecord,
} from '@/services/game-graph-store';
import { annIndex } from '@/services/ann-index';

/** Worker stand-in that answers every compute with flat scores sized to nodeIds. */
class AnsweringWorker {
  static posted: Array<{ nodeIds: string[]; edges: Float32Array }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(msg: { nodeIds: string[]; edges: Float32Array }) {
    AnsweringWorker.posted.push({ nodeIds: msg.nodeIds, edges: new Float32Array(msg.edges) });
    const n = msg.nodeIds.length;
    queueMicrotask(() => this.onmessage?.({
      data: {
        type: 'result',
        pageRank: new Float32Array(n).fill(1 / Math.max(1, n)),
        personalizedPageRank: null,
        authority: new Float32Array(n),
        hub: new Float32Array(n),
        nodeBetweenness: null,
        edgeBetweenness: null,
        prDelta: null,
        community: new Int32Array(n),
        degree: new Uint16Array(n),
        communityCount: 1,
      },
    } as MessageEvent));
  }
  terminate() { /* noop */ }
}

/** The pre-change adjacency: per-node object lists, stable-sorted by weight desc. */
function referenceAdjacency(edges: Float32Array, nodeIds: string[]): Map<string, Array<{ id: string; weight: number }>> {
  const adj = new Map<string, Array<{ id: string; weight: number }>>();
  for (let i = 0; i < edges.length / 3; i++) {
    const fromId = nodeIds[edges[i * 3]];
    const toId = nodeIds[edges[i * 3 + 1]];
    const w = edges[i * 3 + 2];
    if (!fromId || !toId) continue;
    if (!adj.has(fromId)) adj.set(fromId, []);
    if (!adj.has(toId)) adj.set(toId, []);
    adj.get(fromId)!.push({ id: toId, weight: w });
    adj.get(toId)!.push({ id: fromId, weight: w });
  }
  for (const list of adj.values()) list.sort((a, b) => b.weight - a.weight);
  return adj;
}

/** Pre-change Phase A dedup with template-string keys. */
function referencePackedEdges(nodeIds: string[], results: Record<string, Neighbor[]>): Float32Array {
  const idIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const edgeSet = new Map<string, number>();
  for (const [fromId, neighbors] of Object.entries(results)) {
    const fromIdx = idIndex.get(fromId);
    if (fromIdx === undefined) continue;
    for (const n of neighbors) {
      const toIdx = idIndex.get(n.id);
      if (toIdx === undefined || toIdx === fromIdx) continue;
      const sim = Math.max(0, 1 - n.distance);
      if (sim <= 0) continue;
      const key = `${Math.min(fromIdx, toIdx)}-${Math.max(fromIdx, toIdx)}`;
      if (sim > (edgeSet.get(key) ?? 0)) edgeSet.set(key, sim);
    }
  }
  const out = new Float32Array(edgeSet.size * 3);
  let i = 0;
  for (const [key, w] of edgeSet) {
    const [a, b] = key.split('-').map(Number);
    out[i * 3] = a; out[i * 3 + 1] = b; out[i * 3 + 2] = w;
    i++;
  }
  return out;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

/** n nodes with up to 10 random neighbours each; weights rounded so ties happen. */
function fixture(n: number, seed = 7): { ids: string[]; results: Record<string, Neighbor[]> } {
  const rnd = seeded(seed);
  const ids = Array.from({ length: n }, (_, i) => `steam-${1000 + i}`);
  const results: Record<string, Neighbor[]> = {};
  for (let i = 0; i < n; i++) {
    const list: Neighbor[] = [];
    for (let k = 0; k < 10; k++) {
      const j = Math.floor(rnd() * n);
      list.push({ id: ids[j], distance: Math.round(rnd() * 10) / 20 });
    }
    results[ids[i]] = list;
  }
  return { ids, results };
}

function loadFixture(ids: string[], results: Record<string, Neighbor[]>) {
  emb.rows = ids.map((gameId) => ({ gameId, embedding: new Float32Array([1, 0]) }));
  ann.neighbors = new Map(Object.entries(results));
  ann.vectorCount = ids.length;
}

async function wipeGraphDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.open('ark-game-graph', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('graph')) req.result.createObjectStore('graph'); };
    req.onsuccess = () => {
      const tx = req.result.transaction('graph', 'readwrite');
      tx.objectStore('graph').clear();
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
  });
}

async function writeRaw(records: Array<[string, unknown]>): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.open('ark-game-graph', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('graph')) req.result.createObjectStore('graph'); };
    req.onsuccess = () => {
      const tx = req.result.transaction('graph', 'readwrite');
      for (const [k, v] of records) tx.objectStore('graph').put(v, k);
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
  });
}

beforeEach(async () => {
  AnsweringWorker.posted = [];
  vi.stubGlobal('Worker', AnsweringWorker);
  ann.isReady = true;
  ann.failIds = new Set();
  await wipeGraphDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildNeighborCsr / getNeighbors', () => {
  it('matches the old Map adjacency (ids, weights, order incl. ties) for every node', () => {
    const { ids, results } = fixture(300);
    const edges = referencePackedEdges(ids, results);
    const csr = buildNeighborCsr(edges, ids.length);
    const ref = referenceAdjacency(edges, ids);
    for (let u = 0; u < ids.length; u++) {
      const got: Array<{ id: string; weight: number }> = [];
      for (let j = csr.offsets[u]; j < csr.offsets[u + 1]; j++) got.push({ id: ids[csr.nbr[j]], weight: csr.w[j] });
      expect(got).toEqual(ref.get(ids[u]) ?? []);
    }
  });

  it('store.getNeighbors(id, k) equals the old lists after a build, and the CSR is rebuilt after a rebuild', async () => {
    const { ids, results } = fixture(120, 11);
    loadFixture(ids, results);
    const store = new GameGraphStore({ persist: async () => {} });
    expect(await store.build('sig-a')).toBe(true);
    const edges = store.getEdges()!;
    expect(Array.from(edges)).toEqual(Array.from(referencePackedEdges(ids, results)));
    const ref = referenceAdjacency(edges, ids);
    for (const id of ids) {
      expect(store.getNeighbors(id, 5)).toEqual((ref.get(id) ?? []).slice(0, 5));
      expect(store.getNeighbors(id, 100)).toEqual(ref.get(id) ?? []);
    }
    expect(store.getNeighbors('unknown-id')).toEqual([]);

    // Rebuild the same store on a different fixture (past the rebuild throttle):
    // neighbours must follow the new edges, not the CSR built above.
    const next = fixture(120, 99);
    loadFixture(next.ids, next.results);
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
    try {
      expect(await store.build('sig-b', { force: true })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const ref2 = referenceAdjacency(store.getEdges()!, next.ids);
    for (const id of next.ids) expect(store.getNeighbors(id, 50)).toEqual(ref2.get(id) ?? []);
    expect(ref2).not.toEqual(ref);
  });
});

describe('graph persistence', () => {
  it('writes all four keys in one transaction, META last', async () => {
    const { ids, results } = fixture(20);
    loadFixture(ids, results);
    const persist = vi.fn(async (_records: ReadonlyArray<GraphRecord>) => {});
    const store = new GameGraphStore({ persist });
    expect(await store.build('sig-p')).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].map(([k]) => k)).toEqual(['nodeIds', 'edges', 'scores', 'meta']);
  });

  it('a persist that rejects keeps the in-memory graph serving', async () => {
    const { ids, results } = fixture(20);
    loadFixture(ids, results);
    const store = new GameGraphStore({ persist: async () => { throw new Error('quota'); } });
    expect(await store.build('sig-q')).toBe(true);
    expect(store.state.phase).toBe('ready');
    expect(store.getScores(ids[0])).not.toBeNull();
  });

  it('putGraphRecordsAtomic rejects when the SCORES put aborts the transaction (nothing lands)', async () => {
    const puts: string[] = [];
    const tx: Partial<IDBTransaction> & { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null } = {
      oncomplete: null, onerror: null, onabort: null, error: null,
      objectStore: () => ({
        put: (_v: unknown, key: IDBValidKey) => {
          puts.push(String(key));
          if (key === 'scores') queueMicrotask(() => tx.onabort?.());
          return {} as IDBRequest;
        },
      }) as unknown as IDBObjectStore,
    };
    const db = { transaction: () => tx } as unknown as IDBDatabase;
    await expect(putGraphRecordsAtomic(db, [['nodeIds', []], ['edges', 1], ['scores', 2], ['meta', 3]])).rejects.toThrow(/aborted/);
    expect(puts).toEqual(['nodeIds', 'edges', 'scores', 'meta']);
  });

  it('round-trips through real IDB: a build persists and a new store restores it', async () => {
    const { ids, results } = fixture(30);
    loadFixture(ids, results);
    const a = new GameGraphStore();
    expect(await a.build('sig-r')).toBe(true);
    const b = new GameGraphStore();
    expect(await b.tryRestore('sig-r')).toBe(true);
    expect(b.nodeCount).toBe(ids.length);
    expect(b.getNeighbors(ids[1], 50)).toEqual(a.getNeighbors(ids[1], 50));
  });
});

describe('tryRestore consistency', () => {
  const meta = { signature: 's', nodeCount: 3, edgeCount: 1, communityCount: 1, builtAt: 1, metricsBuiltAt: 1 };
  const scores = (n: number) => ({
    pageRank: new Float32Array(n), community: new Int32Array(n), degree: new Uint16Array(n),
    authority: new Float32Array(n), hub: new Float32Array(n),
  });

  it('isPersistedGraphConsistent flags every mismatch', () => {
    const ids = ['a', 'b', 'c'];
    const edges = new Float32Array([0, 1, 0.5]);
    expect(isPersistedGraphConsistent(meta, ids, scores(3), edges)).toBe(true);
    expect(isPersistedGraphConsistent(meta, ['a', 'b'], scores(3), edges)).toBe(false);
    expect(isPersistedGraphConsistent(meta, ids, scores(2), edges)).toBe(false);
    expect(isPersistedGraphConsistent(meta, ids, { ...scores(3), degree: new Uint16Array(4) }, edges)).toBe(false);
    expect(isPersistedGraphConsistent(meta, ids, scores(3), new Float32Array(6))).toBe(false);
  });

  it('returns false for new node ids next to an older build\'s scores (also with acceptStale)', async () => {
    await writeRaw([
      ['meta', meta],
      ['nodeIds', ['a', 'b', 'c']],
      ['scores', scores(2)],
      ['edges', new Float32Array([0, 1, 0.5])],
    ]);
    const store = new GameGraphStore();
    expect(await store.tryRestore('s')).toBe(false);
    expect(await store.tryRestore('other', { acceptStale: true })).toBe(false);
    expect(store.hasScores).toBe(false);
  });

  it('returns false when the edge buffer length disagrees with meta.edgeCount', async () => {
    await writeRaw([
      ['meta', meta],
      ['nodeIds', ['a', 'b', 'c']],
      ['scores', scores(3)],
      ['edges', new Float32Array([0, 1, 0.5, 1, 2, 0.4])],
    ]);
    expect(await new GameGraphStore().tryRestore('s')).toBe(false);
  });
});

describe('ANN query failures during a build', () => {
  /** 100 nodes, batch size 1 → 100 batches; `failing` of them return `{}`. */
  function setup(failing: number) {
    const { ids, results } = fixture(100, 5);
    loadFixture(ids, results);
    ann.failIds = new Set(ids.slice(0, failing));
    return ids;
  }

  it('10% failed batches: build fails with cooldown, nothing persisted, previous graph keeps serving', async () => {
    // First a good graph, persisted.
    const ids = setup(0);
    const persisted: Array<ReadonlyArray<GraphRecord>> = [];
    const store = new GameGraphStore({ queryBatchSize: 1, persist: async (r) => { persisted.push(r); } });
    expect(await store.build('sig-good')).toBe(true);
    expect(persisted).toHaveLength(1);
    const before = store.getScores(ids[5]);

    setup(10);
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
    try {
      expect(await store.build('sig-next', { force: true })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(persisted).toHaveLength(1);
    expect(AnsweringWorker.posted).toHaveLength(1); // metrics worker never started for the failed build
    expect(store.state.phase).toBe('ready');
    expect(store.meta?.signature).toBe('sig-good');
    expect(store.getScores(ids[5])).toEqual(before);
    expect(store.isRebuildThrottled('sig-next', true)).toBe(true); // cooldown armed
  });

  it('1% failed batches: build completes', async () => {
    setup(1);
    const persist = vi.fn(async () => {});
    const store = new GameGraphStore({ queryBatchSize: 1, persist });
    expect(await store.build('sig-1')).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('every batch empty: edgeless multi-node graph is not saved as ready', async () => {
    setup(100);
    const persist = vi.fn(async () => {});
    const store = new GameGraphStore({ queryBatchSize: 50, persist });
    expect(await store.build('sig-0')).toBe(false);
    expect(store.state.phase).toBe('error');
    expect(persist).not.toHaveBeenCalled();
  });

  it('index going not-ready mid Phase A fails the build', async () => {
    setup(0);
    vi.mocked(annIndex.queryBatch).mockImplementationOnce(async () => { ann.isReady = false; return {}; });
    const persist = vi.fn(async () => {});
    const store = new GameGraphStore({ queryBatchSize: 1, persist });
    expect(await store.build('sig-nr')).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('ANN index swapped (vector count changed without catalog embedding) fails the build', async () => {
    setup(0);
    vi.mocked(annIndex.queryBatch).mockImplementationOnce(async (entries) => {
      ann.vectorCount = 7;
      const out: Record<string, Neighbor[]> = {};
      for (const e of entries) out[e.id] = ann.neighbors.get(e.id) ?? [];
      return out;
    });
    const persist = vi.fn(async () => {});
    const store = new GameGraphStore({ queryBatchSize: 1, persist });
    expect(await store.build('sig-swap')).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
