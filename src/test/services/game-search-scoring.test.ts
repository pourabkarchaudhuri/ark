import { describe, it, expect } from 'vitest';
import {
  scoreGame,
  buildSingleSearchIndex,
  normalizeSearchText,
  compareBrowseSearchZeroScore,
} from '@/services/game-search-scoring';
import type { Game } from '@/types/game';

function game(overrides: Partial<Game> & { id: string; title: string }): Game {
  return {
    store: 'steam',
    developer: 'Dev',
    publisher: 'Pub',
    genre: [],
    metacriticScore: null,
    platform: ['PC'],
    status: 'Want to Play',
    priority: 'Medium',
    publicReviews: '',
    recommendationSource: '',
    releaseDate: '2024-01-01',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('scoreGame', () => {
  it('exact title scores highest tier', () => {
    const g = game({ id: '1', title: 'Hades' });
    const idx = buildSingleSearchIndex(g);
    expect(scoreGame(idx, ['hades'], 'hades', g)).toBeGreaterThanOrEqual(200);
  });

  it('title prefix scores above metadata-only', () => {
    const g = game({ id: '1', title: 'Hades II', developer: 'Warner Bros', genre: ['Action'] });
    const idx = buildSingleSearchIndex(g);
    const prefix = scoreGame(idx, ['had'], 'had', g);
    expect(prefix).toBeGreaterThanOrEqual(100);
  });

  it('metadata-only match stays in low tier', () => {
    const g = game({
      id: '1',
      title: 'Totally Unrelated Name',
      developer: 'Warner Bros Interactive',
      publisher: 'Pub',
      genre: ['Simulation'],
    });
    const idx = buildSingleSearchIndex(g);
    const s = scoreGame(idx, ['war'], 'war', g);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(25);
  });

  it('word-boundary multi-token beats dev substring noise', () => {
    const good = game({ id: '1', title: 'Dark Souls', developer: 'FromSoftware' });
    const noise = game({
      id: '2',
      title: 'Other Game',
      developer: 'Warner Bros',
      publisher: 'Pub',
      genre: ['Action'],
    });
    const q = 'dark souls';
    const tokens = q.split(/\s+/).filter(Boolean);
    const sGood = scoreGame(buildSingleSearchIndex(good), tokens, q, good);
    const sNoise = scoreGame(buildSingleSearchIndex(noise), tokens, q, noise);
    expect(sGood).toBeGreaterThan(sNoise);
    expect(sGood).toBeGreaterThanOrEqual(60);
  });

  it('disables shorthand when allowShorthand is false (library mode)', () => {
    const g = game({ id: '1', title: 'Red Dead Redemption 2' });
    const idx = buildSingleSearchIndex(g);
    const withSh = scoreGame(idx, ['rdr2'], 'rdr2', g, { allowShorthand: true });
    const noSh = scoreGame(idx, ['rdr2'], 'rdr2', g, { allowShorthand: false });
    expect(withSh).toBeGreaterThan(0);
    expect(noSh).toBe(0);
  });

  it('short genre tokens do not match via substring in unrelated genre words', () => {
    const g = game({ id: '1', title: 'ZZZ Obscure', genre: ['Party'] });
    const idx = buildSingleSearchIndex(g);
    const s = scoreGame(idx, ['art'], 'art', g);
    expect(s).toBe(0);
  });

  it('matches RPG via short genre alias when title does not contain token', () => {
    const g = game({ id: '1', title: 'Fantasy Quest', genre: ['RPG'] });
    const idx = buildSingleSearchIndex(g);
    const s = scoreGame(idx, ['rpg'], 'rpg', g);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(30);
  });

  it('normalizes punctuation for title equivalence', () => {
    const g = game({ id: '1', title: 'Hades™' });
    const idx = buildSingleSearchIndex(g);
    expect(normalizeSearchText(g.title)).toBe('hades');
    expect(scoreGame(idx, ['hades'], 'hades', g)).toBeGreaterThanOrEqual(200);
  });

  it('does not use loose subsequence shorthand for vowel-heavy tokens (no title match)', () => {
    const g = game({ id: '1', title: 'Dead Reckoning' });
    const idx = buildSingleSearchIndex(g);
    expect(scoreGame(idx, ['dark'], 'dark', g, { allowShorthand: true })).toBe(0);
  });
});

describe('compareBrowseSearchZeroScore', () => {
  it('orders by lower searchResultRank when no normalized hit', () => {
    const first = game({ id: '1', title: 'A', searchResultRank: 1 });
    const second = game({ id: '2', title: 'B', searchResultRank: 9 });
    expect(compareBrowseSearchZeroScore(first, second, 'zzz')).toBeLessThan(0);
  });
});
