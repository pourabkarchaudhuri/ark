/**
 * v1.0.97 B34 — Oracle ranking and explanation fixes, driven through the real worker pipeline:
 * removed games stay off library shelves, Backlog Advisor reasons are honest, publisher-only loyalty is
 * worded as the publisher, rejected games give no engagement-curve bonus, mood shelves are unique,
 * the worker labels engagement before building the profile, and deals need a real discount.
 */
import { describe, it, expect } from 'vitest';
import { FIXTURE_NOW, candidatePool, makeCandidate, makeUser, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';
import { explanationHeadline } from '@/services/reco-explainer';
import { oracleShelfKey } from '@/services/oracle-shelf-key';
import type { UserGameSnapshot } from '@/types/reco';

const DAY = 24 * 60 * 60 * 1000;

describe('removed games on library shelves (oracle#2)', () => {
  const removedAt = new Date(FIXTURE_NOW - 10 * DAY).toISOString();

  it('a removed On Hold game is not in Unfinished Business and not the Finish-and-Try seed', async () => {
    const lib = multiTasteLibrary().map(g => (g.gameId === 'steam-90' ? { ...g, hoursPlayed: 300 } : g));
    const result = await runWorkerPipeline(baseWorkerInput(lib, candidatePool(120), FIXTURE_NOW));
    const unfinished = result.shelves.find(s => s.type === 'unfinished-business');
    expect(unfinished?.games.map(g => g.gameId)).not.toContain('steam-90');
    const finish = result.shelves.find(s => s.type === 'finish-and-try');
    expect(finish?.seedGameTitle).not.toBe('Shooter Regret');

    // Control: the same game, not removed, is the seed (most hours On Hold) and is unfinished business.
    const owned = lib.map(g => (g.gameId === 'steam-90' ? { ...g, removedAt: undefined } : g));
    const control = await runWorkerPipeline(baseWorkerInput(owned, candidatePool(120), FIXTURE_NOW));
    expect(control.shelves.find(s => s.type === 'finish-and-try')?.seedGameTitle).toBe('Shooter Regret');
    expect(control.shelves.find(s => s.type === 'unfinished-business')?.games.map(g => g.gameId)).toContain('steam-90');
  });

  it('a removed Want to Play game is not in Backlog Advisor', async () => {
    const lib = [
      ...multiTasteLibrary(),
      makeUser('steam-92', { title: 'Removed Wish', genres: ['RPG'], status: 'Want to Play', hoursPlayed: 0, rating: 0, removedAt }),
      makeUser('steam-93', { title: 'Kept Wish', genres: ['RPG'], status: 'Want to Play', hoursPlayed: 0, rating: 0 }),
    ];
    const result = await runWorkerPipeline(baseWorkerInput(lib, candidatePool(120), FIXTURE_NOW));
    const ids = result.shelves.find(s => s.type === 'backlog-advisor')?.games.map(g => g.gameId) ?? [];
    expect(ids).toContain('steam-93');
    expect(ids).not.toContain('steam-92');
  });
});

describe('Backlog Advisor reasons (oracle#14)', () => {
  const studioLibrary = (): UserGameSnapshot[] => [
    makeUser('steam-1', { title: 'Bastion Prime', genres: ['Action', 'RPG'], developer: 'Supergiant Games', hoursPlayed: 40, rating: 5 }),
    makeUser('steam-2', { title: 'Transistor Echo', genres: ['Action', 'RPG'], developer: 'Supergiant Games', hoursPlayed: 30, rating: 5 }),
    makeUser('steam-3', { title: 'Farm Days', genres: ['Simulation'], developer: 'Cozy Co', hoursPlayed: 20, rating: 4 }),
    // Backlog game sharing only the loyal developer (no franchise), raw genre spellings.
    makeUser('steam-50', {
      title: 'Pyre Night', genres: ['action', 'Action', 'Rogue'], developer: 'Supergiant Games',
      status: 'Want to Play', hoursPlayed: 0, rating: 0,
    }),
  ];

  async function backlogGame(semantic: number) {
    const result = await runWorkerPipeline(baseWorkerInput(studioLibrary(), candidatePool(60), FIXTURE_NOW, {
      embeddingCoverage: 1,
      tasteCentroid: [1, 0, 0],
      backlogSemanticScores: { 'steam-50': semantic },
    }));
    const g = result.shelves.find(s => s.type === 'backlog-advisor')?.games.find(x => x.gameId === 'steam-50');
    expect(g).toBeDefined();
    return g!;
  }

  it('a developer-only match is studio loyalty, not a franchise', async () => {
    const g = await backlogGame(0.6);
    expect(g.layerScores.franchiseBoost).toBe(0);
    expect(g.layerScores.studioLoyaltyBoost).toBeCloseTo(0.15);
    expect(g.reasons.loyalStudio).toEqual({ role: 'developer', name: 'Supergiant Games' });
    const headline = explanationHeadline(g);
    expect(headline).not.toMatch(/franchise/);
    expect(headline).toMatch(/Supergiant Games is a studio/);
  });

  it('a cosine of 0.35 is not a "strong semantic match"; a high one is', async () => {
    expect((await backlogGame(0.35)).reasons.explanation).not.toMatch(/Strong semantic match/);
    expect((await backlogGame(0.6)).reasons.explanation).toMatch(/Strong semantic match/);
  });

  it('genre chips are the canonical shared genres and match the count in the reason', async () => {
    const g = await backlogGame(0.6);
    expect(g.reasons.sharedGenres).toEqual(['Action']);
    expect(g.reasons.explanation).toMatch(new RegExp(`Matches ${g.reasons.sharedGenres.length} of your top genres`));
  });
});

describe('publisher-only loyalty wording (oracle#15)', () => {
  it('names the publisher, not the developer, when only the publisher is loyal', async () => {
    const lib = [
      makeUser('steam-1', { title: 'Serious Run', genres: ['Action'], developer: 'Studio One', publisher: 'Devolver Digital', hoursPlayed: 40, rating: 5 }),
      makeUser('steam-2', { title: 'Hotline Days', genres: ['Action'], developer: 'Studio Two', publisher: 'Devolver Digital', hoursPlayed: 40, rating: 5 }),
    ];
    const pool = [
      makeCandidate('steam-8000', { title: 'Talos Gate', genres: ['Action'], developer: 'Croteam', publisher: 'Devolver Digital', metacriticScore: 90 }),
      ...candidatePool(30),
    ];
    const result = await runWorkerPipeline(baseWorkerInput(lib, pool, FIXTURE_NOW));
    const g = result.shelves.flatMap(s => s.games).find(x => x.gameId === 'steam-8000');
    expect(g).toBeDefined();
    expect(g!.layerScores.studioLoyaltyBoost).toBeCloseTo(0.25);
    expect(g!.reasons.loyalStudio).toEqual({ role: 'publisher', name: 'Devolver Digital' });
    expect(g!.reasons.explanation).not.toMatch(/from Croteam, a studio you trust/);
    expect(g!.reasons.explanation).toMatch(/published by Devolver Digital, a label you trust/);
  });
});

describe('engagement curve bonus from rejected games (oracle#16)', () => {
  // Three sessions spread over 60 days: a 'long-tail' curve (x1.4).
  const longTail = (rating: number) => makeUser('steam-1', {
    title: 'Endless Puzzles', genres: ['Puzzle'], hoursPlayed: 120, rating, status: 'Playing',
    sessionCount: 3,
    sessionTimestamps: [FIXTURE_NOW - 60 * DAY, FIXTURE_NOW - 30 * DAY, FIXTURE_NOW - 2 * DAY],
    sessionDurations: [60, 60, 60],
  });
  const pool = () => [0, 1, 2, 3].map(i => makeCandidate(`steam-${8100 + i}`, { title: `Puzzle ${i}`, genres: ['Puzzle'] }));

  async function heroCurveBonus(rating: number) {
    const lib = [longTail(rating), makeUser('steam-2', { title: 'Race Day', genres: ['Racing'], hoursPlayed: 10, rating: 4 })];
    const result = await runWorkerPipeline(baseWorkerInput(lib, pool(), FIXTURE_NOW));
    const hero = result.shelves.find(s => s.type === 'hero')!.games[0];
    return hero.layerScores.engagementCurveBonus;
  }

  it('a 1-star long-tail game gives no curve bonus to a same-genre candidate', async () => {
    expect(await heroCurveBonus(1)).toBe(0);
  });

  it('a liked long-tail game still does', async () => {
    expect(await heroCurveBonus(5)).toBeGreaterThan(0);
  });
});

describe('duplicate "For your X side" shelves (oracle#18)', () => {
  it('two clusters with the same top genre get unique titles and shelf keys', async () => {
    const mk = (i: number, themes: string[], over: Partial<UserGameSnapshot> = {}) => makeUser(`steam-${i}`, {
      title: `Lib ${i}`, genres: ['Action'], themes, hoursPlayed: 30, rating: 5, developer: `Dev ${i}`, ...over,
    });
    const lib = [
      ...[1, 2, 3, 4].map(i => mk(i, ['Sci-fi', 'Space'], { genres: ['Action', 'Strategy'] })),
      ...[5, 6, 7, 8].map(i => mk(i, ['Fantasy', 'Magic'], { genres: ['Action', 'RPG'] })),
    ];
    const clusters = [
      { id: 0, label: 'Action', gameCount: 4, topGames: ['Lib 1'], profile: { topGenre: 'Action', genres: [{ name: 'Action' }, { name: 'Strategy' }], themes: [{ name: 'sci-fi' }] } },
      { id: 1, label: 'Action', gameCount: 4, topGames: ['Lib 5'], profile: { topGenre: 'Action', genres: [{ name: 'Action' }, { name: 'RPG' }], themes: [{ name: 'fantasy' }] } },
    ];
    const pool = Array.from({ length: 40 }, (_, i) => makeCandidate(`steam-${8200 + i}`, {
      title: `Pick ${String.fromCharCode(65 + (i % 26))}${i}`,
      developer: `Studio ${i}`,
      genres: i % 2 === 0 ? ['Action', 'Strategy'] : ['Action', 'RPG'],
      themes: i % 2 === 0 ? ['Sci-fi'] : ['Fantasy'],
    }));
    const result = await runWorkerPipeline(baseWorkerInput(lib, pool, FIXTURE_NOW, {
      precomputedClusters: clusters as never,
    }));
    const mood = result.shelves.filter(s => s.type === 'for-your-mood');
    expect(mood.length).toBe(2);
    const titles = mood.map(s => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(mood.map(oracleShelfKey)).size).toBe(mood.length);
    expect(titles[0]).toBe('For your Action side');
    expect(titles[1]).toBe('For your RPG side');
    // The fallback label also filters the shelf.
    expect(mood[1].games.every(g => g.genres.includes('RPG'))).toBe(true);
  });
});

describe('worker engagement label before the taste profile (oracle#1)', () => {
  // A completed game played in three sessions over two days: the old store classifier called it
  // 'binge-drop' (x0.6); the shared one does not.
  const binge = (pattern: UserGameSnapshot['engagementPattern']) => makeUser('steam-1', {
    title: 'Short Story', genres: ['Adventure'], status: 'Completed', hoursPlayed: 12, rating: 5,
    sessionCount: 3,
    sessionTimestamps: [FIXTURE_NOW - 3 * DAY, FIXTURE_NOW - 2.5 * DAY, FIXTURE_NOW - 2 * DAY],
    sessionDurations: [240, 240, 240],
    engagementPattern: pattern,
  });

  it('the early-return path (no candidates) builds its profile with the shared label', async () => {
    const stale = await runWorkerPipeline(baseWorkerInput([binge('binge-drop')], [], FIXTURE_NOW));
    const fresh = await runWorkerPipeline(baseWorkerInput([binge('unknown')], [], FIXTURE_NOW));
    expect(stale.tasteProfile.genres[0].weight).toBeCloseTo(fresh.tasteProfile.genres[0].weight, 10);
  });

  it('the full path builds its profile with the shared label too', async () => {
    const stale = await runWorkerPipeline(baseWorkerInput([binge('binge-drop')], candidatePool(20), FIXTURE_NOW));
    const fresh = await runWorkerPipeline(baseWorkerInput([binge('unknown')], candidatePool(20), FIXTURE_NOW));
    expect(stale.tasteProfile.genres[0].weight).toBeCloseTo(fresh.tasteProfile.genres[0].weight, 10);
  });
});

describe('Deals For You needs a real discount (earlier review)', () => {
  it('a full-price game flagged at its all-time low is not a deal and not first', async () => {
    const name = (i: number) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)) + 'rion';
    const pool = candidatePool(80).map((c, i) => {
      const titled = { ...c, title: name(i), developer: `Studio ${i}` };
      if (i % 4 === 0) return { ...titled, price: { isFree: false, discountPercent: 50 } };
      if (i % 4 === 1) return { ...titled, price: { isFree: false, discountPercent: 0, atHistoricalLow: true } };
      return titled;
    });
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), pool, FIXTURE_NOW));
    const shelf = result.shelves.find(s => s.type === 'deals-for-you');
    expect(shelf).toBeDefined();
    expect(shelf!.games.every(g => (g.price?.discountPercent ?? 0) > 0)).toBe(true);
  });
});
