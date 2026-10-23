/**
 * R4 taste modeling: rejected games must not shape positive taste, and the
 * semantic layer must be discriminative, source-fair, negative-aware and imputed.
 */
import { describe, it, expect } from 'vitest';
import { buildTasteProfile, _engagementCache } from '@/services/reco-scoring';
import {
  NEG_PENALTY_WEIGHT,
  contrastCentroid,
  negativeConfidence,
  percentileBySource,
  semanticSourceOf,
  finalSemanticScore,
} from '@/services/semantic-scoring';
import { embeddingService } from '@/services/embedding-service';
import { detectTasteClusters } from '@/services/reco-scoring';
import { FIXTURE_NOW, makeCandidate, makeUser, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

describe('taste profile ignores rejected games', () => {
  it('1-star 80h and removed games add no genre/theme weight', () => {
    _engagementCache.clear();
    const taste = buildTasteProfile(multiTasteLibrary(), FIXTURE_NOW);
    const shooter = taste.genres.find(g => g.name.toLowerCase() === 'shooter');
    expect(shooter?.weight ?? 0).toBe(0);
    const online = taste.themes.find(t => t.name === 'online');
    expect(online?.weight ?? 0).toBe(0);
  });

  it('a shooter candidate no longer outranks an equal RPG candidate through taste', async () => {
    _engagementCache.clear();
    const lib = multiTasteLibrary();
    const mk = (id: string, genres: string[], themes: string[]) =>
      makeCandidate(id, {
        title: id, genres, themes, developer: `Dev ${id}`, metacriticScore: 80,
        reviewPositivity: 0.9, reviewVolume: 50_000, playerCount: 50_000, releaseDate: '2022-01-01',
      });
    const result = await runWorkerPipeline(baseWorkerInput(lib, [
      mk('steam-8001', ['Shooter', 'Action'], ['Multiplayer', 'Online']),
      mk('steam-8002', ['RPG', 'Action'], ['Dark Fantasy']),
    ], FIXTURE_NOW));
    const score = (id: string) => result.shelves.flatMap(s => s.games).find(g => g.gameId === id)?.score ?? 0;
    expect(score('steam-8002')).toBeGreaterThan(score('steam-8001'));
  });
});

describe('semantic-scoring', () => {
  it('semanticSourceOf', () => {
    expect(semanticSourceOf('steam-10')).toBe('steam');
    expect(semanticSourceOf('epic-abc')).toBe('epic');
    expect(semanticSourceOf('custom-1')).toBe('other');
  });

  it('percentileBySource makes each source use the full 0..1 range', () => {
    const raw = new Map<string, number>();
    // Steam cosines sit high (0.6-0.8), Epic low (0.3-0.5): composition differs, rank should not.
    for (let i = 0; i < 40; i++) raw.set(`steam-${i}`, 0.6 + i * 0.005);
    for (let i = 0; i < 40; i++) raw.set(`epic-${i}`, 0.3 + i * 0.005);
    const pct = percentileBySource(raw);
    expect(pct.get('steam-39')).toBeCloseTo(1, 6);
    expect(pct.get('epic-39')).toBeCloseTo(1, 6);
    expect(pct.get('steam-0')).toBeCloseTo(0, 6);
    expect(pct.get('epic-0')).toBeCloseTo(0, 6);
  });

  it('small source groups get a neutral percentile, not the Steam-dominated global rank', () => {
    const raw = new Map<string, number>();
    for (let i = 0; i < 50; i++) raw.set(`steam-${i}`, 0.5 + i * 0.004);
    raw.set('epic-1', 0.2);
    raw.set('epic-2', 0.9);
    const pct = percentileBySource(raw);
    expect(pct.get('epic-1')).toBe(0.5);
    expect(pct.get('epic-2')).toBe(0.5);
    expect(pct.get('steam-49')).toBeCloseTo(1, 6);
  });

  it('a mid-sized Epic group is ranked within itself', () => {
    const raw = new Map<string, number>();
    for (let i = 0; i < 3000; i++) raw.set(`steam-${i}`, 0.6 + (i % 100) * 0.002);
    for (let i = 0; i < 12; i++) raw.set(`epic-${i}`, 0.2 + i * 0.01);
    const pct = percentileBySource(raw);
    expect(pct.get('epic-11')).toBeCloseTo(1, 6);
    expect(pct.get('epic-0')).toBeCloseTo(0, 6);
  });

  it('the negative penalty is relative: only candidates closer to rejected games than to taste are hit', () => {
    expect(finalSemanticScore(0.9, 0.9, 1)).toBeCloseTo(0.9, 6); // best taste match that also resembles negatives: untouched
    expect(finalSemanticScore(0.3, 0.9, 1)).toBeCloseTo(0.3 - NEG_PENALTY_WEIGHT * 0.6, 6);
    expect(finalSemanticScore(0.8, 0.1, 1)).toBeCloseTo(0.8, 6);
    expect(finalSemanticScore(0.3, 0.9, 0)).toBeCloseTo(0.3, 6);
    expect(finalSemanticScore(0, 1, 1)).toBe(0);
  });

  it('negative confidence follows summed weight, not count', () => {
    expect(negativeConfidence(0)).toBe(0);
    expect(negativeConfidence(2.5)).toBeCloseTo(0.5, 6);
    expect(negativeConfidence(10)).toBe(1);
  });

  it('contrastCentroid moves the query away from the negative direction', () => {
    const taste = Float32Array.from([1, 0, 0]);
    const neg = Float32Array.from([0.6, 0.8, 0]);
    const q = contrastCentroid(taste, neg, 0.5)!;
    const dotNeg = q[0] * 0.6 + q[1] * 0.8;
    expect(dotNeg).toBeLessThan(0.6);
    expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(1, 6);
    expect(contrastCentroid(taste, null, 0.5)).toBe(taste);
  });
});

describe('computeTasteCentroid robustness', () => {
  it('uses the modal dimension, not the first row', () => {
    const odd = { embedding: [1, 1], weight: 1 };
    const rows = [odd, ...Array.from({ length: 3 }, () => ({ embedding: [1, 0, 0, 0], weight: 1 }))];
    const c = embeddingService.computeTasteCentroid(rows);
    expect(c).not.toBeNull();
    expect(c!.length).toBe(4);
  });

  it('ignores zero and negative weights', () => {
    const c = embeddingService.computeTasteCentroid([
      { embedding: [1, 0], weight: 1 },
      { embedding: [0, 1], weight: 0 },
      { embedding: [0, 1], weight: -2 },
    ]);
    expect(Array.from(c!)).toEqual([1, 0]);
  });
});

describe('review hardening (R4)', () => {
  it('detectTasteClusters ignores rejected games', () => {
    _engagementCache.clear();
    const clusters = detectTasteClusters(multiTasteLibrary(), FIXTURE_NOW);
    const members = clusters.flatMap(c => c.gameIds ?? []);
    expect(members).not.toContain('steam-90');
    expect(members).not.toContain('steam-91');
  });

  it('a Stretch Pick never comes from a genre the user rejected', async () => {
    _engagementCache.clear();
    const lib = multiTasteLibrary();
    const mk = (id: string, genres: string[]) =>
      makeCandidate(id, { title: id, genres, themes: [], developer: id, metacriticScore: 85, reviewPositivity: 0.9, reviewVolume: 50_000, playerCount: 50_000, releaseDate: '2022-01-01' });
    const result = await runWorkerPipeline(baseWorkerInput(lib, [
      mk('steam-8101', ['Shooter']),       // only rejected games share this genre
      mk('steam-8102', ['Puzzle']),        // unrelated, never seen: legitimate stretch
    ], FIXTURE_NOW));
    const all = result.shelves.flatMap(s => s.games);
    expect(all.find(g => g.gameId === 'steam-8101')?.reasons.isStretchPick ?? false).toBe(false);
    expect(all.find(g => g.gameId === 'steam-8102')?.reasons.isStretchPick ?? true).toBe(true);
  });

  it('keeps unrelated users untouched: makeUser sanity', () => {
    expect(makeUser('x').rating).toBe(4);
  });
});
