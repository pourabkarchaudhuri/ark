/**
 * v1.0.75: results cached by a different Oracle engine version must never be
 * served, and each compute records telemetry + a compact "shown" log row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/library-store', () => ({
  libraryStore: {
    getAllGameIds: () => [],
    getEntry: () => undefined,
    getAllEntries: () => [],
    subscribe: () => () => {},
  },
}));
vi.mock('@/services/custom-game-store', () => ({
  customGameStore: { getAllGames: () => [], subscribe: () => () => {} },
}));
vi.mock('@/services/journey-store', () => ({ journeyStore: { getAllEntries: () => [] } }));
vi.mock('@/services/session-store', () => ({ sessionStore: { getAll: () => [] } }));
vi.mock('@/services/status-history-store', () => ({ statusHistoryStore: { getAll: () => [] } }));
vi.mock('@/services/reco-history-store', () => ({
  recoHistoryStore: {
    getDismissals: () => [],
    getThumbsUpIds: () => [],
    getThumbsDownIds: () => [],
  },
}));
vi.mock('@/services/catalog-store', () => ({ catalogStore: {} }));
vi.mock('@/services/epic-catalog-store', () => ({ epicCatalogStore: {} }));
vi.mock('@/services/ann-index', () => ({ annIndex: { isReady: false, vectorCount: 0 } }));
vi.mock('@/services/bm25-index', () => ({
  bm25Index: { isReady: false, scheduleIdleRebuild: () => {} },
}));
vi.mock('@/services/embedding-service', () => ({
  embeddingService: { computeTasteCentroid: () => null },
}));
vi.mock('@/services/game-graph-store', () => ({ gameGraphStore: { isReady: false } }));
vi.mock('@/services/similar-games', () => ({
  getSimilarTitlesForRecoBatch: async () => new Map(),
}));
vi.mock('@/services/resolve-graph-scores', () => ({
  GRAPH_BUILD_TIMEOUT_MS: 8_000,
  resolveGraphScores: async () => ({
    graphScoresMap: undefined,
    userCommunityCounts: undefined,
    userCommunityTotal: undefined,
  }),
}));

import {
  RecoStore,
  buildOracleLibrarySignature,
  currentOraclePipelineStages,
} from '@/services/reco-store';
import { ORACLE_ENGINE_VERSION } from '@/services/oracle-engine-version';
import { oracleEventLog } from '@/services/oracle-event-log';
import { TELEMETRY_LAYERS } from '@/services/reco-scoring';
import type { RecoShelf, RecoTelemetry, RecoWorkerResult, TasteProfile } from '@/types/reco';
import { makeScored } from '@/test/oracle/fixtures';

const CACHE_KEY = 'ark-oracle-results';

function cachePayload(over: Record<string, unknown> = {}) {
  return {
    shelves: [{ type: 'hero', title: 't', subtitle: '', games: [] }],
    tasteProfile: null,
    computeTimeMs: 5,
    lastComputed: Date.now(),
    libraryCount: 0,
    candidateCount: 0,
    librarySignature: buildOracleLibrarySignature(),
    pipelineStages: currentOraclePipelineStages(),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
});

describe('Oracle result cache — engine version', () => {
  const load = (store: RecoStore) => (store as any).loadResultsFromCache() as Promise<unknown>;

  it('serves a cache written by the current engine version', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload({ engineVersion: ORACLE_ENGINE_VERSION })));
    expect(await load(new RecoStore())).not.toBeNull();
  });

  it('rejects a cache with no engine version (written before versioning)', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload()));
    expect(await load(new RecoStore())).toBeNull();
  });

  it('rejects a cache from a different engine version', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload({ engineVersion: ORACLE_ENGINE_VERSION + 1 })));
    expect(await load(new RecoStore())).toBeNull();
  });

  it('saves the current engine version with the cache', () => {
    const store = new RecoStore();
    (store as any).state = { ...(store as any).state, shelves: [{ type: 'hero', title: 't', games: [] }], lastComputed: Date.now() };
    (store as any).saveResultsToCache();
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    expect(saved.engineVersion).toBe(ORACLE_ENGINE_VERSION);
  });
});

describe('finishWorkerResult — telemetry and shown-run logging', () => {
  const profile = { genres: [], themes: [], gameModes: [], perspectives: [], developers: [], publishers: [], eras: [], totalGames: 0, totalHours: 0, avgRating: 0, topGenre: '', topTheme: '', clusters: [] } as unknown as TasteProfile;
  const telemetry = { layers: [], top20Ties: 0, top20Distinct: 0, funnel: { candidatesIn: 0, afterExclusions: 0, scored: 0, mmrPool: 0, mmrSelected: 0, shelfGames: 0 }, embeddingCoverage: 0, mlCoverage: 0, graphScoresAvailable: false, weightSum: 0 } as RecoTelemetry;

  it('stores worker telemetry on state and logs one compact shown-run row', () => {
    const spy = vi.spyOn(oracleEventLog, 'record').mockImplementation(() => {});
    const store = new RecoStore();
    const anyStore = store as any;
    anyStore.saveResultsToCache = vi.fn();
    anyStore.rerankShelvesInBackground = vi.fn();
    const shelves = [
      { type: 'hero', title: 'Hero', games: [makeScored('steam-1', 0.8)] },
      { type: 'hidden-gems', title: 'Gems', games: [makeScored('steam-2', 0.5), makeScored('steam-3', 0.4)] },
    ] as unknown as RecoShelf[];
    const msg = { type: 'result', tasteProfile: profile, shelves, computeTimeMs: 1, telemetry } as RecoWorkerResult;

    anyStore.finishWorkerResult(msg, anyStore.computeGeneration);

    expect(store.getState().telemetry).toBe(telemetry);
    const shown = spy.mock.calls.map(c => c[0]).find(e => e.type === 'shown-run');
    expect(shown).toBeDefined();
    const data = shown!.data as { engineVersion: number; layerOrder: readonly string[]; items: Array<{ id: string; shelf: string; pos: number; layers?: number[] }> };
    expect(data.engineVersion).toBe(ORACLE_ENGINE_VERSION);
    expect(data.layerOrder).toEqual([...TELEMETRY_LAYERS]);
    expect(data.items.map(i => [i.id, i.shelf, i.pos])).toEqual([
      ['steam-1', 'hero', 0], ['steam-2', 'hidden-gems', 0], ['steam-3', 'hidden-gems', 1],
    ]);
    expect(data.items[0].layers).toHaveLength(TELEMETRY_LAYERS.length);
    spy.mockRestore();
  });

  it('bounds the shown-run row: 8 games per shelf, layer detail only for the first 3', () => {
    const spy = vi.spyOn(oracleEventLog, 'record').mockImplementation(() => {});
    const store = new RecoStore();
    const anyStore = store as any;
    anyStore.saveResultsToCache = vi.fn();
    anyStore.rerankShelvesInBackground = vi.fn();
    const games = Array.from({ length: 20 }, (_, i) => makeScored(`steam-${i}`, 0.9 - i * 0.01));
    const shelves = [{ type: 'hero', title: 'Hero', games }] as unknown as RecoShelf[];
    anyStore.finishWorkerResult({ type: 'result', tasteProfile: profile, shelves, computeTimeMs: 1, telemetry } as RecoWorkerResult, anyStore.computeGeneration);
    const shown = spy.mock.calls.map(c => c[0]).find(e => e.type === 'shown-run')!;
    const items = (shown.data as { items: Array<{ layers?: number[] }> }).items;
    expect(items).toHaveLength(8);
    expect(items.filter(i => i.layers).length).toBe(3);
    spy.mockRestore();
  });
});
