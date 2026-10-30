/**
 * 1.0.97: the status panel's Recommendation Engine and Reranker Setup timers are per run.
 * The engine timer used to start once per session (a 5 s recompute showed "47m 12s" and kept
 * growing while idle); the reranker timer did the same for a second model pull.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recoState = vi.hoisted(() => ({
  current: {
    status: 'idle', progress: { stage: '', percent: 0 }, tasteProfile: null,
    shelves: [] as unknown[], computeTimeMs: 0, lastComputed: null, error: null,
    libraryCount: 0, candidateCount: 0,
  },
}));

vi.mock('@/services/catalog-store', () => ({
  catalogStore: {
    syncProgress: { stage: 'idle', batchesCompleted: 0, batchesTotal: 0, gamesStored: 0 },
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock('@/services/epic-catalog-store', () => ({
  epicCatalogStore: { syncProgress: { stage: 'idle', itemsFetched: 0, itemsStored: 0 }, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('@/services/reco-store', () => ({
  recoStore: { getState: () => recoState.current, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('@/services/embedding-service', () => ({
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
vi.mock('@/services/ann-index', () => ({
  annIndex: { buildProgress: { done: 0, total: 0 }, isReady: false, isBuilding: false, vectorCount: 0, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('@/services/galaxy-cache', () => ({
  getBuildStage: () => 'idle',
  getBuildNodeCount: () => 0,
  getBuildStepIndex: () => -1,
  getBuildStepDetail: () => null,
  GALAXY_STEP_LABELS: ['Embed', 'Graph', 'Project', 'Finalize'],
  subscribeGalaxy: vi.fn(() => () => {}),
}));
vi.mock('@/services/oracle-rerank', () => ({
  RERANK_TIER_LABELS: { none: 'None', cosine: 'Cosine', qwen_graded: 'Qwen3 graded' },
  initRerankProgressListener: vi.fn(),
  getLastRerankRun: () => null,
  subscribeRerankRuns: vi.fn(() => () => {}),
}));

import { systemStatus, reportRerankProgress, reportRerankDone } from '@/services/system-status';

let clock = 0;
const setReco = (status: string, computeTimeMs = 0) => {
  recoState.current = { ...recoState.current, status, computeTimeMs };
  systemStatus._trackRecoTimer(status);
};

beforeEach(() => {
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Recommendation Engine timer', () => {
  it('each compute reports its own elapsed time, and idle reports 0', () => {
    setReco('computing');
    clock += 4_000;
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(4_000);
    clock += 1_000;
    setReco('done'); // no computeTimeMs: the frozen end - start
    clock += 60 * 60_000; // an hour idle on 'done' does not grow it
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(5_000);

    setReco('idle');
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(0);

    setReco('computing'); // the second compute starts from zero
    clock += 2_500;
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(2_500);
    setReco('done', 2_400);
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(2_400); // the worker's own figure wins
  });

  it('an error freezes at the failed run\'s duration', () => {
    setReco('idle');
    setReco('computing');
    clock += 3_000;
    setReco('error');
    clock += 10_000;
    expect(systemStatus.getSnapshot().recoPipeline.elapsed).toBe(3_000);
  });
});

describe('Reranker Setup timer', () => {
  it('a second pull after "done" starts from its own first event', () => {
    reportRerankProgress({ status: 'Pulling', pct: 10 } as never);
    clock += 30_000;
    reportRerankDone({ done: true, tier: 'qwen_graded', ollamaUp: true } as never);
    expect(systemStatus.getSnapshot().rerankSetup.elapsed).toBe(30_000);

    clock += 3_600_000; // much later, another model pull
    reportRerankProgress({ status: 'Pulling', pct: 5 } as never);
    clock += 2_000;
    reportRerankProgress({ status: 'Pulling', pct: 50 } as never);
    expect(systemStatus.getSnapshot().rerankSetup.elapsed).toBe(2_000);
    clock += 1_000;
    reportRerankDone({ done: true, tier: 'qwen_graded', ollamaUp: true } as never);
    expect(systemStatus.getSnapshot().rerankSetup.elapsed).toBe(3_000);
  });
});
