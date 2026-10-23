/**
 * ANN job coordination (renderer side): Rebuild ANN vs catalog embedding.
 *
 * Users saw the ANN loader "go back and forth" and vectors go missing when a
 * catalog pass ran during Rebuild ANN: nothing kept the two apart, both wrote
 * one shared progress reading, and the pass's adds were dropped by the clear.
 * These tests pin the fix:
 *  - a rebuild holds an exclusive lease; other writers' adds wait for it and
 *    are applied after it (never dropped, never interleaved into the clear)
 *  - build progress has a single owner
 *  - backfill / rebuild are single-flight
 *  - the circuit-breaker resume of a FORCED pass is not forced
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
    batch: async (ops: Array<{ type: string; namespace: string; key: string; value?: unknown }>) => {
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

function installOllama(generate: (items: Array<{ id: string; text: string }>) => Promise<Record<string, number[]>>) {
  const generateEmbeddings = vi.fn(generate);
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

const embedAll = async (items: Array<{ id: string; text: string }>) => {
  const out: Record<string, number[]> = {};
  for (const item of items) out[item.id] = new Array(EMBEDDING_DIM).fill(0.01);
  return out;
};

/** Main-process stand-in: tracks ids, coherence, and an ordered op log. */
function installFakeAnn(opts: { clearGate?: Promise<void>; startCoherent?: boolean } = {}) {
  const ids = new Set<string>();
  let coherent = opts.startCoherent ?? true;
  const log: string[] = [];
  const api = {
    load: vi.fn(async () => ids.size > 0),
    save: vi.fn(async (o?: { force?: boolean; complete?: boolean }) => {
      if (o?.complete) coherent = true;
      log.push(o?.complete ? 'save:complete' : o?.force ? 'save:force' : 'save');
      return coherent;
    }),
    addVectors: vi.fn(async (entries: Array<{ id: string }>) => {
      let added = 0;
      for (const e of entries) { if (!ids.has(e.id)) added++; ids.add(e.id); }
      log.push(`add:${entries.map((e) => e.id).join(',')}`);
      return { added, replaced: entries.length - added, failed: 0, aborted: false };
    }),
    query: vi.fn(async () => []),
    queryBatch: vi.fn(async () => ({})),
    status: vi.fn(async () => ({ ready: ids.size > 0, vectorCount: ids.size, dims: 1024, partial: !coherent })),
    clear: vi.fn(async () => {
      log.push('clear:start');
      if (opts.clearGate) await opts.clearGate;
      ids.clear();
      coherent = false;
      log.push('clear:done');
      return true;
    }),
  };
  Object.defineProperty(window, 'ann', { value: api, writable: true, configurable: true });
  return { api, ids, log };
}

function seedPooled(db: Map<string, unknown>, ns: string, id: string) {
  db.set(`${ns}::${id}`, {
    gameId: id,
    embedding: new Array(EMBEDDING_DIM).fill(0.02),
    textHash: 'seed',
    timestamp: Date.now(),
    format: 'f32',
  });
}

function makeCatalogEntry(appid: number) {
  return { appid, name: `Game ${appid}`, genres: [], themes: [], modes: [], developer: 'Dev', shortDescription: 'desc' };
}

function iteratorOf<T>(entries: T[]) {
  return async (onBatch: (batch: T[]) => void): Promise<number> => { onBatch(entries); return entries.length; };
}

async function load() {
  const [svc, ann] = await Promise.all([import('@/services/embedding-service'), import('@/services/ann-index')]);
  return { embeddingService: svc.embeddingService, annIndex: ann.annIndex };
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
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('annIndex lease', () => {
  it('queues non-lease adds until the lease is released; lease-holder adds go straight through', async () => {
    const { api, log } = installFakeAnn();
    const { annIndex } = await load();

    const lease = await annIndex.acquireLease('ann-rebuild');
    let otherDone = false;
    const other = annIndex.addVectors([{ id: 'catalog-1', vector: [1] }]).then(() => { otherDone = true; });
    await annIndex.addVectors([{ id: 'backfill-1', vector: [1] }], { lease });
    await new Promise((r) => setTimeout(r, 10));
    expect(otherDone).toBe(false);
    expect(api.addVectors).toHaveBeenCalledTimes(1);

    lease.release();
    await other;
    expect(log).toEqual(['add:backfill-1', 'add:catalog-1']);
  });

  it('acquiring a lease drains writes already in flight before it is granted', async () => {
    const { api } = installFakeAnn();
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((r) => { releaseAdd = r; });
    const base = api.addVectors.getMockImplementation()!;
    api.addVectors.mockImplementationOnce(async (entries) => { await addGate; return base(entries); });
    const { annIndex } = await load();

    const inflight = annIndex.addVectors([{ id: 'catalog-1', vector: [1] }]);
    let granted = false;
    const leaseP = annIndex.acquireLease('ann-rebuild').then((l) => { granted = true; return l; });
    await new Promise((r) => setTimeout(r, 10));
    expect(granted).toBe(false);
    releaseAdd();
    await inflight;
    const lease = await leaseP;
    expect(granted).toBe(true);
    lease.release();
  });
});

describe('build progress has a single owner', () => {
  it('ignores updates / finish from a job that does not own the reading', async () => {
    installFakeAnn();
    const { annIndex } = await load();

    expect(annIndex.setBuildProgress(0, 100, 'ann-rebuild')).toBe(true);
    expect(annIndex.isBuilding).toBe(true);
    // Catalog pass tries to write its own progress / finish over the rebuild.
    expect(annIndex.setBuildProgress(48, 48, 'catalog:steam')).toBe(false);
    expect(annIndex.finishBuild('catalog:steam')).toBe(false);
    expect(annIndex.isBuilding).toBe(true);
    expect(annIndex.buildProgress).toEqual({ done: 0, total: 100 });

    expect(annIndex.finishBuild('ann-rebuild')).toBe(true);
    expect(annIndex.isBuilding).toBe(false);
    // Free again — the catalog pass may take it now.
    expect(annIndex.setBuildProgress(1, 10, 'catalog:steam')).toBe(true);
  });

  it('a lease preempts the progress reading from a running catalog pass', async () => {
    installFakeAnn();
    const { annIndex } = await load();
    annIndex.setBuildProgress(5, 10, 'catalog:steam');
    const lease = await annIndex.acquireLease('ann-rebuild');
    expect(annIndex.progressOwner).toBe('ann-rebuild');
    expect(annIndex.setBuildProgress(6, 10, 'catalog:steam')).toBe(false);
    annIndex.finishBuild('ann-rebuild');
    lease.release();
  });
});

describe('Rebuild ANN vs catalog embedding', () => {
  it("holds catalog adds until the rebuild's clear + backfill finished — nothing dropped or interleaved", async () => {
    const db = installFakeStore();
    seedPooled(db, 'embed-library', 'steam-100');
    seedPooled(db, 'embed-catalog', 'steam-200');
    let openClear!: () => void;
    const clearGate = new Promise<void>((r) => { openClear = r; });
    const { log, ids } = installFakeAnn({ clearGate });
    installOllama(embedAll);
    const { embeddingService, annIndex } = await load();
    await annIndex.refreshStatus();

    const rebuild = embeddingService.rebuildAnnFromCache();
    await vi.waitFor(() => expect(log).toContain('clear:start'));
    expect(embeddingService.isAnnRebuilding).toBe(true);

    const pass = embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1), makeCatalogEntry(2)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 1000 },
    );
    await new Promise((r) => setTimeout(r, 20));
    // Nothing from the catalog pass reached ANN while the clear is in flight.
    expect(log).toEqual(['clear:start']);

    openClear();
    const count = await rebuild;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await pass).toBe(2);

    const completeAt = log.indexOf('save:complete');
    const catalogAddAt = log.findIndex((l) => l.startsWith('add:') && l.slice(4).split(',').includes('steam-1'));
    expect(log.indexOf('clear:done')).toBeLessThan(completeAt);
    expect(completeAt).toBeGreaterThan(-1);
    // Catalog vectors applied AFTER the rebuild completed, and they survived.
    expect(catalogAddAt).toBeGreaterThan(completeAt);
    expect(ids.has('steam-1')).toBe(true);
    expect(ids.has('steam-2')).toBe(true);
    expect(ids.has('steam-100')).toBe(true);
    expect(embeddingService.isAnnRebuilding).toBe(false);
    expect(annIndex.isBuilding).toBe(false);
  });

  it('concurrent Rebuild clicks share one operation (one clear)', async () => {
    const db = installFakeStore();
    seedPooled(db, 'embed-catalog', 'steam-200');
    const { api } = installFakeAnn();
    const { embeddingService } = await load();

    const a = embeddingService.rebuildAnnFromCache();
    const b = embeddingService.rebuildAnnFromCache();
    const [ca, cb] = await Promise.all([a, b]);
    expect(ca).toBe(cb);
    expect(api.clear).toHaveBeenCalledTimes(1);
  });

  it('backfill is single-flight: concurrent triggers run one backfill', async () => {
    const db = installFakeStore();
    seedPooled(db, 'embed-catalog', 'steam-200');
    const { api } = installFakeAnn({ startCoherent: false });
    const { embeddingService, annIndex } = await load();
    await annIndex.refreshStatus();
    expect(annIndex.needsBackfill).toBe(true);

    const svc = embeddingService as unknown as { _backfillAnnIndex(): Promise<number> };
    const p1 = svc._backfillAnnIndex();
    const p2 = svc._backfillAnnIndex();
    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);
    expect(api.save.mock.calls.filter((c) => (c[0] as { complete?: boolean } | undefined)?.complete)).toHaveLength(1);
    expect(annIndex.needsBackfill).toBe(false);
  });

  it('cancelCatalogEmbeddingsAndWait also waits for a running backfill/rebuild', async () => {
    const db = installFakeStore();
    seedPooled(db, 'embed-catalog', 'steam-200');
    let openClear!: () => void;
    const clearGate = new Promise<void>((r) => { openClear = r; });
    installFakeAnn({ clearGate });
    const { embeddingService } = await load();

    const rebuild = embeddingService.rebuildAnnFromCache();
    let waited = false;
    const wait = embeddingService.cancelCatalogEmbeddingsAndWait().then(() => { waited = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(waited).toBe(false);
    openClear();
    await rebuild;
    await wait;
    expect(waited).toBe(true);
  });
});

describe('forced pass + circuit breaker', () => {
  it('saves a NON-forced resume callback when a forced pass trips the breaker', async () => {
    installFakeStore();
    installFakeAnn();
    installOllama(async () => ({})); // Ollama answers nothing → probe fails → trip
    const { embeddingService } = await load();

    const count = await embeddingService.generateCatalogEmbeddings(
      iteratorOf([makeCatalogEntry(1)]),
      { storeKey: 'steam-catalog', lastSyncTimestamp: 1000, force: true },
    );
    expect(count).toBe(0);
    expect(embeddingService.lastCatalogPassOutcome('steam')).toBe('tripped');

    const svc = embeddingService as unknown as {
      _breakerResume: { steam?: () => Promise<number> };
      _clearCircuitBreaker(): void;
    };
    const resume = svc._breakerResume.steam;
    expect(resume).toBeTypeOf('function');
    svc._clearCircuitBreaker(); // stop the probe timer

    const spy = vi.spyOn(embeddingService, 'generateCatalogEmbeddings').mockResolvedValue(0);
    await resume!();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ force: false, storeKey: 'steam-catalog' });
  });

  it('forceReindexCatalog reports incomplete (not "done") when the Steam pass trips', async () => {
    installFakeStore();
    installFakeAnn();
    installOllama(async () => ({}));
    const { embeddingService } = await load();

    const result = await embeddingService.forceReindexCatalog({
      steam: { iterate: iteratorOf([makeCatalogEntry(1)]), lastSyncTimestamp: () => 1000 },
      epic: { iterate: iteratorOf([]), lastSyncTimestamp: () => 1000 },
    });
    (embeddingService as unknown as { _clearCircuitBreaker(): void })._clearCircuitBreaker();
    expect(result.complete).toBe(false);
    expect(result.steamOutcome).toBe('tripped');
    expect(result.epicOutcome).toBe('skipped');
    expect(embeddingService.isForceReindexRunning).toBe(false);
  });

  it('forceReindexCatalog completes only after both forced passes ran', async () => {
    installFakeStore();
    installFakeAnn();
    installOllama(embedAll);
    const { embeddingService } = await load();

    const result = await embeddingService.forceReindexCatalog({
      steam: { iterate: iteratorOf([makeCatalogEntry(1), makeCatalogEntry(2)]), lastSyncTimestamp: () => 1000 },
      epic: {
        iterate: iteratorOf([{ epicId: 'a', name: 'A', genres: [], themes: [], modes: [], developer: 'D', description: 'd', longDescription: '' }]),
        lastSyncTimestamp: () => 1000,
      },
    });
    expect(result).toMatchObject({ steam: 2, epic: 1, complete: true, steamOutcome: 'done', epicOutcome: 'done' });
    expect(embeddingService.isHeavyRebuildCooldown).toBe(true);
  });
});

describe('content epoch', () => {
  it('is bumped once per catalog pass, not once per group', async () => {
    installFakeStore();
    installFakeAnn();
    installOllama(embedAll);
    const { embeddingService } = await load();
    const { getEmbeddingContentEpoch } = await import('@/services/embedding-service');
    const before = await getEmbeddingContentEpoch();

    // 250 entries → three 100-game groups (un-chunked path).
    const entries = Array.from({ length: 250 }, (_, i) => makeCatalogEntry(i + 1));
    const count = await embeddingService.generateCatalogEmbeddings(iteratorOf(entries), {
      storeKey: 'steam-catalog', lastSyncTimestamp: 1000,
    });
    expect(count).toBe(250);
    expect(await getEmbeddingContentEpoch()).toBe(before + 1);
  });
});
