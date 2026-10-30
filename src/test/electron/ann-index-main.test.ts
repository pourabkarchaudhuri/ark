/**
 * Main-process ANN index (electron/ann-index.ts) — safety contract tests.
 *
 * usearch is replaced by an in-memory fake (`__resetAnnIndexForTests`), since
 * `require()` via createRequire bypasses vi.mock. Covers:
 *  - upsert commits id maps only after the native add succeeded
 *  - vector validation (length / finite / zero)
 *  - loadIndex is a no-op while an index is in memory (renderer reloads)
 *  - a corrupt / inconsistent persisted index is quarantined, not loaded
 *  - a cleared / partial index is never persisted until a backfill completes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../electron/safe-logger.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../electron/settings-store.js', () => ({
  settingsStore: { getOllamaSettings: () => ({ embeddingMrl256Enabled: false }) },
}));

import {
  ANN_LAYOUT_GENERATION,
  __resetAnnIndexForTests,
  addVectors,
  clearIndex,
  getStatus,
  loadIndex,
  query,
  queryBatch,
  QUERY_SLICE,
  saveIndex,
  setAnnModelTag,
} from '../../../electron/ann-index';
import { EMBEDDING_LAYOUT_GENERATION } from '@/services/embedding-layout';

const DIMS = 1024;

class FakeIndex {
  static created = 0;
  static failAdd: ((key: bigint) => boolean) | null = null;
  static loadThrows = false;
  vectors = new Map<bigint, Float32Array>();
  constructor(public dims: number) { FakeIndex.created++; }
  add(key: bigint, vec: Float32Array) {
    if (FakeIndex.failAdd?.(key)) throw new Error('simulated native add failure');
    if (this.vectors.has(key)) throw new Error('Duplicate keys not allowed in high-level wrappers');
    this.vectors.set(key, vec);
  }
  remove(key: bigint) { return this.vectors.delete(key) ? 1 : 0; }
  contains(key: bigint) { return this.vectors.has(key); }
  size() { return this.vectors.size; }
  dimensions() { return this.dims; }
  static searchCalls: number[] = [];
  private searchOne(vec: Float32Array, k: number) {
    return [...this.vectors.entries()].map(([key, v]) => {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * vec[i];
      return { key, distance: 1 - dot };
    }).sort((a, b) => a.distance - b.distance || Number(a.key - b.key)).slice(0, k);
  }
  /** Mirrors usearch: one vector → Matches; a flat matrix → BatchMatches padded to `k` per row. */
  search(vecs: Float32Array, k: number) {
    const rows = vecs.length / this.dims;
    FakeIndex.searchCalls.push(rows);
    if (rows === 1) {
      const scored = this.searchOne(vecs, k);
      return { keys: scored.map((s) => s.key), distances: scored.map((s) => s.distance) };
    }
    const keys = new BigUint64Array(rows * k).fill(0xffffffffffffffffn);
    const distances = new Float32Array(rows * k).fill(Number.POSITIVE_INFINITY);
    const counts = new BigUint64Array(rows);
    for (let r = 0; r < rows; r++) {
      const scored = this.searchOne(vecs.subarray(r * this.dims, (r + 1) * this.dims), k);
      scored.forEach((s, j) => { keys[r * k + j] = s.key; distances[r * k + j] = s.distance; });
      counts[r] = BigInt(scored.length);
    }
    return { keys, distances, counts };
  }
  save(p: string) {
    fs.writeFileSync(p, JSON.stringify([...this.vectors.keys()].map(String)));
  }
  load(p: string) {
    if (FakeIndex.loadThrows) throw new Error('simulated corrupt file');
    const keys = JSON.parse(fs.readFileSync(p, 'utf-8')) as string[];
    for (const k of keys) this.vectors.set(BigInt(k), new Float32Array(this.dims));
  }
}

function unit(axis: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[axis % DIMS] = 1;
  return v;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-ann-test-'));
  FakeIndex.created = 0;
  FakeIndex.failAdd = null;
  FakeIndex.loadThrows = false;
  FakeIndex.searchCalls = [];
  __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
});

afterEach(() => {
  __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('upsert — id maps committed only after a successful native add', () => {
  it('a failed add of a NEW id leaves no map entry, and the next id still lands correctly', async () => {
    FakeIndex.failAdd = () => true;
    const r1 = await addVectors([{ id: 'steam-1', vector: unit(1) }]);
    expect(r1).toMatchObject({ added: 0, failed: 1, aborted: false });
    expect(getStatus().vectorCount).toBe(0);

    FakeIndex.failAdd = null;
    const r2 = await addVectors([{ id: 'steam-2', vector: unit(2) }]);
    expect(r2.added).toBe(1);
    expect(query(unit(2), 1).map((r) => r.id)).toEqual(['steam-2']);
  });

  it('a failed RE-add after remove vacates the slot instead of pointing at a missing vector', async () => {
    await addVectors([{ id: 'steam-1', vector: unit(1) }, { id: 'steam-2', vector: unit(2) }]);
    expect(getStatus().vectorCount).toBe(2);

    FakeIndex.failAdd = (key) => key === 0n;
    const r = await addVectors([{ id: 'steam-1', vector: unit(5) }]);
    expect(r).toMatchObject({ failed: 1, replaced: 0 });
    // steam-1 is gone from both the native index and the maps — consistent.
    expect(getStatus().vectorCount).toBe(1);
    expect(query(unit(1), 5).map((x) => x.id)).not.toContain('steam-1');

    // It can be re-added later (fresh slot, maps consistent).
    FakeIndex.failAdd = null;
    const again = await addVectors([{ id: 'steam-1', vector: unit(1) }]);
    expect(again.added).toBe(1);
    expect(query(unit(1), 1).map((x) => x.id)).toEqual(['steam-1']);
  });

  it('rejects wrong-length, non-finite and zero vectors without touching the maps', async () => {
    const bad = unit(3);
    bad[7] = Number.NaN;
    const r = await addVectors([
      { id: 'short', vector: [1, 2, 3] },
      { id: 'nan', vector: bad },
      { id: 'zero', vector: new Array(DIMS).fill(0) },
      { id: 'ok', vector: unit(4) },
    ]);
    expect(r).toMatchObject({ added: 1, failed: 3 });
    expect(getStatus().vectorCount).toBe(1);
  });

  it('reports aborted (not a silent partial count) when the index is cleared mid-batch', async () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `g${i}`, vector: unit(i) }));
    const p = addVectors(entries);
    clearIndex(); // runs while addVectors yields between slices
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.added).toBeLessThan(200);
  });
});

describe('persistence — partial indexes are never written', () => {
  it('refuses force saves of a cleared / implicitly created index until a backfill completes', async () => {
    clearIndex();
    await addVectors([{ id: 'steam-1', vector: unit(1) }]);
    expect(getStatus().partial).toBe(true);
    expect(saveIndex({ force: true })).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw.usearch'))).toBe(false);

    expect(saveIndex({ force: true, complete: true })).toBe(true);
    expect(getStatus().partial).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw.usearch'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw-meta.json'))).toBe(true);
  });
});

describe('loadIndex', () => {
  async function persistTwo(): Promise<void> {
    await addVectors([{ id: 'steam-1', vector: unit(1) }, { id: 'steam-2', vector: unit(2) }]);
    expect(saveIndex({ complete: true })).toBe(true);
  }

  it('is a no-op while an index is already in memory (renderer reload never stacks a second copy)', async () => {
    await persistTwo();
    const before = FakeIndex.created;
    expect(await loadIndex()).toBe(true);
    expect(await loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before);

    // Fresh main state → loads from disk exactly once.
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    expect(await loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before + 1);
    expect(getStatus()).toMatchObject({ ready: true, vectorCount: 2, partial: false });
    expect(await loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before + 1);
  });

  it('quarantines a file that fails to load and reports not-ready', async () => {
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    FakeIndex.loadThrows = true;
    expect(await loadIndex()).toBe(false);
    expect(getStatus().ready).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw.usearch'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw.usearch.corrupt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ann-hnsw-meta.json.corrupt'))).toBe(true);
  });

  it('quarantines an index whose size does not match the saved id map', async () => {
    await persistTwo();
    // Meta claims three live ids, the index only holds two vectors.
    const metaPath = path.join(dir, 'ann-hnsw-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.gameIds.push('steam-3');
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    expect(await loadIndex()).toBe(false);
    expect(getStatus()).toMatchObject({ ready: false, partial: true });
    expect(fs.existsSync(path.join(dir, 'ann-hnsw-meta.json.corrupt'))).toBe(true);
  });
});


describe('layout generation + model tag stamp (re-embed foundation)', () => {
  const metaPath = () => path.join(dir, 'ann-hnsw-meta.json');
  const indexPath = () => path.join(dir, 'ann-hnsw.usearch');

  async function persistTwo(): Promise<void> {
    await addVectors([{ id: 'steam-1', vector: unit(1) }, { id: 'steam-2', vector: unit(2) }]);
    expect(saveIndex({ complete: true })).toBe(true);
  }
  function rewriteMeta(fn: (m: Record<string, unknown>) => void): void {
    const m = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
    fn(m);
    fs.writeFileSync(metaPath(), JSON.stringify(m));
  }

  it('the main-process generation mirrors the renderer layout generation (a bump must change both)', () => {
    expect(ANN_LAYOUT_GENERATION).toBe(EMBEDDING_LAYOUT_GENERATION);
  });

  it('a saved index records its generation and model tag, and status reports them', async () => {
    setAnnModelTag('snowflake-arctic-embed2');
    await persistTwo();
    const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
    expect(meta.layoutGeneration).toBe(ANN_LAYOUT_GENERATION);
    expect(meta.modelTag).toBe('snowflake-arctic-embed2');
    expect(getStatus()).toMatchObject({ layoutGeneration: ANN_LAYOUT_GENERATION, modelTag: 'snowflake-arctic-embed2' });
  });

  it('refuses to serve an index built under another generation: deleted for rebuild, never loaded', async () => {
    await persistTwo();
    rewriteMeta(m => { m.layoutGeneration = ANN_LAYOUT_GENERATION + 1; });
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    const created = FakeIndex.created;
    expect(await loadIndex()).toBe(false);
    expect(FakeIndex.created).toBe(created); // the (multi-GB) native index was not even opened
    expect(getStatus()).toMatchObject({ ready: false, partial: true });
    expect(fs.existsSync(indexPath())).toBe(false);
    expect(fs.existsSync(metaPath())).toBe(false);
  });

  it('a different model TAG never discards the index (it is informational: a rebuild would reuse the same cached vectors)', async () => {
    setAnnModelTag('snowflake-arctic-embed2');
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    setAnnModelTag('snowflake-arctic-embed2:latest');
    expect(await loadIndex()).toBe(true);
    expect(fs.existsSync(indexPath())).toBe(true);
  });

  it('the model tag does not leak between tests (reset clears it)', () => {
    setAnnModelTag('leaky');
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    expect(getStatus().modelTag).toBe('');
  });

  it('an index saved before stamps existed loads as generation 1 and is stamped on its next save', async () => {
    setAnnModelTag('');
    await persistTwo();
    rewriteMeta(m => { delete m.layoutGeneration; delete m.modelTag; });
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    setAnnModelTag('snowflake-arctic-embed2');
    expect(await loadIndex()).toBe(true);
    expect(getStatus().ready).toBe(true);
    await addVectors([{ id: 'steam-3', vector: unit(3) }]);
    expect(saveIndex({ complete: true, force: true })).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
    expect(meta).toMatchObject({ layoutGeneration: ANN_LAYOUT_GENERATION, modelTag: 'snowflake-arctic-embed2' });
  });

  it('an unknown current model tag never discards a tagged index', async () => {
    setAnnModelTag('snowflake-arctic-embed2');
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    setAnnModelTag('');
    expect(await loadIndex()).toBe(true);
  });
});

describe('queryBatch — batched native search instead of a per-vector loop (1.0.97)', () => {
  /** Mixed vectors so every query has a distinct, deterministic neighbour order. */
  function mixed(i: number): number[] {
    const v = new Array(DIMS).fill(0);
    v[i % DIMS] = 1;
    v[(i * 7 + 3) % DIMS] += 0.5;
    v[(i * 13 + 5) % DIMS] += 0.25;
    return v;
  }

  async function seed(n: number): Promise<void> {
    await addVectors(Array.from({ length: n }, (_, i) => ({ id: `g${i}`, vector: mixed(i) })));
  }

  it('returns the same neighbours as one query() per vector, minus the source id', async () => {
    await seed(80);
    const entries = Array.from({ length: 70 }, (_, i) => ({ id: `g${i}`, vector: mixed(i) }));
    const batched = await queryBatch(entries, 5);
    for (const e of entries) {
      const single = query(e.vector, 6).filter((r) => r.id !== e.id);
      expect(batched[e.id].map((r) => r.id)).toEqual(single.map((r) => r.id));
      batched[e.id].forEach((r, j) => expect(r.distance).toBeCloseTo(single[j].distance, 6));
    }
  });

  it('searches QUERY_SLICE vectors per native call instead of one call per vector', async () => {
    await seed(40);
    FakeIndex.searchCalls = [];
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, vector: mixed(i) }));
    await queryBatch(entries, 3);
    expect(FakeIndex.searchCalls.length).toBe(Math.ceil(200 / QUERY_SLICE));
    expect(Math.max(...FakeIndex.searchCalls)).toBeLessThanOrEqual(QUERY_SLICE);
  });

  it('filters padding (sentinel keys / non-finite distances) and vacated slots', async () => {
    await seed(3);
    // Vacate g1's slot: the id map keeps 3 slots but only 2 vectors hold live ids.
    FakeIndex.failAdd = (key) => key === 1n;
    await addVectors([{ id: 'g1', vector: mixed(1) }]);
    FakeIndex.failAdd = null;
    const out = await queryBatch([{ id: 'g0', vector: mixed(0) }, { id: 'g2', vector: mixed(2) }], 5);
    expect(out.g0.map((r) => r.id)).toEqual(['g2']);
    expect(out.g2.map((r) => r.id)).toEqual(['g0']);
    for (const rows of Object.values(out)) for (const r of rows) expect(Number.isFinite(r.distance)).toBe(true);
  });

  it('yields to the event loop between slices of a 200-vector batch', async () => {
    await seed(40);
    let ticks = 0;
    let running = true;
    const spin = () => { if (!running) return; ticks++; setImmediate(spin); };
    setImmediate(spin);
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, vector: mixed(i) }));
    await queryBatch(entries, 3);
    running = false;
    expect(ticks).toBeGreaterThanOrEqual(Math.ceil(200 / QUERY_SLICE) - 2);
  });

  it('returns {} when the index is cleared while the batch is yielding', async () => {
    await seed(40);
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, vector: mixed(i) }));
    const p = queryBatch(entries, 3);
    clearIndex();
    expect(await p).toEqual({});
  });
});

describe('loadIndex — async id map read (1.0.97)', () => {
  async function persistTwo(): Promise<void> {
    await addVectors([{ id: 'steam-1', vector: unit(1) }, { id: 'steam-2', vector: unit(2) }]);
    expect(saveIndex({ complete: true })).toBe(true);
  }

  it('reads the id map with fs.promises.readFile and returns a promise', async () => {
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    const asyncRead = vi.spyOn(fs.promises, 'readFile');
    try {
      const pending = loadIndex();
      expect(pending).toBeInstanceOf(Promise);
      expect(await pending).toBe(true);
      const metaPath = path.join(dir, 'ann-hnsw-meta.json');
      expect(asyncRead.mock.calls.some((c) => String(c[0]) === metaPath)).toBe(true);
    } finally {
      asyncRead.mockRestore();
    }
  });

  it('concurrent loads share one native load', async () => {
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    const before = FakeIndex.created;
    const [a, b] = await Promise.all([loadIndex(), loadIndex()]);
    expect([a, b]).toEqual([true, true]);
    expect(FakeIndex.created).toBe(before + 1);
  });

  it('a clear while the id map is being read leaves the index unloaded', async () => {
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    const pending = loadIndex();
    clearIndex();
    expect(await pending).toBe(false);
    expect(getStatus().ready).toBe(false);
  });
});
