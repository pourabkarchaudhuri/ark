import { describe, it, expect, beforeEach } from 'vitest';
import { recoHistoryStore } from '@/services/reco-history-store';
import { fingerprintThumbsUp } from '@/services/oracle-signature';
import { buildPositiveProfile } from '@/services/reco-feedback-profiles';
import type { CandidateGame, UserGameSnapshot } from '@/types/reco';

function stubCandidate(partial: Partial<CandidateGame> & { gameId: string; title: string }): CandidateGame {
  return {
    developer: '',
    publisher: '',
    genres: [],
    themes: [],
    gameModes: [],
    perspectives: [],
    platforms: [],
    metacriticScore: null,
    playerCount: null,
    releaseDate: '2020-01-01',
    similarGameTitles: [],
    ...partial,
  };
}

function stubUser(gameId: string): UserGameSnapshot {
  return {
    gameId,
    title: gameId,
    status: 'Completed',
    rating: 5,
    hoursPlayed: 10,
    genres: ['Action'],
    themes: [],
    gameModes: [],
    perspectives: [],
    developer: '',
    publisher: '',
    releaseDate: '2020-01-01',
    addedAt: new Date().toISOString(),
    statusTrajectory: ['Completed'],
    sessionCount: 0,
    avgSessionMinutes: 0,
    lastSessionDate: null,
    activeToIdleRatio: 0,
    similarGameTitles: [],
    sessionTimestamps: [],
    sessionDurations: [],
    engagementPattern: 'unknown',
  };
}

describe('getThumbsUpIds', () => {
  beforeEach(() => {
    localStorage.clear();
    recoHistoryStore.reset();
  });

  it('returns only game ids with thumbs === 1', () => {
    recoHistoryStore.recordThumbs('steam-up-1', 1, 'Liked');
    recoHistoryStore.recordThumbs('steam-up-2', 1, 'Also Liked');
    recoHistoryStore.recordThumbs('steam-down-1', -1, 'Nope');

    const ups = recoHistoryStore.getThumbsUpIds();
    expect(ups.sort()).toEqual(['steam-up-1', 'steam-up-2']);
    expect(ups).not.toContain('steam-down-1');
  });

  it('returns empty when no thumbs-up recorded', () => {
    recoHistoryStore.recordThumbs('steam-down-1', -1, 'Nope');
    expect(recoHistoryStore.getThumbsUpIds()).toEqual([]);
  });
});

describe('fingerprintThumbsUp', () => {
  it('changes when thumbs-up set changes', () => {
    const a = fingerprintThumbsUp(['steam-1']);
    const b = fingerprintThumbsUp(['steam-1', 'steam-2']);
    const c = fingerprintThumbsUp(['steam-1']);
    expect(b).not.toBe(a);
    expect(c).toBe(a);
  });

  it('is order-independent', () => {
    expect(fingerprintThumbsUp(['b', 'a'])).toBe(fingerprintThumbsUp(['a', 'b']));
  });
});

describe('buildPositiveProfile', () => {
  it('boosts candidates that share genres/themes with thumbs-up games', () => {
    const thumbsUp = [
      stubCandidate({
        gameId: 'liked-1',
        title: 'Liked Action RPG',
        genres: ['Action', 'RPG'],
        themes: ['Fantasy'],
        developer: 'Supergiant',
      }),
    ];
    const profile = buildPositiveProfile([stubUser('lib-1')], thumbsUp);
    expect(profile.strength).toBeGreaterThan(0);

    const matching = stubCandidate({
      gameId: 'cand-match',
      title: 'Another Action RPG',
      genres: ['Action', 'RPG'],
      themes: ['Fantasy'],
      developer: 'Supergiant',
    });
    const mismatch = stubCandidate({
      gameId: 'cand-miss',
      title: 'Sports Sim',
      genres: ['Sports'],
      themes: ['Modern'],
      developer: 'EA',
    });

    const matchScore = scoreAgainstProfile(profile.vec, matching);
    const missScore = scoreAgainstProfile(profile.vec, mismatch);
    expect(matchScore).toBeGreaterThan(missScore);
    expect(matchScore).toBeGreaterThan(0);
  });

  it('returns zero strength with no thumbs-up candidates', () => {
    const profile = buildPositiveProfile([stubUser('lib-1')], []);
    expect(profile.strength).toBe(0);
    expect(profile.vec.size).toBe(0);
  });
});

/** Cosine-ish overlap for test: sum of shared feature weights. */
function scoreAgainstProfile(
  vec: Map<string, number>,
  c: CandidateGame,
): number {
  let sum = 0;
  for (const g of c.genres) {
    const v = vec.get(`g:${g.toLowerCase().trim()}`);
    if (v) sum += v;
  }
  for (const t of c.themes) {
    const v = vec.get(`t:${t.toLowerCase().trim()}`);
    if (v) sum += v;
  }
  if (c.developer) {
    const v = vec.get(`d:${c.developer.toLowerCase().trim()}`);
    if (v) sum += v;
  }
  return sum;
}
