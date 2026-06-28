/**
 * Graph Metrics Worker
 *
 * Computes per-node graph metrics off the main thread.
 * Inputs an edge list + nodeIds + optional library-seeded personalization vector.
 *
 * Metrics:
 *  - PageRank (global) — drives Stellar Classification + future quality propagation
 *  - Personalized PageRank — seeded on user library; drives Frontier Aurora + PR-delta visuals
 *  - Louvain community ID — drives Constellation naming + community-affinity scoring
 *  - Degree — local connectivity baseline
 *
 * Future: betweenness (sampled Brandes), kCore, clusteringCoef, HITS, Burt brokerage.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import pagerank from 'graphology-metrics/centrality/pagerank';

export interface GraphMetricsWorkerInput {
  type: 'compute';
  nodeIds: string[];
  /** Flat packed triples: [fromIdx, toIdx, weight, fromIdx, toIdx, weight, ...]. */
  edges: Float32Array;
  /**
   * Optional per-node seed weights for Personalized PageRank.
   * Length must match nodeIds. Non-zero entries identify the user's library
   * (weighted by playtime/engagement). Pass null/undefined to skip PPR.
   */
  personalization?: Float32Array | null;
  config?: {
    pageRankAlpha?: number;
    pageRankTolerance?: number;
    louvainResolution?: number;
    pprMaxIterations?: number;
  };
}

export interface GraphMetricsWorkerProgress {
  type: 'progress';
  stage: string;
  percent: number;
}

export interface GraphMetricsWorkerResult {
  type: 'result';
  pageRank: Float32Array;
  /** Null when no personalization vector was supplied. */
  personalizedPageRank: Float32Array | null;
  /** HITS authority — each node's score as a "destination" target. */
  authority: Float32Array;
  /** HITS hub — each node's score as a "router" connecting authorities. */
  hub: Float32Array;
  /** Sampled Brandes node betweenness — null when graph too small or skipped. */
  nodeBetweenness: Float32Array | null;
  /** Sampled Brandes edge betweenness, indexed identically to the input `edges` triple list. */
  edgeBetweenness: Float32Array | null;
  /** PPR - PR normalized to [-1, 1]. Null when no PPR (no library seed). */
  prDelta: Float32Array | null;
  community: Int32Array;
  degree: Uint16Array;
  communityCount: number;
  computeMs: number;
}

export interface GraphMetricsWorkerError {
  type: 'error';
  error: string;
}

export type GraphMetricsWorkerOutput =
  | GraphMetricsWorkerProgress
  | GraphMetricsWorkerResult
  | GraphMetricsWorkerError;

function postProgress(stage: string, percent: number): void {
  (self as unknown as Worker).postMessage({ type: 'progress', stage, percent } satisfies GraphMetricsWorkerProgress);
}

/**
 * Personalized PageRank via power iteration on a weighted undirected graph.
 *
 * Standard PageRank teleports to a uniform distribution; PPR teleports to the
 * seed distribution. On a personalized seed where only library nodes are non-zero,
 * the converged scores naturally concentrate around games structurally close to
 * what the user already plays — the math equivalent of "more like this".
 *
 * Adjacency is stored as a CSR-like flat structure (built from the edge list)
 * to keep memory + cache pressure low at 60K+ nodes.
 */
function computePPR(
  n: number,
  csrOffsets: Uint32Array,
  csrNeighbors: Uint32Array,
  csrWeights: Float32Array,
  weightSum: Float32Array,
  seed: Float32Array,
  alpha: number,
  maxIter: number,
  tolerance: number,
  onProgress: (pct: number) => void,
): Float32Array {
  // Normalize the seed vector (sum to 1)
  let seedSum = 0;
  for (let i = 0; i < n; i++) seedSum += seed[i];
  const normSeed = new Float32Array(n);
  if (seedSum > 0) {
    for (let i = 0; i < n; i++) normSeed[i] = seed[i] / seedSum;
  } else {
    // No personalization — degenerate to uniform (becomes equivalent to standard PR)
    const u = 1 / Math.max(1, n);
    for (let i = 0; i < n; i++) normSeed[i] = u;
  }

  let pr = new Float32Array(n);
  pr.set(normSeed);
  let next = new Float32Array(n);

  const teleport = 1 - alpha;

  for (let iter = 0; iter < maxIter; iter++) {
    // next[v] = teleport * seed[v] + alpha * Σ_u (pr[u] * w(u,v) / weightSum[u])
    next.fill(0);
    for (let u = 0; u < n; u++) {
      const ws = weightSum[u];
      if (ws <= 0) continue;
      const rankShare = (pr[u] * alpha) / ws;
      const start = csrOffsets[u];
      const end = csrOffsets[u + 1];
      for (let k = start; k < end; k++) {
        next[csrNeighbors[k]] += rankShare * csrWeights[k];
      }
    }
    // Add teleport to seed
    let diff = 0;
    for (let i = 0; i < n; i++) {
      const v = next[i] + teleport * normSeed[i];
      diff += Math.abs(v - pr[i]);
      next[i] = v;
    }
    // Swap buffers
    const tmp = pr; pr = next; next = tmp;

    if (iter % 5 === 0) onProgress(iter / maxIter);
    if (diff < tolerance) break;
  }
  return pr;
}

/**
 * HITS (Hyperlink-Induced Topic Search) on a weighted undirected graph.
 *
 * On an undirected graph this collapses to a flavor of eigenvector centrality,
 * but the auth/hub split still differentiates nodes by community structure:
 * authority captures "destination weight" within tightly-knit clusters, hub
 * captures "router weight" across them. Used by Stellar Classification to
 * separate Pulsar (high auth, low hub — cult masterpiece) from Quasar
 * (high auth + high hub — canonical entry point).
 */
function computeHITS(
  n: number,
  csrOffsets: Uint32Array,
  csrNeighbors: Uint32Array,
  csrWeights: Float32Array,
  maxIter: number,
  tolerance: number,
  onProgress: (pct: number) => void,
): { authority: Float32Array; hub: Float32Array } {
  let auth = new Float32Array(n);
  let hub = new Float32Array(n);
  const initVal = 1 / Math.max(1, n);
  for (let i = 0; i < n; i++) { auth[i] = initVal; hub[i] = initVal; }

  let nextAuth = new Float32Array(n);
  let nextHub = new Float32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    nextAuth.fill(0);
    nextHub.fill(0);

    // authority[v] = Σ_u w(u,v) * hub[u]
    // hub[v]       = Σ_u w(u,v) * authority[u]
    // (undirected → symmetric, single CSR walk handles both directions)
    for (let u = 0; u < n; u++) {
      const start = csrOffsets[u];
      const end = csrOffsets[u + 1];
      const hu = hub[u];
      const au = auth[u];
      for (let k = start; k < end; k++) {
        const v = csrNeighbors[k];
        const w = csrWeights[k];
        nextAuth[v] += w * hu;
        nextHub[v] += w * au;
      }
    }

    // L2 normalize
    let sumA = 0, sumH = 0;
    for (let i = 0; i < n; i++) { sumA += nextAuth[i] * nextAuth[i]; sumH += nextHub[i] * nextHub[i]; }
    const normA = Math.sqrt(sumA) || 1;
    const normH = Math.sqrt(sumH) || 1;

    let diff = 0;
    for (let i = 0; i < n; i++) {
      const a = nextAuth[i] / normA;
      const h = nextHub[i] / normH;
      diff += Math.abs(a - auth[i]) + Math.abs(h - hub[i]);
      nextAuth[i] = a;
      nextHub[i] = h;
    }
    // Swap
    const ta = auth; auth = nextAuth; nextAuth = ta;
    const th = hub; hub = nextHub; nextHub = th;

    if (iter % 5 === 0) onProgress(iter / maxIter);
    if (diff < tolerance) break;
  }
  return { authority: auth, hub };
}

/**
 * Sampled Brandes betweenness on an unweighted undirected graph.
 *
 * Standard Brandes (BFS variant): for each source s, perform BFS, count shortest-path
 * counts σ, then back-propagate dependency δ. Accumulate to node + edge totals.
 * Sampling K sources gives an unbiased estimator scaled by (n / K).
 *
 * Edge weights from cosine similarity are noisy and clustered around 0.5-0.9 —
 * BFS-on-unweighted is ~10× faster and the resulting "shortest path" structure
 * still surfaces the load-bearing connections that the Fault Lines visualization needs.
 *
 * Inputs:
 *  - csrOffsets/Neighbors: standard CSR adjacency
 *  - edgeIndexByPair: Map "u*N+v" (u<v) → index into original packed-triples edge list
 *  - sampleCount K, e.g. 300
 */
function sampledBrandes(
  n: number,
  csrOffsets: Uint32Array,
  csrNeighbors: Uint32Array,
  edgeIndexByPair: Map<number, number>,
  edgeCount: number,
  sampleCount: number,
  onProgress: (pct: number) => void,
): { nodeBetweenness: Float32Array; edgeBetweenness: Float32Array } {
  const nodeBC = new Float32Array(n);
  const edgeBC = new Float32Array(edgeCount);
  if (n === 0) return { nodeBetweenness: nodeBC, edgeBetweenness: edgeBC };

  const K = Math.min(sampleCount, n);
  const stride = Math.max(1, Math.floor(n / K));

  // Reusable per-source buffers
  const dist = new Int32Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  // Predecessor lists per node, stored as flat arrays + offsets
  const predCounts = new Uint32Array(n);
  const predHead = new Uint32Array(n);
  // Conservatively size pred storage at edge count × 2 (max predecessors across all nodes ≤ degree)
  const predNext = new Uint32Array(edgeCount * 2);
  const predNode = new Uint32Array(edgeCount * 2);
  // BFS queue + visit order stack
  const queue = new Uint32Array(n);
  const stack = new Uint32Array(n);

  let samplesDone = 0;
  for (let sIdx = 0; sIdx < K; sIdx++) {
    const s = (sIdx * stride) % n;

    // Reset per-source state. predHead is the linked-list head index per node;
    // missing this reset was a BLOCKER — stale heads from sample N-1 mixed predecessors across samples.
    dist.fill(-1);
    sigma.fill(0);
    delta.fill(0);
    predCounts.fill(0);
    predHead.fill(0);
    let predCursor = 0;
    dist[s] = 0;
    sigma[s] = 1;

    let qHead = 0, qTail = 0;
    let stackTop = 0;
    queue[qTail++] = s;

    while (qHead < qTail) {
      const v = queue[qHead++];
      stack[stackTop++] = v;
      const dv = dist[v];
      const sv = sigma[v];
      const start = csrOffsets[v];
      const end = csrOffsets[v + 1];
      for (let k = start; k < end; k++) {
        const w = csrNeighbors[k];
        const dw = dist[w];
        if (dw < 0) {
          dist[w] = dv + 1;
          queue[qTail++] = w;
        }
        if (dist[w] === dv + 1) {
          sigma[w] += sv;
          // Append v to predecessor list of w
          const head = predHead[w] | 0;
          const slot = predCursor++;
          predNext[slot] = predCounts[w] === 0 ? 0xffffffff : head;
          predNode[slot] = v;
          predHead[w] = slot;
          predCounts[w]++;
        }
      }
    }

    // Back-propagate dependency
    while (stackTop > 0) {
      const w = stack[--stackTop];
      const sw = sigma[w];
      const coeff = (1 + delta[w]) / sw;
      let slot = predHead[w];
      let remaining = predCounts[w];
      while (remaining > 0) {
        const v = predNode[slot];
        const contrib = sigma[v] * coeff;
        delta[v] += contrib;
        // Edge dependency — split equally between predecessors when multiple shortest paths
        const lo = v < w ? v : w;
        const hi = v < w ? w : v;
        const eKey = lo * n + hi;
        const eIdx = edgeIndexByPair.get(eKey);
        if (eIdx !== undefined) edgeBC[eIdx] += contrib;
        remaining--;
        if (remaining > 0) slot = predNext[slot];
      }
      if (w !== s) nodeBC[w] += delta[w];
    }

    samplesDone++;
    if (samplesDone % 10 === 0) onProgress(samplesDone / K);
  }

  // Scale to estimate full-graph betweenness
  const scale = n / K;
  for (let i = 0; i < n; i++) nodeBC[i] *= scale;
  for (let i = 0; i < edgeCount; i++) edgeBC[i] *= scale;

  return { nodeBetweenness: nodeBC, edgeBetweenness: edgeBC };
}

/**
 * Build CSR-like adjacency from a packed edge list (undirected → each edge added twice).
 * Returns offsets, neighbors, weights, and per-node weight sums.
 */
function buildCSR(n: number, edges: Float32Array): {
  csrOffsets: Uint32Array;
  csrNeighbors: Uint32Array;
  csrWeights: Float32Array;
  weightSum: Float32Array;
} {
  const tripleCount = edges.length / 3;
  // First pass: count degree per node (undirected → both endpoints)
  const degree = new Uint32Array(n);
  for (let i = 0; i < tripleCount; i++) {
    const a = edges[i * 3];
    const b = edges[i * 3 + 1];
    if (a === b) continue;
    degree[a]++;
    degree[b]++;
  }
  // Build offsets
  const csrOffsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) csrOffsets[i + 1] = csrOffsets[i] + degree[i];
  const totalSlots = csrOffsets[n];

  const csrNeighbors = new Uint32Array(totalSlots);
  const csrWeights = new Float32Array(totalSlots);
  const cursor = new Uint32Array(n);
  const weightSum = new Float32Array(n);
  for (let i = 0; i < tripleCount; i++) {
    const a = edges[i * 3];
    const b = edges[i * 3 + 1];
    const w = edges[i * 3 + 2];
    if (a === b) continue;
    const slotA = csrOffsets[a] + cursor[a]++;
    csrNeighbors[slotA] = b;
    csrWeights[slotA] = w;
    weightSum[a] += w;
    const slotB = csrOffsets[b] + cursor[b]++;
    csrNeighbors[slotB] = a;
    csrWeights[slotB] = w;
    weightSum[b] += w;
  }
  return { csrOffsets, csrNeighbors, csrWeights, weightSum };
}

self.onmessage = (e: MessageEvent<GraphMetricsWorkerInput>) => {
  const msg = e.data;
  if (msg.type !== 'compute') return;

  const t0 = performance.now();
  try {
    const { nodeIds, edges, personalization, config } = msg;
    const n = nodeIds.length;

    postProgress('Building graph...', 5);

    const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
    for (let i = 0; i < n; i++) graph.addNode(String(i));

    const tripleCount = edges.length / 3;
    let edgesAdded = 0;
    for (let i = 0; i < tripleCount; i++) {
      const from = edges[i * 3];
      const to = edges[i * 3 + 1];
      const w = edges[i * 3 + 2];
      if (from === to) continue;
      const a = String(Math.min(from, to));
      const b = String(Math.max(from, to));
      if (!graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { weight: w });
        edgesAdded++;
      }
    }

    postProgress(`Built graph: ${n} nodes, ${edgesAdded} edges`, 15);

    // Degree
    const degree = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      degree[i] = Math.min(65535, graph.degree(String(i)));
    }
    postProgress('Degree computed', 22);

    // Global PageRank via graphology
    postProgress('Computing PageRank...', 28);
    const prAlpha = config?.pageRankAlpha ?? 0.85;
    const prTol = config?.pageRankTolerance ?? 1e-6;
    const prMap = pagerank(graph, { alpha: prAlpha, tolerance: prTol, getEdgeWeight: 'weight' }) as Record<string, number>;
    const pageRank = new Float32Array(n);
    for (let i = 0; i < n; i++) pageRank[i] = prMap[String(i)] ?? 0;
    postProgress('PageRank computed', 50);

    // Build CSR once — shared by PPR + HITS to avoid duplicate work.
    const csr = buildCSR(n, edges);

    // Personalized PageRank (only if a personalization vector was supplied)
    let personalizedPageRank: Float32Array | null = null;
    const hasSeed = personalization && personalization.length === n;
    if (hasSeed) {
      let seedNonZero = 0;
      for (let i = 0; i < n; i++) if (personalization[i] > 0) seedNonZero++;
      if (seedNonZero > 0) {
        postProgress(`Computing Personalized PageRank (${seedNonZero} seeds)...`, 52);
        const maxIter = config?.pprMaxIterations ?? 50;
        personalizedPageRank = computePPR(
          n,
          csr.csrOffsets,
          csr.csrNeighbors,
          csr.csrWeights,
          csr.weightSum,
          personalization,
          prAlpha,
          maxIter,
          prTol,
          (pct) => postProgress('Computing Personalized PageRank...', 52 + Math.round(pct * 18)),
        );
      }
    }
    postProgress('Personalized PageRank computed', 70);

    // HITS — authority + hub. Feeds Stellar Classification's Pulsar vs Quasar split.
    postProgress('Computing HITS authority + hub...', 72);
    const hits = n > 0
      ? computeHITS(
          n,
          csr.csrOffsets,
          csr.csrNeighbors,
          csr.csrWeights,
          50,
          1e-6,
          (pct) => postProgress('Computing HITS...', 72 + Math.round(pct * 6)),
        )
      : { authority: new Float32Array(0), hub: new Float32Array(0) };
    postProgress('HITS computed', 78);

    // Sampled Brandes for node + edge betweenness — drives Fault Lines + future Tectonic Mode
    postProgress('Computing betweenness (Brandes)...', 80);
    let nodeBetweenness: Float32Array | null = null;
    let edgeBetweenness: Float32Array | null = null;
    if (n > 0 && edgesAdded > 0) {
      // Build edge-index map: canonical key (lo*n + hi) → index in input edges triple list
      const edgeIndexByPair = new Map<number, number>();
      const tc = edges.length / 3;
      for (let i = 0; i < tc; i++) {
        const a = edges[i * 3];
        const b = edges[i * 3 + 1];
        if (a === b) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = lo * n + hi;
        if (!edgeIndexByPair.has(key)) edgeIndexByPair.set(key, i);
      }
      const brandesResult = sampledBrandes(
        n,
        csr.csrOffsets,
        csr.csrNeighbors,
        edgeIndexByPair,
        tc,
        300,
        (pct) => postProgress('Computing betweenness...', 80 + Math.round(pct * 10)),
      );
      nodeBetweenness = brandesResult.nodeBetweenness;
      edgeBetweenness = brandesResult.edgeBetweenness;
    }
    postProgress('Betweenness computed', 90);

    // Louvain communities
    postProgress('Detecting communities (Louvain)...', 92);
    const louvainResult = louvain(graph, {
      resolution: config?.louvainResolution ?? 1,
      getEdgeWeight: 'weight',
    }) as Record<string, number>;
    const community = new Int32Array(n);
    const communitySet = new Set<number>();
    for (let i = 0; i < n; i++) {
      const c = louvainResult[String(i)] ?? -1;
      community[i] = c;
      if (c >= 0) communitySet.add(c);
    }
    postProgress('Communities detected', 98);

    // PageRank delta — drives PageRank Aurora (warm where player resonates above global mean)
    let prDelta: Float32Array | null = null;
    if (personalizedPageRank) {
      // Normalize both vectors to comparable scales by total mass
      let prSum = 0, pprSum = 0;
      for (let i = 0; i < n; i++) { prSum += pageRank[i]; pprSum += personalizedPageRank[i]; }
      // Guard degenerate normalization — if either sum is non-positive, downstream shader
      // attribute would receive NaN/Inf via 1/0. Leave prDelta null so consumers fall back.
      if (prSum > 0 && pprSum > 0) {
        const prScale = 1 / prSum;
        const pprScale = 1 / pprSum;
        const raw = new Float32Array(n);
        let maxAbs = 1e-9;
        for (let i = 0; i < n; i++) {
          const d = personalizedPageRank[i] * pprScale - pageRank[i] * prScale;
          raw[i] = d;
          const ad = Math.abs(d);
          if (ad > maxAbs) maxAbs = ad;
        }
        // Map to [-1, 1]; maxAbs is at least 1e-9 so invMax is finite.
        const invMax = 1 / maxAbs;
        for (let i = 0; i < n; i++) raw[i] *= invMax;
        prDelta = raw;
      }
    }

    const result: GraphMetricsWorkerResult = {
      type: 'result',
      pageRank,
      personalizedPageRank,
      authority: hits.authority,
      hub: hits.hub,
      nodeBetweenness,
      edgeBetweenness,
      prDelta,
      community,
      degree,
      communityCount: communitySet.size,
      computeMs: performance.now() - t0,
    };

    const transfers: ArrayBuffer[] = [
      pageRank.buffer as ArrayBuffer,
      community.buffer as ArrayBuffer,
      degree.buffer as ArrayBuffer,
      hits.authority.buffer as ArrayBuffer,
      hits.hub.buffer as ArrayBuffer,
    ];
    if (personalizedPageRank) transfers.push(personalizedPageRank.buffer as ArrayBuffer);
    if (nodeBetweenness) transfers.push(nodeBetweenness.buffer as ArrayBuffer);
    if (edgeBetweenness) transfers.push(edgeBetweenness.buffer as ArrayBuffer);
    if (prDelta) transfers.push(prDelta.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage(result, transfers);
  } catch (err) {
    const errMsg: GraphMetricsWorkerError = {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(errMsg);
  }
};

export {};
