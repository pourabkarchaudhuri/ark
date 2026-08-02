/**
 * System Status — 'migrating' stage regression test (v1.0.65 hotfix).
 *
 * Root cause of the real user-reported bug ("Catalog Embeddings progress
 * stays at 0" after updating to v1.0.65): catalog-store.ts's `CatalogSyncProgress`
 * gained a new `'migrating'` stage as part of the v1.0.65 LevelDB migration,
 * but system-status.ts's `getSnapshot()` never learned to handle it — it fell
 * through to a blank `detail` and 0% `percent` while still showing `stage:
 * 'running'`, and since the embedding pipeline is gated behind catalog sync
 * finishing, the whole subsystem looked frozen during what can be a multi-
 * minute one-time migration on a large catalog.
 *
 * These tests assert the fixed behavior directly against `getSnapshot()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const catalogSyncProgress = vi.fn();
const epicCatalogSyncProgress = vi.fn();

vi.mock('./catalog-store', () => ({
  catalogStore: {
    get syncProgress() { return catalogSyncProgress(); },
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./epic-catalog-store', () => ({
  epicCatalogStore: {
    get syncProgress() { return epicCatalogSyncProgress(); },
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./reco-store', () => ({
  recoStore: {
    getState: () => ({
      status: 'idle', progress: { stage: '', percent: 0 }, tasteProfile: null,
      shelves: [], computeTimeMs: 0, lastComputed: null, error: null,
      libraryCount: 0, candidateCount: 0,
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./embedding-service', () => ({
  embeddingService: {
    catalogProgress: { completed: 0, total: 0 },
    isCatalogRunning: false,
    rechunkProgress: { completed: 0, total: 0, phase: 'library' },
    isRechunkRunning: false,
    rechunkStatus: 'idle',
    rechunkMessage: null,
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./ann-index', () => ({
  annIndex: {
    buildProgress: { done: 0, total: 0 },
    isReady: false,
    isBuilding: false,
    vectorCount: 0,
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./galaxy-cache', () => ({
  getBuildStage: () => 'idle',
  getBuildNodeCount: () => 0,
  getBuildStepIndex: () => -1,
  getBuildStepDetail: () => null,
  GALAXY_STEP_LABELS: ['Embed', 'Graph', 'Project', 'Finalize'],
  subscribeGalaxy: vi.fn(() => () => {}),
}));

vi.mock('./oracle-rerank', () => ({
  RERANK_TIER_LABELS: { none: 'None', cosine: 'Cosine' },
  initRerankProgressListener: vi.fn(),
}));

import { systemStatus } from './system-status';

beforeEach(() => {
  catalogSyncProgress.mockReset();
  epicCatalogSyncProgress.mockReset();
  catalogSyncProgress.mockReturnValue({ stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0 });
  epicCatalogSyncProgress.mockReturnValue({ stage: 'idle', itemsFetched: 0, itemsStored: 0 });
});

describe('SystemStatus — Steam catalog "migrating" stage', () => {
  it('shows a non-blank detail and non-zero percent while migrating (not stuck at 0)', () => {
    catalogSyncProgress.mockReturnValue({
      stage: 'migrating', batchesCompleted: 0, batchesTotal: 0, gamesStored: 42_000,
    });

    const snap = systemStatus.getSnapshot();

    expect(snap.steamCatalogSync.stage).toBe('running');
    expect(snap.steamCatalogSync.detail).toContain('42,000');
    expect(snap.steamCatalogSync.detail).not.toBe('');
    expect(snap.steamCatalogSync.percent).toBeGreaterThan(0);
  });

  it('reflects the running migrated count as it climbs', () => {
    catalogSyncProgress.mockReturnValue({
      stage: 'migrating', batchesCompleted: 0, batchesTotal: 0, gamesStored: 100_000,
    });
    const snap = systemStatus.getSnapshot();
    expect(snap.steamCatalogSync.detail).toContain('100,000');
  });
});

describe('SystemStatus — Epic catalog "migrating" stage', () => {
  it('shows a non-blank detail while migrating', () => {
    epicCatalogSyncProgress.mockReturnValue({
      stage: 'migrating', itemsFetched: 0, itemsStored: 1_500,
    });

    const snap = systemStatus.getSnapshot();

    expect(snap.epicCatalogSync.stage).toBe('running');
    expect(snap.epicCatalogSync.detail).toContain('1,500');
    expect(snap.epicCatalogSync.percent).toBeGreaterThan(0);
  });
});

describe('SystemStatus — Catalog Embeddings widget while blocked behind catalog sync', () => {
  it('explains why it is at 0 instead of showing a bare blank widget', () => {
    catalogSyncProgress.mockReturnValue({
      stage: 'migrating', batchesCompleted: 0, batchesTotal: 0, gamesStored: 5_000,
    });

    const snap = systemStatus.getSnapshot();

    expect(snap.catalogEmbeddings.stage).toBe('idle');
    expect(snap.catalogEmbeddings.detail).toBe('Waiting for Steam Catalog sync…');
  });

  it('does not show the waiting message once catalog sync is done', () => {
    catalogSyncProgress.mockReturnValue({
      stage: 'done', batchesCompleted: 10, batchesTotal: 10, gamesStored: 155_000,
    });

    const snap = systemStatus.getSnapshot();

    expect(snap.catalogEmbeddings.detail).not.toBe('Waiting for Steam Catalog sync…');
  });
});
