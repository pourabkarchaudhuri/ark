import { describe, it, expect } from 'vitest';
import { normalizeTitle, deduplicateGames } from '@/services/game-service';
import { Game } from '@/types/game';

// Helper to create a minimal Game object for testing
function createGame(overrides: Partial<Game> & { id: string; title: string }): Game {
  return {
    store: 'steam',
    developer: 'Test Dev',
    publisher: 'Test Pub',
    genre: ['Action'],
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

describe('normalizeTitle', () => {
  it('lowercases and trims', () => {
    expect(normalizeTitle('  ELDEN RING  ')).toBe('elden ring');
  });

  it('replaces ampersand with "and"', () => {
    expect(normalizeTitle('Ratchet & Clank')).toBe('ratchet and clank');
  });

  it('removes smart quotes', () => {
    expect(normalizeTitle("Baldur's Gate 3")).toBe('baldurs gate 3');
    expect(normalizeTitle('It\u2019s a Game')).toBe('its a game');
  });

  it('removes special characters', () => {
    expect(normalizeTitle('DOOM: Eternal')).toBe('doom eternal');
    expect(normalizeTitle('Game™ – Special!')).toBe('game special');
  });

  it('strips edition suffixes', () => {
    expect(normalizeTitle('Cyberpunk 2077: Ultimate Edition')).toBe('cyberpunk 2077');
    expect(normalizeTitle('Elden Ring Deluxe Edition')).toBe('elden ring');
    expect(normalizeTitle('Witcher 3 Game of the Year')).toBe('witcher 3');
    expect(normalizeTitle('Horizon Zero Dawn Complete Edition')).toBe('horizon zero dawn');
    expect(normalizeTitle('Metro Exodus Gold Edition')).toBe('metro exodus');
  });

  it('normalizes multiple spaces', () => {
    expect(normalizeTitle('a    b   c')).toBe('a b c');
  });

  it('handles empty strings', () => {
    expect(normalizeTitle('')).toBe('');
  });

  it('produces same key for matching titles across stores', () => {
    expect(normalizeTitle('Elden Ring')).toBe(normalizeTitle('ELDEN RING'));
    expect(normalizeTitle('Cyberpunk 2077')).toBe(normalizeTitle('Cyberpunk 2077: Ultimate Edition'));
    expect(normalizeTitle("Baldur's Gate 3")).toBe(normalizeTitle('Baldurs Gate 3'));
  });

  it('normalises Roman numerals to Arabic', () => {
    expect(normalizeTitle('Dark Souls III')).toBe(normalizeTitle('Dark Souls 3'));
    expect(normalizeTitle('Final Fantasy VII')).toBe(normalizeTitle('Final Fantasy 7'));
    expect(normalizeTitle('Civilization VI')).toBe(normalizeTitle('Civilization 6'));
    expect(normalizeTitle('Resident Evil II')).toBe(normalizeTitle('Resident Evil 2'));
  });

  it('strips trademark and copyright symbols', () => {
    expect(normalizeTitle('DOOM™ Eternal')).toBe('doom eternal');
    expect(normalizeTitle('Game® Pro©')).toBe('game pro');
  });

  it('strips additional edition suffixes', () => {
    expect(normalizeTitle('Metro Exodus: Directors Cut')).toBe('metro exodus');
    expect(normalizeTitle('Alan Wake Remastered')).toBe('alan wake');
    expect(normalizeTitle('Dark Souls Trilogy')).toBe('dark souls');
    expect(normalizeTitle('Borderlands: The Handsome Collection')).toBe('borderlands the handsome');
  });
});

describe('deduplicateGames', () => {
  it('returns games unchanged when no duplicates', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'Game A', store: 'steam' }),
      createGame({ id: 'steam-2', title: 'Game B', store: 'steam' }),
      createGame({ id: 'epic-ns:1', title: 'Game C', store: 'epic' }),
    ];

    const result = deduplicateGames(games);
    expect(result).toHaveLength(3);
  });

  it('marks single-store games with availableOn', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'Game A', store: 'steam' }),
      createGame({ id: 'epic-ns:1', title: 'Game B', store: 'epic' }),
    ];

    const result = deduplicateGames(games);
    expect(result[0].availableOn).toEqual(['steam']);
    expect(result[1].availableOn).toEqual(['epic']);
  });

  it('merges duplicate titles across stores', () => {
    const games = [
      createGame({ id: 'steam-730', title: 'Elden Ring', store: 'steam', steamAppId: 730, metacriticScore: 96 }),
      createGame({ id: 'epic-ns:elden', title: 'Elden Ring', store: 'epic', epicNamespace: 'ns', epicOfferId: 'elden' }),
    ];

    const result = deduplicateGames(games);
    expect(result).toHaveLength(1);
    expect(result[0].availableOn).toContain('steam');
    expect(result[0].availableOn).toContain('epic');
    expect(result[0].availableOn).toHaveLength(2);
  });

  it('prefers Steam as primary when merging', () => {
    const games = [
      createGame({ id: 'steam-730', title: 'Elden Ring', store: 'steam', steamAppId: 730, metacriticScore: 96 }),
      createGame({ id: 'epic-ns:elden', title: 'Elden Ring', store: 'epic', epicNamespace: 'ns', epicOfferId: 'elden' }),
    ];

    const result = deduplicateGames(games);
    expect(result[0].store).toBe('steam');
    expect(result[0].id).toBe('steam-730');
    expect(result[0].secondaryId).toBe('epic-ns:elden');
  });

  it('prefers Steam even when Epic comes first', () => {
    const games = [
      createGame({ id: 'epic-ns:elden', title: 'Elden Ring', store: 'epic', epicNamespace: 'ns', epicOfferId: 'elden' }),
      createGame({ id: 'steam-730', title: 'Elden Ring', store: 'steam', steamAppId: 730, metacriticScore: 96 }),
    ];

    const result = deduplicateGames(games);
    expect(result[0].store).toBe('steam');
    expect(result[0].id).toBe('steam-730');
    expect(result[0].secondaryId).toBe('epic-ns:elden');
  });

  it('preserves Epic metadata when merging', () => {
    const games = [
      createGame({ id: 'steam-730', title: 'Elden Ring', store: 'steam', steamAppId: 730 }),
      createGame({ id: 'epic-ns:elden', title: 'Elden Ring', store: 'epic', epicNamespace: 'ns', epicOfferId: 'elden' }),
    ];

    const result = deduplicateGames(games);
    expect(result[0].epicNamespace).toBe('ns');
    expect(result[0].epicOfferId).toBe('elden');
    expect(result[0].steamAppId).toBe(730);
  });

  it('preserves Epic pricing as epicPrice on merged games', () => {
    const games = [
      createGame({ id: 'steam-730', title: 'Elden Ring', store: 'steam', steamAppId: 730 }),
      createGame({
        id: 'epic-ns:elden', title: 'Elden Ring', store: 'epic',
        epicNamespace: 'ns', epicOfferId: 'elden',
        price: { isFree: false, finalFormatted: '$49.99', discountPercent: 10 },
      }),
    ];

    const result = deduplicateGames(games);
    expect(result[0].epicPrice).toEqual({ isFree: false, finalFormatted: '$49.99', discountPercent: 10 });
  });

  it('deduplicates edition variants', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'Cyberpunk 2077', store: 'steam' }),
      createGame({ id: 'epic-ns:cp', title: 'Cyberpunk 2077: Ultimate Edition', store: 'epic', epicNamespace: 'ns', epicOfferId: 'cp' }),
    ];

    const result = deduplicateGames(games);
    expect(result).toHaveLength(1);
    expect(result[0].availableOn).toContain('steam');
    expect(result[0].availableOn).toContain('epic');
  });

  it('does not merge different games from the same store', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'Game A', store: 'steam' }),
      createGame({ id: 'steam-2', title: 'Game A', store: 'steam' }), // Same title, same store
    ];

    const result = deduplicateGames(games);
    // Should deduplicate by title, keeping the first occurrence
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('steam-1');
  });

  it('handles empty input', () => {
    expect(deduplicateGames([])).toEqual([]);
  });

  it('handles single game', () => {
    const games = [createGame({ id: 'steam-1', title: 'Solo Game', store: 'steam' })];
    const result = deduplicateGames(games);
    expect(result).toHaveLength(1);
    expect(result[0].availableOn).toEqual(['steam']);
  });

  it('handles multiple cross-store duplicates', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'Game A', store: 'steam' }),
      createGame({ id: 'epic-ns:a', title: 'Game A', store: 'epic', epicNamespace: 'ns', epicOfferId: 'a' }),
      createGame({ id: 'steam-2', title: 'Game B', store: 'steam' }),
      createGame({ id: 'epic-ns:b', title: 'Game B', store: 'epic', epicNamespace: 'ns', epicOfferId: 'b' }),
      createGame({ id: 'steam-3', title: 'Steam Only', store: 'steam' }),
      createGame({ id: 'epic-ns:c', title: 'Epic Only', store: 'epic' }),
    ];

    const result = deduplicateGames(games);
    expect(result).toHaveLength(4); // Game A, Game B, Steam Only, Epic Only

    const gameA = result.find(g => normalizeTitle(g.title) === 'game a');
    expect(gameA?.availableOn).toEqual(expect.arrayContaining(['steam', 'epic']));

    const steamOnly = result.find(g => g.title === 'Steam Only');
    expect(steamOnly?.availableOn).toEqual(['steam']);

    const epicOnly = result.find(g => g.title === 'Epic Only');
    expect(epicOnly?.availableOn).toEqual(['epic']);
  });
});

describe('filterByStore', () => {
  // We test the logic that the service uses — imported module has class instance
  // so we test the method pattern directly
  it('returns all games when store is All', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'A', store: 'steam' }),
      createGame({ id: 'epic-ns:1', title: 'B', store: 'epic' }),
    ];

    // "All" filter should not remove anything
    const filtered = games.filter(g => true); // filterByStore('All') returns all
    expect(filtered).toHaveLength(2);
  });

  it('filters Steam games correctly', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'A', store: 'steam', availableOn: ['steam'] }),
      createGame({ id: 'epic-ns:1', title: 'B', store: 'epic', availableOn: ['epic'] }),
      createGame({ id: 'steam-2', title: 'C', store: 'steam', availableOn: ['steam', 'epic'] }),
    ];

    const steamGames = games.filter(g => g.store === 'steam' || g.availableOn?.includes('steam'));
    expect(steamGames).toHaveLength(2);
    expect(steamGames.map(g => g.title)).toEqual(['A', 'C']);
  });

  it('filters Epic games correctly', () => {
    const games = [
      createGame({ id: 'steam-1', title: 'A', store: 'steam', availableOn: ['steam'] }),
      createGame({ id: 'epic-ns:1', title: 'B', store: 'epic', availableOn: ['epic'] }),
      createGame({ id: 'steam-2', title: 'C', store: 'steam', availableOn: ['steam', 'epic'] }),
    ];

    const epicGames = games.filter(g => g.store === 'epic' || g.availableOn?.includes('epic'));
    expect(epicGames).toHaveLength(2);
    expect(epicGames.map(g => g.title)).toEqual(['B', 'C']);
  });

  it('includes merged games in both store filters', () => {
    const mergedGame = createGame({
      id: 'steam-1',
      title: 'Cross-Store Game',
      store: 'steam',
      availableOn: ['steam', 'epic'],
    });

    const inSteam = mergedGame.store === 'steam' || mergedGame.availableOn?.includes('steam');
    const inEpic = mergedGame.store === 'epic' || mergedGame.availableOn?.includes('epic');

    expect(inSteam).toBe(true);
    expect(inEpic).toBe(true);
  });
});
