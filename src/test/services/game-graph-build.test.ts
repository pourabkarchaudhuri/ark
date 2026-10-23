/**
 * GameGraphStore build lifecycle: metrics-worker timeout flips the store to
 * 'error' (instead of 'building' forever), and concurrent build() calls share
 * one in-flight promise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/services/ann-index', () => ({
  annIndex: {
    isReady: true,
    vectorCount: 2,
    queryBatch: vi.fn(async () => ({
      'steam-a': [{ id: 'steam-b', distance: 0.1 }],
      'steam-b': [{ id: 'steam-a', distance: 0.1 }],
    })),
  },
}));

const heap = vi.hoisted(() => ({ high: false }));

vi.mock('@/services/embedding-service', () => ({
  embeddingService: { isCatalogRunning: false, isAnnRebuilding: false, isHeavyRebuildCooldown: false },
  // Float32Array rows — the graph build no longer materialises number[] vectors.
  getAllPooledEmbeddingsForGraph: vi.fn(async () => [
    { gameId: 'steam-a', embedding: new Float32Array([1, 0]) },
    { gameId: 'steam-b', embedding: new Float32Array([0, 1]) },
  ]),
  isRendererHeapPressureHigh: () => heap.high,
}));

import { GameGraphStore, runGraphMetricsWorker } from '@/services/game-graph-store';
import { getAllPooledEmbeddingsForGraph } from '@/services/embedding-service';

/** Worker stand-in that accepts the job and never answers. */
class SilentWorker {
  static instances: SilentWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  posted = 0;
  constructor() { SilentWorker.instances.push(this); }
  postMessage() { this.posted++; }
  terminate() { this.terminated = true; }
}

describe('runGraphMetricsWorker', () => {
  beforeEach(() => { vi.useFakeTimers(); SilentWorker.instances = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects and terminates the worker when it never answers', async () => {
    const p = runGraphMetricsWorker(
      () => new SilentWorker() as unknown as Worker,
      ['a', 'b'],
      new Float32Array([0, 1, 0.9]),
      null,
      { timeoutMs: 1_000 },
    );
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(SilentWorker.instances[0].terminated).toBe(true);
  });

  it('a late result after the timeout is ignored', async () => {
    const onProgress = vi.fn();
    const p = runGraphMetricsWorker(
      () => new SilentWorker() as unknown as Worker,
      ['a'],
      new Float32Array(0),
      null,
      { timeoutMs: 500, onProgress },
    );
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    const w = SilentWorker.instances[0];
    w.onmessage?.({ data: { type: 'progress', stage: 'late', percent: 50 } } as MessageEvent);
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('GameGraphStore.build', () => {
  beforeEach(() => {
    SilentWorker.instances = [];
    vi.stubGlobal('Worker', SilentWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('metrics-worker timeout sets phase "error" instead of hanging in "building"', async () => {
    const store = new GameGraphStore({ metricsTimeoutMs: 30 });
    const ok = await store.build('ann-2');
    expect(ok).toBe(false);
    expect(store.state.phase).toBe('error');
    expect(SilentWorker.instances).toHaveLength(1);
    expect(SilentWorker.instances[0].terminated).toBe(true);
    expect(store.isBuildInFlight).toBe(false);
  });

  it('concurrent build() calls share one in-flight build', async () => {
    const store = new GameGraphStore({ metricsTimeoutMs: 30 });
    const a = store.build('ann-2');
    const b = store.build('ann-2');
    expect(b).toBe(a);
    await a;
    expect(SilentWorker.instances).toHaveLength(1);
  });

  it('a forced build queues behind an in-flight unforced one instead of being absorbed', async () => {
    const store = new GameGraphStore({ metricsTimeoutMs: 30 });
    const a = store.build('ann-2');
    const forced = store.build('ann-2', { force: true });
    expect(forced).not.toBe(a);
    await a;
    await forced;
    // The unforced build failed (worker timeout) → failure cooldown throttles the queued forced one
    expect(SilentWorker.instances).toHaveLength(1);
    expect(store.isRebuildThrottled('ann-2', true)).toBe(true);
  });

  it('backs off after a failed build instead of retrying every compute', async () => {
    const store = new GameGraphStore({ metricsTimeoutMs: 30 });
    await store.build('ann-2');
    expect(SilentWorker.instances).toHaveLength(1);
    expect(store.isRebuildThrottled('ann-2')).toBe(true);
    await store.build('ann-2');
    expect(SilentWorker.instances).toHaveLength(1);
  });

  it('defers (memory gate) instead of reading every vector when the renderer heap is under pressure', async () => {
    heap.high = true;
    try {
      vi.mocked(getAllPooledEmbeddingsForGraph).mockClear();
      const store = new GameGraphStore({ metricsTimeoutMs: 30 });
      const ok = await store.build('ann-3');
      expect(ok).toBe(false);
      expect(store.state.phase).toBe('error');
      expect(getAllPooledEmbeddingsForGraph).not.toHaveBeenCalled();
      expect(SilentWorker.instances).toHaveLength(0);
    } finally {
      heap.high = false;
    }
  });
});
