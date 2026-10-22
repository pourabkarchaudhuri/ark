/**
 * Embedding pipeline hang/slowness fixes — regression tests.
 *
 * Covers the failure modes behind "embeddings stuck for hours":
 *  - IDB→LevelDB migration copied chunk groups with one `store.put` per game
 *    (rate-limited → threw → re-ran every launch). Must use `store.batch`.
 *  - A hung Ollama made every catalog batch wait out its timeout forever.
 *    A circuit breaker must stop the pass and resume once Ollama answers.
 *  - One game Ollama always rejects blocked the pass watermark forever (full
 *    rescan every launch). It must be skipped after 3 attempts and the
 *    watermark written.
 *  - Force re-index right after cancel got the cancelled run's promise back.
 *  - Pause persisted across restarts and blocked cancels.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIM } from '@/services/embedding-service';

const IDB_NAME = 'ark-embeddings';
const MIGRATION_MARKER = 'ark-embeddings-migrated-v1';

type BatchOp = { type: 'put' | 'del'; namespace: string; key: string; value?: unknown };

function installFakeStore() {
  const db = new Map<string, unknown>();
  const calls = { batch: 0, put: 0, embedPuts: 0, get: 0, getChunk: 0 };
  const batches: BatchOp[][] = [];

  const fake = {
    get: async (ns: string, key: string) => {
      calls.get++;
      return { value: db.get(`${ns}::${key}`) ?? null };
    },
    getMany: async (ns: string, keys: string[]) => ({
      values: keys.map((k) => db.get(`${ns}::${k}`) ?? null),
    }),
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
    put: async (ns: string, key: string, value: unknown) => {
      calls.put++;
      if (ns.startsWith('embed-')) calls.embedPuts++;
      db.set(`${ns}::${key}`, value);
      return { ok: true };
    },
    del: async (ns: string, key: string) => { db.delete(`${ns}::${key}`); return { ok: true }; },
    batch: async (ops: BatchOp[]) => {
      calls.batch++;
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
  return { db, calls, batches };
}

type EmbedFn = (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>;

function vec(): number[] {
  return new Array(EMBEDDING_DIM).fill(0.01);
}

/** Ollama mock; `embed` decides per call what comes back. */
function installOllama(embed: EmbedFn) {
  const generateEmbeddings = vi.fn(embed);
  const healthCheck = vi.fn(async () => ({ running: true, version: '0.1.0' }));
  Object.defineProperty(window, 'ollama', {
    value: {
      healthCheck,
      setup: async () => ({ ollamaDetected: true, ollamaVersion: '0.1.0', embeddingModelReady: true, error: null }),
      generateEmbeddings,
    },
    writable: true,
    configurable: true,
  });
  return { generateEmbeddings, healthCheck };
}

const embedAll: EmbedFn = async (items) => {
  const out: Record<string, number[]> = {};
  for (const item of items) out[item.id] = vec();
  return out;
};

function setChunking(enabled: boolean) {
  Object.defineProperty(window, 'settings', {
    value: { getOllamaSettings: async () => ({ embeddingChunkingEnabled: enabled }) },
    writable: true,
    configurable: true,
  });
}

function makeCatalogEntry(appid: number, name = `Game ${appid}`) {
  return { appid, name, genres: ['Action'], themes: [], modes: [], developer: 'Dev', shortDescription: `desc ${appid}` };
}

function iteratorOf<T>(entries: T[]) {
  return async (onBatch: (batch: T[]) => void): Promise<number> => {
    onBatch(entries);
    return entries.length;
  };
}

async function loadService() {
  const mod = await import('@/services/embedding-service');
  return mod;
}

async function deleteIdbDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
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

afterEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
  await deleteIdbDatabase();
});

// ─── 1. Migration writes in batches ─────────────────────────────────────────

describe('IDB → LevelDB migration', () => {
  function makeChunk(gameId: string, seed: number) {
    const q = new Int8Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) q[i] = ((seed + i) % 255) - 127;
    return {
      chunkId: `cat:${gameId}::facets#0`,
      tier: 'cat',
      gameId,
      kind: 'facets',
      seq: 0,
      q,
      scale: 0.01,
      textHash: `c1:${seed}`,
      weight: 1,
      timestamp: Date.now(),
    };
  }

  async function seedChunks(count: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('embeddings', { keyPath: 'gameId' });
        db.createObjectStore('catalog-embeddings', { keyPath: 'gameId' });
        db.createObjectStore('embedding-meta', { keyPath: 'key' });
        const s = db.createObjectStore('chunk-embeddings', { keyPath: 'chunkId' });
        s.createIndex('byGame', 'gameId', { unique: false });
        s.createIndex('byTierGame', ['tier', 'gameId'], { unique: false });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('chunk-embeddings', 'readwrite');
        for (let i = 0; i < count; i++) tx.objectStore('chunk-embeddings').put(makeChunk(`steam-${i}`, i));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });
  }

  it('copies chunk groups with store.batch (≤200 groups per call), never one put per game', async () => {
    localStorage.removeItem(MIGRATION_MARKER);
    await seedChunks(450);
    const { db, calls, batches } = installFakeStore();

    const { getChunksForGame } = await loadService();
    const chunks = await getChunksForGame('steam-449');

    expect(chunks).toHaveLength(1);
    expect(localStorage.getItem(MIGRATION_MARKER)).toBe('yes');
    expect(calls.embedPuts).toBe(0);
    const chunkBatches = batches.filter((ops) => ops.every((op) => op.namespace === 'embed-chunks'));
    expect(chunkBatches.map((ops) => ops.length)).toEqual([200, 200, 50]);
    const migratedKeys = [...db.keys()].filter((k) => k.startsWith('embed-chunks::'));
    expect(migratedKeys).toHaveLength(450);
  });
});

// ─── 2. Circuit breaker ─────────────────────────────────────────────────────

describe('catalog pass circuit breaker', () => {
  it('stops as soon as an empty Ollama call is confirmed by a failed probe, marks Ollama unavailable, keeps the watermark unwritten', async () => {
    const { db } = installFakeStore();
    const ollama = installOllama(async () => ({}));
    const { embeddingService } = await loadService();

    const entries = Array.from({ length: 1000 }, (_, i) => makeCatalogEntry(i + 1));
    const generated = await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
    });

    expect(generated).toBe(0);
    // 10 groups of 100 were queued — one empty group call, then one failed probe trips the breaker.
    expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(2);
    expect(embeddingService.isOllamaUnavailable).toBe(true);
    expect(embeddingService.isOllamaStalled).toBe(true);
    expect(embeddingService.isCatalogRunning).toBe(false);
    expect(db.has('embed-meta::steam-catalog')).toBe(false);
    // Ambiguous all-null failures must not count toward poisoning games.
    expect(db.has('embed-meta::embed-failures')).toBe(false);

    embeddingService.cancelCatalogEmbeddings(); // also clears the pending auto-resume
    expect(embeddingService.isOllamaStalled).toBe(false);
  });

  it('resumes the stopped pass once a probe embedding succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFakeStore();
    let healthy = false;
    const ollama = installOllama(async (items) => (healthy ? embedAll(items) : {}));
    const { embeddingService } = await loadService();

    const entries = Array.from({ length: 600 }, (_, i) => makeCatalogEntry(i + 1));
    await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
    });
    expect(embeddingService.isOllamaStalled).toBe(true);

    healthy = true;
    await vi.advanceTimersByTimeAsync(61_000);
    for (let i = 0; i < 50 && (embeddingService.isOllamaStalled || embeddingService.isCatalogRunning); i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(embeddingService.isOllamaStalled).toBe(false);
    expect(embeddingService.isCatalogRunning).toBe(false);
    expect(embeddingService.catalogProgress).toEqual({ completed: 600, total: 600 });
    // 1 failed call + 1 failed probe (trip) + 1 recovery probe + 6 successful groups.
    expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(9);
  });

  it('re-checks availability after the negative TTL instead of caching "unavailable" forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFakeStore();
    const { healthCheck } = installOllama(embedAll);
    healthCheck.mockResolvedValueOnce({ running: false, version: null as unknown as string });
    const { embeddingService } = await loadService();

    expect(await embeddingService.isAvailable()).toBe(false);
    expect(await embeddingService.isAvailable()).toBe(false); // inside TTL — no re-probe
    expect(healthCheck).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(await embeddingService.isAvailable()).toBe(true);
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });
});

// ─── 3. Poison games ────────────────────────────────────────────────────────

describe('poison-game handling', () => {
  it('skips a game Ollama always rejects after 3 attempts and then writes the watermark', async () => {
    const { db } = installFakeStore();
    const rejectSteam2: EmbedFn = async (items) => {
      const out: Record<string, number[]> = {};
      for (const item of items) if (item.id !== 'steam-2') out[item.id] = vec();
      return out;
    };
    const ollama = installOllama(rejectSteam2);
    const { embeddingService } = await loadService();
    const entries = [makeCatalogEntry(1), makeCatalogEntry(2)];
    const run = (ts: number) => embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: ts,
    });

    expect(await run(1000)).toBe(1); // steam-1 embedded, steam-2 attempt 1
    expect(db.has('embed-meta::steam-catalog')).toBe(false);

    await run(1000); // steam-2 alone → attempt 2 (confirmed via probe)
    expect(db.has('embed-meta::steam-catalog')).toBe(false);

    await run(1000); // attempt 3 → poisoned → nothing left to retry
    const wm = db.get('embed-meta::steam-catalog') as { syncTimestamp: number } | undefined;
    expect(wm?.syncTimestamp).toBe(1000);

    // A later sync rescans, but the poisoned game is not sent to Ollama again.
    const callsBefore = ollama.generateEmbeddings.mock.calls.length;
    await run(2000);
    const sentIds = ollama.generateEmbeddings.mock.calls.slice(callsBefore).flatMap(([items]) => items.map((i) => i.id));
    expect(sentIds).not.toContain('steam-2');
    expect((db.get('embed-meta::steam-catalog') as { syncTimestamp: number }).syncTimestamp).toBe(2000);
  });

  it('does not count transient (timeout / never-sent) failures as strikes against a game', async () => {
    const { db } = installFakeStore();
    // steam-2 always comes back as transient (Ollama timed out before reaching it)
    const transientSteam2 = (async (items: Array<{ id: string; text: string }>) => {
      const results: Record<string, number[]> = {};
      for (const item of items) if (item.id !== 'steam-2') results[item.id] = vec();
      return { results, transientIds: items.some((i) => i.id === 'steam-2') ? ['steam-2'] : [] };
    }) as unknown as EmbedFn;
    installOllama(transientSteam2);
    const { embeddingService } = await loadService();
    const entries = [makeCatalogEntry(1), makeCatalogEntry(2)];
    for (let i = 0; i < 4; i++) {
      await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 1000 });
    }
    // Never poisoned → never skipped → the watermark is not advanced past it
    expect(db.has('embed-meta::steam-catalog')).toBe(false);
  });

  it('re-chunk job skips a poison game after 3 attempts and advances its cursor instead of stopping', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setChunking(true);
    installFakeStore();
    installOllama(async (items) => {
      const out: Record<string, number[]> = {};
      for (const item of items) if (!item.id.startsWith('lib:bad::')) out[item.id] = vec();
      return out;
    });
    const { embeddingService } = await loadService();

    const jobPromise = embeddingService.startRechunkJob({
      libraryGames: [
        { id: 'bad', title: 'Bad Game', genres: ['Action'] },
        { id: 'good', title: 'Good Game', genres: ['Puzzle'] },
      ],
      steamIterator: async () => 0,
      epicIterator: async () => 0,
    }, { force: true });

    let settled = false;
    void jobPromise.finally(() => { settled = true; });
    for (let i = 0; i < 60 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);

    const result = await jobPromise;
    expect(result.status).toBe('done');
    expect(result.successCount).toBe(1); // 'good' written after 'bad' was skipped
    expect(result.failureCount).toBe(3);
  });
});

// ─── 4. Force re-index after cancel ─────────────────────────────────────────

describe('force re-index right after cancel', () => {
  it('waits for the cancelled run to settle and then really runs', async () => {
    installFakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const ollama = installOllama(async (items) => {
      if (first) { first = false; await gate; }
      return embedAll(items);
    });
    const { embeddingService } = await loadService();
    const entries = [makeCatalogEntry(1), makeCatalogEntry(2), makeCatalogEntry(3)];

    const background = embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
    });
    await vi.waitFor(() => expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(1));

    embeddingService.cancelCatalogEmbeddings();
    const forced = embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
      force: true,
    });
    expect(forced).not.toBe(background);

    release();
    await background;
    const forcedCount = await forced;

    expect(forcedCount).toBe(3);
    expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(2);
    expect(embeddingService.isCatalogRunning).toBe(false);
  });

  it('cancelCatalogEmbeddingsAndWait resolves only after the in-flight run has settled', async () => {
    installFakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ollama = installOllama(async (items) => { await gate; return embedAll(items); });
    const { embeddingService } = await loadService();

    const run = embeddingService.generateCatalogEmbeddings(iteratorOf([makeCatalogEntry(1)]), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
    });
    await vi.waitFor(() => expect(ollama.generateEmbeddings).toHaveBeenCalledTimes(1));

    let waited = false;
    const wait = embeddingService.cancelCatalogEmbeddingsAndWait().then(() => { waited = true; });
    await Promise.resolve();
    expect(waited).toBe(false);

    release();
    await wait;
    await run;
    expect(embeddingService.isCatalogRunning).toBe(false);
  });
});

// ─── 5. Pause ───────────────────────────────────────────────────────────────

describe('pause', () => {
  it('is not restored from a previous session', async () => {
    localStorage.setItem('ark-embedding-paused', '1');
    const { embeddingService } = await loadService();
    expect(embeddingService.isPaused).toBe(false);
    expect(localStorage.getItem('ark-embedding-paused')).toBeNull();
  });

  it('a cancel issued while paused ends the pass without waiting for resume', async () => {
    installFakeStore();
    const ollama = installOllama(embedAll);
    const { embeddingService } = await loadService();
    embeddingService.pause();

    const run = embeddingService.generateCatalogEmbeddings(iteratorOf([makeCatalogEntry(1)]), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 1000,
    });
    await vi.waitFor(() => expect(embeddingService.isCatalogRunning).toBe(true));
    embeddingService.cancelCatalogEmbeddings();

    expect(await run).toBe(0);
    expect(ollama.generateEmbeddings).not.toHaveBeenCalled();
    expect(embeddingService.isCatalogRunning).toBe(false);
    embeddingService.resume();
  });

  it('generateMissing returns immediately while paused instead of blocking', async () => {
    installFakeStore();
    const ollama = installOllama(embedAll);
    const { embeddingService } = await loadService();
    embeddingService.pause();

    const count = await embeddingService.generateMissing([{ id: 'steam-1', title: 'A' }]);
    expect(count).toBe(0);
    expect(ollama.generateEmbeddings).not.toHaveBeenCalled();
    embeddingService.resume();
  });
});

// ─── 6. Oracle / library generation reuses catalog vectors ─────────────────

describe('generateMissing', () => {
  it('treats an existing catalog embedding as present (no re-embed) unless the game has user notes', async () => {
    const { db } = installFakeStore();
    db.set('embed-catalog::steam-1', {
      gameId: 'steam-1', embedding: vec(), textHash: 'x', timestamp: Date.now(), format: 'f32',
    });
    db.set('embed-catalog::steam-2', {
      gameId: 'steam-2', embedding: vec(), textHash: 'x', timestamp: Date.now(), format: 'f32',
    });
    const ollama = installOllama(embedAll);
    const { embeddingService } = await loadService();

    const generated = await embeddingService.generateMissing([
      { id: 'steam-1', title: 'Has catalog vector' },
      { id: 'steam-2', title: 'Has catalog vector but notes', userNotes: 'loved the combat' },
      { id: 'steam-3', title: 'No vector at all' },
    ]);

    expect(generated).toBe(2);
    const sent = ollama.generateEmbeddings.mock.calls.flatMap(([items]) => items.map((i) => i.id));
    expect(sent.sort()).toEqual(['steam-2', 'steam-3']);
  });

  it('honours an already-aborted signal', async () => {
    installFakeStore();
    const ollama = installOllama(embedAll);
    const { embeddingService } = await loadService();
    const ac = new AbortController();
    ac.abort();
    expect(await embeddingService.generateMissing([{ id: 'steam-9', title: 'X' }], undefined, { signal: ac.signal })).toBe(0);
    expect(ollama.generateEmbeddings).not.toHaveBeenCalled();
  });
});

// ─── 7. Cheap pooled counts ─────────────────────────────────────────────────

describe('getPooledEmbeddingCount', () => {
  it('scans once, then serves counts from the key index and stays exact across writes', async () => {
    const { calls } = installFakeStore();
    installOllama(embedAll);
    const { embeddingService, getPooledEmbeddingCount } = await loadService();

    expect(await getPooledEmbeddingCount()).toBe(0);
    const scansAfterFirst = calls.getChunk;

    await embeddingService.generateCatalogEmbeddings(iteratorOf([makeCatalogEntry(1), makeCatalogEntry(2)]), {
      storeKey: 'steam-catalog',
      lastSyncTimestamp: 0,
    });
    const scansAfterPass = calls.getChunk;

    expect(await getPooledEmbeddingCount()).toBe(2);
    expect(await getPooledEmbeddingCount()).toBe(2);
    expect(calls.getChunk).toBe(scansAfterPass);
    expect(scansAfterFirst).toBeGreaterThan(0);
  });
});
