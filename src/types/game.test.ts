import { describe, it, expect } from 'vitest';
import { Game, GameStatus, GamePriority, GameFilters, CreateGameInput } from './game';

describe('Game Types', () => {
  describe('Game interface', () => {
    it('should define a valid game object', () => {
      const game: Game = {
        id: 'test-id',
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

      expect(game.id).toBe('test-id');
      expect(game.title).toBe('Test Game');
      expect(game.genre).toContain('Action');
      expect(game.metacriticScore).toBe(85);
    });

    it('should allow null metacritic score', () => {
      const game: Game = {
        id: 'test-id',
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

  describe('GameStatus type', () => {
    it('should only allow valid status values', () => {
      const validStatuses: GameStatus[] = [
        'Want to Play',
        'Playing',
        'Completed',
        'On Hold',
        'Dropped',
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
      };

      expect(filters.search).toBe('test');
      expect(filters.status).toBe('Want to Play');
    });

    it('should allow "All" for category filters', () => {
      const filters: GameFilters = {
        search: '',
        status: 'All',
        priority: 'All',
        genre: 'All',
        platform: 'All',
      };

      expect(filters.status).toBe('All');
      expect(filters.priority).toBe('All');
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

