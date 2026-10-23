/**
 * forceReindexAll — ordered, persisted, resumable full re-index (library → Steam → Epic → ANN).
 * The heavy stages are stubbed on the service instance; what is under test is the orchestration and the
 * persisted migration state around it.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real IndexedDB-backed passes are slow under a loaded CI/dev machine; the default 5s per test is too tight.
vi.setConfig({ testTimeout: 30_000 });

type Svc = Record<string, any>;

async function freshService(): Promise<Svc> {
  vi.resetModules();
  const mod = await import('@/services/embedding-service');
  return mod.embeddingService as unknown as Svc;
}

const sources = {
  steam: { iterate: async () => 0, lastSyncTimestamp: () => 1 },
  epic: { iterate: async () => 0, lastSyncTimestamp: () => 1 },
};

function stub(svc: Svc, opts: {
  libraryOk?: boolean;
  steamOutcome?: string;
  epicOutcome?: string;
  annThrows?: boolean;
  calls?: string[];
} = {}) {
  const calls = opts.calls ?? [];
  svc.cancelLibraryEmbeddings = vi.fn();
  svc.cancelCatalogEmbeddingsAndWait = vi.fn(async () => { calls.push('cancel'); });
  svc.generateMissing = vi.fn(async (_games: unknown, _p: unknown, o?: { force?: boolean }) => {
    calls.push(`library${o?.force ? ':force' : ''}`);
    svc._lastLibraryRun = opts.libraryOk === false
      ? { requested: 10, generated: 2, stoppedEarly: true }
      : { requested: 10, generated: 10, stoppedEarly: false };
    return 10;
  });
  svc.generateCatalogEmbeddings = vi.fn(async (_it: unknown, o: { force?: boolean }) => {
    calls.push(`steam${o.force ? ':force' : ''}`);
    svc._lastPassOutcome.steam = opts.steamOutcome ?? 'done';
    return 100;
  });
  svc.generateEpicCatalogEmbeddings = vi.fn(async (_it: unknown, o: { force?: boolean }) => {
    calls.push(`epic${o.force ? ':force' : ''}`);
    svc._lastPassOutcome.epic = opts.epicOutcome ?? 'done';
    return 7;
  });
  svc.rebuildAnnFromCache = vi.fn(async () => {
    calls.push('ann');
    if (opts.annThrows) throw new Error('ann down');
    return 3;
  });
  return calls;
}

const run = (svc: Svc, over: Record<string, unknown> = {}) =>
  svc.forceReindexAll({ libraryGames: () => [{ id: 'steam-1', title: 'A' }], ...sources, ...over });

describe('forceReindexAll', () => {
  beforeEach(() => { indexedDB = new IDBFactory(); });

  it('runs library first, then Steam, then Epic, then rebuilds the ANN — all forced — and ends "done"', async () => {
    const svc = await freshService();
    const calls = stub(svc);
    const result = await run(svc);
    expect(calls).toEqual(['cancel', 'library:force', 'steam:force', 'epic:force', 'ann']);
    expect(result).toMatchObject({ complete: true, libraryOk: true, ann: true, library: 10, steam: 100, epic: 7 });
    expect(svc.migrationState).toMatchObject({ state: 'done', dataStamp: 't10m1c1p1' });
    expect(svc.isReindexRecommended).toBe(false);
    expect(svc.isForceReindexAllRunning).toBe(false);
  });

  it('a library that did not finish stops the run before the catalog is touched; state is pending/interrupted', async () => {
    const svc = await freshService();
    const calls = stub(svc, { libraryOk: false });
    const result = await run(svc);
    expect(calls).toEqual(['cancel', 'library:force']);
    expect(result).toMatchObject({ complete: false, libraryOk: false });
    expect(svc.migrationState).toMatchObject({ state: 'pending', reason: 'interrupted' });
    expect(svc.isReindexRecommended).toBe(true);
  });

  it('an empty library is not a failure: the catalog and the ANN are still rebuilt', async () => {
    const svc = await freshService();
    const calls = stub(svc);
    svc.generateMissing = vi.fn(async () => { calls.push('library:force'); svc._lastLibraryRun = { requested: 0, generated: 0, stoppedEarly: false }; return 0; });
    const result = await run(svc, { libraryGames: () => [] });
    expect(calls).toEqual(['cancel', 'library:force', 'steam:force', 'epic:force', 'ann']);
    expect(result).toMatchObject({ libraryOk: true, complete: true });
  });

  it('a Steam pass that trips/cancels stops before Epic and the ANN rebuild', async () => {
    const svc = await freshService();
    const calls = stub(svc, { steamOutcome: 'tripped' });
    const result = await run(svc);
    expect(calls).toEqual(['cancel', 'library:force', 'steam:force']);
    expect(result).toMatchObject({ complete: false, steamOutcome: 'tripped' });
    expect(svc.migrationState.state).toBe('pending');
  });

  it('an ANN rebuild failure is not "done": the data is fresh but the index is not, so it stays resumable', async () => {
    const svc = await freshService();
    stub(svc, { annThrows: true });
    const result = await run(svc);
    expect(result).toMatchObject({ complete: false, ann: false, epicOutcome: 'done' });
    expect(svc.migrationState).toMatchObject({ state: 'pending', reason: 'interrupted' });
  });

  it('a crash mid-run is recorded as interrupted (the record is never left "running")', async () => {
    const svc = await freshService();
    stub(svc);
    svc.generateCatalogEmbeddings = vi.fn(async () => { throw new Error('boom'); });
    await expect(run(svc)).rejects.toThrow('boom');
    expect(svc.migrationState).toMatchObject({ state: 'pending', reason: 'interrupted' });
  });

  it('resume reuses the interrupted run id; a plain re-run starts a new one', async () => {
    const svc = await freshService();
    stub(svc, { steamOutcome: 'tripped' });
    const first = await run(svc);
    expect(first.runId).toMatch(/^run-/);

    stub(svc); // Ollama recovered
    const resumed = await run(svc, { resume: true });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.complete).toBe(true);

    stub(svc, { steamOutcome: 'tripped' });
    const again = await run(svc);
    stub(svc);
    const fresh = await run(svc); // not a resume
    expect(fresh.runId).not.toBe(again.runId);
  });

  it('the interrupted state survives an app restart (persisted in embed-meta) and a restart finds it pending', async () => {
    const svc = await freshService();
    stub(svc, { epicOutcome: 'unavailable' });
    await run(svc);
    expect(svc.migrationState.state).toBe('pending');

    const reborn = await freshService(); // same IndexedDB, fresh module = restart
    const rec = await reborn.refreshMigrationState();
    expect(rec).toMatchObject({ state: 'pending', reason: 'interrupted' });
    expect(reborn.isReindexRecommended).toBe(true);
  });

  it('is single-flight: a second call joins the running one', async () => {
    const svc = await freshService();
    stub(svc);
    const a = run(svc);
    const b = run(svc);
    expect(b).toBe(a);
    await a;
    expect(svc.generateMissing).toHaveBeenCalledTimes(1);
  });

  it('declining stores "Later" for the current target and a fresh start keeps it declined', async () => {
    const svc = await freshService();
    stub(svc, { epicOutcome: 'unavailable' });
    await run(svc);
    const declined = await svc.declineMigration();
    expect(declined.state).toBe('declined');
    expect(svc.isReindexRecommended).toBe(false);
    const reborn = await freshService();
    expect((await reborn.refreshMigrationState()).state).toBe('declined');
  });

  it('first run on a profile reports done without doing anything', async () => {
    const svc = await freshService();
    const rec = await svc.refreshMigrationState();
    expect(rec).toMatchObject({ state: 'done', dataStamp: 't10m1c1p1' });
    expect(svc.isReindexRecommended).toBe(false);
  });
});
