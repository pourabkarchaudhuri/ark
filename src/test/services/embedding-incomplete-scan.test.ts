/**
 * Embedding passes and graph reads never treat a partial LevelDB scan as
 * complete (1.0.97 B19, renderer-stores#32).
 *
 * The stream helpers stopped at the first failed getChunk hop and returned
 * the partial walk as the whole namespace: the catalog pass then stamped its
 * watermark with games unembedded (and skipped them until the next sync), a
 * partial skip index sent cached games back to Ollama, and the graph was
 * built and persisted from a partial set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIM } from '@/services/embedding-service';

const MIGRATION_MARKER = 'ark-embeddings-migrated-v1';

function installFakeStore(opts: { failChunkNs?: string } = {}) {
  const db = new Map<string, unknown>();
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
      if (opts.failChunkNs === ns) return { error: 'simulated read error' };
      const prefix = `${ns}::`;
      const keys: string[] = [];
      for (const k of db.keys()) if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      keys.sort();
      const startIdx = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
      const eff = startIdx < 0 ? keys.length : startIdx;
      const rows = keys.slice(eff, eff + limit).map((k) => ({ key: k, value: db.get(`${ns}::${k}`) }));
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
    has: async () => ({ value: false }),
    clearNamespace: async () => ({ ok: true }),
  };
  Object.defineProperty(window, 'store', { value: fake, writable: true, configurable: true });
  return db;
}

function installOllamaMock() {
  const generateEmbeddings = vi.fn(async (items: Array<{ id: string; text: string }>) => {
    const out: Record<string, number[]> = {};
    for (const item of items) out[item.id] = new Array(EMBEDDING_DIM).fill(0.01);
    return out;
  });
  Object.defineProperty(window, 'ollama', {
    value: {
      healthCheck: async () => ({ running: true, version: '0.1.0' }),
      setup: async () => ({ ollamaDetected: true, ollamaVersion: '0.1.0', embeddingModelReady: true, error: null }),
      generateEmbeddings,
    },
    writable: true,
    configurable: true,
  });
  return { generateEmbeddings };
}

const entry = (appid: number) => ({ appid, name: `Game ${appid}`, genres: [], themes: [], modes: [], developer: 'Dev', shortDescription: 'desc' });

/** A catalog iterator as `catalogStore.scanAllEntries` returns it. */
function scanOf(entries: Array<ReturnType<typeof entry>>, complete: boolean) {
  return async (onBatch: (batch: any[]) => void) => {
    if (entries.length) onBatch(entries);
    return { count: entries.length, complete };
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(MIGRATION_MARKER, 'yes');
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ollama', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ann', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'settings', {
    value: { getOllamaSettings: async () => ({ embeddingChunkingEnabled: false }) },
    writable: true,
    configurable: true,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('catalog embedding pass — incomplete source scan', () => {
  it('embeds what it read but does not write the watermark, and reports error', async () => {
    const db = installFakeStore();
    const { generateEmbeddings } = installOllamaMock();
    const { embeddingService } = await import('@/services/embedding-service');

    const n = await embeddingService.generateCatalogEmbeddings(scanOf([entry(1), entry(2)], false), {
      storeKey: 'steam-catalog', lastSyncTimestamp: 1000,
    });

    expect(n).toBe(2);
    expect(generateEmbeddings).toHaveBeenCalled();
    expect(db.has('embed-meta::steam-catalog')).toBe(false);
    expect(embeddingService.lastCatalogPassOutcome('steam')).toBe('error');
  });

  it('a complete scan still writes the watermark (control)', async () => {
    const db = installFakeStore();
    installOllamaMock();
    const { embeddingService } = await import('@/services/embedding-service');

    await embeddingService.generateCatalogEmbeddings(scanOf([entry(1)], true), {
      storeKey: 'steam-catalog', lastSyncTimestamp: 1000,
    });

    expect(db.has('embed-meta::steam-catalog')).toBe(true);
    expect(embeddingService.lastCatalogPassOutcome('steam')).toBe('done');
  });

  it('"nothing to embed" from a partial scan does not write the watermark either', async () => {
    const db = installFakeStore();
    installOllamaMock();
    const { embeddingService } = await import('@/services/embedding-service');

    await embeddingService.generateCatalogEmbeddings(scanOf([], false), {
      storeKey: 'steam-catalog', lastSyncTimestamp: 1000,
    });

    expect(db.has('embed-meta::steam-catalog')).toBe(false);
    expect(embeddingService.lastCatalogPassOutcome('steam')).toBe('error');
  });

  it('a skip index that could not be read fully fails the pass instead of re-embedding', async () => {
    const db = installFakeStore({ failChunkNs: 'embed-catalog' });
    const { generateEmbeddings } = installOllamaMock();
    const { embeddingService } = await import('@/services/embedding-service');

    const n = await embeddingService.generateCatalogEmbeddings(scanOf([entry(1)], true), {
      storeKey: 'steam-catalog', lastSyncTimestamp: 1000,
    });

    expect(n).toBe(0);
    expect(generateEmbeddings).not.toHaveBeenCalled();
    expect(db.has('embed-meta::steam-catalog')).toBe(false);
    expect(embeddingService.lastCatalogPassOutcome('steam')).toBe('error');
  });
});

describe('graph embedding read — incomplete scan', () => {
  it('getAllPooledEmbeddingsForGraph throws IncompleteScanError instead of returning a partial set', async () => {
    installFakeStore({ failChunkNs: 'embed-catalog' });
    const { getAllPooledEmbeddingsForGraph } = await import('@/services/embedding-service');
    const { IncompleteScanError } = await import('@/services/level-stream');
    await expect(getAllPooledEmbeddingsForGraph()).rejects.toBeInstanceOf(IncompleteScanError);
  });
});
