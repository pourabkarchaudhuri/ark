/**
 * Shared Oracle test fixtures (v1.0.75).
 *
 * Builders for the worker's input types plus three archetype libraries used
 * to compare engine behavior across releases:
 *   - backlogHeavyLibrary: 300 games, mostly Want-to-Play / 0h (ML + taste stress test)
 *   - multiTasteLibrary:   cozy + soulslike + 4X, plus removed / 1-star games
 *   - newUserLibrary:      2 games (cold-start path)
 * and a varied candidate pool.
 */
import type { CandidateGame, ScoredGame, UserGameSnapshot } from '@/types/reco';

const DAY = 24 * 60 * 60 * 1000;
export const FIXTURE_NOW = Date.UTC(2026, 9, 1);

export function makeUser(gameId: string, over: Partial<UserGameSnapshot> = {}): UserGameSnapshot {
  return {
    gameId,
    title: over.title ?? gameId,
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    developer: '',
    publisher: '',
    releaseDate: '2020-01-01',
    status: 'Completed',
    hoursPlayed: 10,
    rating: 4,
    addedAt: new Date(FIXTURE_NOW - 90 * DAY).toISOString(),
    sessionCount: 0,
    avgSessionMinutes: 0,
    lastSessionDate: null,
    activeToIdleRatio: 1,
    statusTrajectory: [],
    similarGameTitles: [],
    engagementPattern: 'unknown',
    sessionTimestamps: [],
    sessionDurations: [],
    ...over,
  };
}

export function makeCandidate(gameId: string, over: Partial<CandidateGame> = {}): CandidateGame {
  return {
    gameId,
    title: over.title ?? gameId,
    developer: '',
    publisher: '',
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    platforms: ['Windows'],
    metacriticScore: null,
    playerCount: null,
    releaseDate: '2022-01-01',
    similarGameTitles: [],
    ...over,
  };
}

export function makeScored(gameId: string, score: number, over: Partial<ScoredGame> = {}): ScoredGame {
  return {
    gameId,
    title: over.title ?? gameId,
    developer: '',
    publisher: '',
    genres: ['Action'],
    themes: [],
    gameModes: [],
    platforms: ['Windows'],
    metacriticScore: null,
    playerCount: null,
    releaseDate: '2022-01-01',
    score,
    layerScores: {
      contentSimilarity: 0,
      semanticSimilarity: 0,
      clusterSemanticSim: 0,
      graphSignal: 0,
      qualitySignal: 0,
      popularitySignal: 0,
      recencyBoost: 0,
      diversityBonus: 0,
      trajectoryMultiplier: 1,
      negativeSignal: 0,
      timeOfDayBoost: 0,
      engagementCurveBonus: 0,
      franchiseBoost: 0,
      studioLoyaltyBoost: 0,
      sequencingBoost: 0,
    },
    reasons: {
      sharedGenres: [],
      sharedThemes: [],
      sharedModes: [],
      similarTo: [],
      metacriticScore: null,
      popularityRank: null,
      isHiddenGem: false,
      isStretchPick: false,
      isFranchiseEntry: false,
      isOnSale: false,
      semanticRetrieved: false,
      explanation: '',
    },
    ...over,
  };
}

/** Deterministic pseudo-random so fixtures are stable across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 300 games, mostly unplayed backlog; a handful of genuinely played favourites. */
export function backlogHeavyLibrary(): UserGameSnapshot[] {
  const rand = lcg(11);
  const genres = ['RPG', 'Strategy', 'Adventure', 'Simulation', 'Action'];
  const games: UserGameSnapshot[] = [];
  for (let i = 0; i < 300; i++) {
    const played = i < 12;
    games.push(makeUser(`steam-${1000 + i}`, {
      title: `Backlog Game ${i}`,
      genres: [genres[Math.floor(rand() * genres.length)]],
      status: played ? 'Completed' : 'Want to Play',
      hoursPlayed: played ? 20 + Math.floor(rand() * 60) : 0,
      rating: played ? 4 + Math.floor(rand() * 2) : 0,
      sessionCount: played ? 6 : 0,
    }));
  }
  return games;
}

/** Cozy farming + soulslikes + 4X, plus a removed game and a hated 80h game. */
export function multiTasteLibrary(): UserGameSnapshot[] {
  const mk = (id: string, title: string, genres: string[], themes: string[], over: Partial<UserGameSnapshot> = {}) =>
    makeUser(id, { title, genres, themes, developer: `${title} Studio`, ...over });
  return [
    mk('steam-1', 'Valley Farm', ['Simulation', 'Casual'], ['Farming', 'Relaxing'], { hoursPlayed: 120, rating: 5, status: 'Playing' }),
    mk('steam-2', 'Cozy Cafe', ['Simulation', 'Casual'], ['Relaxing'], { hoursPlayed: 60, rating: 5 }),
    mk('steam-3', 'Dark Knight Souls', ['RPG', 'Action'], ['Dark Fantasy', 'Difficult'], { hoursPlayed: 90, rating: 5 }),
    mk('steam-4', 'Ashen Blade', ['RPG', 'Action'], ['Dark Fantasy'], { hoursPlayed: 70, rating: 4 }),
    mk('steam-5', 'Empire Builder', ['Strategy'], ['4X', 'Turn-Based'], { hoursPlayed: 200, rating: 5 }),
    mk('steam-6', 'Galactic Rulers', ['Strategy'], ['4X', 'Sci-fi'], { hoursPlayed: 150, rating: 4 }),
    // Things the user rejected — must NOT shape taste positively (fixed in R4).
    mk('steam-90', 'Shooter Regret', ['Shooter', 'Action'], ['Multiplayer'], { removedAt: new Date(FIXTURE_NOW - 30 * DAY).toISOString(), hoursPlayed: 1, rating: 0, status: 'On Hold' }),
    mk('steam-91', 'Hated Live Service', ['Shooter', 'Action'], ['Multiplayer', 'Online'], { hoursPlayed: 80, rating: 1, status: 'On Hold' }),
  ];
}

export function newUserLibrary(): UserGameSnapshot[] {
  return [
    makeUser('steam-500', { title: 'First Game', genres: ['RPG'], hoursPlayed: 5, rating: 4, status: 'Playing' }),
    makeUser('steam-501', { title: 'Second Game', genres: ['Adventure'], hoursPlayed: 2, rating: 0, status: 'Want to Play' }),
  ];
}

/** A varied candidate pool (genres/quality/popularity/age differ so scores spread). */
export function candidatePool(n = 60): CandidateGame[] {
  const rand = lcg(7);
  const genreSets: string[][] = [
    ['RPG', 'Action'], ['Strategy'], ['Simulation', 'Casual'], ['Shooter', 'Action'],
    ['Adventure'], ['Puzzle'], ['Racing'], ['Sports'], ['Horror'], ['Platformer'],
  ];
  const pool: CandidateGame[] = [];
  for (let i = 0; i < n; i++) {
    const year = 2005 + Math.floor(rand() * 21);
    pool.push(makeCandidate(`steam-${7000 + i}`, {
      title: `Candidate ${i}`,
      genres: genreSets[i % genreSets.length],
      themes: i % 3 === 0 ? ['Fantasy'] : [],
      developer: `Dev ${i % 9}`,
      metacriticScore: rand() < 0.5 ? 55 + Math.floor(rand() * 40) : null,
      playerCount: rand() < 0.6 ? Math.floor(rand() * 200_000) : null,
      recommendations: rand() < 0.7 ? Math.floor(rand() * 100_000) : undefined,
      reviewPositivity: rand() < 0.7 ? 0.5 + rand() * 0.5 : undefined,
      reviewVolume: rand() < 0.7 ? Math.floor(rand() * 200_000) : undefined,
      releaseDate: `${year}-06-01`,
    }));
  }
  return pool;
}
