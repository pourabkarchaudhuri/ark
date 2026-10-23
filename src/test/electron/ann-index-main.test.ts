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
  __resetAnnIndexForTests,
  addVectors,
  clearIndex,
  getStatus,
  loadIndex,
  query,
  saveIndex,
} from '../../../electron/ann-index';

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
  search(vec: Float32Array, k: number) {
    const scored = [...this.vectors.entries()].map(([key, v]) => {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * vec[i];
      return { key, distance: 1 - dot };
    }).sort((a, b) => a.distance - b.distance).slice(0, k);
    return { keys: scored.map((s) => s.key), distances: scored.map((s) => s.distance) };
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
    expect(loadIndex()).toBe(true);
    expect(loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before);

    // Fresh main state → loads from disk exactly once.
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    expect(loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before + 1);
    expect(getStatus()).toMatchObject({ ready: true, vectorCount: 2, partial: false });
    expect(loadIndex()).toBe(true);
    expect(FakeIndex.created).toBe(before + 1);
  });

  it('quarantines a file that fails to load and reports not-ready', async () => {
    await persistTwo();
    __resetAnnIndexForTests({ Index: FakeIndex, userDataDir: dir });
    FakeIndex.loadThrows = true;
    expect(loadIndex()).toBe(false);
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
    expect(loadIndex()).toBe(false);
    expect(getStatus()).toMatchObject({ ready: false, partial: true });
    expect(fs.existsSync(path.join(dir, 'ann-hnsw-meta.json.corrupt'))).toBe(true);
  });
});
