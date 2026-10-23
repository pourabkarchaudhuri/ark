/**
 * R6 recall / candidate pool: pure helpers extracted from RecoStore.
 */
import { describe, it, expect } from 'vitest';
import { selectAnnCandidates } from '@/services/ann-retrieve';
import {
  PREFILTER_MAX_POOL,
  dedupeCandidatesByTitle,
  expandTwinIds,
  hasAdultHintTags,
  isLikelyAdultByTags,
  isWindowsPlayable,
  passesRetrievalQualityFloor,
  preFilterCandidates,
  reviewQualityKey,
  selectColdStartSeedIds,
} from '@/services/reco-prefilter';
import { _engagementCache, normalizeTitleKey } from '@/services/reco-scoring';
import { FIXTURE_NOW, candidatePool, makeCandidate, makeUser, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

describe('selectAnnCandidates', () => {
  const hit = (id: string, distance: number) => ({ id, distance });

  it('aggregates chunk rows to their game and keeps the best distance', () => {
    const out = selectAnnCandidates(
      [hit('cat:steam-1::desc#0', 0.2), hit('steam-1', 0.3), hit('lib:steam-2::facets#0', 0.1)],
      { ceiling: 0.45, maxKeep: 10, isExcluded: () => false },
    );
    expect(out.map(n => n.id).sort()).toEqual(['steam-1', 'steam-2']);
    expect(out.find(n => n.id === 'steam-1')!.distance).toBeLessThanOrEqual(0.3);
  });

  it('removes library games BEFORE the cap, so they cannot burn slots', () => {
    const raw = Array.from({ length: 600 }, (_, i) => hit(`steam-${i}`, 0.1 + i * 0.0004));
    const owned = new Set(Array.from({ length: 300 }, (_, i) => `steam-${i}`));
    const out = selectAnnCandidates(raw, { ceiling: 0.45, maxKeep: 500, isExcluded: id => owned.has(id) });
    expect(out).toHaveLength(300); // all non-owned survivors; with cap-first this would have been 200
    expect(out.every(n => !owned.has(n.id))).toBe(true);
  });

  it('applies the ceiling and cap in distance order and ignores non-store ids', () => {
    const out = selectAnnCandidates(
      [hit('steam-3', 0.5), hit('steam-4', 0.2), hit('steam-5', 0.1), hit('custom-1', 0.05)],
      { ceiling: 0.45, maxKeep: 1, isExcluded: () => false },
    );
    expect(out.map(n => n.id)).toEqual(['steam-5']);
  });
});

describe('passesRetrievalQualityFloor', () => {
  const now = FIXTURE_NOW;
  const q = (over: object) => passesRetrievalQualityFloor({ releaseDate: '2020-01-01', ...over }, now);
  it('rejects well-reviewed-volume but poorly rated released games', () => {
    expect(q({ reviewVolume: 500, reviewPositivity: 0.3 })).toBe(false);
  });
  it('accepts decent ratings, unknown reviews and unreleased titles', () => {
    expect(q({ reviewVolume: 500, reviewPositivity: 0.8 })).toBe(true);
    expect(q({})).toBe(true);
    expect(q({ releaseDate: '2030-01-01', reviewVolume: 500, reviewPositivity: 0.1 })).toBe(true);
    expect(q({ comingSoon: true, reviewVolume: 500, reviewPositivity: 0.1 })).toBe(true);
  });
  it('treats a handful of reviews as noise (rejected unless zero)', () => {
    expect(q({ reviewVolume: 5, reviewPositivity: 1 })).toBe(false);
    expect(q({ reviewVolume: 0, reviewPositivity: 0 })).toBe(true);
  });
});

describe('selectColdStartSeedIds', () => {
  const rows = [
    { id: 'steam-1', genre: ['RPG'], totalReviews: 90_000 },
    { id: 'steam-2', genre: ['Shooter'], totalReviews: 80_000 },
    { id: 'steam-3', genre: ['RPG'], totalReviews: 100 },
    { id: 'steam-4', genre: ['RPG'], category: 'trending', totalReviews: 100 },
    { id: 'steam-5', genre: ['Role-Playing'], totalReviews: 7_000 },
  ];
  it('picks top sellers in the user top genres, best first, even when rows are already seen elsewhere', () => {
    _engagementCache.clear();
    const lib = [makeUser('steam-100', { genres: ['RPG'], hoursPlayed: 30, rating: 5 })];
    const ids = selectColdStartSeedIds(lib, rows, 10);
    expect(ids).toEqual(['steam-1', 'steam-4']);
  });
  it('does not seed from a genre the user rejected', () => {
    const lib = [
      makeUser('steam-100', { genres: ['RPG'], hoursPlayed: 30, rating: 5 }),
      makeUser('steam-101', { genres: ['Shooter'], hoursPlayed: 80, rating: 1, status: 'On Hold' }),
    ];
    expect(selectColdStartSeedIds(lib, rows, 10)).not.toContain('steam-2');
  });
  it('a brand-new library admits any top seller and respects the quota', () => {
    expect(selectColdStartSeedIds([], rows, 2)).toEqual(['steam-1', 'steam-2']);
  });
});

describe('pool hygiene', () => {
  it('isLikelyAdultByTags is conservative', () => {
    expect(isLikelyAdultByTags({ genres: ['Hentai'], themes: [] })).toBe(true);
    expect(isLikelyAdultByTags({ genres: ['RPG'], themes: ['NSFW'] })).toBe(true);
    // Ambiguous mature tags (The Witcher 3, Baldur's Gate 3...) must NOT be dropped on the tag alone.
    expect(isLikelyAdultByTags({ genres: ['RPG'], themes: ['Sexual Content', 'Nudity'] })).toBe(false);
    expect(isLikelyAdultByTags({ genres: ['RPG'], themes: ['Mature', 'Violent'] })).toBe(false);
    expect(hasAdultHintTags({ genres: ['RPG'], themes: ['Sexual Content'] })).toBe(true);
    expect(hasAdultHintTags({ genres: ['RPG'], themes: ['Violent'] })).toBe(false);
  });

  it('isWindowsPlayable', () => {
    expect(isWindowsPlayable([])).toBe(true);
    expect(isWindowsPlayable(['Windows', 'Mac'])).toBe(true);
    expect(isWindowsPlayable(['PC'])).toBe(true);
    expect(isWindowsPlayable(['Mac', 'Linux'])).toBe(false);
  });

  it('dedupeCandidatesByTitle collapses editions/stores and drops owned titles', () => {
    const steam = makeCandidate('steam-1', { title: 'The Witcher® 3: Wild Hunt', reviewVolume: 500_000, reviewPositivity: 0.96 });
    const goty = makeCandidate('steam-2', { title: 'The Witcher 3: Wild Hunt – Game of the Year Edition', reviewVolume: 1000, reviewPositivity: 0.9 });
    const epic = makeCandidate('epic-9', { title: 'The Witcher 3: Wild Hunt' });
    const other = makeCandidate('steam-3', { title: 'Hades' });
    const owned = makeCandidate('steam-4', { title: 'Celeste Deluxe Edition' });
    const empty1 = makeCandidate('steam-5', { title: '!!!' });
    const empty2 = makeCandidate('steam-6', { title: '???' });
    const out = dedupeCandidatesByTitle(
      [steam, goty, epic, other, owned, empty1, empty2],
      new Set([normalizeTitleKey('Celeste')]),
    );
    expect(out.map(c => c.gameId)).toEqual(['steam-1', 'steam-3', 'steam-5', 'steam-6']);
  });

  it('the dedupe winner keeps a link to its twin and the retrieval flags of the losers', () => {
    const steam = makeCandidate('steam-1', { title: 'Hades', reviewVolume: 90_000, reviewPositivity: 0.98 });
    const epic = makeCandidate('epic-1', { title: 'Hades', semanticRetrieved: true, coldStartSeeded: true });
    const [winner] = dedupeCandidatesByTitle([steam, epic], new Set());
    expect(winner.gameId).toBe('steam-1');
    expect(winner.secondaryGameId).toBe('epic-1');
    expect(winner.semanticRetrieved).toBe(true);
    expect(winner.coldStartSeeded).toBe(true);
    // A dismissal of the Epic copy still reaches the Steam winner.
    expect(expandTwinIds(['epic-1'], [winner])).toContain('steam-1');
  });

  it('expandTwinIds carries ids across cross-store twins in both directions', () => {
    const cands = [
      { gameId: 'steam-1', secondaryGameId: 'epic-a' },
      { gameId: 'steam-2', secondaryGameId: 'epic-b' },
      { gameId: 'steam-3' },
    ];
    expect(expandTwinIds(['steam-1', 'epic-b'], cands).sort()).toEqual(['epic-a', 'epic-b', 'steam-1', 'steam-2']);
  });
});

describe('preFilterCandidates', () => {
  const genres = ['RPG', 'Strategy', 'Puzzle', 'Racing', 'Sports', 'Horror', 'Platformer', 'Simulation'];
  const bigPool = (n: number) => Array.from({ length: n }, (_, i) => makeCandidate(`steam-${10_000 + i}`, {
    title: `Pool Game ${i}`,
    genres: i % 40 === 0 ? [] : [genres[i % genres.length]],
    developer: `Dev ${i % 500}`,
    reviewPositivity: 0.5 + ((i * 7) % 50) / 100,
    reviewVolume: 20 + ((i * 13) % 5000),
    metacriticScore: i % 9 === 0 ? 70 + (i % 25) : null,
  }));
  const library = () => [
    makeUser('steam-1', { title: 'Lib RPG', genres: ['RPG'], hoursPlayed: 60, rating: 5, developer: 'Loyal Dev' }),
    makeUser('steam-2', { title: 'Lib RPG 2', genres: ['RPG'], hoursPlayed: 40, rating: 5, developer: 'Loyal Dev' }),
    makeUser('steam-3', { title: 'Lib Hated', genres: ['Sports'], hoursPlayed: 90, rating: 1, status: 'On Hold', developer: 'Hated Dev' }),
  ];

  it('returns the same array when the pool already fits', () => {
    const small = bigPool(100);
    expect(preFilterCandidates(small, library())).toBe(small);
  });

  it('shrinks an oversized pool to the cap and keeps ANN/BM25/cold-start hits', () => {
    _engagementCache.clear();
    const pool = bigPool(9000);
    pool[8000] = { ...pool[8000], semanticRetrieved: true };
    pool[8001] = { ...pool[8001], lexicalRetrieved: true };
    pool[8002] = { ...pool[8002], coldStartSeeded: true };
    const out = preFilterCandidates(pool, library(), { now: FIXTURE_NOW });
    expect(out.length).toBeLessThanOrEqual(PREFILTER_MAX_POOL + 500);
    expect(out.length).toBeGreaterThan(500);
    for (const id of [pool[8000].gameId, pool[8001].gameId, pool[8002].gameId]) {
      expect(out.some(c => c.gameId === id)).toBe(true);
    }
  });

  it('is deterministic for the same input (seeded wildcard, no Math.random)', () => {
    _engagementCache.clear();
    const pool = bigPool(9000);
    const a = preFilterCandidates(pool, library(), { now: FIXTURE_NOW }).map(c => c.gameId);
    const b = preFilterCandidates(pool, library(), { now: FIXTURE_NOW }).map(c => c.gameId);
    expect(a).toEqual(b);
  });

  it('keeps untagged candidates reachable, best-reviewed first', () => {
    _engagementCache.clear();
    const out = preFilterCandidates(bigPool(9000), library(), { now: FIXTURE_NOW });
    const untagged = out.filter(c => c.genres.length === 0);
    expect(untagged.length).toBeGreaterThanOrEqual(100);
  });

  it('the studio quota follows loyal studios only', () => {
    _engagementCache.clear();
    const pool = bigPool(9000).map((c, i) => (i % 7 === 0 ? { ...c, genres: ['Puzzle'], developer: i % 2 ? 'Loyal Dev' : 'Hated Dev', metacriticScore: null } : c));
    const out = preFilterCandidates(pool, library(), { now: FIXTURE_NOW });
    const loyal = out.filter(c => c.developer === 'Loyal Dev').length;
    const hated = out.filter(c => c.developer === 'Hated Dev').length;
    expect(loyal).toBeGreaterThan(hated);
  });

  it('genres only a rejected game shares do not open the genre quota', () => {
    _engagementCache.clear();
    const pool = bigPool(9000);
    const out = preFilterCandidates(pool, library(), { now: FIXTURE_NOW });
    const sportsShare = out.filter(c => c.genres.includes('Sports')).length / Math.max(1, out.length);
    const rpgShare = out.filter(c => c.genres.includes('RPG')).length / Math.max(1, out.length);
    expect(rpgShare).toBeGreaterThan(sportsShare);
  });

  it('reviewQualityKey ranks positivity weighted by volume', () => {
    expect(reviewQualityKey({ reviewPositivity: 0.9, reviewVolume: 10_000 })).toBeGreaterThan(reviewQualityKey({ reviewPositivity: 0.9, reviewVolume: 20 }));
    expect(reviewQualityKey({})).toBe(0);
  });
});


describe('shelves from the full scored pool (R6)', () => {
  const sale = (i: number, dev: string) => makeCandidate(`steam-${8000 + i}`, {
    title: `Sale Game ${i}`, genres: ['RPG', 'Action'], themes: ['Dark Fantasy'], developer: dev,
    metacriticScore: 78, reviewPositivity: 0.9, reviewVolume: 20_000, playerCount: 5_000 + i,
    releaseDate: '2021-03-01', price: { isFree: false, finalFormatted: '$10', discountPercent: 50 },
  });

  it('a Deals shelf takes at most two games per developer', async () => {
    const pool = [
      ...candidatePool(60),
      ...Array.from({ length: 6 }, (_, i) => sale(i, 'Same Dev')),
      ...Array.from({ length: 3 }, (_, i) => sale(10 + i, `Other Dev ${i}`)),
    ];
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), pool, FIXTURE_NOW));
    const deals = result.shelves.find(sh => sh.type === 'deals-for-you');
    if (deals) {
      expect(deals.games.filter(g => g.developer === 'Same Dev').length).toBeLessThanOrEqual(2);
    }
    // Developer cap must hold for every catalogue-style shelf.
    for (const sh of result.shelves.filter(x => ['deals-for-you', 'free-for-you', 'critics-choice', 'trending-now', 'hidden-gems', 'new-releases-for-you'].includes(x.type))) {
      const perDev = new Map<string, number>();
      for (const g of sh.games) perDev.set(g.developer, (perDev.get(g.developer) ?? 0) + 1);
      expect(Math.max(0, ...perDev.values())).toBeLessThanOrEqual(2);
    }
  });

  it('unreleased games stay out of the main shelves', async () => {
    const future = makeCandidate('steam-8900', {
      title: 'Future Hit', genres: ['RPG', 'Action'], themes: ['Dark Fantasy'], developer: 'Future Dev',
      metacriticScore: 95, reviewPositivity: 0.99, reviewVolume: 90_000, playerCount: 1, releaseDate: '2031-01-01', comingSoon: true,
    });
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), [...candidatePool(60), future], FIXTURE_NOW));
    for (const sh of result.shelves) {
      if (['coming-soon-for-you', 'upcoming-sequels'].includes(sh.type)) continue;
      expect(sh.games.some(g => g.gameId === 'steam-8900')).toBe(false);
    }
  });
});
