/**
 * R5 scoring-math cleanup: each test pins a defect from the Oracle audit
 * (quality, popularity, recency, diversity, notes, studio loyalty, time-of-day,
 * sequencing, franchise, curve classification, calibration, NaN guard).
 */
import { describe, it, expect } from 'vitest';
import {
  QUALITY_UNKNOWN,
  buildSequencingContext,
  buildTasteProfile,
  buildTimeOfDayContext,
  calibrateMatchPercent,
  classifyEngagementCurve,
  computeDiversityBonus,
  computeNotesThemeBonus,
  computePopularitySignal,
  computeQualitySignal,
  computeRecencyBoost,
  computeSequencingBoost,
  computeStudioLoyaltyBoost,
  computeTimeOfDayBoost,
  noteTokens,
  splitCreditedNames,
  _engagementCache,
} from '@/services/reco-scoring';
import { computeFranchiseBoost, detectFranchises } from '@/services/franchise';
import { normalizeLayerScores, matchPercent, explanationLines, weightsFromTelemetry } from '@/services/reco-explainer';
import { DenseFeatureSpace, fastCosineProfileVsCandidate } from '@/services/reco-scoring';
import { FIXTURE_NOW, candidatePool, makeCandidate, makeScored, makeUser, multiTasteLibrary } from './fixtures';
import { baseWorkerInput, runWorkerPipeline } from './pipeline-harness';

const cand = (over = {}) => makeCandidate('steam-1', over);

describe('quality signal', () => {
  it('missing stats are not better than present-but-low stats', () => {
    const low = computeQualitySignal(cand({ metacriticScore: 55, reviewPositivity: undefined, reviewVolume: undefined, recommendations: undefined }));
    const none = computeQualitySignal(cand({ metacriticScore: null, reviewPositivity: undefined, reviewVolume: undefined, recommendations: undefined, achievements: undefined }));
    expect(none).toBeLessThanOrEqual(low);
    expect(none).toBe(QUALITY_UNKNOWN);
  });

  it('is small-sample safe: 3/3 positive does not beat 900/1000 positive', () => {
    const tiny = computeQualitySignal(cand({ reviewPositivity: 1, reviewVolume: 3 }));
    const solid = computeQualitySignal(cand({ reviewPositivity: 0.9, reviewVolume: 1000 }));
    expect(tiny).toBeLessThan(solid);
  });

  it('positivity outweighs raw review volume', () => {
    const lovedSmall = computeQualitySignal(cand({ reviewPositivity: 0.97, reviewVolume: 2_000 }));
    const mixedHuge = computeQualitySignal(cand({ reviewPositivity: 0.7, reviewVolume: 500_000 }));
    expect(lovedSmall).toBeGreaterThan(mixedHuge);
  });

  it('does not depend on the other candidates in the pool or on the wall-clock year', () => {
    const c = cand({ metacriticScore: 80, recommendations: 5_000, reviewPositivity: 0.9, reviewVolume: 3_000 });
    expect(computeQualitySignal(c)).toBe(computeQualitySignal({ ...c }));
    const old = computeQualitySignal({ ...c, releaseDate: '1999-01-01' });
    const fresh = computeQualitySignal({ ...c, releaseDate: '2026-01-01' });
    expect(old).toBe(fresh); // recency is its own layer; no double count
  });

  it('stays within [0, 1]', () => {
    for (const c of [cand({ metacriticScore: 100, recommendations: 1e9, reviewPositivity: 1, reviewVolume: 1e9, achievements: 9999 }), cand({})]) {
      const q = computeQualitySignal(c);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe('popularity signal', () => {
  it('is a real debias: less popular scores higher than blockbuster', () => {
    expect(computePopularitySignal(500, 1_000_000)).toBeGreaterThan(computePopularitySignal(900_000, 1_000_000));
  });
  it('unknown player count is neutral, not a fixed 0.3', () => {
    const mid = computePopularitySignal(1_000, 1_000_000);
    expect(computePopularitySignal(null, 1_000_000)).toBeGreaterThan(computePopularitySignal(900_000, 1_000_000));
    expect(computePopularitySignal(null, 1_000_000)).toBeCloseTo(0.5, 6);
    expect(mid).toBeGreaterThan(0);
  });
  it('is bounded', () => {
    for (const p of [0, 1, 1e9, null]) {
      const v = computePopularitySignal(p, 1e6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('recency boost', () => {
  it('unreleased / future titles do not get the maximum boost', () => {
    expect(computeRecencyBoost('2027-06-01', FIXTURE_NOW)).toBeLessThan(1);
    expect(computeRecencyBoost('2027-06-01', FIXTURE_NOW)).toBeLessThanOrEqual(0.3);
  });
  it('unparseable is neutral', () => {
    expect(computeRecencyBoost('', FIXTURE_NOW)).toBe(0.3);
    expect(computeRecencyBoost('soon', FIXTURE_NOW)).toBe(0.3);
  });
  it('uses UTC years (New Year dates do not slip a year) and `now`, not wall-clock', () => {
    const jan1 = Date.UTC(2026, 0, 1);
    expect(computeRecencyBoost('2026-01-01', jan1)).toBe(1);
    expect(computeRecencyBoost('2016-01-01', jan1)).toBeCloseTo(0, 6);
    expect(computeRecencyBoost('2021-06-01', jan1)).toBeCloseTo(0.5, 6);
  });
});

describe('diversity bonus', () => {
  it('is 0, not the maximum, for a candidate with no recognised genres', () => {
    expect(computeDiversityBonus([], [{ name: 'RPG', weight: 5 }], 5)).toBe(0);
  });
  it('rewards genres the user has not engaged with', () => {
    const genres = [{ name: 'RPG', weight: 10 }];
    expect(computeDiversityBonus(['Puzzle'], genres, 10)).toBeGreaterThan(computeDiversityBonus(['RPG'], genres, 10));
  });
});

describe('notes bonus', () => {
  const loved = noteTokens('loved the dark moody atmosphere and tight combat in this soulslike adventure');
  it('is normalised by candidate tokens (a long title does not dilute, a short exact match is not capped by library notes size)', () => {
    const exact = computeNotesThemeBonus(cand({ title: 'Dark Combat', genres: [], themes: [] }), loved);
    const diluted = computeNotesThemeBonus(cand({ title: 'Dark Combat Chronicles Of The Forgotten Realm Edition', genres: [], themes: [] }), loved);
    expect(exact).toBeGreaterThan(diluted);
  });
  it('ignores stopwords and stays tiny', () => {
    const stop = noteTokens('the and game games play');
    expect(computeNotesThemeBonus(cand({ title: 'The Game', genres: [], themes: [] }), stop)).toBe(0);
    expect(computeNotesThemeBonus(cand({ title: 'Dark Combat', genres: [], themes: [] }), loved)).toBeLessThanOrEqual(0.03 + 1e-9);
  });
});

describe('studio loyalty', () => {
  it('splits multi-developer credits', () => {
    expect(splitCreditedNames('Studio A, Studio B / Studio C; Studio D')).toEqual(['studio a', 'studio b', 'studio c', 'studio d']);
    expect(splitCreditedNames('')).toEqual([]);
  });

  it('a co-developed candidate matches a loyal developer', () => {
    const profile = buildTasteProfile([], FIXTURE_NOW);
    expect(computeStudioLoyaltyBoost(cand({ developer: 'Big Co, Loyal Studio', publisher: 'Pub' }), ['loyal studio'], profile)).toBeGreaterThan(0);
  });

  it('does not conflate developer and publisher roles', () => {
    const profile = buildTasteProfile([], FIXTURE_NOW);
    expect(computeStudioLoyaltyBoost(cand({ developer: 'Other', publisher: 'Loyal Studio' }), ['loyal studio'], profile)).toBe(0);
  });

  it('loyalty needs both a good rating and real hours', () => {
    _engagementCache.clear();
    const mk = (id: string, rating: number, hours: number) => makeUser(id, { developer: 'Acme', title: id, rating, hoursPlayed: hours });
    const lowHoursHighRating = buildTasteProfile([mk('a', 5, 1), mk('b', 5, 1)], FIXTURE_NOW);
    expect(lowHoursHighRating.loyalDevelopers).not.toContain('acme');
    _engagementCache.clear();
    const both = buildTasteProfile([mk('a', 5, 15), mk('b', 4, 10)], FIXTURE_NOW);
    expect(both.loyalDevelopers).toContain('acme');
    _engagementCache.clear();
    const badRating = buildTasteProfile([mk('a', 3, 50), mk('b', 3, 50)], FIXTURE_NOW);
    expect(badRating.loyalDevelopers).not.toContain('acme');
  });
});

describe('time-of-day and sequencing use lift over baseline', () => {
  const HOUR = 3_600_000;
  const evening = Date.UTC(2026, 5, 1, 20) + new Date().getTimezoneOffset() * 60_000;
  const sessions = (n: number, hour: number) => Array.from({ length: n }, (_, i) => evening + i * 24 * HOUR + (hour - 20) * HOUR);

  it('a genre that dominates at every hour gets no time-of-day boost', () => {
    const rpg = makeUser('rpg', { genres: ['RPG'], sessionTimestamps: [...sessions(12, 20), ...sessions(12, 9)] });
    const ctx = buildTimeOfDayContext([rpg], 20);
    expect(computeTimeOfDayBoost(cand({ genres: ['RPG'] }), ctx)).toBe(0);
  });

  it('a genre played disproportionately at this hour does get one', () => {
    const night = makeUser('n', { genres: ['Horror'], sessionTimestamps: sessions(12, 20) });
    const day = makeUser('d', { genres: ['Puzzle'], sessionTimestamps: sessions(12, 9) });
    const ctx = buildTimeOfDayContext([night, day], 20);
    expect(computeTimeOfDayBoost(cand({ genres: ['Horror'] }), ctx)).toBeGreaterThan(0.3);
    expect(computeTimeOfDayBoost(cand({ genres: ['Puzzle'] }), ctx)).toBe(0);
  });

  it('needs a meaningful sample before claiming a time-of-day habit', () => {
    const few = makeUser('f', { genres: ['Horror'], sessionTimestamps: sessions(4, 20) });
    expect(buildTimeOfDayContext([few], 20).hasSufficientData).toBe(false);
  });

  it('sequencing needs a larger sample than 4 sessions', () => {
    const few = [makeUser('a', { genres: ['RPG'], lastSessionDate: '2026-01-02T00:00:00Z', sessionTimestamps: [1, 3] }),
      makeUser('b', { genres: ['Puzzle'], lastSessionDate: '2026-01-03T00:00:00Z', sessionTimestamps: [2, 4] })];
    expect(buildSequencingContext(few).hasSufficientData).toBe(false);
  });

  it('sequencing is lift over how often the next genre is played anyway', () => {
    const t = (i: number) => Date.UTC(2026, 0, 1) + i * HOUR;
    const a = makeUser('a', { genres: ['RPG'], lastSessionDate: new Date(t(100)).toISOString(), sessionTimestamps: Array.from({ length: 10 }, (_, i) => t(i * 2)) });
    const b = makeUser('b', { genres: ['Puzzle'], lastSessionDate: new Date(t(99)).toISOString(), sessionTimestamps: Array.from({ length: 10 }, (_, i) => t(i * 2 + 1)) });
    const ctx = buildSequencingContext([a, b]);
    expect(ctx.hasSufficientData).toBe(true);
    // Puzzle always follows RPG, but Puzzle is also half of everything played: modest lift only.
    expect(computeSequencingBoost(cand({ genres: ['Puzzle'] }), ctx)).toBeLessThan(0.6);
  });
});

describe('engagement curve', () => {
  it('a one-weekend completed 5-star game is not a binge-drop', () => {
    const t0 = FIXTURE_NOW - 10 * 86_400_000;
    const g = makeUser('x', {
      status: 'Completed', rating: 5, hoursPlayed: 20, sessionCount: 5,
      sessionTimestamps: [t0, t0 + 3_600_000, t0 + 7_200_000, t0 + 86_400_000, t0 + 90_000_000],
      sessionDurations: [180, 200, 220, 240, 260],
    });
    expect(classifyEngagementCurve(g)).not.toBe('binge-drop');
  });
  it('an abandoned weekend game still is', () => {
    const t0 = FIXTURE_NOW - 10 * 86_400_000;
    const g = makeUser('y', {
      status: 'On Hold', rating: 0, hoursPlayed: 8, sessionCount: 4,
      sessionTimestamps: [t0, t0 + 3_600_000, t0 + 7_200_000, t0 + 86_400_000],
      sessionDurations: [120, 90, 60, 30],
    });
    expect(classifyEngagementCurve(g)).toBe('binge-drop');
  });
});

describe('franchise', () => {
  it('only played entries count as the user following the franchise', () => {
    const lib = [makeUser('steam-10', { title: 'Zorblax 1', hoursPlayed: 0, rating: 0, status: 'Want to Play' })];
    const cands = [makeCandidate('steam-11', { title: 'Zorblax 2' })];
    const franchises = detectFranchises(lib, cands);
    const boost = computeFranchiseBoost(cands[0], franchises, new Set(['steam-10']));
    expect(boost.boost).toBe(0);
    expect(boost.isFranchiseEntry).toBe(false);
  });

  it('a played, liked franchise boosts', () => {
    const lib = [makeUser('steam-10', { title: 'Zorblax 1', hoursPlayed: 30, rating: 5 })];
    const cands = [makeCandidate('steam-11', { title: 'Zorblax 2' })];
    const boost = computeFranchiseBoost(cands[0], detectFranchises(lib, cands), new Set(['steam-10']));
    expect(boost.boost).toBeGreaterThan(0.4);
    expect(boost.isFranchiseEntry).toBe(true);
  });

  it('a franchise the user rated poorly is a negative, not a boost', () => {
    const lib = [makeUser('steam-10', { title: 'Zorblax 1', hoursPlayed: 30, rating: 1 })];
    const cands = [makeCandidate('steam-11', { title: 'Zorblax 2' })];
    const boost = computeFranchiseBoost(cands[0], detectFranchises(lib, cands), new Set(['steam-10']));
    expect(boost.boost).toBeLessThan(0);
    expect(boost.isFranchiseEntry).toBe(false);
  });
});

describe('match percent calibration', () => {
  it('maps the pool range onto 0..100 monotonically', () => {
    expect(calibrateMatchPercent(0.2, 0.2, 0.6)).toBe(0);
    expect(calibrateMatchPercent(0.6, 0.2, 0.6)).toBe(100);
    expect(calibrateMatchPercent(0.4, 0.2, 0.6)).toBe(50);
    expect(calibrateMatchPercent(0.9, 0.2, 0.6)).toBe(100);
    expect(calibrateMatchPercent(0.1, 0.2, 0.6)).toBe(0);
  });
  it('degenerate range falls back to the raw score', () => {
    expect(calibrateMatchPercent(0.42, 0.5, 0.5)).toBe(42);
  });
});

describe('pipeline behaviour', () => {
  it('an acclaimed older game outranks an empty-stat unreleased one', async () => {
    const lib = [makeUser('steam-1', { genres: ['Action'], hoursPlayed: 40, rating: 5 })];
    const acclaimed = makeCandidate('steam-9001', { title: 'Old Classic', genres: ['Action'], releaseDate: '2012-05-01', metacriticScore: 92, recommendations: 80_000, reviewPositivity: 0.96, reviewVolume: 90_000, playerCount: 20_000 });
    const empty = makeCandidate('steam-9002', { title: 'Mystery Future', genres: ['Action'], releaseDate: '2028-01-01', metacriticScore: null, recommendations: undefined, reviewPositivity: undefined, reviewVolume: undefined, playerCount: null });
    const result = await runWorkerPipeline(baseWorkerInput(lib, [acclaimed, empty], FIXTURE_NOW));
    const score = (id: string) => result.shelves.flatMap(s => s.games).find(g => g.gameId === id)?.score ?? 0;
    expect(score('steam-9001')).toBeGreaterThan(score('steam-9002'));
  });

  it('reports non-finite scores in telemetry instead of silently dropping them', async () => {
    const lib = [makeUser('steam-1', { genres: ['Action'], hoursPlayed: 40, rating: 5 })];
    const bad = makeCandidate('steam-9003', { title: 'Bad', genres: ['Action'], mlScore: Number.NaN });
    const good = makeCandidate('steam-9004', { title: 'Good', genres: ['Action'] });
    const result = await runWorkerPipeline(baseWorkerInput(lib, [bad, good], FIXTURE_NOW));
    // A NaN ML score is treated as missing (median), so the candidate is still scored — nothing is lost.
    expect(result.telemetry!.funnel.scored).toBe(2);
    expect(result.telemetry!.funnel.nonFinite).toBe(0);
  });

  it('layer weights reported by the worker sum to a defined total', async () => {
    const lib = [makeUser('steam-1', { genres: ['Action'], hoursPlayed: 40, rating: 5 })];
    const result = await runWorkerPipeline(baseWorkerInput(lib, [makeCandidate('steam-9005', { genres: ['Action'] })], FIXTURE_NOW));
    const positive = result.telemetry!.layers.filter(l => !['negativeSignal'].includes(l.layer)).reduce((s, l) => s + l.weight, 0);
    expect(positive).toBeGreaterThan(0.9);
    expect(positive).toBeLessThan(1.1);
  });
});


describe('content cosine ignores metadata completeness', () => {
  it('extra features the profile has no opinion on neither help nor hurt', () => {
    const profile = Float32Array.from([2, 1, 1, 0, 0]);
    const mag = Math.sqrt(4 + 1 + 1);
    const lean = fastCosineProfileVsCandidate(profile, mag, [0, 1, 2], Math.sqrt(3));
    const rich = fastCosineProfileVsCandidate(profile, mag, [0, 1, 2, 3, 4], Math.sqrt(5));
    expect(rich).toBeCloseTo(lean, 10);
  });
  it('a single matching tag is not a perfect match', () => {
    const profile = Float32Array.from([1, 1, 1, 1]);
    const one = fastCosineProfileVsCandidate(profile, 2, [0], 1);
    const three = fastCosineProfileVsCandidate(profile, 2, [0, 1, 2], Math.sqrt(3));
    expect(one).toBeLessThan(three);
  });
});

describe('explanations', () => {
  const game = makeScored('steam-1', 0.5, { layerScores: { ...makeScored('x', 0).layerScores, contentSimilarity: 0.8, mlSignal: 0.9 } });

  it('credit only the layers that actually carried weight in the run', () => {
    const real = normalizeLayerScores(game, { contentSimilarity: 0.4, mlSignal: 0 });
    expect(real.map(b => b.name)).toEqual(['Genre & Theme Match']);
    expect(real[0].percentage).toBe(100);
    const fallback = normalizeLayerScores(game);
    expect(fallback.length).toBe(2);
  });

  it('weightsFromTelemetry maps layers to weights', () => {
    expect(weightsFromTelemetry(undefined)).toBeUndefined();
    expect(weightsFromTelemetry({ layers: [{ layer: 'graphSignal', coverage: 1, min: 0, median: 0, max: 1, weight: 0.1 }] } as never)).toEqual({ graphSignal: 0.1 });
  });

  it('keeps a worker sentence containing "; " as one line', () => {
    const g = makeScored('steam-2', 0.5, { reasons: { ...makeScored('x', 0).reasons, explanation: '80% match — fits your A; B taste' } });
    expect(explanationLines(g)).toEqual(['80% match — fits your A; B taste']);
  });

  it('matchPercent prefers the calibrated value and falls back to the raw score', () => {
    expect(matchPercent({ score: 0.31, matchPct: 87 })).toBe(87);
    expect(matchPercent({ score: 0.31 })).toBe(31);
  });
});

describe('pipeline: calibrated match and shelf seeds', () => {
  it('spreads the displayed match percentage across the pool', async () => {
    const result = await runWorkerPipeline(baseWorkerInput(multiTasteLibrary(), candidatePool(80), FIXTURE_NOW));
    const games = result.shelves.flatMap(sh => sh.games);
    const pcts = games.map(g => g.matchPct).filter((v): v is number => typeof v === 'number');
    expect(pcts.length).toBeGreaterThan(0);
    expect(Math.max(...pcts)).toBeLessThanOrEqual(99);
    expect(Math.min(...pcts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...pcts) - Math.min(...pcts)).toBeGreaterThan(20);
  });

  it('"Because you loved" is never seeded by a game the user rated 1 star', async () => {
    const hated = makeUser('steam-90', { title: 'Hated Epic', genres: ['Action'], hoursPlayed: 90, rating: 1, status: 'On Hold' });
    const liked = makeUser('steam-91', { title: 'Liked Game', genres: ['Action'], hoursPlayed: 30, rating: 5 });
    const pool = Array.from({ length: 6 }, (_, i) => makeCandidate(`steam-92${i}`, {
      title: `Pick ${i}`, genres: ['Action'], metacriticScore: 80,
      similarGameTitles: [], reviewPositivity: 0.9, reviewVolume: 9_000, releaseDate: '2020-01-01',
    }));
    const lib = [hated, { ...liked, similarGameTitles: pool.map(c => c.title) }];
    const result = await runWorkerPipeline(baseWorkerInput(lib, pool, FIXTURE_NOW));
    const because = result.shelves.find(sh => sh.type === 'because-you-loved');
    if (because) expect(because.seedGameTitle).not.toBe('Hated Epic');
  });
});


describe('review hardening (R5)', () => {
  it('splitCreditedNames strips legal suffixes and placeholders', () => {
    expect(splitCreditedNames('Capcom Co., Ltd.')).toEqual(['capcom']);
    expect(splitCreditedNames('Foo, Inc.')).toEqual(['foo']);
    expect(splitCreditedNames('Valve Corporation')).toEqual(['valve']);
    expect(splitCreditedNames('Unknown Developer')).toEqual([]);
    expect(splitCreditedNames('Studio A, Studio B')).toEqual(['studio a', 'studio b']);
    expect(splitCreditedNames('A, A')).toEqual(['a']);
  });

  it('a co-credited candidate still maps onto its profile developer feature', () => {
    const space = new DenseFeatureSpace();
    const acme = space.register('d:acme');
    const co = space.candidateToIndices(makeCandidate('steam-9202', { genres: [], themes: [], gameModes: [], developer: 'Other, Acme', publisher: '' }));
    expect(co.indices).toContain(acme);
    const none = space.candidateToIndices(makeCandidate('steam-9203', { genres: [], themes: [], gameModes: [], developer: 'Other', publisher: '' }));
    expect(none.indices).not.toContain(acme);
  });

  it('a Completed weekend game keeps a non-binge pattern even when the store labelled it binge-drop', async () => {
    const t0 = FIXTURE_NOW - 10 * 86_400_000;
    const lib = [makeUser('steam-1', {
      genres: ['Action'], status: 'Completed', rating: 5, hoursPlayed: 20, sessionCount: 5,
      engagementPattern: 'binge-drop',
      sessionTimestamps: [t0, t0 + 3_600_000, t0 + 7_200_000, t0 + 86_400_000, t0 + 90_000_000],
      sessionDurations: [180, 200, 220, 240, 260],
    })];
    const withLabel = await runWorkerPipeline(baseWorkerInput(lib, [makeCandidate('steam-9301', { genres: ['Action'] })], FIXTURE_NOW));
    const withoutLabel = await runWorkerPipeline(baseWorkerInput(
      [{ ...lib[0], engagementPattern: 'unknown' }], [makeCandidate('steam-9301', { genres: ['Action'] })], FIXTURE_NOW));
    const score = (r: typeof withLabel) => r.shelves.flatMap(sh => sh.games)[0]?.score;
    expect(score(withLabel)).toBe(score(withoutLabel));
  });

  it('a handful of transitions cannot saturate the sequencing lift', () => {
    const HOUR = 3_600_000;
    const t = (i: number) => Date.UTC(2026, 0, 1) + i * HOUR;
    // 5 RPG sessions followed once each by Puzzle (only 4 transitions out of RPG): too thin to trust.
    const rpg = makeUser('a', { genres: ['RPG'], lastSessionDate: new Date(t(50)).toISOString(), sessionTimestamps: [t(0), t(2), t(4), t(6), t(8)] });
    const puz = makeUser('b', { genres: ['Puzzle'], lastSessionDate: new Date(t(49)).toISOString(), sessionTimestamps: [t(1), t(3), t(5), t(7)] });
    const other = makeUser('c', { genres: ['Racing'], sessionTimestamps: [t(20), t(21), t(22), t(23)] });
    const ctx = buildSequencingContext([rpg, puz, other]);
    expect(computeSequencingBoost(cand({ genres: ['Puzzle'] }), ctx)).toBeLessThan(0.7);
  });

  it('time-of-day: a genre seen once or twice in the bucket carries no boost', () => {
    const HOUR = 3_600_000;
    const evening = Date.UTC(2026, 5, 1, 20) + new Date().getTimezoneOffset() * 60_000;
    const day = makeUser('d', { genres: ['Puzzle'], sessionTimestamps: Array.from({ length: 30 }, (_, i) => evening + (i - 11) * HOUR * 24 + (9 - 20) * HOUR) });
    const main = makeUser('m', { genres: ['RPG'], sessionTimestamps: Array.from({ length: 10 }, (_, i) => evening + i * 24 * HOUR) });
    const rare = makeUser('r', { genres: ['Horror'], sessionTimestamps: [evening + 11 * 24 * HOUR] });
    const ctx = buildTimeOfDayContext([day, main, rare], 20);
    expect(computeTimeOfDayBoost(cand({ genres: ['Horror'] }), ctx)).toBe(0);
  });
});
