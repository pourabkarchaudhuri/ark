import { describe, it, expect } from 'vitest';
import { countActiveFilters } from '@/lib/active-filters';
import type { GameFilters } from '@/types/game';

const base: GameFilters = {
  search: '',
  status: 'All',
  priority: 'All',
  genre: 'All',
  platform: 'All',
  category: 'trending',
  releaseYear: 'All',
  store: [],
};

describe('countActiveFilters', () => {
  it('is 0 with default filters in either view', () => {
    expect(countActiveFilters(base, 'browse')).toBe(0);
    expect(countActiveFilters(base, 'library')).toBe(0);
  });

  it('counts a Release Year filter on its own', () => {
    expect(countActiveFilters({ ...base, releaseYear: '2019' }, 'browse')).toBe(1);
    expect(countActiveFilters({ ...base, releaseYear: '2019' }, 'library')).toBe(1);
  });

  it('only counts status/priority in Library and category in Browse', () => {
    const f: GameFilters = { ...base, status: 'Playing', priority: 'High', category: 'free' };
    expect(countActiveFilters(f, 'library')).toBe(2);
    expect(countActiveFilters(f, 'browse')).toBe(1);
  });

  it('counts genre, platform, year and store together', () => {
    const f: GameFilters = { ...base, genre: 'RPG', platform: 'Windows', releaseYear: '2020', store: ['steam'] };
    expect(countActiveFilters(f, 'browse')).toBe(4);
  });
});
