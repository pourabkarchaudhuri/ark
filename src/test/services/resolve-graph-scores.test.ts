import { describe, it, expect, vi, beforeEach } from 'vitest';

const build = vi.fn();
const tryRestore = vi.fn();
const subscribe = vi.fn(() => () => {});
const getAllScores = vi.fn();
const getScoreBuffers = vi.fn();

let graphReady = false;
let graphPhase: 'idle' | 'building' | 'ready' | 'error' = 'idle';

vi.mock('@/services/game-graph-store', () => ({
  gameGraphStore: {
    get isReady() {
      return graphReady;
    },
    get state() {
      return { phase: graphPhase };
    },
    build: (...args: unknown[]) => build(...args),
    tryRestore: (...args: unknown[]) => tryRestore(...args),
    subscribe: (...args: unknown[]) => subscribe(...args),
    getAllScores: (...args: unknown[]) => getAllScores(...args),
    getScoreBuffers: (...args: unknown[]) => getScoreBuffers(...args),
  },
}));

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    get isReady() {
      return true;
    },
    vectorCount: 100,
  },
}));

vi.mock('@/services/engagement-weight', () => ({
  computeEngagementWeight: () => 1,
}));

import { resolveGraphScores } from '@/services/resolve-graph-scores';
import type { UserGameSnapshot } from '@/types/reco';

function stubUser(gameId: string): UserGameSnapshot {
  return {
    gameId,
    title: gameId,
    status: 'Completed',
    rating: 5,
    hoursPlayed: 10,
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    developer: '',
    publisher: '',
    releaseDate: '2020-01-01',
    addedAt: new Date().toISOString(),
    statusTrajectory: ['Completed'],
    sessionCount: 0,
    avgSessionMinutes: 0,
    lastSessionDate: null,
    activeToIdleRatio: 0,
    similarGameTitles: [],
    sessionTimestamps: [],
    sessionDurations: [],
    engagementPattern: 'unknown',
  };
}

const scores = {
  'steam-1': {
    pageRank: 0.1,
    personalizedPageRank: 0.2,
    authority: 0,
    hub: 0,
    community: 1,
    degree: 3,
  },
};

describe('resolveGraphScores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphReady = false;
    graphPhase = 'idle';
    getAllScores.mockReturnValue(scores);
    getScoreBuffers.mockReturnValue({
      personalizedPageRank: new Float32Array([0.1, 0.2]),
    });
    tryRestore.mockResolvedValue(false);
    build.mockResolvedValue(true);
    subscribe.mockReturnValue(() => {});
  });

  it('packs immediately when graph already ready', async () => {
    graphReady = true;
    graphPhase = 'ready';
    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(result.graphScoresMap).toEqual(scores);
    expect(build).not.toHaveBeenCalled();
    expect(tryRestore).not.toHaveBeenCalled();
  });

  it('prefers restore and packs without awaiting a cold rebuild', async () => {
    tryRestore.mockResolvedValue(true);
    graphReady = false;
    // after restore, store becomes ready
    tryRestore.mockImplementation(async () => {
      graphReady = true;
      graphPhase = 'ready';
      return true;
    });

    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(tryRestore).toHaveBeenCalledTimes(1);
    expect(result.graphScoresMap).toEqual(scores);
    expect(build).not.toHaveBeenCalled();
  });

  it('cold miss fires build without awaiting and returns undefined', async () => {
    tryRestore.mockResolvedValue(false);
    let buildResolved = false;
    build.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            buildResolved = true;
            graphReady = true;
            resolve(true);
          }, 200);
        }),
    );

    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(result.graphScoresMap).toBeUndefined();
    expect(build).toHaveBeenCalledTimes(1);
    expect(buildResolved).toBe(false); // did not await full rebuild
  });

  it('building phase waits at most once (no double waitReady)', async () => {
    graphPhase = 'building';
    tryRestore.mockResolvedValue(false);

    let subscribeCalls = 0;
    subscribe.mockImplementation((fn: () => void) => {
      subscribeCalls++;
      // become ready quickly
      queueMicrotask(() => {
        graphReady = true;
        graphPhase = 'ready';
        fn();
      });
      return () => {};
    });

    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(subscribeCalls).toBe(1);
    expect(result.graphScoresMap).toEqual(scores);
    expect(build).not.toHaveBeenCalled();
  });

  it('restored graph with null PPR kicks background seed repair', async () => {
    tryRestore.mockImplementation(async () => {
      graphReady = true;
      graphPhase = 'ready';
      return true;
    });
    getScoreBuffers.mockReturnValue({ personalizedPageRank: null });

    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).toHaveBeenCalledWith(
      expect.stringMatching(/^ann-/),
      expect.objectContaining({ force: true, librarySeed: expect.anything() }),
    );
  });
});
