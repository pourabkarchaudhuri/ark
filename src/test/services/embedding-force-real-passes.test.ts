/**
 * Force + resume against the REAL passes (only Ollama and storage are faked): a forced pass must re-embed
 * chunks whose text is unchanged, rows must carry the layout stamp / run id, and a resumed run must skip what the
 * interrupted run already redid.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real IndexedDB-backed passes are slow under a loaded CI/dev machine; the default 5s per test is too tight.
vi.setConfig({ testTimeout: 30_000 });
import { EMBEDDING_DIM } from '@/services/embedding-service';

const IDB_NAME = 'ark-embeddings';

function vec(): number[] {
  return new Array(EMBEDDING_DIM).fill(0.01);
}

function installOllama() {
  const generateEmbeddings = vi.fn(async (items: Array<{ id: string; text: string }>) => {
    const out: Record<string, number[]> = {};
    for (const item of items) out[item.id] = vec();
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
  return generateEmbeddings;
}

const entry = (appid: number) => ({
  appid, name: `Game ${appid}`, genres: ['Action'], themes: [], modes: [], developer: 'Dev', shortDescription: `desc ${appid}`,
});
const iteratorOf = <T,>(entries: T[]) => async (onBatch: (b: T[]) => void) => { onBatch(entries); return entries.length; };

async function freshService() {
  vi.resetModules();
  return await import('@/services/embedding-service');
}

async function readRows(store: 'catalog-embeddings' | 'embeddings' | 'chunk-embeddings'): Promise<any[]> {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, 'readonly');
      const all = tx.objectStore(store).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'ann', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(window, 'settings', {
    value: { getOllamaSettings: async () => ({ embeddingChunkingEnabled: true }) },
    writable: true,
    configurable: true,
  });
});

afterEach(async () => {
  localStorage.clear();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

describe('catalog pass: force really re-embeds (chunk diff no longer re-uses unchanged chunks)', () => {
  it('normal pass embeds; the next normal pass skips everything; a forced pass embeds again', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    const entries = [entry(1), entry(2), entry(3)];

    await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 0 });
    const firstCalls = gen.mock.calls.flatMap(c => c[0]).length;
    expect(firstCalls).toBeGreaterThan(0); // facets + summary chunk per game

    gen.mockClear();
    await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 0 });
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBe(0);

    gen.mockClear();
    await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 0, force: true });
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBe(firstCalls); // every chunk re-embedded (it used to be 0)
  });

  it('written pooled and chunk rows carry the layout stamp', async () => {
    installOllama();
    const { embeddingService } = await freshService();
    await embeddingService.generateCatalogEmbeddings(iteratorOf([entry(1)]), { storeKey: 'steam-catalog', lastSyncTimestamp: 0 });
    const pooled = await readRows('catalog-embeddings');
    const chunks = await readRows('chunk-embeddings');
    expect(pooled).toHaveLength(1);
    expect(pooled[0]).toMatchObject({ layout: 't10m1c1p1', poolVersion: 1 });
    expect(pooled[0].reindexRun).toBeUndefined(); // a normal pass is not part of a re-index run
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.layout).toBe('t10m1c1p1');
  });
});

describe('full re-index: resume skips what the interrupted run already redid', () => {
  const lib = [1, 2, 3].map(i => ({ id: `steam-${i}`, title: `Lib ${i}`, genres: ['RPG'], themes: [], modes: [], developer: 'Dev', summary: `s${i}` }));
  const sources = (n: number) => ({
    libraryGames: () => lib,
    steam: { iterate: iteratorOf(Array.from({ length: n }, (_, i) => entry(100 + i))), lastSyncTimestamp: () => 1 },
    epic: { iterate: iteratorOf([] as never[]), lastSyncTimestamp: () => 1 },
  });

  it('rows redone by a run carry its id; resuming the same run re-embeds nothing; a fresh run redoes everything', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    // The final ANN rebuild fails: the data stages finished but the run ends "pending" — a resumable interruption.
    (embeddingService as unknown as { rebuildAnnFromCache: () => Promise<number> }).rebuildAnnFromCache = async () => { throw new Error('ann down'); };
    const first = await embeddingService.forceReindexAll(sources(3));
    expect(first.libraryOk).toBe(true);
    expect(first.steamOutcome).toBe('done');
    expect(first.complete).toBe(false);
    expect(embeddingService.migrationState).toMatchObject({ state: 'pending', reason: 'interrupted', runId: first.runId });

    const catalogRows = await readRows('catalog-embeddings');
    const libraryRows = await readRows('embeddings');
    expect(catalogRows.length).toBe(3);
    expect(libraryRows.length).toBe(3);
    for (const r of [...catalogRows, ...libraryRows]) expect(r.reindexRun).toBe(first.runId);

    gen.mockClear();
    const resumed = await embeddingService.forceReindexAll({ ...sources(3), resume: true });
    expect(resumed.runId).toBe(first.runId);
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBe(0); // everything already redone by this run

    gen.mockClear();
    const fresh = await embeddingService.forceReindexAll(sources(3));
    expect(fresh.runId).not.toBe(first.runId);
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBeGreaterThan(0);
    for (const r of await readRows('catalog-embeddings')) expect(r.reindexRun).toBe(fresh.runId);
  });

  it('a partially redone run resumes only the remainder', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    (embeddingService as unknown as { rebuildAnnFromCache: () => Promise<number> }).rebuildAnnFromCache = async () => { throw new Error('ann down'); };
    // Run 1 only covers 2 of 4 catalog games (the catalog "grew" afterwards).
    const first = await embeddingService.forceReindexAll(sources(2));
    expect(first.steamOutcome).toBe('done');
    gen.mockClear();
    const resumed = await embeddingService.forceReindexAll({ ...sources(4), resume: true });
    expect(resumed.runId).toBe(first.runId);
    const idsEmbedded = new Set(gen.mock.calls.flatMap(c => c[0]).map((i: { id: string }) => i.id.split('::')[0]));
    // Only the two games the first run never saw are embedded (their chunks), not the ones it already redid.
    expect([...idsEmbedded].every(id => id === 'cat:steam-102' || id === 'cat:steam-103')).toBe(true);
    expect(idsEmbedded.size).toBe(2);
  });
});

describe('library-first ordering', () => {
  it('a catalog pass yields to a library run in flight and continues once it settles', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    const svc = embeddingService as unknown as { _libraryPromise: Promise<number> | null };
    let finishLibrary!: () => void;
    svc._libraryPromise = new Promise<number>((resolve) => { finishLibrary = () => resolve(0); });

    const pass = embeddingService.generateCatalogEmbeddings(iteratorOf([entry(1)]), { storeKey: 'steam-catalog', lastSyncTimestamp: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(gen).not.toHaveBeenCalled(); // waiting behind the library run

    svc._libraryPromise = null; // (generateMissing clears it in its finally)
    finishLibrary();
    await pass;
    expect(gen).toHaveBeenCalled();
  });
});


async function mutate(store: string, fn: (rows: any[]) => any[], keyPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const all = os.getAll();
      all.onsuccess = () => {
        for (const row of fn(all.result)) os.put(row);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
  void keyPath;
}

describe('resume only skips rows that are still CURRENT', () => {
  const srcs = (entries: unknown[]) => ({
    libraryGames: () => [],
    steam: { iterate: iteratorOf(entries as never[]), lastSyncTimestamp: () => 1 },
    epic: { iterate: iteratorOf([] as never[]), lastSyncTimestamp: () => 1 },
  });

  it('a game whose text changed since the interrupted run is re-embedded on resume', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    (embeddingService as unknown as { rebuildAnnFromCache: () => Promise<number> }).rebuildAnnFromCache = async () => { throw new Error('ann down'); };
    const first = await embeddingService.forceReindexAll(srcs([entry(1), entry(2)]));
    gen.mockClear();
    const changed = { ...entry(2), shortDescription: 'a completely different description' };
    const resumed = await embeddingService.forceReindexAll({ ...srcs([entry(1), changed]), resume: true });
    expect(resumed.runId).toBe(first.runId);
    const ids = new Set(gen.mock.calls.flatMap(c => c[0]).map((i: { id: string }) => i.id.split('::')[0]));
    expect([...ids]).toEqual(['cat:steam-2']); // only the game whose text changed
  });

  it('a row stamped by the run but from another layout is not treated as redone', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    (embeddingService as unknown as { rebuildAnnFromCache: () => Promise<number> }).rebuildAnnFromCache = async () => { throw new Error('ann down'); };
    const first = await embeddingService.forceReindexAll(srcs([entry(1)]));
    await mutate('catalog-embeddings', rows => rows.map(r => ({ ...r, layout: 't9m1c1p1' })), 'gameId');
    gen.mockClear();
    const resumed = await embeddingService.forceReindexAll({ ...srcs([entry(1)]), resume: true });
    expect(resumed.runId).toBe(first.runId);
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBeGreaterThan(0);
  });
});

describe('upgrade fixture: data written before stamps existed is left completely alone', () => {
  it('unstamped rows + a legacy "t10m1" watermark → a normal pass skips the scan and embeds nothing', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    const entries = [entry(1), entry(2), entry(3)];
    await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 5 });

    // Rewrite everything the way the PREVIOUS release stored it: no layout, no run id, bare-prefix watermark.
    await mutate('catalog-embeddings', rows => rows.map(({ layout, reindexRun, ...r }) => { void layout; void reindexRun; return r; }), 'gameId');
    await mutate('chunk-embeddings', rows => rows.map(({ layout, ...r }) => { void layout; return r; }), 'chunkId');
    await mutate('embedding-meta', rows => rows.map(r => (r.key === 'steam-catalog' ? { ...r, versionStamp: 't10m1' } : r)), 'key');

    const reborn = (await freshService()).embeddingService;
    gen.mockClear();
    await reborn.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 5 });
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBe(0);

    // …and even a pass that cannot use the watermark (catalog "re-synced") finds every row current.
    gen.mockClear();
    await reborn.generateCatalogEmbeddings(iteratorOf(entries), { storeKey: 'steam-catalog', lastSyncTimestamp: 6 });
    expect(gen.mock.calls.flatMap(c => c[0]).length).toBe(0);
  });
});

describe('forced library run never joins a non-forced one', () => {
  it('waits for every in-flight run (a waiter may start the next one) before it forces', async () => {
    const gen = installOllama();
    const { embeddingService } = await freshService();
    const svc = embeddingService as unknown as { _libraryPromise: Promise<number> | null };
    let release1!: () => void;
    let release2!: () => void;
    const first = new Promise<number>((r) => { release1 = () => r(0); });
    const second = new Promise<number>((r) => { release2 = () => r(0); });
    svc._libraryPromise = first;
    // When the first settles, a waiter immediately starts a NON-forced run (the race the loop guards against).
    void first.then(() => { svc._libraryPromise = second; });

    let finished = false;
    const forced = embeddingService
      .generateMissing([{ id: 'steam-1', title: 'Lib', genres: ['RPG'], summary: 's' }], undefined, { force: true })
      .then((n) => { finished = true; return n; });

    release1();
    await new Promise((r) => setTimeout(r, 100));
    expect(finished).toBe(false); // still waiting on the second run
    svc._libraryPromise = null;
    release2();
    await forced;
    expect(gen).toHaveBeenCalled(); // and it then ran its own FORCED pass
  });
});
