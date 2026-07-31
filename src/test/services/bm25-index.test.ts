/**
 * BM25 MiniSearch index — title/genre query returns expected ids from fixture docs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createEmptyBm25Index,
  addBm25Documents,
  searchBm25Index,
  type Bm25Document,
} from '@/services/bm25-index';
import { buildLexicalTasteQuery } from '@/services/oracle-rerank';
import type { TasteProfile } from '@/types/reco';

function fixtureDocs(): Bm25Document[] {
  return [
    {
      id: 'steam-100',
      title: 'Elden Ring',
      genres: 'Action RPG',
      themes: 'Fantasy Open World',
      developer: 'FromSoftware',
      publisher: 'Bandai Namco',
      shortDescription: 'A vast dark fantasy action RPG.',
    },
    {
      id: 'steam-200',
      title: 'Stardew Valley',
      genres: 'Simulation Indie',
      themes: 'Farming Relaxing',
      developer: 'ConcernedApe',
      publisher: 'ConcernedApe',
      shortDescription: 'Build the farm of your dreams.',
    },
    {
      id: 'steam-300',
      title: 'Hades',
      genres: 'Action Roguelike',
      themes: 'Mythology',
      developer: 'Supergiant Games',
      publisher: 'Supergiant Games',
      shortDescription: 'Defy the god of the dead.',
    },
    {
      id: 'epic-abc',
      title: 'Alan Wake 2',
      genres: 'Horror Adventure',
      themes: 'Narrative Thriller',
      developer: 'Remedy Entertainment',
      publisher: 'Epic Games Publishing',
      shortDescription: 'A survival horror story sequel.',
    },
  ];
}

function emptyProfile(): TasteProfile {
  return {
    genres: [],
    themes: [],
    gameModes: [],
    perspectives: [],
    developers: [],
    publishers: [],
    eras: [],
    totalGames: 0,
    totalHours: 0,
    avgRating: 0,
    topGenre: '',
    topTheme: '',
    clusters: [],
    loyalDevelopers: [],
    loyalPublishers: [],
  };
}

describe('bm25-index', () => {
  let index: ReturnType<typeof createEmptyBm25Index>;

  beforeEach(() => {
    index = createEmptyBm25Index();
    addBm25Documents(index, fixtureDocs());
  });

  it('returns title match for exact game name', () => {
    const hits = searchBm25Index(index, 'Elden Ring', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('steam-100');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('ranks genre/theme query toward matching docs', () => {
    const hits = searchBm25Index(index, 'Action RPG Fantasy FromSoftware', 10);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('steam-100');
    // Elden Ring should outrank farming sim for this query
    const eldenRank = ids.indexOf('steam-100');
    const stardewRank = ids.indexOf('steam-200');
    if (stardewRank >= 0) {
      expect(eldenRank).toBeLessThan(stardewRank);
    } else {
      expect(eldenRank).toBe(0);
    }
  });

  it('finds epic catalog ids', () => {
    const hits = searchBm25Index(index, 'Alan Wake horror', 5);
    expect(hits.some((h) => h.id === 'epic-abc')).toBe(true);
  });

  it('respects k cap', () => {
    const hits = searchBm25Index(index, 'Games Action Indie Horror', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for blank query', () => {
    expect(searchBm25Index(index, '   ', 10)).toEqual([]);
  });
});

describe('buildLexicalTasteQuery', () => {
  it('includes top genres, themes, loyal studios, and loved titles', () => {
    const p = emptyProfile();
    p.topGenre = 'RPG';
    p.topTheme = 'Fantasy';
    p.genres = [
      { name: 'RPG', weight: 3, gameCount: 5, totalHours: 100, avgRating: 4.5 },
      { name: 'Action', weight: 2, gameCount: 3, totalHours: 40, avgRating: 4 },
    ];
    p.themes = [
      { name: 'Fantasy', weight: 2, gameCount: 4, totalHours: 80, avgRating: 4.2 },
    ];
    p.loyalDevelopers = ['FromSoftware', 'Supergiant Games'];
    const q = buildLexicalTasteQuery(p, {
      lovedTitles: ['Elden Ring', 'Hades'],
    });
    expect(q).toContain('RPG');
    expect(q).toContain('Fantasy');
    expect(q).toContain('FromSoftware');
    expect(q).toContain('Elden Ring');
    expect(q).toContain('Hades');
    // Lexical query should be keyword-ish, not the prose recommender prompt
    expect(q.toLowerCase()).not.toContain('recommend games for this player');
  });
});
