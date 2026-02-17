import { describe, it, expect, vi } from 'vitest';
import { transformSteamGame, hasValidDeveloperInfo } from '@/services/steam-service';
import type { SteamAppDetails } from '@/types/steam';
import type { LibraryGameEntry } from '@/types/game';
import { STEAM_CDN_BASE } from '@/types/steam';

/** Minimal valid SteamAppDetails for testing */
function createSteamAppDetails(overrides: Partial<SteamAppDetails> = {}): SteamAppDetails {
  return {
    type: 'game',
    name: 'Test Game',
    steam_appid: 730,
    required_age: 0,
    is_free: false,
    detailed_description: 'Full description',
    about_the_game: 'About the game',
    short_description: 'Short description',
    supported_languages: 'English',
    header_image: 'https://cdn.example.com/730/header.jpg',
    capsule_image: 'https://cdn.example.com/730/capsule.jpg',
    capsule_imagev5: 'https://cdn.example.com/730/capsulev5.jpg',
    website: 'https://example.com',
    pc_requirements: { minimum: '', recommended: '' },
    platforms: { windows: true, mac: false, linux: false },
    ...overrides,
  };
}

describe('transformSteamGame', () => {
  it('extracts platforms correctly (windows, mac, linux)', () => {
    const details = createSteamAppDetails({
      platforms: { windows: true, mac: true, linux: true },
    });
    const game = transformSteamGame(details);
    expect(game.platform).toEqual(['Windows', 'Mac', 'Linux']);
  });

  it('extracts genres from genre descriptions', () => {
    const details = createSteamAppDetails({
      genres: [
        { id: '1', description: 'Action' },
        { id: '2', description: 'RPG' },
      ],
    });
    const game = transformSteamGame(details);
    expect(game.genre).toEqual(['Action', 'RPG']);
  });

  it('extracts screenshots from path_full', () => {
    const details = createSteamAppDetails({
      screenshots: [
        { id: 1, path_thumbnail: 't1.jpg', path_full: 'https://cdn.example.com/s1.jpg' },
        { id: 2, path_thumbnail: 't2.jpg', path_full: 'https://cdn.example.com/s2.jpg' },
      ],
    });
    const game = transformSteamGame(details);
    expect(game.screenshots).toContain('https://cdn.example.com/730/header.jpg');
    expect(game.screenshots).toContain('https://cdn.example.com/s1.jpg');
    expect(game.screenshots).toContain('https://cdn.example.com/s2.jpg');
  });

  it('parses valid release date to ISO string', () => {
    const details = createSteamAppDetails({
      release_date: { coming_soon: false, date: 'Jan 15, 2025' },
    });
    const game = transformSteamGame(details);
    expect(game.releaseDate).toBe(new Date('Jan 15, 2025').toISOString());
  });

  it('keeps raw date string when parsing fails', () => {
    const details = createSteamAppDetails({
      release_date: { coming_soon: false, date: 'TBD' },
    });
    const game = transformSteamGame(details);
    expect(game.releaseDate).toBe('TBD');
  });

  it('uses library entry data when provided', () => {
    const details = createSteamAppDetails();
    const addedAt = new Date('2024-06-01');
    const updatedAt = new Date('2024-12-01');
    const libraryEntry: LibraryGameEntry = {
      gameId: 'steam-730',
      status: 'Playing',
      priority: 'High',
      publicReviews: 'Great game!',
      recommendationSource: 'Friend',
      hoursPlayed: 50,
      rating: 5,
      addedAt,
      updatedAt,
    };
    const game = transformSteamGame(details, libraryEntry);
    expect(game.status).toBe('Playing');
    expect(game.priority).toBe('High');
    expect(game.publicReviews).toBe('Great game!');
    expect(game.recommendationSource).toBe('Friend');
    expect(game.createdAt).toBe(addedAt);
    expect(game.updatedAt).toBe(updatedAt);
    expect(game.isInLibrary).toBe(true);
  });

  it('sets correct store field', () => {
    const details = createSteamAppDetails();
    const game = transformSteamGame(details);
    expect(game.store).toBe('steam');
  });

  it('handles missing developers and publishers gracefully', () => {
    const details = createSteamAppDetails({
      developers: undefined,
      publishers: undefined,
    });
    const game = transformSteamGame(details);
    expect(game.developer).toBe('Unknown Developer');
    expect(game.publisher).toBe('Unknown Publisher');
  });

  it('handles missing platforms by defaulting to PC', () => {
    const details = createSteamAppDetails({
      platforms: { windows: false, mac: false, linux: false },
    });
    const game = transformSteamGame(details);
    expect(game.platform).toEqual(['PC']);
  });

  it('passes rank and playerCount correctly', () => {
    const details = createSteamAppDetails();
    const game = transformSteamGame(details, undefined, 5, 125000);
    expect(game.rank).toBe(5);
    expect(game.playerCount).toBe(125000);
  });

  it('uses cover URL from Steam CDN', () => {
    const details = createSteamAppDetails({ steam_appid: 730 });
    const game = transformSteamGame(details);
    expect(game.coverUrl).toBe(`${STEAM_CDN_BASE}/730/library_600x900.jpg`);
  });

  it('handles empty optional fields gracefully', () => {
    const details = createSteamAppDetails({
      genres: undefined,
      screenshots: undefined,
      release_date: undefined,
      metacritic: undefined,
      price_overview: undefined,
    });
    const game = transformSteamGame(details);
    expect(game.genre).toEqual([]);
    expect(game.screenshots).toEqual(['https://cdn.example.com/730/header.jpg']);
    expect(game.releaseDate).toBe('');
    expect(game.metacriticScore).toBeNull();
    expect(game.price?.isFree).toBe(false);
  });
});

describe('hasValidDeveloperInfo', () => {
  it('returns true when both developer and publisher are valid', () => {
    const game = {
      developer: 'Valve',
      publisher: 'Valve',
    } as Parameters<typeof hasValidDeveloperInfo>[0];
    expect(hasValidDeveloperInfo(game)).toBe(true);
  });

  it('returns false when developer is Unknown Developer', () => {
    const game = {
      developer: 'Unknown Developer',
      publisher: 'Valve',
    } as Parameters<typeof hasValidDeveloperInfo>[0];
    expect(hasValidDeveloperInfo(game)).toBe(false);
  });

  it('returns false when publisher is Unknown Publisher', () => {
    const game = {
      developer: 'Valve',
      publisher: 'Unknown Publisher',
    } as Parameters<typeof hasValidDeveloperInfo>[0];
    expect(hasValidDeveloperInfo(game)).toBe(false);
  });

  it('returns false when developer is empty string', () => {
    const game = {
      developer: '',
      publisher: 'Valve',
    } as Parameters<typeof hasValidDeveloperInfo>[0];
    expect(hasValidDeveloperInfo(game)).toBe(false);
  });

  it('returns false when both are invalid', () => {
    const game = {
      developer: 'Unknown Developer',
      publisher: 'Unknown Publisher',
    } as Parameters<typeof hasValidDeveloperInfo>[0];
    expect(hasValidDeveloperInfo(game)).toBe(false);
  });
});
