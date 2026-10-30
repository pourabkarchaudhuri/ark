/**
 * 1.0.97 Oracle pipeline performance, without score changes:
 *  - worker payload: library embeddings left out (Backlog Advisor similarity precomputed on the main
 *    thread) and MMR sketches posted as Float32Arrays — shelves identical to the old payload
 *  - pool neighbours: pool built once, stop at a source boundary, yield by elapsed time
 *  - pool hygiene: title keys normalised once in dedupeCandidatesByTitle, same output
 */
import { describe, it, expect, vi } from 'vitest';
import {
  computeBacklogSemanticScores,
  computePoolNeighbors,
  computePoolNeighborsAsync,
  computeSemanticSimilarity,
  detectTasteClusters,
  normalizeTitleKey,
} from '@/services/reco-scoring';
import { sketchEmbedding } from '@/services/mmr-embedding';
import { dedupeCandidatesByTitle, hasAdultHintTags, isLikelyAdultByTags, reviewQualityKey } from '@/services/reco-prefilter';
import type { CandidateGame, RecoWorkerInput } from '@/types/reco';
import { FIXTURE_NOW, backlogHeavyLibrary, candidatePool, makeCandidate } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DIM = 24;

function embeddedFixture() {
  const rand = lcg(5);
  const vec = () => Array.from({ length: DIM }, () => rand() - 0.4);
  const users = backlogHeavyLibrary().slice(0, 80).map(u => ({ ...u, embedding: vec() }));
  const candidates = candidatePool(120);
  const centroid = new Float32Array(vec());
  const sketches = new Map<string, Float32Array>();
  for (const c of candidates) {
    const sk = sketchEmbedding(vec());
    if (sk) sketches.set(c.gameId, sk);
  }
  const semantic: Record<string, number> = {};
  for (const c of candidates) semantic[c.gameId] = rand();
  return { users, candidates, centroid, sketches, semantic };
}

describe('worker payload: precomputed backlog similarity + stripped library embeddings', () => {
  it('computeBacklogSemanticScores matches the in-worker cosine for Want-to-Play games only', () => {
    const { users, centroid } = embeddedFixture();
    const scores = computeBacklogSemanticScores(users, centroid, 0.5)!;
    const wtp = users.filter(u => u.status === 'Want to Play' && u.hoursPlayed === 0);
    expect(Object.keys(scores).sort()).toEqual(wtp.map(u => u.gameId).sort());
    for (const u of wtp) {
      expect(scores[u.gameId]).toBe(computeSemanticSimilarity(new Float64Array(Array.from(centroid)), u.embedding));
    }
    expect(computeBacklogSemanticScores(users, centroid, 0)).toBeUndefined();
    expect(computeBacklogSemanticScores(users, null, 0.5)).toBeUndefined();
  });

  it('backlog-advisor ordering and reasons (and every other shelf) are identical to the old payload', async () => {
    const { users, candidates, centroid, sketches, semantic } = embeddedFixture();
    const clusters = detectTasteClusters(users, FIXTURE_NOW);
    const common: Partial<RecoWorkerInput> = {
      embeddingCoverage: 0.6,
      tasteCentroid: Array.from(centroid),
      precomputedSemanticScores: semantic,
      precomputedClusters: clusters,
    };
    const before = await runWorkerPipeline(baseWorkerInput(
      structuredClone(users), structuredClone(candidates), FIXTURE_NOW,
      { ...common, mmrVectors: Object.fromEntries([...sketches].map(([id, s]) => [id, Array.from(s)])) },
    ));
    const after = await runWorkerPipeline(baseWorkerInput(
      users.map(({ embedding: _e, ...rest }) => rest), structuredClone(candidates), FIXTURE_NOW,
      {
        ...common,
        mmrVectors: Object.fromEntries(sketches),
        backlogSemanticScores: computeBacklogSemanticScores(users, centroid, 0.6),
      },
    ));
    const backlog = (r: typeof before) => r.shelves.find(s => s.type === 'backlog-advisor');
    expect(backlog(before)).toBeDefined();
    expect(backlog(before)!.games.some(g => g.layerScores.semanticSimilarity > 0)).toBe(true);
    expect(backlog(after)!.games.map(g => [g.gameId, g.score, g.reasons])).toEqual(backlog(before)!.games.map(g => [g.gameId, g.score, g.reasons]));
    expect(after.shelves).toEqual(before.shelves);
  });
});

describe('pool neighbours (1.0.97)', () => {
  const rand = lcg(3);
  const vec = () => Array.from({ length: 16 }, () => rand() - 0.3);
  const sources = Array.from({ length: 8 }, (_, i) => ({ gameId: `lib-${i}`, vector: vec() }));
  const candidates = Array.from({ length: 400 }, (_, i) => ({ gameId: `c-${i}`, embedding: i % 5 === 0 ? undefined : vec() }));
  const opts = { k: 20, ceiling: 0.9 };

  it('async (pool built once) is bit-identical to the one-shot version', async () => {
    const sync = computePoolNeighbors(sources, candidates, opts);
    const res = await computePoolNeighborsAsync(sources, candidates, opts);
    expect(res).toEqual(sync);
    // A source with the wrong dimension is skipped by both, as before.
    const mixed = [...sources.slice(0, 3), { gameId: 'odd', vector: [1, 2, 3] }, ...sources.slice(3)];
    expect(await computePoolNeighborsAsync(mixed, candidates, opts)).toEqual(computePoolNeighbors(mixed, candidates, opts));
  });

  it('an abort stops the loop at the next source boundary', async () => {
    const ac = new AbortController();
    let checks = 0;
    const res = await computePoolNeighborsAsync(sources, candidates, {
      ...opts,
      shouldStop: () => {
        checks++;
        if (checks === 4) ac.abort(); // check #1 is before the pool is built; #2/#3 let sources 0 and 1 run
        return ac.signal.aborted;
      },
    });
    expect(res).toEqual(computePoolNeighbors(sources.slice(0, 2), candidates, opts));
    const stopped = await computePoolNeighborsAsync(sources, candidates, { ...opts, shouldStop: () => true });
    expect(stopped.hits).toBe(0);
  });

  it('yields by elapsed time, not once per source', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      let t = 0;
      // Each clock read advances 1 ms: with an 8 ms slice the 8 sources yield at most once or twice.
      await computePoolNeighborsAsync(sources, candidates, { ...opts, now: () => (t += 1) });
      const yields = spy.mock.calls.filter(c => c[1] === 0).length;
      expect(yields).toBeLessThan(sources.length / 2);
      spy.mockClear();
      t = 0;
      // A slow slice (each source "takes" 20 ms) yields after every source.
      await computePoolNeighborsAsync(sources, candidates, { ...opts, now: () => (t += 10) });
      expect(spy.mock.calls.filter(c => c[1] === 0).length).toBe(sources.length);
    } finally {
      spy.mockRestore();
    }
  });
});

/** The pre-1.0.97 dedupeCandidatesByTitle, kept as the reference. */
function legacyDedupe(candidates: CandidateGame[], owned: ReadonlySet<string>): CandidateGame[] {
  const best = new Map<string, CandidateGame>();
  const losers = new Map<string, CandidateGame[]>();
  const better = (a: CandidateGame, b: CandidateGame): boolean => {
    const ka = reviewQualityKey(a) + (a.metacriticScore ?? 0) / 100;
    const kb = reviewQualityKey(b) + (b.metacriticScore ?? 0) / 100;
    if (ka !== kb) return ka > kb;
    return a.gameId.startsWith('steam-') && !b.gameId.startsWith('steam-');
  };
  for (const c of candidates) {
    const key = normalizeTitleKey(c.title);
    if (!key) continue;
    if (owned.has(key)) continue;
    const prev = best.get(key);
    if (!prev) { best.set(key, c); continue; }
    if (better(c, prev)) { best.set(key, c); losers.set(key, [...(losers.get(key) ?? []), prev]); }
    else losers.set(key, [...(losers.get(key) ?? []), c]);
  }
  for (const [key, winner] of best) {
    for (const loser of losers.get(key) ?? []) {
      if (!winner.secondaryGameId && loser.gameId !== winner.gameId) winner.secondaryGameId = loser.gameId;
      if (loser.semanticRetrieved) winner.semanticRetrieved = true;
      if (loser.lexicalRetrieved) winner.lexicalRetrieved = true;
      if (loser.coldStartSeeded) winner.coldStartSeeded = true;
    }
  }
  const kept = new Set(best.values());
  return candidates.filter(c => !normalizeTitleKey(c.title) || kept.has(c));
}

describe('dedupeCandidatesByTitle (title key normalised once)', () => {
  it('returns the same survivors, order and merged flags as before for a fixture with duplicate titles', () => {
    const rand = lcg(17);
    const titles = ['Hades', 'Hades: Deluxe Edition', 'HADES', 'Celeste', 'Celeste GOTY', '', 'Owned Game', 'Owned Game Remastered', 'Stardew'];
    const make = () => Array.from({ length: 300 }, (_, i) => makeCandidate(`${rand() < 0.5 ? 'steam' : 'epic'}-${i}`, {
      title: `${titles[Math.floor(rand() * titles.length)]}${rand() < 0.3 ? ` ${i % 7}` : ''}`,
      reviewPositivity: [0.5, 0.9][Math.floor(rand() * 2)],
      reviewVolume: [100, 1000][Math.floor(rand() * 2)],
      metacriticScore: rand() < 0.3 ? 80 : null,
      semanticRetrieved: rand() < 0.2,
      lexicalRetrieved: rand() < 0.2,
      coldStartSeeded: rand() < 0.1,
    }));
    const base = make();
    const owned = new Set([normalizeTitleKey('Owned Game')]);
    const a = legacyDedupe(structuredClone(base), owned);
    const b = dedupeCandidatesByTitle(structuredClone(base), owned);
    expect(b.length).toBeLessThan(base.length);
    expect(b).toEqual(a);
  });

  it('adult tag checks read genres and themes without building a merged array', () => {
    expect(isLikelyAdultByTags({ genres: ['Action'], themes: ['Hentai'] })).toBe(true);
    expect(isLikelyAdultByTags({ genres: ['NSFW'], themes: [] })).toBe(true);
    expect(isLikelyAdultByTags({ genres: ['Action'], themes: ['Mature'] })).toBe(false);
    expect(hasAdultHintTags({ genres: [], themes: ['Sexual Content'] })).toBe(true);
    expect(hasAdultHintTags({ genres: ['Mature'], themes: [] })).toBe(true);
    expect(hasAdultHintTags({ genres: ['RPG'], themes: ['Fantasy'] })).toBe(false);
  });
});
