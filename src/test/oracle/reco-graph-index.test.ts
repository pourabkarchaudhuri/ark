/**
 * 1.0.97: the graph-signal pre-pass uses inverted lookups (buildGraphCandidateIndex) instead of
 * scanning the whole library per candidate. Scores and similarTo must be identical to the full scan,
 * including tie order, duplicate titles, removed games, duplicate library ids and neighbour hits.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGraphCandidateIndex,
  buildGraphUserContext,
  computeGraphSignal,
  type GraphNeighborHit,
} from '@/services/reco-scoring';
import type { CandidateGame, UserGameSnapshot } from '@/types/reco';
import { FIXTURE_NOW, makeCandidate, makeUser } from './fixtures';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A small vocabulary makes similar lists, titles and candidates collide often (equivalence runs). */
const vocab = (n: number) => Array.from({ length: n }, (_, i) => `Title ${i}`).concat(['', 'Title 3: Remastered', 'TITLE 5']);

function randomFixture(seed: number, nUsers: number, nCands: number, vocabSize = 40) {
  const r = rng(seed);
  const VOCAB = vocab(vocabSize);
  const pick = () => VOCAB[Math.floor(r() * VOCAB.length)];
  const users: UserGameSnapshot[] = [];
  for (let i = 0; i < nUsers; i++) {
    // Some duplicate ids (last one wins in the context maps) and some removed games.
    const id = r() < 0.05 && i > 0 ? users[Math.floor(r() * i)].gameId : `steam-u${i}`;
    users.push(makeUser(id, {
      title: pick(),
      // Coarse buckets so equal weights (and equal contribution values) are common.
      hoursPlayed: [0, 5, 40][Math.floor(r() * 3)],
      rating: [0, 3, 5][Math.floor(r() * 3)],
      status: r() < 0.7 ? 'Completed' : 'Playing',
      similarGameTitles: Array.from({ length: Math.floor(r() * 6) }, pick),
      ...(r() < 0.08 ? { removedAt: '2026-01-01T00:00:00.000Z' } : {}),
    }));
  }
  const cands: CandidateGame[] = [];
  const hits: Record<string, GraphNeighborHit[]> = {};
  for (let i = 0; i < nCands; i++) {
    const c = makeCandidate(`steam-c${i}`, { title: pick(), similarGameTitles: Array.from({ length: Math.floor(r() * 6) }, pick) });
    cands.push(c);
    if (r() < 0.3) {
      hits[c.gameId] = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({
        u: r() < 0.9 ? users[Math.floor(r() * users.length)].gameId : 'steam-unknown',
        d: [0.02, 0.1, 0.2, 0.3, 0.5][Math.floor(r() * 5)],
      }));
    }
  }
  return { users, cands, hits };
}

describe('computeGraphSignal with the candidate index', () => {
  it.each([1, 2, 3, 4, 5])('matches the full library scan exactly (seed %i)', (seed) => {
    const { users, cands, hits } = randomFixture(seed, 120, 400);
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    // The worker sorts by weight after building the context, then indexes that order.
    users.sort((a, b) => (ctx.ugWeights.get(b.gameId) ?? 0) - (ctx.ugWeights.get(a.gameId) ?? 0));
    const index = buildGraphCandidateIndex(users, ctx);
    let nonZero = 0;
    for (const c of cands) {
      const slow = computeGraphSignal(c, users, hits[c.gameId], ctx);
      const fast = computeGraphSignal(c, users, hits[c.gameId], ctx, index);
      expect(fast.score).toBe(slow.score);
      expect(fast.similarTo).toEqual(slow.similarTo);
      if (slow.score > 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(50); // the fixture exercises real matches
  });

  it('ignores an index built for a different array length (falls back to the scan)', () => {
    const { users, cands } = randomFixture(9, 30, 20);
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const stale = buildGraphCandidateIndex(users.slice(0, 10), ctx);
    for (const c of cands) {
      expect(computeGraphSignal(c, users, undefined, ctx, stale)).toEqual(computeGraphSignal(c, users, undefined, ctx));
    }
  });

  it('3K x 3K runs well under the full scan', () => {
    // Real libraries: thousands of distinct titles, each related to a handful of others.
    const { users, cands, hits } = randomFixture(11, 3000, 3000, 20_000);
    const ctx = buildGraphUserContext(users, FIXTURE_NOW);
    const t0 = performance.now();
    const index = buildGraphCandidateIndex(users, ctx);
    for (const c of cands) computeGraphSignal(c, users, hits[c.gameId], ctx, index);
    const fastMs = performance.now() - t0;
    const t1 = performance.now();
    for (const c of cands.slice(0, 300)) computeGraphSignal(c, users, hits[c.gameId], ctx);
    const slowMsFor10Pct = performance.now() - t1;
    // The indexed pass over all 3K candidates beats the scan over a tenth of them.
    expect(fastMs).toBeLessThan(slowMsFor10Pct);
  });
});
