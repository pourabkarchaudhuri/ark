import { describe, it, expect } from 'vitest';
import {
  Game,
  GameStatus,
  GamePriority,
  GameFilters,
  CreateGameInput,
  GameStore,
  getStoreFromId,
  getSteamAppIdFromId,
  migrateGameId,
} from '@/types/game';

describe('Game Types', () => {
  describe('Game interface', () => {
    it('should define a valid game object', () => {
      const game: Game = {
        id: 'steam-12345',
        store: 'steam',
        steamAppId: 12345,
        title: 'Test Game',
        developer: 'Test Developer',
        genre: ['Action', 'RPG'],
        metacriticScore: 85,
        platform: ['PC', 'PlayStation 5'],
        status: 'Want to Play',
        priority: 'High',
        publisher: 'Test Publisher',
        publicReviews: 'Great game!',
        recommendationSource: 'Personal Discovery',
        releaseDate: 'March 24, 2024',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(game.id).toBe('steam-12345');
      expect(game.store).toBe('steam');
      expect(game.title).toBe('Test Game');
      expect(game.genre).toContain('Action');
      expect(game.metacriticScore).toBe(85);
    });

    it('should define a valid Epic game object', () => {
      const game: Game = {
        id: 'epic-fn:fortnite',
        store: 'epic',
        epicNamespace: 'fn',
        epicOfferId: 'fortnite',
        title: 'Fortnite',
        developer: 'Epic Games',
        genre: ['Battle Royale'],
        metacriticScore: 81,
        platform: ['PC'],
        status: 'Playing',
        priority: 'Medium',
        publisher: 'Epic Games',
        publicReviews: '',
        recommendationSource: '',
        releaseDate: '2017-07-25',
        availableOn: ['epic'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(game.id).toBe('epic-fn:fortnite');
      expect(game.store).toBe('epic');
      expect(game.epicNamespace).toBe('fn');
      expect(game.epicOfferId).toBe('fortnite');
      expect(game.availableOn).toContain('epic');
    });

    it('should support multi-store availability', () => {
      const game: Game = {
        id: 'steam-1245620',
        store: 'steam',
        steamAppId: 1245620,
        title: 'Elden Ring',
        developer: 'FromSoftware',
        genre: ['Action', 'RPG'],
        metacriticScore: 96,
        platform: ['PC'],
        status: 'Completed',
        priority: 'High',
        publisher: 'Bandai Namco',
        publicReviews: '',
        recommendationSource: '',
        releaseDate: '2022-02-25',
        availableOn: ['steam', 'epic'],
        secondaryId: 'epic-ns:elden-ring',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(game.availableOn).toEqual(['steam', 'epic']);
      expect(game.secondaryId).toBe('epic-ns:elden-ring');
    });

    it('should allow null metacritic score', () => {
      const game: Game = {
        id: 'steam-99999',
        title: 'Test Game',
        developer: 'Test Developer',
        genre: [],
        metacriticScore: null,
        platform: [],
        status: 'Want to Play',
        priority: 'Medium',
        publisher: '',
        publicReviews: '',
        recommendationSource: '',
        releaseDate: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(game.metacriticScore).toBeNull();
    });
  });

  describe('GameStore type', () => {
    it('should define valid store values', () => {
      const stores: GameStore[] = ['steam', 'epic', 'custom'];
      expect(stores).toHaveLength(3);
      expect(stores).toContain('steam');
      expect(stores).toContain('epic');
      expect(stores).toContain('custom');
    });
  });

  describe('GameStatus type', () => {
    it('should only allow valid status values', () => {
      const validStatuses: GameStatus[] = [
        'Want to Play',
        'Playing',
        'Playing Now',
        'Completed',
        'On Hold',
      ];

      validStatuses.forEach((status) => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('GamePriority type', () => {
    it('should only allow valid priority values', () => {
      const validPriorities: GamePriority[] = ['High', 'Medium', 'Low'];

      validPriorities.forEach((priority) => {
        expect(typeof priority).toBe('string');
      });
    });
  });

  describe('GameFilters interface', () => {
    it('should define valid filter object', () => {
      const filters: GameFilters = {
        search: 'test',
        status: 'Want to Play',
        priority: 'High',
        genre: 'Action',
        platform: 'PC',
        category: 'all',
        releaseYear: 'All',
        store: [],
      };

      expect(filters.search).toBe('test');
      expect(filters.status).toBe('Want to Play');
      expect(filters.store).toEqual([]);
    });

    it('should allow "All" for category filters', () => {
      const filters: GameFilters = {
        search: '',
        status: 'All',
        priority: 'All',
        genre: 'All',
        platform: 'All',
        category: 'all',
        releaseYear: 'All',
        store: [],
      };

      expect(filters.status).toBe('All');
      expect(filters.priority).toBe('All');
      expect(filters.store).toEqual([]);
    });

    it('should allow specific store filter values', () => {
      const steamFilter: GameFilters = {
        search: '',
        status: 'All',
        priority: 'All',
        genre: 'All',
        platform: 'All',
        category: 'all',
        releaseYear: 'All',
        store: ['steam'],
      };
      expect(steamFilter.store).toEqual(['steam']);

      const epicFilter: GameFilters = { ...steamFilter, store: ['epic'] };
      expect(epicFilter.store).toEqual(['epic']);

      const bothFilter: GameFilters = { ...steamFilter, store: ['steam', 'epic'] };
      expect(bothFilter.store).toEqual(['steam', 'epic']);
    });
  });

  describe('CreateGameInput type', () => {
    it('should exclude id, createdAt, and updatedAt', () => {
      const input: CreateGameInput = {
        title: 'New Game',
        developer: 'Developer',
        genre: ['Action'],
        metacriticScore: 80,
        platform: ['PC'],
        status: 'Want to Play',
        priority: 'Medium',
        publisher: 'Publisher',
        publicReviews: '',
        recommendationSource: '',
        releaseDate: 'January 1, 2024',
      };

      expect(input.title).toBe('New Game');
      // @ts-expect-error - id should not exist on CreateGameInput
      expect(input.id).toBeUndefined();
      // @ts-expect-error - createdAt should not exist on CreateGameInput
      expect(input.createdAt).toBeUndefined();
      // @ts-expect-error - updatedAt should not exist on CreateGameInput
      expect(input.updatedAt).toBeUndefined();
    });
  });
});

describe('Game ID Helper Functions', () => {
  describe('getStoreFromId', () => {
    it('identifies Steam games', () => {
      expect(getStoreFromId('steam-730')).toBe('steam');
      expect(getStoreFromId('steam-1245620')).toBe('steam');
    });

    it('identifies Epic games', () => {
      expect(getStoreFromId('epic-fn:fortnite')).toBe('epic');
      expect(getStoreFromId('epic-namespace:offerId')).toBe('epic');
    });

    it('identifies custom games', () => {
      expect(getStoreFromId('custom-1')).toBe('custom');
      expect(getStoreFromId('custom-99')).toBe('custom');
    });

    it('defaults to steam for unrecognized format', () => {
      expect(getStoreFromId('12345')).toBe('steam');
      expect(getStoreFromId('unknown')).toBe('steam');
    });
  });

  describe('getSteamAppIdFromId', () => {
    it('extracts numeric Steam app ID', () => {
      expect(getSteamAppIdFromId('steam-730')).toBe(730);
      expect(getSteamAppIdFromId('steam-1245620')).toBe(1245620);
    });

    it('returns null for non-Steam IDs', () => {
      expect(getSteamAppIdFromId('epic-fn:fortnite')).toBeNull();
      expect(getSteamAppIdFromId('custom-1')).toBeNull();
    });

    it('returns null for invalid Steam IDs', () => {
      expect(getSteamAppIdFromId('steam-abc')).toBeNull();
    });
  });

  describe('migrateGameId', () => {
    it('returns already-migrated string IDs unchanged', () => {
      expect(migrateGameId({ gameId: 'steam-730' })).toBe('steam-730');
      expect(migrateGameId({ gameId: 'epic-fn:fortnite' })).toBe('epic-fn:fortnite');
      expect(migrateGameId({ gameId: 'custom-1' })).toBe('custom-1');
    });

    it('migrates positive numeric gameId to steam format', () => {
      expect(migrateGameId({ gameId: 730 })).toBe('steam-730');
      expect(migrateGameId({ gameId: 1245620 })).toBe('steam-1245620');
    });

    it('migrates negative numeric gameId to custom format', () => {
      expect(migrateGameId({ gameId: -1 })).toBe('custom-1');
      expect(migrateGameId({ gameId: -99 })).toBe('custom-99');
    });

    it('falls back to steamAppId when gameId is missing', () => {
      expect(migrateGameId({ steamAppId: 730 })).toBe('steam-730');
    });

    it('falls back to igdbId when both gameId and steamAppId are missing', () => {
      expect(migrateGameId({ igdbId: 999 } as any)).toBe('steam-999');
    });

    it('defaults to steam-0 when nothing is available', () => {
      expect(migrateGameId({})).toBe('steam-0');
    });
  });
});
