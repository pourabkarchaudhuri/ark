/**
 * Oracle rerank — taste query text
 */

import { describe, it, expect } from 'vitest';
import { buildTasteQueryText } from '@/services/oracle-rerank';
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
    const q = buildTasteQueryText(p);
    expect(q).toContain('RPG');
    expect(q).toContain('Fantasy');
    expect(q).toContain('FromSoftware');
    expect(q).toContain('Single-player');
  });
});
