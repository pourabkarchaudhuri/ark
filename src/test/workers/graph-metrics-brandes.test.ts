/**
 * Sampled Brandes: per-slot edge indices from buildCSR replaced the
 * `lo*n+hi` → edge-index Map lookup in the back-propagation loop. Output must
 * be identical to the Map implementation (kept below as the reference).
 */
import { describe, it, expect } from 'vitest';
import { buildCSR, sampledBrandes } from '@/workers/graph-metrics.worker';

/** Pre-change implementation: predecessor edges resolved through a pair-keyed Map. */
function referenceBrandes(
  n: number,
  csrOffsets: Uint32Array,
  csrNeighbors: Uint32Array,
  edges: Float32Array,
  sampleCount: number,
): { nodeBetweenness: Float32Array; edgeBetweenness: Float32Array } {
  const edgeCount = edges.length / 3;
  const edgeIndexByPair = new Map<number, number>();
  for (let i = 0; i < edgeCount; i++) {
    const a = edges[i * 3];
    const b = edges[i * 3 + 1];
    if (a === b) continue;
    const key = Math.min(a, b) * n + Math.max(a, b);
    if (!edgeIndexByPair.has(key)) edgeIndexByPair.set(key, i);
  }
  const nodeBC = new Float32Array(n);
  const edgeBC = new Float32Array(edgeCount);
  const K = Math.min(sampleCount, n);
  const stride = Math.max(1, Math.floor(n / K));
  const dist = new Int32Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const predCounts = new Uint32Array(n);
  const predHead = new Uint32Array(n);
  const predNext = new Uint32Array(edgeCount * 2);
  const predNode = new Uint32Array(edgeCount * 2);
  const queue = new Uint32Array(n);
  const stack = new Uint32Array(n);
  for (let sIdx = 0; sIdx < K; sIdx++) {
    const s = (sIdx * stride) % n;
    dist.fill(-1); sigma.fill(0); delta.fill(0); predCounts.fill(0); predHead.fill(0);
    let predCursor = 0;
    dist[s] = 0; sigma[s] = 1;
    let qHead = 0, qTail = 0, stackTop = 0;
    queue[qTail++] = s;
    while (qHead < qTail) {
      const v = queue[qHead++];
      stack[stackTop++] = v;
      const dv = dist[v];
      for (let k = csrOffsets[v]; k < csrOffsets[v + 1]; k++) {
        const w = csrNeighbors[k];
        if (dist[w] < 0) { dist[w] = dv + 1; queue[qTail++] = w; }
        if (dist[w] === dv + 1) {
          sigma[w] += sigma[v];
          const slot = predCursor++;
          predNext[slot] = predCounts[w] === 0 ? 0xffffffff : predHead[w];
          predNode[slot] = v;
          predHead[w] = slot;
          predCounts[w]++;
        }
      }
    }
    while (stackTop > 0) {
      const w = stack[--stackTop];
      const coeff = (1 + delta[w]) / sigma[w];
      let slot = predHead[w];
      let remaining = predCounts[w];
      while (remaining > 0) {
        const v = predNode[slot];
        const contrib = sigma[v] * coeff;
        delta[v] += contrib;
        const eIdx = edgeIndexByPair.get(Math.min(v, w) * n + Math.max(v, w));
        if (eIdx !== undefined) edgeBC[eIdx] += contrib;
        remaining--;
        if (remaining > 0) slot = predNext[slot];
      }
      if (w !== s) nodeBC[w] += delta[w];
    }
  }
  const scale = n / K;
  for (let i = 0; i < n; i++) nodeBC[i] *= scale;
  for (let i = 0; i < edgeCount; i++) edgeBC[i] *= scale;
  return { nodeBetweenness: nodeBC, edgeBetweenness: edgeBC };
}

/** Deterministic LCG so the fixture graph is identical run to run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Random K-neighbour-ish undirected graph, deduplicated like the graph build's Phase A. */
function randomGraph(n: number, k: number, seed: number): Float32Array {
  const rnd = seeded(seed);
  const pairs = new Map<number, number>();
  for (let u = 0; u < n; u++) {
    for (let j = 0; j < k; j++) {
      const v = Math.floor(rnd() * n);
      if (v === u) continue;
      const key = Math.min(u, v) * n + Math.max(u, v);
      if (!pairs.has(key)) pairs.set(key, 0.5 + rnd() * 0.5);
    }
  }
  const out = new Float32Array(pairs.size * 3);
  let i = 0;
  for (const [key, w] of pairs) {
    const lo = Math.floor(key / n);
    out[i * 3] = lo;
    out[i * 3 + 1] = key - lo * n;
    out[i * 3 + 2] = w;
    i++;
  }
  return out;
}

describe('sampledBrandes with per-slot edge indices', () => {
  it('matches the Map-based implementation exactly on a seeded random graph', () => {
    const n = 600;
    const edges = randomGraph(n, 6, 42);
    const csr = buildCSR(n, edges);
    const got = sampledBrandes(n, csr.csrOffsets, csr.csrNeighbors, csr.csrEdgeIdx, edges.length / 3, 300, () => {});
    const want = referenceBrandes(n, csr.csrOffsets, csr.csrNeighbors, edges, 300);
    expect(Array.from(got.nodeBetweenness)).toEqual(Array.from(want.nodeBetweenness));
    expect(Array.from(got.edgeBetweenness)).toEqual(Array.from(want.edgeBetweenness));
    // Sanity: the fixture actually exercises the edge accumulator.
    expect(got.edgeBetweenness.some((v) => v > 0)).toBe(true);
  });

  it('credits a duplicated pair (either direction) to its first-seen triple, like the Map did', () => {
    // 0-1 appears twice (second time reversed); 1-2 once; self-loop ignored.
    const edges = new Float32Array([0, 1, 0.9, 1, 2, 0.8, 1, 0, 0.7, 2, 2, 1]);
    const n = 3;
    const csr = buildCSR(n, edges);
    for (let k = csr.csrOffsets[0]; k < csr.csrOffsets[1]; k++) expect(csr.csrEdgeIdx[k]).toBe(0);
    const got = sampledBrandes(n, csr.csrOffsets, csr.csrNeighbors, csr.csrEdgeIdx, edges.length / 3, 300, () => {});
    const want = referenceBrandes(n, csr.csrOffsets, csr.csrNeighbors, edges, 300);
    expect(Array.from(got.edgeBetweenness)).toEqual(Array.from(want.edgeBetweenness));
    expect(got.edgeBetweenness[2]).toBe(0);
  });

  it('buildCSR edge index points both directions of every triple at that triple', () => {
    const edges = new Float32Array([0, 1, 0.5, 2, 1, 0.6, 3, 0, 0.7]);
    const csr = buildCSR(4, edges);
    for (let u = 0; u < 4; u++) {
      for (let k = csr.csrOffsets[u]; k < csr.csrOffsets[u + 1]; k++) {
        const i = csr.csrEdgeIdx[k];
        const a = edges[i * 3];
        const b = edges[i * 3 + 1];
        expect([a, b].sort()).toEqual([u, csr.csrNeighbors[k]].sort());
      }
    }
  });
});
