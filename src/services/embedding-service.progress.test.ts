/**
 * Embedding Service — catalog progress-state hygiene tests (v1.0.71).
 *
 * Users reported that "Catalog Embeddings" / "Embedding Space" progress bars
 * get stuck below 100% and never reach done. Root cause: several exit paths
 * in `_runCatalogEmbeddings`/`_runEpicCatalogEmbeddings` never wrote a
 * terminal progress value (leaving whatever partial reading was last
 * written), `_catalogProgress` was a single field shared by both Steam and
 * Epic passes (Epic's `{0,N}` start wiped Steam's just-completed `{N,N}`),
 * and the ANN index's `_building` flag could get stuck `true` forever on a
 * 0-vectors-eligible backfill or a thrown error. These tests exercise the
 * fixes through the public API (`generateCatalogEmbeddings` /
 * `generateEpicCatalogEmbeddings`), the same surface real callers use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIM } from '@/services/embedding-service';

const MIGRATION_MARKER = 'ark-embeddings-migrated-v1';

function installFakeStore() {
  const db = new Map<string, unknown>();

  const fake = {
    get: async (ns: string, key: string) => ({ value: db.get(`${ns}::${key}`) ?? null }),
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
    batch: async (ops: any[]) => {
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
  return db;
}

function installOllamaMock(opts: { unavailable?: boolean; throwOnBatch?: boolean } = {}) {
  if (opts.unavailable) {
    Object.defineProperty(window, 'ollama', { value: undefined, writable: true, configurable: true });
    return { generateEmbeddings: vi.fn() };
  }
  const generateEmbeddings = vi.fn(async (items: Array<{ id: string; text: string }>) => {
    if (opts.throwOnBatch) throw new Error('simulated Ollama failure');
    const out: Record<string, number[]> = {};
    for (const item of items) out[item.id] = new Array(EMBEDDING_DIM).fill(0.01);
    return out;
  });
  Object.defineProperty(window, 'ollama', {
    value: {
      healthCheck: async () => ({ running: true, version: '0.1.0' }),
      setup: async () => ({
        ollamaDetected: true, ollamaVersion: '0.1.0', embeddingModelReady: true, error: null,
      }),
      generateEmbeddings,
    },
    writable: true,
    configurable: true,
  });
  return { generateEmbeddings };
}

function makeCatalogEntry(appid: number, name = 'Test Game') {
  return { appid, name, genres: [], themes: [], modes: [], developer: 'Dev', shortDescription: 'desc' };
}

function makeEpicEntry(epicId: string, name = 'Test Epic Game') {
  return { epicId, name, genres: [], themes: [], modes: [], developer: 'Dev', description: 'desc', longDescription: '' };
}

function iteratorOf<T>(entries: T[]) {
  return async (onBatch: (batch: T[]) => void): Promise<number> => {
    onBatch(entries);
    return entries.length;
  };
}

async function loadFresh() {
  const [{ embeddingService }, { annIndex }] = await Promise.all([
    import('@/services/embedding-service'),
    import('@/services/ann-index'),
  ]);
  return { embeddingService, annIndex };
}

beforeEach(() => {
  localStorage.clear();
  // Skip the real IDB->LevelDB migration path entirely — irrelevant to these tests.
  localStorage.setItem(MIGRATION_MARKER, 'yes');
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ollama', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ann', { value: undefined, writable: true, configurable: true });
  // Force the simple (non-chunked) embedding path — isEmbeddingChunkingEnabled()
  // defaults to true when window.settings is absent, which would otherwise
  // route through embedAndPersistChunkedGame and need a much larger mock
  // surface unrelated to what these tests are verifying.
  Object.defineProperty(window, 'settings', {
    value: { getOllamaSettings: async () => ({ embeddingChunkingEnabled: false }) },
    writable: true,
    configurable: true,
  });
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
});

describe('generateCatalogEmbeddings — terminal progress state', () => {
  it('resets progress to {0,0} when Ollama is unavailable, never leaves a partial reading', async () => {
    installFakeStore();
    installOllamaMock({ unavailable: true });
    const { embeddingService } = await loadFresh();

    const result = await embeddingService.generateCatalogEmbeddings(iteratorOf([makeCatalogEntry(1)]), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: Date.now(),
    });

    expect(result).toBe(0);
    expect(embeddingService.catalogProgress).toEqual({ completed: 0, total: 0 });
    expect(embeddingService.isCatalogRunning).toBe(false);
  });

  it('completes a normal run at {N,N}, with ANN no longer marked as building', async () => {
    installFakeStore();
    installOllamaMock();
    const { embeddingService, annIndex } = await loadFresh();

    const count = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1), makeCatalogEntry(2)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: Date.now() },
    );

    expect(count).toBe(2);
    expect(embeddingService.catalogProgress).toEqual({ completed: 2, total: 2 });
    expect(embeddingService.isCatalogRunning).toBe(false);
    expect(annIndex.isBuilding).toBe(false);
  });

  it('resets progress to {0,0} and un-wedges ANN when a batch write throws', async () => {
    installFakeStore();
    installOllamaMock({ throwOnBatch: true });
    const { embeddingService, annIndex } = await loadFresh();

    const count = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: Date.now() },
    );

    // generateEmbeddings throws inside the batch loop, which is NOT caught
    // per-batch (only saveCachedEmbeddings/annIndex.addVectors are) — it
    // propagates to the function's outer catch.
    expect(count).toBe(0);
    expect(embeddingService.catalogProgress).toEqual({ completed: 0, total: 0 });
    expect(embeddingService.isCatalogRunning).toBe(false);
    expect(annIndex.isBuilding).toBe(false);
  });
});

describe('generateCatalogEmbeddings + generateEpicCatalogEmbeddings — split progress fields', () => {
  it("Epic starting its own pass does not wipe Steam's already-completed progress", async () => {
    installFakeStore();
    const ollama = installOllamaMock();
    const { embeddingService } = await loadFresh();

    const steamCount = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: Date.now() },
    );
    expect(steamCount).toBe(1);
    expect(embeddingService.catalogProgress).toEqual({ completed: 1, total: 1 });

    // Start Epic's pass with a larger batch — its own {0, N} start must not
    // reset Steam's {1,1} contribution to the merged getter.
    const epicPromise = embeddingService.generateEpicCatalogEmbeddings(
      iteratorOf([makeEpicEntry('a'), makeEpicEntry('b')]),
      { storeKey: 'epic-catalog', lastSyncTimestamp: Date.now() },
    );

    // Merged progress should read Steam's 1/1 plus whatever Epic has posted
    // so far (0 or more) — completed/total must never regress below Steam's
    // own contribution.
    const midway = embeddingService.catalogProgress;
    expect(midway.completed).toBeGreaterThanOrEqual(1);
    expect(midway.total).toBeGreaterThanOrEqual(1);

    const epicCount = await epicPromise;
    expect(epicCount).toBe(2);
    expect(embeddingService.catalogProgress).toEqual({ completed: 3, total: 3 });
    expect(ollama.generateEmbeddings).toHaveBeenCalled();
  });
});

describe('generateCatalogEmbeddings — force option bypasses the content-hash skip', () => {
  it('re-embeds an entry whose cached hash still matches when force=true, but skips it otherwise', async () => {
    const db = installFakeStore();
    const ollama = installOllamaMock();
    const { embeddingService } = await loadFresh();
    const { buildCatalogEmbeddingText, hashWholeEmbeddingText } = await import('@/services/embedding-service');

    const entry = makeCatalogEntry(42);
    const text = buildCatalogEmbeddingText(entry as any);
    const hash = hashWholeEmbeddingText(text);

    // Seed a cached pooled embedding whose hash already matches this entry's
    // current content — a normal (non-forced) pass must skip it.
    db.set('embed-catalog::steam-42', {
      gameId: 'steam-42',
      embedding: new Array(EMBEDDING_DIM).fill(0.02),
      textHash: hash,
      timestamp: Date.now(),
      format: 'f32',
    });

    const normalCount = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([entry]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 0 },
    );
    expect(normalCount).toBe(0);
    expect(ollama.generateEmbeddings).not.toHaveBeenCalled();

    // Forced pass must re-embed it anyway, even though the hash still matches
    // — this is the recovery path for suspected cache corruption, where the
    // hash bookkeeping can agree with a corrupted stored vector.
    const forcedCount = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([entry]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 0, force: true },
    );
    expect(forcedCount).toBe(1);
    expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(1);
  });
});

describe('ANN index building state — never left stuck true', () => {
  it('does not stay "building" after a canSkipScan pass with zero vectors eligible', async () => {
    installFakeStore();
    installOllamaMock();
    const { embeddingService, annIndex } = await loadFresh();

    // First real pass stamps the watermark.
    await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 100 },
    );
    expect(annIndex.isBuilding).toBe(false);

    // Second pass with the same (or later) sync timestamp hits canSkipScan —
    // annIndex._building must still resolve to false, not get stuck at the
    // backfill's initial setBuildProgress(0, 1) when 0 vectors are eligible.
    await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 100 },
    );
    expect(annIndex.isBuilding).toBe(false);
  });
});
