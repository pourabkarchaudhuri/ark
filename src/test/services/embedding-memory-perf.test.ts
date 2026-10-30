/**
 * Embedding service memory / perf fixes (1.0.97 B32):
 *  - Re-chunk catalog phases keep only ids; PhaseItems (text + hash) are
 *    built one page at a time, in the same cursor order as before.
 *  - Catalog TTL refresh only rewrites rows past half the 90-day TTL.
 *  - Live embedding cache evicts catalog vectors no compute still needs.
 *  - Galaxy precompute: shape-check pass 1, int8 projection pass 2 (worker
 *    or inline), same output as the old dequantise-and-project path.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIM } from '@/services/embedding-service';
import { hashWholeEmbeddingText } from '@/services/embedding-chunks';
import {
  collectRechunkQueue,
  gamesAfterCursor,
  createInitialRechunkWatermark,
  RECHUNK_META_KEY,
} from '@/services/embedding-rechunk';
import {
  generateGaussianProjectionMatrix,
  projectInt8Page,
  type GalaxyProjectionWorkerInput,
} from '@/services/galaxy-projection';
import { dequantizeEmbedding, quantizeEmbedding } from '@/services/embedding-quant';

const MIGRATION_MARKER = 'ark-embeddings-migrated-v1';
const DAY = 24 * 60 * 60 * 1000;

type BatchOp = { type: 'put' | 'del'; namespace: string; key: string; value?: unknown };

function installFakeStore() {
  const db = new Map<string, unknown>();
  const batches: BatchOp[][] = [];
  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
    getMany: async (ns: string, keys: string[]) => ({ values: keys.map((k) => db.get(`${ns}::${k}`) ?? null) }),
    getAll: async (ns: string) => {
      const rows: Array<{ key: string; value: unknown }> = [];
      const prefix = `${ns}::`;
      for (const [k, v] of db.entries()) if (k.startsWith(prefix)) rows.push({ key: k.slice(prefix.length), value: v });
      return { rows };
    },
    getChunk: async (ns: string, { startAfter, limit }: { startAfter?: string; limit: number }) => {
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
    batch: async (ops: BatchOp[]) => {
      batches.push(ops);
      for (const op of ops) {
        if (op.type === 'put') db.set(`${op.namespace}::${op.key}`, op.value);
        else db.delete(`${op.namespace}::${op.key}`);
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
  return { db, batches };
}

function vecFor(seed: number): number[] {
  const v = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = Math.sin(seed * 31 + i * 0.37) * 0.5;
  return v;
}

type EmbedFn = (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>;

function installOllama(embed: EmbedFn) {
  const generateEmbeddings = vi.fn(embed);
  Object.defineProperty(window, 'ollama', {
    value: {
      healthCheck: vi.fn(async () => ({ running: true, version: '0.1.0' })),
      setup: async () => ({ ollamaDetected: true, ollamaVersion: '0.1.0', embeddingModelReady: true, error: null }),
      generateEmbeddings,
    },
    writable: true,
    configurable: true,
  });
  return { generateEmbeddings };
}

const embedAll: EmbedFn = async (items) => {
  const out: Record<string, number[]> = {};
  items.forEach((item, i) => { out[item.id] = vecFor(i + 1); });
  return out;
};

function setChunking(enabled: boolean) {
  Object.defineProperty(window, 'settings', {
    value: { getOllamaSettings: async () => ({ embeddingChunkingEnabled: enabled }) },
    writable: true,
    configurable: true,
  });
}

function makeCatalogEntry(appid: number) {
  return { appid, name: `Game ${appid}`, genres: ['Action'], themes: [], modes: [], developer: 'Dev', shortDescription: `desc ${appid}` };
}

function iteratorOf<T>(entries: T[]) {
  return async (onBatch: (batch: T[]) => void): Promise<number> => {
    for (let i = 0; i < entries.length; i += 7) onBatch(entries.slice(i, i + 7));
    return entries.length;
  };
}

/** A pooled LevelDB row (int8 `q` as a plain array, like toLevelPooled writes). */
function pooledRow(gameId: string, seed: number, timestamp = Date.now()) {
  const { q, scale } = quantizeEmbedding(Float32Array.from(vecFor(seed)));
  return { gameId, q: Array.from(q), scale, textHash: `h${seed}`, timestamp, format: 'i8' };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(MIGRATION_MARKER, 'yes');
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ollama', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ann', { value: undefined, writable: true, configurable: true });
  setChunking(false);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ─── 1. Re-chunk job: ids only, pages loaded lazily ─────────────────────────

describe('re-chunk catalog queue', () => {
  it('1,000-entry iterator with a cursor at entry 400: same queue and order as gamesAfterCursor over full items', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => makeCatalogEntry(i + 1));
    const sortedIds = entries.map((e) => `steam-${e.appid}`).sort((a, b) => a.localeCompare(b));
    const cursor = sortedIds[399];
    const retained = new Map<string, unknown>();
    const { queue, already } = await collectRechunkQueue(
      iteratorOf(entries),
      (e) => `steam-${e.appid}`,
      cursor,
      (id, e) => { retained.set(id, e); },
    );
    const old = gamesAfterCursor(entries.map((e) => ({ id: `steam-${e.appid}` })), cursor).map((g) => g.id);
    expect(queue).toEqual(old);
    expect(queue).toEqual(sortedIds.slice(400));
    expect(already).toBe(400);
    // Only entries still to do are retained — nothing before the cursor.
    expect(retained.size).toBe(600);
    expect(retained.has(cursor)).toBe(false);
  });

  it('null cursor queues everything sorted, already = 0', async () => {
    const entries = [makeCatalogEntry(30), makeCatalogEntry(4), makeCatalogEntry(100)];
    const { queue, already } = await collectRechunkQueue(iteratorOf(entries), (e) => `steam-${e.appid}`, null);
    expect(queue).toEqual(['steam-100', 'steam-30', 'steam-4']);
    expect(already).toBe(0);
  });
});

describe('re-chunk job steam phase (page loader)', () => {
  it('resumes after the cursor in order, builds the same wholeHash, skips an entry deleted mid-job and advances past it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setChunking(true);
    const { db } = installFakeStore();
    const ollama = installOllama(embedAll);
    const entries = Array.from({ length: 8 }, (_, i) => makeCatalogEntry(i + 1)); // steam-1..steam-8
    // Resume mid steam phase: steam-1..steam-3 were done in an earlier session.
    db.set(`embed-meta::${RECHUNK_META_KEY}`, { ...createInitialRechunkWatermark(), phase: 'steam', cursorAfter: 'steam-3' });

    const fetchCalls: number[][] = [];
    const steamFetch = vi.fn(async (appIds: number[]) => {
      fetchCalls.push(appIds);
      // steam-6 was removed from the catalog after the id walk.
      return entries.filter((e) => appIds.includes(e.appid) && e.appid !== 6);
    });

    const { embeddingService } = await import('@/services/embedding-service');
    const progress: Array<{ completed: number; total: number; phase: string }> = [];
    embeddingService.subscribe(() => {
      const p = embeddingService.rechunkProgress;
      if (p.phase === 'steam') progress.push({ ...p });
    });
    const job = embeddingService.startRechunkJob({
      libraryGames: [],
      steamIterator: iteratorOf(entries),
      steamFetch,
      epicIterator: async () => 0,
      steamTotal: entries.length,
    });
    let settled = false;
    void job.finally(() => { settled = true; });
    for (let i = 0; i < 60 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
    const result = await job;

    expect(result.status).toBe('done');
    // Only ids after the cursor are fetched, one page, in cursor order.
    expect(fetchCalls).toEqual([[4, 5, 6, 7, 8]]);
    // Embedded games in order (chunk ids carry the game id), never anything ≤ the cursor.
    const embeddedGames: string[] = [];
    for (const call of ollama.generateEmbeddings.mock.calls) {
      for (const item of call[0]) {
        const g = /cat:(steam-\d+)::/.exec(item.id)?.[1] ?? item.id;
        if (!embeddedGames.includes(g)) embeddedGames.push(g);
      }
    }
    expect(embeddedGames).toEqual(['steam-4', 'steam-5', 'steam-7', 'steam-8']);
    expect(result.successCount).toBe(4);
    expect(result.skippedCount).toBe(1); // the deleted steam-6

    const { buildCatalogEmbeddingText } = await import('@/services/embedding-service');
    for (const n of [4, 5, 7, 8]) {
      const row = db.get(`embed-catalog::steam-${n}`) as { textHash: string } | undefined;
      expect(row?.textHash).toBe(hashWholeEmbeddingText(buildCatalogEmbeddingText(entries[n - 1] as never)));
    }
    const wm = db.get(`embed-meta::${RECHUNK_META_KEY}`) as { phase: string };
    expect(wm.phase).toBe('done');
    // Progress: steamTotal as the total, starting from the 3 already done before the cursor.
    expect(progress[0]).toEqual({ completed: 3, total: 8, phase: 'steam' });
    expect(progress.every((p) => p.total === 8)).toBe(true);
  });
});

// ─── 2. Catalog TTL refresh age ─────────────────────────────────────────────

describe('catalog TTL refresh', () => {
  it('only rows older than half the TTL are refreshed (10 d no, 50 d / 85 d yes)', async () => {
    const { shouldRefreshCatalogTimestamp, CATALOG_TTL_REFRESH_AGE_MS } = await import('@/services/embedding-service');
    const now = 1_000 * DAY;
    expect(CATALOG_TTL_REFRESH_AGE_MS).toBe(45 * DAY);
    expect(shouldRefreshCatalogTimestamp(now - 10 * DAY, now)).toBe(false);
    expect(shouldRefreshCatalogTimestamp(now - 50 * DAY, now)).toBe(true);
    expect(shouldRefreshCatalogTimestamp(now - 85 * DAY, now)).toBe(true);
    expect(shouldRefreshCatalogTimestamp(0, now)).toBe(false);
  });

  it('daily passes keep every row inside the 90-day TTL, rewriting each at most every ~45 days', async () => {
    const { shouldRefreshCatalogTimestamp } = await import('@/services/embedding-service');
    const t0 = 1_000 * DAY;
    for (const startAge of [0, 44, 46, 80, 89]) {
      let ts = t0 - startAge * DAY;
      let rewrites = 0;
      for (let day = 0; day < 365; day++) {
        const now = t0 + day * DAY;
        expect(now - ts).toBeLessThan(90 * DAY); // never expired
        if (shouldRefreshCatalogTimestamp(ts, now)) { ts = now; rewrites++; }
      }
      expect(rewrites).toBeLessThanOrEqual(9); // a 7-day threshold would have rewritten ~52 times
    }
  });

  it('a real catalog pass refreshes only the 50 / 85-day rows', async () => {
    const { db, batches } = installFakeStore();
    installOllama(embedAll);
    const entries = [makeCatalogEntry(1), makeCatalogEntry(2), makeCatalogEntry(3)];
    let mod = await import('@/services/embedding-service');
    expect(await mod.embeddingService.generateCatalogEmbeddings(iteratorOf(entries))).toBe(3);

    // Age the stored rows, then run a fresh session's pass (no in-memory skip index).
    const ages: Record<string, number> = { 'steam-1': 10, 'steam-2': 50, 'steam-3': 85 };
    for (const [id, days] of Object.entries(ages)) {
      const row = db.get(`embed-catalog::${id}`) as { timestamp: number };
      db.set(`embed-catalog::${id}`, { ...row, timestamp: Date.now() - days * DAY });
    }
    vi.resetModules();
    mod = await import('@/services/embedding-service');
    batches.length = 0;
    expect(await mod.embeddingService.generateCatalogEmbeddings(iteratorOf(entries))).toBe(0);
    await vi.waitFor(() => {
      const refreshed = batches.flat().filter((op) => op.namespace === 'embed-catalog').map((op) => op.key).sort();
      expect(refreshed).toEqual(['steam-2', 'steam-3']);
    });
    expect((db.get('embed-catalog::steam-1') as { timestamp: number }).timestamp).toBeLessThan(Date.now() - 9 * DAY);
  });
});

// ─── 3. Live embedding cache eviction ───────────────────────────────────────

describe('live embedding cache eviction', () => {
  async function setup() {
    const { db } = installFakeStore();
    db.set('embed-library::lib-a', pooledRow('lib-a', 1));
    db.set('embed-library::lib-b', pooledRow('lib-b', 2));
    for (let i = 1; i <= 20; i++) db.set(`embed-catalog::steam-${i}`, pooledRow(`steam-${i}`, 100 + i));
    const mod = await import('@/services/embedding-service');
    const reco = await import('@/services/reco-store');
    const history = await import('@/services/reco-history-store');
    await mod.embeddingService.loadCachedEmbeddings(true);
    return { mod, reco, history };
  }
  const ids = (from: number, to: number) => new Set(Array.from({ length: to - from + 1 }, (_, i) => `steam-${from + i}`));

  it('two computes with disjoint pools: cache = library + pool 2 + pinned ids', async () => {
    const { mod, reco, history } = await setup();
    vi.spyOn(history.recoHistoryStore, 'getThumbsDownIds').mockReturnValue(['steam-2']);
    vi.spyOn(history.recoHistoryStore, 'getDismissals').mockReturnValue([{ gameId: 'steam-3' } as never]);

    const pool1 = ids(1, 8);
    expect(await mod.embeddingService.enrichWithCatalogEmbeddings(pool1, pool1)).toBe(8);
    expect(reco.getEmbeddingCache().size).toBe(2 + 8);

    const pool2 = ids(11, 18);
    expect(await mod.embeddingService.enrichWithCatalogEmbeddings(pool2, pool2)).toBe(8);
    const cache = reco.getEmbeddingCache();
    expect([...cache.keys()].sort()).toEqual(['lib-a', 'lib-b', 'steam-2', 'steam-3', ...pool2].sort());
    // The thumbs-down vector outside the pool is still there for negative mining.
    expect(cache.get('steam-2')).toBeDefined();
  });

  it('keepIds protects candidates that already carried a cached vector (no refetch ping-pong)', async () => {
    const { mod, reco } = await setup();
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(1, 5), ids(1, 5));
    // Next compute: steam-1..5 are still in the pool (already have vectors) and steam-6..8 are new.
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(6, 8), ids(1, 8));
    expect(reco.getEmbeddingCache().size).toBe(2 + 8);
  });

  it('re-fetched vectors are identical, so a later compute sees the same embeddings', async () => {
    const { mod, reco } = await setup();
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(1, 4), ids(1, 4));
    const first = reco.getEmbeddingCache().get('steam-2')!.slice();
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(10, 12), ids(10, 12));
    expect(reco.getEmbeddingCache().has('steam-2')).toBe(false);
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(1, 4), ids(1, 4));
    expect(reco.getEmbeddingCache().get('steam-2')).toEqual(first);
  });

  it('library vectors are never evicted', async () => {
    const { mod, reco } = await setup();
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(1, 2), new Set());
    await mod.embeddingService.enrichWithCatalogEmbeddings(ids(3, 4), new Set());
    const keys = [...reco.getEmbeddingCache().keys()];
    expect(keys).toContain('lib-a');
    expect(keys).toContain('lib-b');
    expect(mod.getCatalogTierCacheIds().has('lib-a')).toBe(false);
  });
});

// ─── 4. Galaxy precompute projection ────────────────────────────────────────

/** Pre-change projection: dequantise every row, normalise, project, center. */
function referenceProjection(
  rows: Array<{ id: string; vec: Float32Array | null }>,
  R: Float32Array,
): { ids: string[]; projected: Float32Array } {
  const P = 100;
  const valid = rows.filter((r) => r.vec);
  const n = valid.length;
  const projected = new Float32Array(n * P);
  valid.forEach((r, idx) => {
    const emb = r.vec!;
    let norm = 0;
    for (let j = 0; j < EMBEDDING_DIM; j++) norm += emb[j] * emb[j];
    norm = Math.sqrt(norm);
    const inv = norm > 1e-10 ? 1 / norm : 0;
    for (let k = 0; k < P; k++) {
      let s = 0;
      for (let j = 0; j < EMBEDDING_DIM; j++) s += R[k * EMBEDDING_DIM + j] * (emb[j] * inv);
      projected[idx * P + k] = s;
    }
  });
  const mean = new Float32Array(P);
  for (let i = 0; i < n; i++) for (let j = 0; j < P; j++) mean[j] += projected[i * P + j];
  for (let j = 0; j < P; j++) mean[j] /= n;
  for (let i = 0; i < n; i++) for (let j = 0; j < P; j++) projected[i * P + j] -= mean[j];
  return { ids: valid.map((r) => r.id), projected };
}

/** In-process stand-in for galaxy-projection.worker.ts (same message protocol, async replies). */
class FakeProjectionWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  pages = 0;
  private R: Float32Array | null = null;
  constructor(private readonly failOnPage = 0) {}
  postMessage(msg: GalaxyProjectionWorkerInput) {
    if (msg.type === 'init') { this.R = msg.R; return; }
    this.pages++;
    if (this.failOnPage > 0 && this.pages === this.failOnPage) {
      setTimeout(() => this.onerror?.({ message: 'boom' } as ErrorEvent), 0);
      return;
    }
    const out = projectInt8Page(msg.q, msg.scales, msg.count, this.R!, EMBEDDING_DIM, 100);
    setTimeout(() => this.onmessage?.({ data: { type: 'page', id: msg.id, out } } as MessageEvent), 0);
  }
  terminate() { /* noop */ }
}

describe('galaxy projected embeddings', () => {
  function seed() {
    const { db } = installFakeStore();
    const now = Date.now();
    const rows: Array<{ id: string; vec: Float32Array | null }> = [];
    for (let i = 0; i < 230; i++) {
      const id = `lib-${String(i).padStart(4, '0')}`;
      const row = pooledRow(id, i + 1, now);
      db.set(`embed-library::${id}`, row);
      rows.push({ id, vec: dequantizeEmbedding(Int8Array.from(row.q), row.scale) });
    }
    // Legacy float row in the middle of the library.
    db.set('embed-library::lib-0120', { gameId: 'lib-0120', embedding: vecFor(9999), textHash: 'x', timestamp: now });
    rows[120] = { id: 'lib-0120', vec: Float32Array.from(vecFor(9999)) };
    // Invalid (wrong length) row — excluded.
    db.set('embed-library::lib-bad', { gameId: 'lib-bad', q: [1, 2, 3], scale: 0.1, textHash: 'x', timestamp: now });
    for (let i = 0; i < 190; i++) {
      const id = `steam-${String(i).padStart(4, '0')}`;
      const row = pooledRow(id, 5000 + i, now);
      db.set(`embed-catalog::${id}`, row);
      rows.push({ id, vec: dequantizeEmbedding(Int8Array.from(row.q), row.scale) });
    }
    // Expired catalog row — excluded.
    db.set('embed-catalog::steam-old', pooledRow('steam-old', 7, now - 100 * DAY));
    const keySorted = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const lib = rows.filter((r) => r.id.startsWith('lib-')).sort(keySorted);
    const cat = rows.filter((r) => r.id.startsWith('steam-')).sort(keySorted);
    return { expectedRows: [...lib, ...cat] };
  }

  function rng(seedN: number) {
    let s = seedN >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
  }

  async function check(createWorker: () => Worker | null) {
    const { expectedRows } = seed();
    const R = generateGaussianProjectionMatrix(EMBEDDING_DIM, 100, rng(3));
    const { loadProjectedEmbeddingsForGraph } = await import('@/services/embedding-service');
    const got = await loadProjectedEmbeddingsForGraph(undefined, { R, createWorker });
    const want = referenceProjection(expectedRows, R);
    expect(got.ids).toEqual(want.ids);
    expect(got.ids).not.toContain('lib-bad');
    expect(got.ids).not.toContain('steam-old');
    expect(got.projected.length).toBe(want.projected.length);
    let maxDiff = 0;
    for (let i = 0; i < want.projected.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got.projected[i] - want.projected[i]));
    expect(maxDiff).toBeLessThan(1e-4);
    return got;
  }

  it('main-thread path matches the old dequantise-and-project output (fixed R)', async () => {
    await check(() => null);
  });

  it('worker path matches too, in id order', async () => {
    const workers: FakeProjectionWorker[] = [];
    await check(() => { const w = new FakeProjectionWorker(); workers.push(w); return w as unknown as Worker; });
    expect(workers).toHaveLength(1);
    expect(workers[0].pages).toBeGreaterThan(1);
  });

  it('a worker that dies mid-run falls back to the main thread without losing rows', async () => {
    await check(() => new FakeProjectionWorker(2) as unknown as Worker);
  });

  it('yields a macrotask every ~200 rows instead of one long task per page', async () => {
    seed();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { loadProjectedEmbeddingsForGraph } = await import('@/services/embedding-service');
    await loadProjectedEmbeddingsForGraph(undefined, { createWorker: () => null });
    const zeroDelay = spy.mock.calls.filter((c) => c[1] === 0).length;
    // ~420 rows walked over two passes → at least 4 yields.
    expect(zeroDelay).toBeGreaterThanOrEqual(4);
  });
});
