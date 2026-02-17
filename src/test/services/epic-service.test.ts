import { describe, it, expect, vi } from 'vitest';
import { transformEpicGame } from '@/services/epic-service';
import type { EpicCatalogItem } from '@/types/epic';
import type { LibraryGameEntry } from '@/types/game';

function makeMinimalItem(overrides: Partial<EpicCatalogItem> = {}): EpicCatalogItem {
  return {
    namespace: 'fn',
    id: 'fortnite-offer-id',
    title: 'Fortnite',
    ...overrides,
  };
}

describe('EpicService', () => {
  describe('transformEpicGame', () => {
    it('transforms minimal EpicCatalogItem to Game with required fields', () => {
      const item = makeMinimalItem();
      const game = transformEpicGame(item);

      expect(game.id).toBe('epic-fn:fortnite-offer-id');
      expect(game.store).toBe('epic');
      expect(game.epicNamespace).toBe('fn');
      expect(game.epicOfferId).toBe('fortnite-offer-id');
      expect(game.title).toBe('Fortnite');
      expect(game.developer).toBe('Unknown Developer');
      expect(game.publisher).toBe('Unknown Publisher');
      expect(game.genre).toEqual(['Game']);
      expect(game.platform).toEqual(['Windows']);
      expect(game.releaseDate).toBe('');
      expect(game.metacriticScore).toBeNull();
      expect(game.status).toBe('Want to Play');
      expect(game.priority).toBe('Medium');
      expect(game.isInLibrary).toBe(false);
    });

    it('extracts genres from tags (names and EPIC_GENRE_MAP IDs)', () => {
      const item = makeMinimalItem({
        tags: [
          { id: 1216, name: 'Action' },      // name takes priority
          { id: 1370 },                       // 1370 = RPG from genre map
          { id: 1210, name: 'Shooter' },     // duplicate prevention via name
        ],
      });
      const game = transformEpicGame(item);

      expect(game.genre).toContain('Action');
      expect(game.genre).toContain('RPG');
      expect(game.genre).toContain('Shooter');
      expect(game.genre).toHaveLength(3);
    });

    it('extracts platforms from customAttributes and categories', () => {
      const item = makeMinimalItem({
        customAttributes: [
          { key: 'PlatformSupport', value: 'Windows,Mac' },
          { key: 'CompatiblePlatforms', value: 'pc' },
        ],
        categories: [
          { path: 'games/edition/windows' },
          { path: 'games/edition/linux' },
        ],
      });
      const game = transformEpicGame(item);

      expect(game.platform).toContain('Windows');
      expect(game.platform).toContain('Mac');
      expect(game.platform).toContain('Linux');
      expect(game.platform.length).toBeGreaterThanOrEqual(2);
    });

    it('defaults to Windows when no platform info is present', () => {
      const item = makeMinimalItem();
      const game = transformEpicGame(item);
      expect(game.platform).toEqual(['Windows']);
    });

    it('handles price: free, discounted, and full price', () => {
      const freeItem = makeMinimalItem({
        price: {
          totalPrice: {
            discountPrice: 0,
            originalPrice: 0,
            fmtPrice: { originalPrice: 'Free', discountPrice: 'Free', intermediatePrice: 'Free' },
          },
        },
      });
      const freeGame = transformEpicGame(freeItem);
      expect(freeGame.price?.isFree).toBe(true);
      expect(freeGame.price?.discountPercent).toBeUndefined();

      const discountedItem = makeMinimalItem({
        price: {
          totalPrice: {
            discountPrice: 2999,
            originalPrice: 5999,
            fmtPrice: { originalPrice: '$59.99', discountPrice: '$29.99', intermediatePrice: '$59.99' },
          },
        },
      });
      const discountedGame = transformEpicGame(discountedItem);
      expect(discountedGame.price?.isFree).toBe(false);
      expect(discountedGame.price?.discountPercent).toBe(50);
      expect(discountedGame.price?.finalFormatted).toBe('$29.99');

      const fullPriceItem = makeMinimalItem({
        price: {
          totalPrice: {
            discountPrice: 5999,
            originalPrice: 5999,
            fmtPrice: { originalPrice: '$59.99', discountPrice: '$59.99', intermediatePrice: '$59.99' },
          },
        },
      });
      const fullPriceGame = transformEpicGame(fullPriceItem);
      expect(fullPriceGame.price?.isFree).toBe(false);
      expect(fullPriceGame.price?.discountPercent).toBeUndefined();
    });

    it('resolves images: coverUrl prefers tall, headerImage prefers wide', () => {
      const tallUrl = 'https://cdn.epicgames.com/tall.jpg';
      const wideUrl = 'https://cdn.epicgames.com/wide.jpg';
      const item = makeMinimalItem({
        keyImages: [
          { type: 'Thumbnail', url: 'https://cdn.epicgames.com/thumb.jpg' },
          { type: 'DieselStoreFrontTall', url: tallUrl },
          { type: 'DieselStoreFrontWide', url: wideUrl },
        ],
      });
      const game = transformEpicGame(item);

      expect(game.coverUrl).toBe(tallUrl);
      expect(game.headerImage).toBe(wideUrl);
    });

    it('resolves epicSlug from catalogNs, offerMappings, url, and productSlug', () => {
      const itemWithCatalogSlug = makeMinimalItem({
        catalogNs: {
          mappings: [
            { pageSlug: 'elden-ring', pageType: 'productHome' },
            { pageSlug: 'other', pageType: 'offer' },
          ],
        },
      });
      expect(transformEpicGame(itemWithCatalogSlug).epicSlug).toBe('elden-ring');

      const itemWithOfferSlug = makeMinimalItem({
        offerMappings: [{ pageSlug: 'cyberpunk-2077', pageType: 'productHome' }],
      });
      expect(transformEpicGame(itemWithOfferSlug).epicSlug).toBe('cyberpunk-2077');

      const itemWithUrl = makeMinimalItem({ url: '/en-US/p/dead-cells' });
      expect(transformEpicGame(itemWithUrl).epicSlug).toBe('dead-cells');

      const itemWithProductSlug = makeMinimalItem({ productSlug: 'hades/home' });
      expect(transformEpicGame(itemWithProductSlug).epicSlug).toBe('hades');
    });

    it('sets comingSoon when effectiveDate is in the future', () => {
      const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
      const pastDate = new Date(Date.now() - 86400000 * 30).toISOString();

      const futureItem = makeMinimalItem({ effectiveDate: futureDate });
      const pastItem = makeMinimalItem({ effectiveDate: pastDate });

      expect(transformEpicGame(futureItem).comingSoon).toBe(true);
      expect(transformEpicGame(pastItem).comingSoon).toBe(false);
    });

    it('merges library entry when provided', () => {
      const item = makeMinimalItem();
      const addedAt = new Date('2024-01-15');
      const updatedAt = new Date('2024-02-01');
      const libraryEntry: LibraryGameEntry = {
        gameId: 'epic-fn:fortnite-offer-id',
        status: 'Playing',
        priority: 'High',
        publicReviews: 'Great battle royale!',
        recommendationSource: 'Friend',
        hoursPlayed: 10,
        rating: 4,
        addedAt,
        updatedAt,
      };

      const game = transformEpicGame(item, libraryEntry);

      expect(game.status).toBe('Playing');
      expect(game.priority).toBe('High');
      expect(game.publicReviews).toBe('Great battle royale!');
      expect(game.recommendationSource).toBe('Friend');
      expect(game.createdAt).toEqual(addedAt);
      expect(game.updatedAt).toEqual(updatedAt);
      expect(game.isInLibrary).toBe(true);
    });
  });
});
