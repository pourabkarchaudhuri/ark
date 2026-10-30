/**
 * Storage panel rows measure LevelDB once a store has migrated (1.0.97 B19, oracle#23).
 *
 * After the v1.0.65 migration the live Steam / Epic catalogs and embeddings
 * live in LevelDB, but the panel kept counting the frozen legacy IndexedDB
 * copies (migration-day numbers forever, or 0 on a fresh install). Rows now
 * use `store:namespaceStats` when the migration marker is 'yes', without
 * going through catalogStore (whose getters would start the migration).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { steamGetEntryCount, epicGetEntryCount } = vi.hoisted(() => ({
  steamGetEntryCount: vi.fn(async () => 0),
  epicGetEntryCount: vi.fn(async () => 0),
}));

vi.mock('@/services/catalog-store', () => ({
  catalogStore: {
    get syncProgress() { return { stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0 }; },
    subscribe: vi.fn(() => () => {}),
    getEntryCount: steamGetEntryCount,
  },
}));
vi.mock('@/services/epic-catalog-store', () => ({
  epicCatalogStore: {
    get syncProgress() { return { stage: 'idle', itemsFetched: 0, itemsStored: 0 }; },
    subscribe: vi.fn(() => () => {}),
    getEntryCount: epicGetEntryCount,
  },
}));
vi.mock('@/services/reco-store', () => ({ recoStore: { getState: () => ({}), subscribe: vi.fn(() => () => {}) } }));
vi.mock('@/services/embedding-service', () => ({ embeddingService: { subscribe: vi.fn(() => () => {}) } }));
vi.mock('@/services/ann-index', () => ({ annIndex: { subscribe: vi.fn(() => () => {}) } }));
vi.mock('@/services/galaxy-cache', () => ({
  getBuildStage: () => 'idle',
  getBuildNodeCount: () => 0,
  getBuildStepIndex: () => -1,
  getBuildStepDetail: () => null,
  GALAXY_STEP_LABELS: [],
  subscribeGalaxy: vi.fn(() => () => {}),
}));
vi.mock('@/services/oracle-rerank', () => ({
  RERANK_TIER_LABELS: {},
  getLastRerankRun: () => null,
  subscribeRerankRuns: vi.fn(() => () => {}),
}));

import { measureStorageMetrics } from '@/services/system-status';

const STATS: Record<string, { count: number; sizeBytes: number }> = {
  'catalog-entries': { count: 155_000, sizeBytes: 90_000_000 },
  'catalog-meta': { count: 2, sizeBytes: 4_000 },
  'epic-catalog-entries': { count: 6_000, sizeBytes: 9_000_000 },
  'epic-catalog-meta': { count: 1, sizeBytes: 1_000 },
  'embed-library': { count: 300, sizeBytes: 500_000 },
  'embed-catalog': { count: 150_000, sizeBytes: 250_000_000 },
  'embed-chunks': { count: 400_000, sizeBytes: 600_000_000 },
  'embed-meta': { count: 3, sizeBytes: 2_000 },
};

function installStore() {
  const namespaceStats = vi.fn(async (namespaces: string[]) => ({
    stats: namespaces.map((namespace) => ({ namespace, ...(STATS[namespace] ?? { count: 0, sizeBytes: 0 }) })),
  }));
  Object.defineProperty(window, 'store', { value: { namespaceStats }, writable: true, configurable: true });
  return namespaceStats;
}

const row = (metrics: Awaited<ReturnType<typeof measureStorageMetrics>>, label: string) =>
  metrics.find((m) => m.label === label)!;

beforeEach(() => {
  localStorage.clear();
  steamGetEntryCount.mockClear();
  epicGetEntryCount.mockClear();
});

afterEach(() => {
  Object.defineProperty(window, 'store', { value: undefined, writable: true, configurable: true });
  localStorage.clear();
});

describe('measureStorageMetrics — LevelDB-backed rows', () => {
  it('uses the LevelDB namespace stats once each migration marker is set', async () => {
    localStorage.setItem('ark-steam-catalog-migrated-v1', 'yes');
    localStorage.setItem('ark-epic-catalog-migrated-v1', 'yes');
    localStorage.setItem('ark-embeddings-migrated-v1', 'yes');
    const namespaceStats = installStore();

    const metrics = await measureStorageMetrics();

    expect(row(metrics, 'Steam Catalog')).toMatchObject({ entryCount: 155_000, sizeBytes: 90_004_000 });
    expect(row(metrics, 'Epic Catalog')).toMatchObject({ entryCount: 6_000, sizeBytes: 9_001_000 });
    expect(row(metrics, 'Embeddings')).toMatchObject({
      entryCount: 300 + 150_000 + 400_000 + 3,
      sizeBytes: 500_000 + 250_000_000 + 600_000_000 + 2_000,
    });
    expect(namespaceStats).toHaveBeenCalledTimes(3);
    // Opening the panel must never trigger the migration through the stores.
    expect(steamGetEntryCount).not.toHaveBeenCalled();
    expect(epicGetEntryCount).not.toHaveBeenCalled();
  });

  it('keeps the IndexedDB measurement while a marker is missing', async () => {
    localStorage.setItem('ark-epic-catalog-migrated-v1', 'yes');
    const namespaceStats = installStore();

    const metrics = await measureStorageMetrics();

    // No IDB databases exist in this test → IDB measurement reads 0.
    expect(row(metrics, 'Steam Catalog')).toMatchObject({ entryCount: 0, sizeBytes: 0 });
    expect(row(metrics, 'Embeddings')).toMatchObject({ entryCount: 0, sizeBytes: 0 });
    expect(row(metrics, 'Epic Catalog')).toMatchObject({ entryCount: 6_000 });
    expect(namespaceStats).toHaveBeenCalledTimes(1);
    expect(namespaceStats).toHaveBeenCalledWith(['epic-catalog-entries', 'epic-catalog-meta']);
  });

  it('falls back to IndexedDB when the preload has no namespaceStats or it errors', async () => {
    localStorage.setItem('ark-steam-catalog-migrated-v1', 'yes');
    Object.defineProperty(window, 'store', {
      value: { namespaceStats: vi.fn(async () => ({ error: 'rate_limited' })) },
      writable: true,
      configurable: true,
    });
    const metrics = await measureStorageMetrics();
    expect(row(metrics, 'Steam Catalog')).toMatchObject({ entryCount: 0, sizeBytes: 0 });
    expect(row(metrics, 'LocalStorage')).toBeDefined();
  });
});
