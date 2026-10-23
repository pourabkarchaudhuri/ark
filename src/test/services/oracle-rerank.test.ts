/**
 * Oracle rerank — taste query text
 */

import { describe, it, expect } from 'vitest';
import { buildTasteQueryText, buildLexicalTasteQuery } from '@/services/oracle-rerank';
import type { TasteProfile } from '@/types/reco';

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

describe('buildTasteQueryText', () => {
  it('includes top genre, theme, and affinities', () => {
    const p = emptyProfile();
    p.topGenre = 'RPG';
    p.topTheme = 'Fantasy';
    p.genres = [{ name: 'RPG', weight: 2, gameCount: 0, totalHours: 0, avgRating: 4 }];
    p.themes = [{ name: 'Fantasy', weight: 1, gameCount: 0, totalHours: 0, avgRating: 4 }];
    p.gameModes = [{ name: 'Single-player', weight: 1, gameCount: 0, totalHours: 0, avgRating: 4 }];
    p.loyalDevelopers = ['FromSoftware'];
    const q = buildTasteQueryText(p, { lovedTitles: ['Elden Ring', 'Hades'] });
    expect(q).toContain('RPG');
    expect(q).toContain('Fantasy');
    expect(q).toContain('FromSoftware');
    // Loved titles anchor the query; the dead "Modes" clause and the repeated top-genre line are gone (R7).
    expect(q).toContain('Elden Ring');
    expect(q).not.toContain('Single-player');
    expect(q).not.toContain('Top genre');
    expect(q.match(/RPG/g)?.length).toBe(1);
  });
});

describe('buildLexicalTasteQuery', () => {
  it('is keyword-focused and includes loved titles', () => {
    const p = emptyProfile();
    p.topGenre = 'RPG';
    p.genres = [{ name: 'RPG', weight: 2, gameCount: 0, totalHours: 0, avgRating: 4 }];
    p.loyalDevelopers = ['FromSoftware'];
    const q = buildLexicalTasteQuery(p, { lovedTitles: ['Elden Ring'] });
    expect(q).toContain('RPG');
    expect(q).toContain('FromSoftware');
    expect(q).toContain('Elden Ring');
    expect(q.toLowerCase()).not.toContain('recommend games');
  });
});
