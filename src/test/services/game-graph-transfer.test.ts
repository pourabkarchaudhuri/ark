import { describe, it, expect } from 'vitest';
import {
  prepareGraphWorkerTransfer,
  copyFloat32ForPersist,
  copyScoresForPersist,
} from '@/services/game-graph-store';

describe('prepareGraphWorkerTransfer', () => {
  it('leaves original edges/personalization attached after worker transfer', () => {
    const edges = new Float32Array([0, 1, 0.5, 1, 2, 0.9]);
    const personalization = new Float32Array([1, 0, 0.5]);

    const { edgesForWorker, personalizationForWorker, transferList } =
      prepareGraphWorkerTransfer(edges, personalization);

    expect(edgesForWorker).not.toBe(edges);
    expect(personalizationForWorker).not.toBe(personalization);
    expect(transferList).toContain(edgesForWorker.buffer);
    expect(transferList).toContain(personalizationForWorker!.buffer);

    // Simulate postMessage(..., transferList) detaching the worker copies only.
    structuredClone(
      { edges: edgesForWorker, personalization: personalizationForWorker },
      { transfer: transferList },
    );

    expect(edges.buffer.byteLength).toBeGreaterThan(0);
    expect(edges[2]).toBeCloseTo(0.5);
    expect(personalization.buffer.byteLength).toBeGreaterThan(0);
    expect(personalization[0]).toBe(1);

    expect(edgesForWorker.buffer.byteLength).toBe(0);
    expect(personalizationForWorker!.buffer.byteLength).toBe(0);
  });

  it('omits personalization from the transfer list when null', () => {
    const edges = new Float32Array([0, 1, 1]);
    const { personalizationForWorker, transferList } =
      prepareGraphWorkerTransfer(edges, null);
    expect(personalizationForWorker).toBeNull();
    expect(transferList).toHaveLength(1);
    expect(transferList[0]).toBeDefined();
  });
});

describe('copyFloat32ForPersist', () => {
  it('returns a fresh attached copy safe for structured clone', () => {
    const view = new Float32Array([0.1, 0.2, 0.3]);
    const copy = copyFloat32ForPersist(view);
    expect(copy).not.toBeNull();
    expect(copy).not.toBe(view);
    expect(copy![0]).toBeCloseTo(0.1);
    expect(copy![1]).toBeCloseTo(0.2);
    expect(copy![2]).toBeCloseTo(0.3);
    expect(() => structuredClone(copy)).not.toThrow();
  });

  it('returns null for null/undefined input', () => {
    expect(copyFloat32ForPersist(null)).toBeNull();
    expect(copyFloat32ForPersist(undefined)).toBeNull();
  });

  it('avoids DataCloneError when the source buffer is already detached', () => {
    const view = new Float32Array([4, 5, 6]);
    structuredClone(view.buffer, { transfer: [view.buffer as ArrayBuffer] });
    expect(view.buffer.byteLength).toBe(0);
    // Detach zeroes TypedArray.length — we cannot recover values; only ensure
    // the persist helper never returns a view that throws on structuredClone.
    const copy = copyFloat32ForPersist(view);
    expect(copy).not.toBeNull();
    expect(() => structuredClone(copy)).not.toThrow();
  });
});

describe('copyScoresForPersist', () => {
  it('copies all typed-array score fields onto attached buffers', () => {
    const pageRank = new Float32Array([0.5]);
    const community = new Int32Array([1]);
    const degree = new Uint16Array([3]);
    const scores = {
      pageRank,
      personalizedPageRank: new Float32Array([0.25]),
      authority: new Float32Array([0.1]),
      hub: new Float32Array([0.2]),
      nodeBetweenness: null as Float32Array | null,
      edgeBetweenness: null as Float32Array | null,
      prDelta: null as Float32Array | null,
      community,
      degree,
    };

    const persistable = copyScoresForPersist(scores);
    expect(persistable.pageRank).not.toBe(pageRank);
    expect(persistable.community).not.toBe(community);
    expect(persistable.degree).not.toBe(degree);
    expect(persistable.personalizedPageRank![0]).toBeCloseTo(0.25);
    expect(() => structuredClone(persistable)).not.toThrow();
  });
});
