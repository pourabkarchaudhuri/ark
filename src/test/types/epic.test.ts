import { describe, it, expect } from 'vitest';
import { EpicKeyImage, EpicCatalogItem, EpicUpcomingRelease } from '@/types/epic';

describe('Epic Types', () => {
  describe('EpicKeyImage', () => {
    it('has correct structure', () => {
      const image: EpicKeyImage = {
        type: 'DieselStoreFrontWide',
        url: 'https://cdn.epicgames.com/image.jpg',
      };

      expect(image.type).toBe('DieselStoreFrontWide');
      expect(image.url).toBe('https://cdn.epicgames.com/image.jpg');
    });
  });

  describe('EpicCatalogItem', () => {
    it('has correct minimal structure', () => {
      const item: EpicCatalogItem = {
        namespace: 'fn',
        id: 'fortnite-offer-id',
        title: 'Fortnite',
      };

      expect(item.namespace).toBe('fn');
      expect(item.id).toBe('fortnite-offer-id');
      expect(item.title).toBe('Fortnite');
    });

    it('supports full catalog structure', () => {
      const item: EpicCatalogItem = {
        namespace: 'ue',
        id: 'unreal-engine-offer',
        title: 'Elden Ring',
        description: 'An action RPG',
        longDescription: 'A detailed description of the game...',
        keyImages: [
          { type: 'DieselStoreFrontWide', url: 'https://example.com/wide.jpg' },
          { type: 'OfferImageTall', url: 'https://example.com/tall.jpg' },
          { type: 'Thumbnail', url: 'https://example.com/thumb.jpg' },
        ],
        categories: [
          { path: 'games/edition/base' },
          { path: 'games' },
        ],
        tags: [
          { id: 1216, name: 'Action' },
          { id: 1367, name: 'RPG' },
        ],
        effectiveDate: '2024-01-01T00:00:00.000Z',
        developer: 'FromSoftware',
        publisher: 'Bandai Namco',
        urlSlug: 'elden-ring',
        productSlug: 'elden-ring',
        price: {
          totalPrice: {
            discountPrice: 3999,
            originalPrice: 5999,
            fmtPrice: {
              originalPrice: '$59.99',
              discountPrice: '$39.99',
              intermediatePrice: '$59.99',
            },
          },
        },
      };

      expect(item.keyImages).toHaveLength(3);
      expect(item.categories).toHaveLength(2);
      expect(item.tags).toHaveLength(2);
      expect(item.price?.totalPrice.discountPrice).toBe(3999);
      expect(item.developer).toBe('FromSoftware');
    });

    it('supports promotional offers', () => {
      const item: EpicCatalogItem = {
        namespace: 'test',
        id: 'test-offer',
        title: 'Test Game',
        promotions: {
          promotionalOffers: [{
            promotionalOffers: [{
              startDate: '2024-01-01T00:00:00.000Z',
              endDate: '2024-01-15T00:00:00.000Z',
              discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 100 },
            }],
          }],
          upcomingPromotionalOffers: [{
            promotionalOffers: [{
              startDate: '2024-02-01T00:00:00.000Z',
              endDate: '2024-02-15T00:00:00.000Z',
              discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 50 },
            }],
          }],
        },
      };

      expect(item.promotions?.promotionalOffers).toHaveLength(1);
      expect(item.promotions?.promotionalOffers[0].promotionalOffers[0].discountSetting.discountPercentage).toBe(100);
      expect(item.promotions?.upcomingPromotionalOffers).toHaveLength(1);
    });

    it('supports custom attributes', () => {
      const item: EpicCatalogItem = {
        namespace: 'test',
        id: 'test-offer',
        title: 'Test Game',
        customAttributes: [
          { key: 'com.epicgames.app.productSlug', value: 'test-game' },
          { key: 'developerName', value: 'Test Studio' },
        ],
      };

      expect(item.customAttributes).toHaveLength(2);
      expect(item.customAttributes![0].key).toBe('com.epicgames.app.productSlug');
    });
  });

  describe('EpicUpcomingRelease', () => {
    it('has correct structure', () => {
      const release: EpicUpcomingRelease = {
        title: 'New Upcoming Game',
        date: '2026-06-15T00:00:00.000Z',
        capsule: 'https://example.com/capsule.jpg',
        discount: false,
        free: false,
        namespace: 'ns-upcoming',
        offerId: 'offer-upcoming',
      };

      expect(release.title).toBe('New Upcoming Game');
      expect(release.date).toBe('2026-06-15T00:00:00.000Z');
      expect(release.capsule).toBe('https://example.com/capsule.jpg');
      expect(release.discount).toBe(false);
      expect(release.free).toBe(false);
      expect(release.namespace).toBe('ns-upcoming');
      expect(release.offerId).toBe('offer-upcoming');
    });

    it('handles free games', () => {
      const freeGame: EpicUpcomingRelease = {
        title: 'Free Game',
        date: '2026-01-01T00:00:00.000Z',
        capsule: 'https://example.com/free.jpg',
        discount: true,
        free: true,
        namespace: 'ns-free',
        offerId: 'offer-free',
      };

      expect(freeGame.free).toBe(true);
      expect(freeGame.discount).toBe(true);
    });
  });

  describe('Game ID format', () => {
    it('generates correct Epic game ID format', () => {
      const namespace = 'fn';
      const offerId = 'fortnite';
      const gameId = `epic-${namespace}:${offerId}`;
      
      expect(gameId).toBe('epic-fn:fortnite');
      expect(gameId.startsWith('epic-')).toBe(true);
    });

    it('parses Epic game ID correctly', () => {
      const gameId = 'epic-some-namespace:some-offer-id';
      const isEpic = gameId.startsWith('epic-');
      const parts = gameId.slice(5).split(':'); // Remove "epic-" prefix
      
      expect(isEpic).toBe(true);
      expect(parts[0]).toBe('some-namespace');
      expect(parts[1]).toBe('some-offer-id');
    });
  });
});
