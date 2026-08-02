/**
 * Embedding Service — LevelDB migration tests (v1.0.67).
 *
 * embedding-service.ts owns 4 IndexedDB stores in database `ark-embeddings`:
 *   - `embeddings` (Tier 1 library, keyPath gameId)
 *   - `catalog-embeddings` (Tier 2 catalog, keyPath gameId)
 *   - `chunk-embeddings` (facet chunks, keyPath chunkId, indexed by
 *     byGame/byTierGame in IDB)
 *   - `embedding-meta` (small KV: epoch, rechunk watermark, sync watermarks)
 *
 * The LevelDB migration denormalizes chunk-embeddings: instead of IDB's
 * byTierGame index, LevelDB stores one row per (tier,gameId) holding the
 * full array of that game's chunks (namespace `embed-chunks`, key
 * `${tier}:${gameId}`). These tests verify:
 *
 *  1. Int8Array round-trips correctly through LevelDB's JSON encoding
 *     (a real risk: Int8Array does NOT survive JSON.stringify/parse as an
 *     array — it becomes a keyed object that fails every coerceInt8Q branch
 *     unless explicitly converted to a plain Array first).
 *  2. Library + catalog pooled embeddings migrate correctly.
 *  3. Chunk rows migrate into the correct (tier,gameId) groups without
 *     cross-contaminating between games or tiers whose chunkId prefixes
 *     could plausibly collide.
 *  4. Meta keys (epoch, watermarks) migrate.
 *  5. The same hardening applied to catalog-store.ts in v1.0.65 holds here
 *     too: a failed migration attempt retries later; concurrent callers
 *     share one in-flight attempt.
 *
 * Because the migration function and most low-level storage helpers are
 * module-private, these tests exercise migration exclusively through the
 * exported read functions (getEmbeddingById, getPooledEmbeddingCount,
 * getChunksForGame, listChunkVectorsForAnn, getEmbeddingContentEpoch,
 * getAllPooledEmbeddingsForGraph) — the same surface real consumers use.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const IDB_NAME = 'ark-embeddings';
const MIGRATION_MARKER = 'ark-embeddings-migrated-v1';

interface RawCachedEmbedding {
  gameId: string;
  embedding?: number[];
  q?: Int8Array;
  scale?: number;
  textHash: string;
  timestamp: number;
  format?: 'f32' | 'i8';
  poolVersion?: number;
}

interface RawCachedChunk {
  chunkId: string;
  tier: 'lib' | 'cat';
  gameId: string;
  kind: string;
  seq: number;
  q: Int8Array;
  scale: number;
  textHash: string;
  weight: number;
  timestamp: number;
}

function makeInt8Vector(seed: number): Int8Array {
  const arr = new Int8Array(1024);
  for (let i = 0; i < 1024; i++) arr[i] = ((seed + i) % 255) - 127;
  return arr;
}

function makePooled(gameId: string, seed: number, overrides: Partial<RawCachedEmbedding> = {}): RawCachedEmbedding {
  return {
    gameId,
    q: makeInt8Vector(seed),
    scale: 0.01,
    textHash: `t10m1:hash-${seed}`,
    timestamp: Date.now(),
    format: 'i8',
    poolVersion: 1,
    ...overrides,
  };
}

function makeChunk(
  tier: 'lib' | 'cat',
  gameId: string,
  kind: string,
  seq: number,
  seed: number,
): RawCachedChunk {
  return {
    chunkId: `${tier}:${gameId}::${kind}#${seq}`,
    tier,
    gameId,
    kind,
    seq,
    q: makeInt8Vector(seed),
    scale: 0.01,
    textHash: `c1:hash-${seed}`,
    weight: kind === 'facets' ? 1.0 : 0.5,
    timestamp: Date.now(),
  };
}

async function seedIdb(opts: {
  library?: RawCachedEmbedding[];
  catalog?: RawCachedEmbedding[];
  chunks?: RawCachedChunk[];
  meta?: Array<{ key: string; [k: string]: unknown }>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 4);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'gameId' });
      if (!db.objectStoreNames.contains('catalog-embeddings')) db.createObjectStore('catalog-embeddings', { keyPath: 'gameId' });
      if (!db.objectStoreNames.contains('embedding-meta')) db.createObjectStore('embedding-meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('chunk-embeddings')) {
        const s = db.createObjectStore('chunk-embeddings', { keyPath: 'chunkId' });
        s.createIndex('byGame', 'gameId', { unique: false });
        s.createIndex('byTierGame', ['tier', 'gameId'], { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['embeddings', 'catalog-embeddings', 'embedding-meta', 'chunk-embeddings'], 'readwrite');
      for (const e of opts.library ?? []) tx.objectStore('embeddings').put(e);
      for (const e of opts.catalog ?? []) tx.objectStore('catalog-embeddings').put(e);
      for (const c of opts.chunks ?? []) tx.objectStore('chunk-embeddings').put(c);
      for (const m of opts.meta ?? []) tx.objectStore('embedding-meta').put(m);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteIdbDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function installFakeStore() {
  const db = new Map<string, unknown>();
  const calls = { batch: 0, get: 0, getChunk: 0 };

  const fake = {
    get: async (ns: string, key: string) => {
      calls.get++;
      return { value: db.get(`${ns}::${key}`) ?? null };
    },
    getAll: async (ns: string) => {
      const rows: Array<{ key: string; value: unknown }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      return { rows };
    },
    getChunk: async (ns: string, { startAfter, limit }: { startAfter?: string; limit: number }) => {
      calls.getChunk++;
      const prefix = `${ns}::`;
      const keys: string[] = [];
      for (const k of db.keys()) if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      keys.sort();
      const startIdx = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
      const eff = startIdx < 0 ? keys.length : startIdx;
      const slice = keys.slice(eff, eff + limit);
      const rows = slice.map((k) => ({ key: k, value: db.get(`${ns}::${k}`) }));
      return { rows, nextKey: rows.length > 0 ? rows[rows.length - 1].key : undefined, done: rows.length < limit };
    },
    put: async (ns: string, key: string, value: unknown) => { db.set(`${ns}::${key}`, value); return { ok: true }; },
    del: async (ns: string, key: string) => { db.delete(`${ns}::${key}`); return { ok: true }; },
    batch: async (ops: any[]) => {
      calls.batch++;
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else if (op.type === 'del') db.delete(`${op.namespace}::${op.key}`);
      }
      return { ok: true };
    },
    has: async (ns: string) => {
      const prefix = `${ns}::`;
      for (const k of db.keys()) if (k.startsWith(prefix)) return { value: true };
      return { value: false };
    },
    clearNamespace: async (ns: string) => {
      const prefix = `${ns}::`;
      for (const k of Array.from(db.keys())) if (k.startsWith(prefix)) db.delete(k);
      return { ok: true };
    },
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return { db, calls };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
  await deleteIdbDatabase();
});

describe('embedding-service migration — Int8Array round-trip', () => {
  it('getEmbeddingById decodes the correct vector after LevelDB migration', async () => {
    const seed = 42;
    await seedIdb({ library: [makePooled('steam-1', seed)] });
    installFakeStore();

    const { getEmbeddingById, coerceInt8Q } = await import('./embedding-service');
    const vec = await getEmbeddingById('steam-1');

    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(1024);
    // Decoded value must be dequantized from the exact seeded int8 array,
    // not silently nulled out by a botched JSON round-trip.
    const expectedQ = makeInt8Vector(seed);
    const expectedFirst = expectedQ[0] * 0.01;
    expect(vec![0]).toBeCloseTo(expectedFirst, 5);
  });
});

describe('embedding-service migration — pooled stores', () => {
  it('migrates library + catalog pooled embeddings; getPooledEmbeddingCount reflects both', async () => {
    await seedIdb({
      library: [makePooled('steam-1', 1), makePooled('steam-2', 2)],
      catalog: [makePooled('steam-100', 100), makePooled('epic-ns:off1', 200)],
    });
    installFakeStore();

    const { getPooledEmbeddingCount } = await import('./embedding-service');
    const count = await getPooledEmbeddingCount();

    expect(count).toBe(4);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });

  it('getAllPooledEmbeddingsForGraph dedupes by gameId, library taking priority', async () => {
    // Same gameId present in BOTH library and catalog (shouldn't happen in
    // practice, but the dedup contract must hold if it ever does).
    await seedIdb({
      library: [makePooled('steam-1', 1)],
      catalog: [makePooled('steam-1', 999), makePooled('steam-2', 2)],
    });
    installFakeStore();

    const { getAllPooledEmbeddingsForGraph } = await import('./embedding-service');
    const rows = await getAllPooledEmbeddingsForGraph();

    expect(rows.length).toBe(2);
    const steam1 = rows.find((r) => r.gameId === 'steam-1');
    expect(steam1).toBeDefined();
    // Library's seed=1 vector should win, not catalog's seed=999.
    const libVec = makeInt8Vector(1);
    expect(steam1!.embedding[0]).toBeCloseTo(libVec[0] * 0.01, 5);
  });
});

describe('embedding-service migration — chunk denormalization', () => {
  it('groups chunks by (tier,gameId) without cross-contamination between adjacent games', async () => {
    // Three games whose chunkId prefixes are lexicographically adjacent —
    // exactly the scenario the streaming group-by-adjacency migration must
    // get right (games interleaved in insertion order; IDB cursor iterates
    // by chunkId regardless of insertion order).
    const chunks: RawCachedChunk[] = [
      makeChunk('cat', 'steam-1', 'facets', 0, 1),
      makeChunk('cat', 'steam-10', 'facets', 0, 10), // adjacent prefix risk: "steam-1" vs "steam-10"
      makeChunk('cat', 'steam-1', 'summary', 0, 2),
      makeChunk('cat', 'steam-2', 'facets', 0, 20),
      makeChunk('lib', 'steam-1', 'notes', 0, 3), // same gameId, different tier
    ];
    await seedIdb({ chunks });
    installFakeStore();

    const { getChunksForGame } = await import('./embedding-service');

    const steam1Chunks = await getChunksForGame('steam-1');
    // getChunksForGame is cross-tier (byGame semantics) — expect both the
    // 'cat' facets+summary chunks AND the 'lib' notes chunk for steam-1,
    // and NOTHING belonging to steam-10 or steam-2.
    expect(steam1Chunks.length).toBe(3);
    expect(steam1Chunks.every((c) => c.gameId === 'steam-1')).toBe(true);
    const kinds = steam1Chunks.map((c) => `${c.tier}:${c.kind}`).sort();
    expect(kinds).toEqual(['cat:facets', 'cat:summary', 'lib:notes']);

    const steam10Chunks = await getChunksForGame('steam-10');
    expect(steam10Chunks.length).toBe(1);
    expect(steam10Chunks[0].gameId).toBe('steam-10');

    const steam2Chunks = await getChunksForGame('steam-2');
    expect(steam2Chunks.length).toBe(1);
    expect(steam2Chunks[0].gameId).toBe('steam-2');
  });

  it('does not lose chunks when one gameId is a byte-prefix of another (adversarial-review regression)', async () => {
    // Exact scenario from the confirmed adversarial-review finding: gameId
    // "42" has facets+notes chunks; gameId "42::ghost" (an id containing
    // the same "::" separator makeChunkId uses internally) has a facets
    // chunk. Under naive primary-key (chunkId) string-prefix grouping, the
    // three chunkIds interleave in ascending order —
    //   "lib:42::facets#0" < "lib:42::ghost::facets#0" < "lib:42::notes#0"
    // — causing game "42"'s chunk group to be flushed twice, with the
    // second flush (only [notes]) silently overwriting and losing the
    // first (only [facets]). The fix iterates the byTierGame COMPOUND
    // INDEX instead, whose [tier, gameId] comparison is on actual field
    // values, immune to this interleaving regardless of gameId content.
    const chunks: RawCachedChunk[] = [
      makeChunk('lib', '42', 'facets', 0, 1),
      makeChunk('lib', '42::ghost', 'facets', 0, 2),
      makeChunk('lib', '42', 'notes', 0, 3),
    ];
    await seedIdb({ chunks });
    installFakeStore();

    const { getChunksForGame } = await import('./embedding-service');

    const game42Chunks = await getChunksForGame('42');
    expect(game42Chunks.length).toBe(2);
    expect(game42Chunks.every((c) => c.gameId === '42')).toBe(true);
    const kinds = game42Chunks.map((c) => c.kind).sort();
    expect(kinds).toEqual(['facets', 'notes']);

    const ghostChunks = await getChunksForGame('42::ghost');
    expect(ghostChunks.length).toBe(1);
    expect(ghostChunks[0].gameId).toBe('42::ghost');
  });

  it('listChunkVectorsForAnn decodes every chunk across all games/tiers', async () => {
    const chunks: RawCachedChunk[] = [
      makeChunk('cat', 'steam-1', 'facets', 0, 5),
      makeChunk('cat', 'steam-2', 'facets', 0, 6),
      makeChunk('lib', 'steam-3', 'notes', 0, 7),
    ];
    await seedIdb({ chunks });
    installFakeStore();

    const { listChunkVectorsForAnn } = await import('./embedding-service');
    const rows = await listChunkVectorsForAnn();

    expect(rows.length).toBe(3);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([
      'cat:steam-1::facets#0',
      'cat:steam-2::facets#0',
      'lib:steam-3::notes#0',
    ]);
  });
});

describe('embedding-service migration — meta keys', () => {
  it('migrates embeddingContentEpoch', async () => {
    await seedIdb({
      library: [makePooled('steam-1', 1)], // non-empty so migration has real work to do
      meta: [{ key: 'embeddingContentEpoch', value: 42 }],
    });
    installFakeStore();

    const { getEmbeddingContentEpoch } = await import('./embedding-service');
    const epoch = await getEmbeddingContentEpoch();

    expect(epoch).toBe(42);
  });
});

describe('embedding-service migration — retry after failure', () => {
  it('does NOT retry migration on every call within the same session (regression: retry-storm)', async () => {
    // Root cause of a real user-reported hang ("progress stuck at Waiting
    // for embeddings"): `getChunksForTierGame`/`writeGameChunksAndPool` are
    // called ONCE PER GAME inside a tight loop during a full catalog
    // embedding pass (up to ~163k iterations). The original implementation
    // left migration retryable on every call after a failure — meaning a
    // single transient failure early in a catalog pass triggered a fresh
    // full re-migration attempt on EVERY subsequent per-game call, an
    // unbounded retry storm that made the whole pass hang indefinitely.
    //
    // This test simulates exactly that shape: one failure, then MANY
    // subsequent calls (standing in for the per-game loop) within the same
    // session — none of them should re-attempt migration.
    await seedIdb({ library: [makePooled('steam-1', 1), makePooled('steam-2', 2)] });
    const { calls } = installFakeStore();

    const { getPooledEmbeddingCount, getEmbeddingById } = await import('./embedding-service');

    const originalBatch = (window as any).store.batch;
    let failOnce = true;
    let batchAttempts = 0;
    (window as any).store.batch = async (ops: any[]) => {
      batchAttempts++;
      if (failOnce) { failOnce = false; return { error: 'simulated_transient_failure' }; }
      return originalBatch(ops);
    };

    // First call: migration attempted, fails, settles (no retry this
    // session). useLevelDB() now reports false post-failure, so this
    // correctly falls back to the legacy IDB path and reports the REAL
    // count (2) — not an incomplete LevelDB view.
    const first = await getPooledEmbeddingCount();
    expect(first).toBe(2);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
    expect(batchAttempts).toBe(1); // the one (failed) attempt happened

    // Simulate the per-game loop: many more calls in the same session.
    // None of these should trigger another migration attempt, and each
    // should correctly fall back to the legacy IDB path rather than
    // silently reading an incomplete LevelDB namespace.
    for (let i = 0; i < 20; i++) {
      const count = await getPooledEmbeddingCount();
      expect(count).toBe(2); // consistently correct via IDB fallback, every time
    }
    expect(batchAttempts).toBe(1); // zero additional migration attempts
    expect(calls.batch).toBe(0); // originalBatch (the real writer) never even ran

    // Falls back to legacy IDB correctly — still sees the real data.
    const vec = await getEmbeddingById('steam-1');
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(1024);

    // Marker never stamped this session (by design — retry happens on the
    // next fresh session/module load, not mid-session).
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });

  it('retries fresh on the next session (module reload) after a failed attempt', async () => {
    await seedIdb({ library: [makePooled('steam-1', 1), makePooled('steam-2', 2)] });
    installFakeStore();

    // Session 1: fails once.
    let mod = await import('./embedding-service');
    const originalBatch = (window as any).store.batch;
    let failOnce = true;
    (window as any).store.batch = async (ops: any[]) => {
      if (failOnce) { failOnce = false; return { error: 'simulated_transient_failure' }; }
      return originalBatch(ops);
    };
    const duringSession1 = await mod.getPooledEmbeddingCount();
    expect(duringSession1).toBe(2); // correct via IDB fallback after the failed attempt
    expect(localStorage.getItem(MIGRATION_MARKER)).toBeNull();

    // Session 2: fresh module load (simulates app restart) — migration
    // state resets, so the (no-longer-failing) batch call succeeds now.
    vi.resetModules();
    mod = await import('./embedding-service');
    const secondSessionCount = await mod.getPooledEmbeddingCount();
    expect(secondSessionCount).toBe(2);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
  });
});

describe('embedding-service migration — concurrent callers share one attempt', () => {
  it('two concurrent calls both see the fully migrated result from one migration pass', async () => {
    await seedIdb({
      library: Array.from({ length: 10 }, (_, i) => makePooled(`steam-${i}`, i)),
    });
    const { calls } = installFakeStore();

    const { getPooledEmbeddingCount } = await import('./embedding-service');

    const [a, b] = await Promise.all([getPooledEmbeddingCount(), getPooledEmbeddingCount()]);
    expect(a).toBe(10);
    expect(b).toBe(10);
    // One migration pass -> one batch call for the library stream (10 rows,
    // well under the 500-row batch size, so exactly one flush).
    expect(calls.batch).toBe(1);
  });
});
