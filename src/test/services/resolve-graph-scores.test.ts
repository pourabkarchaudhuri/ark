import { annGraphSignature } from '@/services/graph-signature';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const build = vi.fn();
const tryRestore = vi.fn();
const subscribe = vi.fn(() => () => {});
const getAllScores = vi.fn();
const getScoresFor = vi.fn();
const getScoreBuffers = vi.fn();
const hasNode = vi.fn();
const isRebuildThrottled = vi.fn();

let graphReady = false;
let graphPhase: 'idle' | 'building' | 'ready' | 'error' = 'idle';
let graphHasScores = false;
let graphMeta: { signature: string } | null = null;

vi.mock('@/services/game-graph-store', () => ({
  gameGraphStore: {
    get isReady() {
      return graphReady;
    },
    get state() {
      return { phase: graphPhase };
    },
    get hasScores() {
      return graphHasScores;
    },
    get meta() {
      return graphMeta;
    },
    build: (...args: unknown[]) => build(...args),
    tryRestore: (...args: unknown[]) => tryRestore(...args),
    subscribe: (...args: unknown[]) => subscribe(...args),
    getAllScores: (...args: unknown[]) => getAllScores(...args),
    getScoresFor: (...args: unknown[]) => getScoresFor(...args),
    getMaxPageRank: () => 0.5,
    getScoreBuffers: (...args: unknown[]) => getScoreBuffers(...args),
    hasNode: (...args: unknown[]) => hasNode(...args),
    isRebuildThrottled: (...args: unknown[]) => isRebuildThrottled(...args),
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

import { resolveGraphScores, _resetPprRepairState } from '@/services/resolve-graph-scores';
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
    _resetPprRepairState();
    graphReady = false;
    graphPhase = 'idle';
    graphHasScores = false;
    graphMeta = null;
    hasNode.mockReturnValue(true);
    isRebuildThrottled.mockReturnValue(false);
    getAllScores.mockReturnValue(scores);
    getScoresFor.mockReturnValue(scores);
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

  it('PPR seed repair runs at most once per signature', async () => {
    graphReady = true;
    graphPhase = 'ready';
    getScoreBuffers.mockReturnValue({ personalizedPageRank: null });

    await resolveGraphScores([stubUser('steam-1')]);
    await resolveGraphScores([stubUser('steam-1')]);
    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('asks for a (throttled) rebuild when serving a graph built for an older signature', async () => {
    graphReady = true;
    graphPhase = 'ready';
    graphMeta = { signature: 'ann-1' };
    getScoreBuffers.mockReturnValue({ personalizedPageRank: new Float32Array([1]) });
    hasNode.mockReturnValue(true);
    build.mockResolvedValue(true);

    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).toHaveBeenCalledWith(annGraphSignature(100), expect.anything());
    graphMeta = null;
  });

  it('skips PPR seed repair when no seed game is a graph node', async () => {
    graphReady = true;
    graphPhase = 'ready';
    getScoreBuffers.mockReturnValue({ personalizedPageRank: new Float32Array([0, 0]) });
    hasNode.mockReturnValue(false);

    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).not.toHaveBeenCalled();
  });

  it('does not burn the repair attempt while rebuilds are throttled', async () => {
    graphReady = true;
    graphPhase = 'ready';
    getScoreBuffers.mockReturnValue({ personalizedPageRank: null });
    isRebuildThrottled.mockReturnValue(true);
    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).not.toHaveBeenCalled();

    isRebuildThrottled.mockReturnValue(false);
    await resolveGraphScores([stubUser('steam-1')]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('packs only candidate + user ids with the global PageRank max when ids are given', async () => {
    graphReady = true;
    graphPhase = 'ready';
    const result = await resolveGraphScores([stubUser('steam-1')], 1_000, ['steam-2', 'steam-3']);
    expect(getAllScores).not.toHaveBeenCalled();
    const ids = [...(getScoresFor.mock.calls[0][0] as Set<string>)].sort();
    expect(ids).toEqual(['steam-1', 'steam-2', 'steam-3']);
    expect(result.graphMaxPageRank).toBe(0.5);
  });

  it('serves the loaded graph while a rebuild is in flight instead of waiting', async () => {
    graphPhase = 'building';
    graphHasScores = true;
    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(subscribe).not.toHaveBeenCalled();
    expect(result.graphScoresMap).toEqual(scores);
  });

  it('signature miss restores the stale graph and leaves the rebuild to build()', async () => {
    tryRestore.mockImplementation(async (_sig: string, opts?: { acceptStale?: boolean }) => {
      if (!opts?.acceptStale) return false;
      graphReady = true;
      graphPhase = 'ready';
      graphMeta = { signature: 'ann-42' };
      return true;
    });
    const result = await resolveGraphScores([stubUser('steam-1')]);
    expect(result.graphScoresMap).toEqual(scores);
    expect(build).toHaveBeenCalledWith(annGraphSignature(100), expect.not.objectContaining({ force: true }));
  });
});
