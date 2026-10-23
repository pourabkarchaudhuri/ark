import { describe, it, expect } from 'vitest';
import {
  N_FEATURES,
  buildFeatureVector,
  buildUserProfileFromGames,
  isEvidenceGame,
  type GameProfile,
} from '../../../electron/ml-features';
import { median, modeShare, percentileRanks } from '@/services/ml-normalize';

const SPEC = {
  globalRecRate: 0.85,
  smoothM: 10,
  defaults: {
    log_hours: 3.0, price_norm: 0.33, discount: 0, win: 1, mac: 0, linux: 0, steam_deck: 0,
    log_helpful: 0, log_funny: 0, review_year: 0.67, review_month: 0.5, positive_ratio_norm: 0.75,
    log_game_reviews: 7, review_age_days: 0.1, game_age_days: 0.3, hours_per_game_age: 10,
    u_avg_hours: 3, u_std_hours: 1.5, u_avg_helpful: 0.3, u_avg_funny: 0.1, u_pct_high_hours: 0.3,
    g_rec_rate: 0.85, g_avg_hours: 3, g_std_hours: 1.5, g_n_reviews: 7, g_avg_helpful: 0.3,
    g_pct_high_hours: 0.3, hours_vs_game_avg: 1, helpful_vs_game: 1,
  } as Record<string, number>,
};

const g = (over: Partial<{ gameId: string; hoursPlayed: number; rating: number; status: string }> = {}) => ({
  gameId: 'steam-1', hoursPlayed: 0, rating: 0, status: 'Want to Play', ...over,
});

describe('buildUserProfileFromGames', () => {
  it('does not count the unplayed backlog as dislikes', () => {
    const backlog = Array.from({ length: 200 }, (_, i) => g({ gameId: `steam-${i}` }));
    const played = [
      g({ gameId: 'steam-a', hoursPlayed: 40, rating: 5, status: 'Completed' }),
      g({ gameId: 'steam-b', hoursPlayed: 12, rating: 4, status: 'Playing' }),
      g({ gameId: 'steam-c', hoursPlayed: 8, rating: 4, status: 'Completed' }),
    ];
    const p = buildUserProfileFromGames([...backlog, ...played], SPEC);
    // 3/3 positive evidence smoothed by the prior; the old code gave ~0.02 weight to evidence (3/203).
    expect(p.u_rec_rate).toBeGreaterThan(0.85);
    expect(p.u_n_reviews).toBeCloseTo(Math.log1p(3), 6);
  });

  it('low ratings pull the rate down', () => {
    const games = Array.from({ length: 12 }, (_, i) => g({ gameId: `steam-${i}`, hoursPlayed: 5, rating: 1 }));
    expect(buildUserProfileFromGames(games, SPEC).u_rec_rate).toBeLessThan(0.5);
  });

  it('thin evidence stays near the neutral prior', () => {
    const p = buildUserProfileFromGames([g({ hoursPlayed: 2, rating: 5 })], SPEC);
    expect(Math.abs(p.u_rec_rate - 0.85)).toBeLessThan(0.1);
    expect(p.u_avg_hours).toBe(3); // < 3 played games: keep default
  });

  it('hours stats use played games only', () => {
    const backlog = Array.from({ length: 100 }, (_, i) => g({ gameId: `steam-${i}` }));
    const played = [10, 20, 30, 40].map((h, i) => g({ gameId: `steam-p${i}`, hoursPlayed: h, rating: 4 }));
    const p = buildUserProfileFromGames([...backlog, ...played], SPEC);
    expect(p.u_avg_hours).toBeGreaterThan(2.5);
    expect(p.u_pct_high_hours).toBe(0.5);
  });

  it('uses trained defaults for helpful/funny instead of 0', () => {
    const p = buildUserProfileFromGames([g({ hoursPlayed: 5, rating: 4 })], SPEC);
    expect(p.u_avg_helpful).toBe(0.3);
    expect(p.u_avg_funny).toBe(0.1);
  });

  it('empty library is neutral', () => {
    const p = buildUserProfileFromGames([], SPEC);
    expect(p.u_rec_rate).toBe(0.85);
    expect(p.u_n_reviews).toBe(0);
  });

  it('isEvidenceGame', () => {
    expect(isEvidenceGame(g())).toBe(false);
    expect(isEvidenceGame(g({ rating: 2 }))).toBe(true);
    expect(isEvidenceGame(g({ hoursPlayed: 3 }))).toBe(true);
    expect(isEvidenceGame(g({ status: 'Completed' }))).toBe(true);
  });
});

describe('buildFeatureVector consistency', () => {
  const user = buildUserProfileFromGames(
    [10, 20, 30, 40].map((h, i) => g({ gameId: `steam-p${i}`, hoursPlayed: h, rating: 4 })),
    SPEC,
  );
  const profile: GameProfile = {
    g_rec_rate: 0.9, g_avg_hours: 3.5, g_std_hours: 1.2, g_n_reviews: 8, g_avg_helpful: 0.4,
    g_pct_high_hours: 0.4, positive_ratio: 92, tags: [0, 5, 199],
  };

  it('has the right length and sets tag indices', () => {
    const v = buildFeatureVector(user, profile, SPEC.defaults);
    expect(v.length).toBe(N_FEATURES);
    expect(v[42]).toBe(1);
    expect(v[47]).toBe(1);
    expect(v[241]).toBe(1);
  });

  it('hypothetical review hours equal the user typical hours, so user-relative features are neutral', () => {
    const v = buildFeatureVector(user, profile, SPEC.defaults);
    expect(v[0]).toBeCloseTo(user.u_avg_hours, 6);
    expect(v[31]).toBe(1);
    expect(v[35]).toBe(0);
    expect(v[36]).toBe(0);
  });

  it('game-relative features derive from the same hours', () => {
    const v = buildFeatureVector(user, profile, SPEC.defaults);
    expect(v[34]).toBeCloseTo(user.u_avg_hours - 3.5, 6);
    expect(v[37]).toBeCloseTo((user.u_avg_hours - 3.5) / 1.2, 6);
    expect(v[38]).toBeCloseTo(user.u_avg_hours * 0.92, 6);
    expect(v[33]).toBe(user.u_avg_hours > 3.5 ? 1 : 0);
  });

  it('review_year stays inside the trained range', () => {
    const v = buildFeatureVector(user, undefined, { ...SPEC.defaults, review_year: 5 });
    expect(v[11]).toBeLessThanOrEqual(1);
  });

  it('missing game profile falls back to defaults without NaN', () => {
    const v = buildFeatureVector(user, undefined, SPEC.defaults);
    expect(Array.from(v).every(Number.isFinite)).toBe(true);
  });
});

describe('ml-normalize', () => {
  it('percentileRanks spreads a narrow band over [0,1]', () => {
    const r = percentileRanks([0.85, 0.9, 0.87, 0.95]);
    expect(r).toEqual([0, 2 / 3, 1 / 3, 1]);
  });
  it('ties share an average rank', () => {
    expect(percentileRanks([1, 1, 2])).toEqual([0.25, 0.25, 1]);
  });
  it('degenerate inputs', () => {
    expect(percentileRanks([])).toEqual([]);
    expect(percentileRanks([0.9])).toEqual([0.5]);
  });
  it('median and modeShare', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
    expect(modeShare([1, 1, 1, 2])).toBe(0.75);
  });
});
